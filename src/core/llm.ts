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

// Groq's answer to a forced tool_choice the model declines to honour. It is a
// 400, not a reply: the request fails outright rather than degrading to text.
// Measured against api.groq.com with openai/gpt-oss-20b — a forced web_search
// on a conversation that had already searched and had the answer in context
// came back "400 Tool choice is required, but model did not call a tool".
//
// Exported because the caller that forces a tool is the only thing that can
// decide what to do instead, and it should not be matching on a message
// fragment of its own.
export function isToolChoiceRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.toLowerCase().includes("tool choice is required")
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
  // `forceTool` names a tool the model MUST call on this one request, which
  // is a stronger thing than asking for it in the prompt — see the price
  // guard in Session. It only means anything alongside a non-empty `tools`.
  options?: { silent?: boolean; forceTool?: string }
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
        tool_choice: !tools?.length
          ? undefined
          : options?.forceTool
            ? { type: "function", function: { name: options.forceTool } }
            : "auto",
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
