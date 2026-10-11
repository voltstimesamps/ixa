import OpenAI from "openai"
import type { Fetch } from "openai/core"
import { config } from "../config"

// Reads one header out of a fetch init, whatever shape it arrived in. The SDK
// builds a plain lowercase-keyed object today; Headers and the entry-array
// form are handled so a future SDK version cannot silently break the log line.
function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(name)
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name)
    return found ? found[1]! : null
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return null
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")
}

// Every HTTP attempt the SDK makes passes through here, retries included —
// and the SDK stamps `x-stainless-retry-count` on each one, so an attempt can
// name itself.
//
// This is why there is no hand-rolled retry loop. The SDK already decides
// which statuses are retryable, honours `retry-after` / `retry-after-ms`, and
// backs off exponentially with jitter; reimplementing that to get a log line
// would mean two retry policies, and the second one would drift. The only
// thing the SDK will not do is say that a retry happened, so that is the only
// thing added here.
//
// Logged per FAILED attempt rather than per retry: the wrapper cannot see how
// many retries remain, and the final attempt — the one that actually ends the
// turn — is the one most worth having in the log.
const loggingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const attempt = Number(headerValue(init, "x-stainless-retry-count") ?? "0") + 1
  const of = `${attempt}/${config.llm.maxRetries + 1}`

  let response: Response
  try {
    response = await fetch(input, init)
  } catch (err) {
    // An aborted attempt is one of our own deadlines firing. chat() logs that
    // with the reason; a second line here would only say it twice.
    if (!isAbortError(err)) {
      console.log(`llm attempt ${of} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    throw err
  }

  if (!response.ok) {
    const retryAfter =
      response.headers.get("retry-after-ms") ?? response.headers.get("retry-after")
    console.log(
      `llm attempt ${of} failed: status=${response.status}` +
        (retryAfter ? ` retry-after=${retryAfter}` : "")
    )
  }
  return response
}

const client = new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
  maxRetries: config.llm.maxRetries,
  // Cast because the SDK's shim types resolve to @types/node-fetch, while what
  // actually runs on Node 20+ is the global fetch. The shapes agree at runtime.
  fetch: loggingFetch as unknown as Fetch,
})

export type Message = OpenAI.Chat.ChatCompletionMessageParam

export type ToolCall = {
  id: string
  name: string
  arguments: string
}

export type LLMResponse =
  | { type: "text"; content: string }
  | { type: "tool_calls"; calls: ToolCall[] }

// Thrown when one of our own deadlines fires. Distinct from a transport error
// so the tool loop's malformed-tool-call retry never mistakes a timeout for a
// model that needs asking again without tools.
export class LLMDeadlineError extends Error {
  constructor(reason: string) {
    super(`LLM call aborted: ${reason}`)
    this.name = "LLMDeadlineError"
  }
}

// ---------------------------------------------- argument-level rejections
//
// A DIFFERENT CATEGORY FROM THE SDK'S RETRIES, and the reason there is a
// hand-rolled retry here at all when loggingFetch above explains why there is
// not one for transport failures.
//
// The SDK retries the TRANSPORT: a 429, a 5xx, a dropped connection — requests
// that were never answered, where sending the same bytes again is the whole
// fix. It honours retry-after and backs off, and nothing here touches that.
//
// This retries the MODEL'S OUTPUT. Groq validates the tool call the model
// produced against the tool schema and rejects the request if it does not fit,
// which arrives as a 400: the request was fine, the sampled tokens were not.
// Two were measured in verification, both fatal to the turn:
//
//   parameters for tool search_memory did not match schema: errors:
//   [`/query`: expected string, but got null]
//   Failed to parse tool call arguments as JSON
//
// Nothing in the turn can correct either one, because no tool call reaches the
// harness: the user gets an apology and has to ask again. Both were sampling
// flukes rather than anything deterministic — the same request succeeded on
// the next run — so the same call is issued ONCE more and the model gets
// another sample. Permissive schemas (see OPTIONAL_STRING in the tool
// registry) are the first line and they remove the whole class where the
// deviation is predictable; this catches what is left.
//
// ONCE, and never more: a second rejection is a signal that something about
// the request is wrong rather than unlucky, and a loop of 400s burns the
// token budget to no purpose while the user waits.
const ARGUMENT_REJECTION = /did not match schema|failed to parse tool call arguments/i

export function isArgumentRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Our own deadline, and the raw-text tool call the session retries WITHOUT
  // tools, are both handled elsewhere and must not be re-sampled here.
  if (err instanceof LLMDeadlineError) return false
  const status = (err as { status?: unknown }).status
  // A rejection of the model's output is a 400. Anything with another status
  // belongs to the SDK's policy (429, 5xx) or to the caller (401, 404), and a
  // transport failure carries no status and no matching message.
  if (typeof status === "number" && status !== 400 && status !== 422) return false
  return ARGUMENT_REJECTION.test(err.message)
}

// Exported for the tests: the retry has to be provable without a network.
export async function withArgumentRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!isArgumentRejection(err)) throw err
    // One line per retry, naming what was rejected.
    console.log(
      `llm retrying once: the provider rejected the model's tool call ` +
        `(${err instanceof Error ? err.message : String(err)})`
    )
    return await run()
  }
}

// Races a promise against a deadline. Used per chunk, not per call: the point
// is to notice that the stream went quiet, which only a per-chunk deadline can
// see. Promise.race attaches handlers to both, so the loser rejecting later is
// never an unhandled rejection.
function withDeadline<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LLMDeadlineError(reason)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

export async function chat(
  messages: Message[],
  tools?: OpenAI.Chat.ChatCompletionTool[],
  options?: { silent?: boolean }
): Promise<LLMResponse> {
  return withArgumentRetry(() => attempt(messages, tools, options))
}

async function attempt(
  messages: Message[],
  tools?: OpenAI.Chat.ChatCompletionTool[],
  options?: { silent?: boolean }
): Promise<LLMResponse> {
  // One controller for the whole call. Aborting it reaches the SDK (which
  // checks the signal between retry attempts) and the underlying socket, so
  // neither a stalled connection nor a retry loop can outlive the ceiling.
  const controller = new AbortController()
  let abortReason: string | null = null
  const abortWith = (reason: string) => {
    abortReason ??= reason
    controller.abort()
  }

  const ceiling = setTimeout(
    () => abortWith(`call exceeded ${config.llm.requestTimeoutMs}ms`),
    config.llm.requestTimeoutMs
  )

  let textContent = ""
  const toolCallMap = new Map<number, ToolCall>()

  try {
    const stream = await client.chat.completions.create(
      {
        model: config.llm.model,
        messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? "auto" : undefined,
        temperature: 0.2,
        stream: true,
      },
      { signal: controller.signal, timeout: config.llm.requestTimeoutMs }
    )

    // Driven by hand rather than with `for await`, because the inactivity
    // deadline has to sit on each individual next() — a for-await loop gives
    // nowhere to put it.
    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      let next: IteratorResult<OpenAI.Chat.ChatCompletionChunk>
      try {
        next = await withDeadline(
          iterator.next(),
          config.llm.streamIdleTimeoutMs,
          `no chunk for ${config.llm.streamIdleTimeoutMs}ms (stream inactivity)`
        )
      } catch (err) {
        // Abort as well as throw: the race only stops us waiting, the abort is
        // what closes the socket and stops the server generating.
        if (err instanceof LLMDeadlineError) abortWith(err.message.replace(/^LLM call aborted: /, ""))
        throw err
      }
      if (next.done) break

      const delta = next.value.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        textContent += delta.content
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallMap.get(tc.index) ?? { id: "", name: "", arguments: "" }
          toolCallMap.set(tc.index, {
            id: existing.id || tc.id || "",
            name: existing.name || tc.function?.name || "",
            arguments: existing.arguments + (tc.function?.arguments ?? ""),
          })
        }
      }
    }
  } catch (err) {
    if (abortReason) {
      console.log(`llm aborted: ${abortReason}`)
      throw new LLMDeadlineError(abortReason)
    }
    throw err
  } finally {
    clearTimeout(ceiling)
  }

  if (toolCallMap.size > 0) {
    return {
      type: "tool_calls",
      calls: Array.from(toolCallMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc),
    }
  }

  // Groq/Llama sometimes outputs tool calls as raw text instead of via the API
  // mechanism. Detect and throw so the session can retry without tools.
  if (textContent.includes("<function")) {
    throw new Error("malformed tool call in text content")
  }

  if (!options?.silent) {
    process.stdout.write(`Ixa: ${textContent}\n\n`)
  }
  return { type: "text", content: textContent }
}
