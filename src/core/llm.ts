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

  rememberRateLimit(response.headers)
  return response
}

// ------------------------------------------------------- the rate-limit view
//
// Groq stamps the remaining per-minute allowance on every response, and the
// only code that sees a response header is the fetch wrapper above. Nothing in
// production reads this: it exists so a MEASUREMENT RUN can pause before it
// earns a 429, which is the difference between a table with a hole in it and
// one that took six minutes longer.
//
// Deliberately a snapshot of the last call rather than a running estimate. The
// numbers are the provider's own and they refill on their own schedule; a
// local model of that schedule would be a second source of truth that drifts.
export type RateLimit = {
  // Requests and tokens the current minute has left, as the provider reports
  // them. Null when the header was absent — a local or non-Groq backend.
  remainingTokens: number | null
  limitTokens: number | null
  remainingRequests: number | null
  // The provider's own reset hint, verbatim ("7.66s"), because it is a string
  // in a format nobody here should be parsing.
  resetTokens: string | null
  at: number
}

let lastRateLimit: RateLimit | null = null

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function rememberRateLimit(headers: Headers): void {
  const remainingTokens = headerNumber(headers, "x-ratelimit-remaining-tokens")
  const remainingRequests = headerNumber(headers, "x-ratelimit-remaining-requests")
  // Nothing at all means this backend does not report limits; keeping the
  // previous snapshot would be worse than having none.
  if (remainingTokens === null && remainingRequests === null) return
  lastRateLimit = {
    remainingTokens,
    limitTokens: headerNumber(headers, "x-ratelimit-limit-tokens"),
    remainingRequests,
    resetTokens: headers.get("x-ratelimit-reset-tokens"),
    at: Date.now(),
  }
}

export function rateLimit(): RateLimit | null {
  return lastRateLimit
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

// What one call spent. Every field is diagnostic: nothing in the tool loop
// branches on any of them, they are logged and reported and nothing more.
//
// The reason they exist is ONE question. A live turn came back with
// `finish_reason=length`, reasoning deltas, and zero characters of content —
// the provider had cut the reply off, and nothing anywhere could say whether
// it had spent two hundred tokens or sixty-five thousand getting there. The
// answer decides whether the fix is a completion cap, a cheaper reasoning
// effort, or the prompt, and it cannot be guessed from the text.
//
// `promptTokens` / `completionTokens` / `reasoningTokens` are the PROVIDER's
// count and arrive on the final stream chunk, which is only sent because the
// request asks for it (`stream_options.include_usage`). They are null when it
// did not arrive — an aborted stream never reaches that chunk, and a local
// backend may not send one at all.
//
// `reasoningChars` and `elapsedMs` are counted HERE, because they are the two
// things the provider cannot report and they were already in hand: the
// reasoning deltas stream past this code either way, and a length cut that
// takes thirty seconds is a different problem from one that takes three.
export type CallCost = {
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  reasoningChars: number
  elapsedMs: number
}

// `finishReason` and `reasoning` answer the same question CallCost does, and
// predate it. All three fields are optional because every test that builds a
// reply by hand predates all of them, and nothing branches on any of them.
export type LLMResponse =
  | {
      type: "text"
      content: string
      finishReason?: string | null
      reasoning?: boolean
      cost?: CallCost
    }
  | { type: "tool_calls"; calls: ToolCall[]; cost?: CallCost }

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

// A THIRD rejection of the model's output, and the one with no retry of its
// own here, because fixing it needs the conversation and this layer does not
// have it.
//
// Every path that passes no tools — the malformed-tool-call retry, the
// unparseable-arguments retry, the empty-reply retry and the tool-budget
// wind-up — sends `tools: undefined`, and Groq reads a request with no tools
// as `tool_choice: "none"`. If the model emits a tool call anyway, the request
// is rejected before anything runs:
//
//   Tool choice is none, but model called a tool
//
// Measured live, and fatal: it matched neither isArgumentRejection above nor
// the malformed-tool-call patterns in the session, so it propagated out of the
// tool loop and the turn died in the apology on the very call that was meant
// to produce the answer. Re-issuing the same request would get the same
// rejection, so the session handles it by changing the REQUEST — a firm
// instruction not to call a tool — and then falls back. See
// NO_TOOL_CALL_CORRECTION in session.ts.
const TOOL_CHOICE_REJECTION = /tool choice is none|tool_choice is none|but model called a tool/i

export function isToolChoiceRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof LLMDeadlineError) return false
  return TOOL_CHOICE_REJECTION.test(err.message)
}

// A FOURTH rejection of the model's output, and the one that reads least like
// one. Groq, on openai/gpt-oss-*, returns a 400 when it cannot parse the
// model's harmony output into tool calls at all:
//
//   Parsing failed. The model generated output that could not be parsed.
//   Please adjust your prompt or try again. See 'failed_generation' for
//   the raw output.
//
// Measured live: it ended a turn that had already made seven tool calls. It
// was not unhandled — the session's malformed-tool-call list matches the words
// "parsing failed", so the turn DID retry — but that retry drops the tools,
// which is the wrong lever for a sampling fluke, and when the second attempt
// failed the same way there was nothing behind it and the turn died.
//
// Distinguished from isArgumentRejection by the shape of the complaint: that
// one is a tool call the provider could read and reject against a schema, this
// one is output it could not read at all, and the remedy is another sample of
// the SAME request. Both phrases are required, so an unrelated 400 — a bad
// parameter, a context-length error — does not match.
const PARSING_FAILURE = /parsing failed/i
const FAILED_GENERATION = /failed_generation/i

export function isParsingFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof LLMDeadlineError) return false
  // A schema rejection is a different 400 and has already had its one retry
  // inside withArgumentRetry below; it must not get a second one here.
  if (isArgumentRejection(err)) return false
  return PARSING_FAILURE.test(err.message) && FAILED_GENERATION.test(err.message)
}

// How much of the raw generation goes in the log. Enough to tell a malformed
// tool call from harmony control tokens from ordinary prose, not so much that
// one bad turn fills the terminal.
const FAILED_GENERATION_LOG_CHARS = 300

// The raw output the provider could not parse, if it sent it.
//
// The SDK puts the response body's `error` object on `err.error`, so Groq's
// `failed_generation` lands there beside `message` and `code`. Nothing else in
// the codebase reads it, and nothing branches on it: this exists only so the
// NEXT occurrence is diagnosable. When this failure was first seen, the whole
// record of it was 80 characters of truncated message in a history row, which
// said nothing about what the model had actually produced.
export function failedGeneration(err: unknown): string | null {
  const body = (err as { error?: { failed_generation?: unknown } }).error
  const raw = body?.failed_generation
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

export function logFailedGeneration(err: unknown): void {
  const raw = failedGeneration(err)
  if (!raw) {
    console.log("llm parsing failure: the provider sent no failed_generation to show")
    return
  }
  const shown =
    raw.length > FAILED_GENERATION_LOG_CHARS
      ? `${raw.slice(0, FAILED_GENERATION_LOG_CHARS)}… (${raw.length} chars)`
      : raw
  // Newlines flattened: harmony output is full of them and a log line that
  // wraps forty times is a log nobody reads.
  console.log(`llm parsing failure, failed_generation: ${shown.replace(/\s*\n\s*/g, " ⏎ ")}`)
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

// Per-call overrides for the two request parameters that bound a completion.
//
// MEASURED BEFORE EITHER WAS SET, by `voice-behavior-verify.ts length`, which
// ran one case under four combinations of them. What it found is in
// ARCHITECTURE.md and the short version is that the provider's documented
// 65,536-token completion for `openai/gpt-oss-20b` is NOT what this request
// gets: every truncated reply was cut at exactly 2048, so `4096` raises the
// ceiling rather than bounding a runaway, and `reasoning_effort: low` is what
// actually removed the truncation.
//
// WHO PASSES THEM: the turn layer, and only the turn layer — `turnCallOptions`
// in session.ts, from `config.llm`, chosen by whether the turn came from
// voice or from text. Everything else (the episode summarizer, and any
// caller that is not answering a person) passes nothing and gets the
// provider's defaults, which is what every call did before this existed.
//
// An unset field means "send nothing and let the provider decide". That is
// not the same as sending the provider's default value, and it is what both
// `IXA_MAX_COMPLETION_TOKENS=0` and an empty `IXA_VOICE_REASONING_EFFORT` do.
export type CallOverrides = {
  reasoningEffort?: "low" | "medium" | "high"
  maxCompletionTokens?: number
}

export type ChatOptions = { silent?: boolean } & CallOverrides

export async function chat(
  messages: Message[],
  tools?: OpenAI.Chat.ChatCompletionTool[],
  options?: ChatOptions
): Promise<LLMResponse> {
  return withArgumentRetry(() => attempt(messages, tools, options))
}

async function attempt(
  messages: Message[],
  tools?: OpenAI.Chat.ChatCompletionTool[],
  options?: ChatOptions
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

  // Why these are tracked at all: a live turn ended with no content and no
  // error, and nothing logged could say whether the model stopped, was cut
  // off, or spent the whole completion on a channel this code never reads.
  //
  // `reasoning` is NOT in the OpenAI schema — it is what Groq returns for
  // openai/gpt-oss-* under its parsed reasoning format, so the SDK does not
  // type it and it has to be read off the delta by hand. A reply whose
  // reasoning arrived and whose content did not is a different fault from one
  // where neither did, and only this tells them apart.
  let finishReason: string | null = null
  let reasoning = false
  // Chars of reasoning delta, and the clock. Both free: the deltas stream past
  // here either way, and a length cut's duration is the cheapest way to tell a
  // model that reasoned for thirty seconds from one that stopped at once.
  let reasoningChars = 0
  const startedAt = Date.now()
  let usage: OpenAI.Completions.CompletionUsage | null = null

  try {
    const stream = await client.chat.completions.create(
      {
        model: config.llm.model,
        messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? "auto" : undefined,
        temperature: 0.2,
        stream: true,
        // The only reason the token counts exist. Without it a streamed
        // response carries no usage at all, so a length cut could not say how
        // much it had spent. It adds ONE extra chunk at the end of the stream
        // and changes nothing the model sees.
        stream_options: { include_usage: true },
        // Omitted unless a caller asks, so the wire request is byte for byte
        // what it was. See CallOverrides.
        ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(options?.maxCompletionTokens
          ? { max_completion_tokens: options.maxCompletionTokens }
          : {}),
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

      // Read before the delta guard: the chunk that carries finish_reason
      // often carries an empty delta, and that is the one chunk worth reading.
      finishReason = next.value.choices[0]?.finish_reason ?? finishReason

      // The usage chunk is the LAST one and it has no choices at all, so it
      // would be dropped by the delta guard below. Groq has also carried usage
      // under `x_groq` on this endpoint, before `stream_options` existed;
      // both are read because which one arrives is the provider's business and
      // a missing count would read as "the call spent nothing".
      usage =
        next.value.usage ??
        (next.value as { x_groq?: { usage?: OpenAI.Completions.CompletionUsage } }).x_groq?.usage ??
        usage

      const delta = next.value.choices[0]?.delta
      if (!delta) continue

      const reasoningDelta = (delta as { reasoning?: unknown }).reasoning
      if (reasoningDelta) {
        reasoning = true
        if (typeof reasoningDelta === "string") reasoningChars += reasoningDelta.length
      }

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

  const cost: CallCost = {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    reasoningChars,
    elapsedMs: Date.now() - startedAt,
  }

  // Only the endings nobody can currently see. "stop" is an ordinary reply and
  // a line per turn saying so is noise; "length" is a reply the provider cut
  // off mid-sentence, which has never been visible here and is
  // indistinguishable from a short answer by reading the text.
  //
  // Logged BEFORE the tool-call return, not after it as it used to be, so a
  // length cut that lands in the middle of a tool call says so too — that
  // shape was invisible, and it is the one where the turn has work on the
  // floor. The empty-content case also gets a line from the tool loop, which
  // can say how much conversation the call carried: see the empty-reply
  // warning in session.ts.
  if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
    console.log(
      `llm finish_reason=${finishReason} (${textContent.length} chars of content, ` +
        `${toolCallMap.size} tool call${toolCallMap.size === 1 ? "" : "s"}, ${describeCost(cost)})`
    )
  }

  if (toolCallMap.size > 0) {
    return {
      type: "tool_calls",
      cost,
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
  return { type: "text", content: textContent, finishReason, reasoning, cost }
}

// One phrase for every log line that reports what a call spent, so the fields
// are named the same way wherever they appear. A count the provider did not
// send reads as "unknown" rather than as 0, which is a different claim.
export function describeCost(cost: CallCost | undefined): string {
  if (!cost) return "cost unknown"
  const token = (value: number | null): string => (value === null ? "unknown" : String(value))
  return (
    `completion_tokens=${token(cost.completionTokens)}, ` +
    `reasoning_tokens=${token(cost.reasoningTokens)}, ` +
    `reasoning_chars=${cost.reasoningChars}, ` +
    `${cost.elapsedMs}ms`
  )
}
