import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { Socket } from "node:net"
import type { AddressInfo } from "node:net"

// What a call SPENT, and the promise that asking for it changes nothing.
//
// A live voice turn came back with `finish_reason=length`, reasoning deltas
// and zero characters of content — the provider cut the reply off — and
// nothing anywhere could say whether it had spent two hundred completion
// tokens or sixty-five thousand. That decides whether the fix is a completion
// cap, a cheaper reasoning effort or the prompt, so the counts are now read
// off the stream and logged.
//
// The second half of the file is the more important half: this is
// instrumentation, so the REQUEST the model sees must be byte for byte what it
// was. `stream_options` is asserted present and every parameter that would
// change the model's behaviour is asserted ABSENT unless a caller asked for
// it. Same local-stub discipline as llm-timeout.test.ts: never Groq, and
// config.ts reads the environment at import time so llm is imported in
// `before`.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

let handler: Handler = (_req, res) => res.end()
const sockets = new Set<Socket>()
const server = http.createServer((req, res) => handler(req, res))
server.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
})

// The parsed body of the last request the stub received, so a test can assert
// on what actually went over the wire rather than on what was passed in.
let lastBody: Record<string, unknown> = {}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

let llm: typeof import("../src/core/llm")

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  process.env.LLM_API_KEY = "test-key"
  process.env.LLM_MODEL = "stub-model"
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.LLM_MAX_RETRIES = "0"
  process.env.LLM_REQUEST_TIMEOUT_MS = "4000"
  process.env.LLM_STREAM_IDLE_TIMEOUT_MS = "2000"

  llm = await import("../src/core/llm.js")
})

after(() => {
  for (const socket of sockets) socket.destroy()
  server.close()
})

function sseHead(res: http.ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...headers,
  })
}

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: "stub-model", ...payload })}\n\n`
}

function contentFrame(content: string): string {
  return frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
}

// Groq's parsed reasoning format: a `reasoning` string on the delta, which is
// not in the OpenAI schema and so is read off by hand.
function reasoningFrame(reasoning: string): string {
  return frame({ choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] })
}

function finishFrame(reason: string): string {
  return frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
}

// The chunk `stream_options: { include_usage: true }` buys: last in the
// stream, and with NO choices at all, which is why the delta guard in the
// chunk loop cannot be the thing that reads it.
function usageFrame(usage: Record<string, unknown>): string {
  return frame({ choices: [], usage })
}

// Captures console.log for one call. The log lines are part of what this
// change delivers, so they are asserted on like any other output.
async function capturingLogs<T>(
  fn: () => Promise<T>
): Promise<{ result?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = []
  const realLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }
  try {
    return { result: await fn(), logs }
  } catch (error) {
    return { error, logs }
  } finally {
    console.log = realLog
  }
}

// --------------------------------------------------------------- the counts

test("a length cut reports what the completion spent, and says so in the log", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(reasoningFrame("thinking".repeat(10)))
    res.write(reasoningFrame("harder"))
    // The shape under test: reasoning arrived, content did not, and the
    // provider cut it off.
    res.write(finishFrame("length"))
    res.write(
      usageFrame({
        prompt_tokens: 1200,
        completion_tokens: 65536,
        total_tokens: 66736,
        completion_tokens_details: { reasoning_tokens: 65500 },
      })
    )
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const { result, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "write a long note" }], [], { silent: true })
  )

  assert.equal(result?.type, "text")
  assert.equal(result?.type === "text" && result.content, "", "the content really was empty")
  assert.equal(result?.type === "text" && result.finishReason, "length")
  assert.equal(result?.type === "text" && result.reasoning, true)

  const cost = result?.cost
  assert.ok(cost, "a reply carries what it cost")
  assert.equal(cost.promptTokens, 1200)
  assert.equal(cost.completionTokens, 65536)
  assert.equal(cost.reasoningTokens, 65500)
  // Counted here, not reported by the provider: 10 * "thinking" + "harder".
  assert.equal(cost.reasoningChars, 86)
  assert.ok(cost.elapsedMs >= 0 && cost.elapsedMs < 4000, `elapsedMs was ${cost.elapsedMs}`)

  const line = logs.find((entry) => entry.startsWith("llm finish_reason=length"))
  assert.ok(line, `no finish_reason line in ${JSON.stringify(logs)}`)
  assert.match(line, /0 chars of content/)
  assert.match(line, /0 tool calls/)
  assert.match(line, /completion_tokens=65536/)
  assert.match(line, /reasoning_tokens=65500/)
  assert.match(line, /reasoning_chars=86/)
  assert.match(line, /\d+ms\)$/)
})

// An ordinary reply still carries the counts — they are what makes a length
// cut comparable to a call that finished.
test("an ordinary reply carries the counts and logs no finish_reason line", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("About eight hundred dollars."))
    res.write(finishFrame("stop"))
    res.write(usageFrame({ prompt_tokens: 900, completion_tokens: 42, total_tokens: 942 }))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const { result, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "how much" }], [], { silent: true })
  )

  assert.equal(result?.cost?.completionTokens, 42)
  // Absent from the response, so unknown rather than zero: a provider that
  // reports no breakdown has not said the model reasoned for nothing.
  assert.equal(result?.cost?.reasoningTokens, null)
  assert.equal(result?.cost?.reasoningChars, 0)
  assert.ok(
    !logs.some((entry) => entry.startsWith("llm finish_reason=")),
    `"stop" is an ordinary ending and gets no line: ${JSON.stringify(logs)}`
  )
})

// The one shape that used to be invisible: the cut landed in the middle of a
// tool call, so the old log line — written after the tool-call return — was
// never reached. That is the case where the turn has work on the floor.
test("a length cut in the middle of a tool call is logged too", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "save_note", arguments: '{"title":"' } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    )
    res.write(finishFrame("length"))
    res.write(usageFrame({ prompt_tokens: 500, completion_tokens: 8000, total_tokens: 8500 }))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const { result, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "write a note" }], [], { silent: true })
  )

  assert.equal(result?.type, "tool_calls")
  assert.equal(result?.cost?.completionTokens, 8000)
  const line = logs.find((entry) => entry.startsWith("llm finish_reason=length"))
  assert.ok(line, `no finish_reason line in ${JSON.stringify(logs)}`)
  assert.match(line, /1 tool call,/)
})

// Groq carried usage under `x_groq` on this endpoint before `stream_options`
// existed. Which one arrives is the provider's business; a missing count would
// read as "the call spent nothing", which is a different claim from "unknown".
test("usage under x_groq is read as well", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("ok"))
    res.write(finishFrame("stop"))
    res.write(
      frame({
        choices: [],
        x_groq: { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
      })
    )
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const response = await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  assert.equal(response.cost?.completionTokens, 20)
})

// A stream that never reaches its usage chunk reports unknown, not zero.
test("a reply with no usage chunk reports unknown counts", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("ok"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const response = await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  assert.equal(response.cost?.completionTokens, null)
  assert.equal(response.cost?.promptTokens, null)
  assert.match(llm.describeCost(response.cost), /completion_tokens=unknown/)
  assert.equal(llm.describeCost(undefined), "cost unknown")
})

// ------------------------------------------------- nothing the model sees

test("the request asks for usage and changes nothing else", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("ok"))
    res.write(finishFrame("stop"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const messages = [
    { role: "system" as const, content: "you are Ixa" },
    { role: "user" as const, content: "what time is it" },
  ]
  const tools = [
    {
      type: "function" as const,
      function: { name: "get_time", description: "the time", parameters: { type: "object" } },
    },
  ]
  await llm.chat(messages, tools, { silent: true })

  assert.deepEqual(lastBody.stream_options, { include_usage: true })

  // What the model actually reads, unchanged and in order.
  assert.deepEqual(lastBody.messages, messages)
  assert.deepEqual(lastBody.tools, tools)
  assert.equal(lastBody.tool_choice, "auto")
  assert.equal(lastBody.temperature, 0.2)
  assert.equal(lastBody.model, "stub-model")
  assert.equal(lastBody.stream, true)

  // Every parameter that would change what the model does, absent — not
  // null, not a default this file chose: ABSENT, so the provider's own
  // defaults still apply. This is the whole promise of the instrumentation
  // commit, and the measurement is what decides whether any of them ships.
  for (const key of ["max_completion_tokens", "max_tokens", "reasoning_effort"]) {
    assert.ok(!(key in lastBody), `${key} must not be sent: ${JSON.stringify(lastBody[key])}`)
  }

  // And nothing beyond the parameters the call has always sent.
  assert.deepEqual(
    Object.keys(lastBody).sort(),
    ["messages", "model", "stream", "stream_options", "temperature", "tool_choice", "tools"],
    `unexpected request keys: ${Object.keys(lastBody).join(", ")}`
  )
})

test("an override reaches the wire only when a caller passes one", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("ok"))
    res.write(finishFrame("stop"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  await llm.chat([{ role: "user", content: "hi" }], [], {
    silent: true,
    reasoningEffort: "low",
    maxCompletionTokens: 4096,
  })
  assert.equal(lastBody.reasoning_effort, "low")
  assert.equal(lastBody.max_completion_tokens, 4096)

  // And the very next call, with no overrides, is clean again — the fields
  // are per call, not sticky state on the client.
  await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  assert.ok(!("reasoning_effort" in lastBody))
  assert.ok(!("max_completion_tokens" in lastBody))
})

// ------------------------------------------------------------- rate limits

test("the provider's remaining per-minute allowance is readable", async () => {
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res, {
      "x-ratelimit-limit-tokens": "8000",
      "x-ratelimit-remaining-tokens": "1234",
      "x-ratelimit-remaining-requests": "99",
      "x-ratelimit-reset-tokens": "7.66s",
    })
    res.write(contentFrame("ok"))
    res.write(finishFrame("stop"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  const seen = llm.rateLimit()
  assert.ok(seen, "the headers were on the response, so they are in hand")
  assert.equal(seen.remainingTokens, 1234)
  assert.equal(seen.limitTokens, 8000)
  assert.equal(seen.remainingRequests, 99)
  assert.equal(seen.resetTokens, "7.66s")

  // A backend that reports no limits at all leaves the previous snapshot
  // alone rather than claiming the allowance is unknown-and-therefore-zero.
  handler = async (req, res) => {
    lastBody = await readBody(req)
    sseHead(res)
    res.write(contentFrame("ok"))
    res.write(finishFrame("stop"))
    res.write("data: [DONE]\n\n")
    res.end()
  }
  await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  assert.equal(llm.rateLimit()?.remainingTokens, 1234)
})
