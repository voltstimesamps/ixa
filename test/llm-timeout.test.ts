import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { Socket } from "node:net"
import type { AddressInfo } from "node:net"

// LLM transport resilience: the two deadlines and the per-attempt log line.
//
// Everything runs against a local stub server, never Groq — the point is to
// reproduce failures on demand, and a real provider cannot be asked to stall.
// config.ts reads process.env at import time, so the environment is set in
// `before` and src/core/llm is pulled in dynamically after it. Node's test
// runner gives each test FILE its own process, so this cannot leak sideways.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

let handler: Handler = (_req, res) => res.end()
const sockets = new Set<Socket>()
const server = http.createServer((req, res) => handler(req, res))
server.on("connection", (socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
})

let llm: typeof import("../src/core/llm")

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  process.env.LLM_API_KEY = "test-key"
  process.env.LLM_MODEL = "stub-model"
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.LLM_MAX_RETRIES = "1"
  process.env.LLM_REQUEST_TIMEOUT_MS = "2000"
  process.env.LLM_STREAM_IDLE_TIMEOUT_MS = "400"

  llm = await import("../src/core/llm.js")
})

after(() => {
  for (const socket of sockets) socket.destroy()
  server.close()
})

function chunkFrame(content: string): string {
  return (
    "data: " +
    JSON.stringify({
      id: "stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }) +
    "\n\n"
  )
}

function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
}

// Captures console.log for one call: the log lines are themselves part of
// what this phase delivers, so they get asserted on like any other output.
export async function capturingLogs<T>(
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

test("a completed stream still returns normally", async () => {
  handler = (_req, res) => {
    sseHead(res)
    res.write(chunkFrame("Hello"))
    res.write(chunkFrame(" there"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const response = await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  assert.equal(response.type, "text")
  assert.equal(response.type === "text" && response.content, "Hello there")
})

test("a stream that stalls after one chunk hits the inactivity deadline", async () => {
  handler = (_req, res) => {
    sseHead(res)
    res.write(chunkFrame("Hel"))
    // Then nothing, ever: headers and one chunk, socket held open, response
    // never ended. This is the hang the SDK's own timeout cannot see, because
    // it is cleared the moment the headers arrive.
  }

  const startedAt = Date.now()
  const { error, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  )
  const elapsed = Date.now() - startedAt

  assert.ok(
    error instanceof llm.LLMDeadlineError,
    `expected LLMDeadlineError, got ${String(error)}`
  )
  assert.match((error as Error).message, /no chunk for 400ms \(stream inactivity\)/)
  // The inactivity deadline, not the 2000ms ceiling.
  assert.ok(elapsed < 1500, `took ${elapsed}ms, so the ceiling fired instead`)
  assert.ok(
    logs.some((line) => /^llm aborted: no chunk for 400ms/.test(line)),
    `no abort log line in ${JSON.stringify(logs)}`
  )
})

test("a response that never arrives hits the request ceiling", async () => {
  // Headers are never written, so the inactivity deadline never starts and
  // only the ceiling can end this.
  handler = () => {}

  const startedAt = Date.now()
  const { error, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  )
  const elapsed = Date.now() - startedAt

  assert.ok(
    error instanceof llm.LLMDeadlineError,
    `expected LLMDeadlineError, got ${String(error)}`
  )
  assert.match((error as Error).message, /call exceeded 2000ms/)
  assert.ok(elapsed >= 1900 && elapsed < 5000, `took ${elapsed}ms`)
  assert.ok(
    logs.some((line) => /^llm aborted: call exceeded 2000ms/.test(line)),
    `no abort log line in ${JSON.stringify(logs)}`
  )
})

test("a retryable status is retried, and the failed attempt is logged", async () => {
  let attempts = 0
  handler = (_req, res) => {
    attempts++
    if (attempts === 1) {
      res.writeHead(429, { "retry-after-ms": "10", "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "slow down" } }))
      return
    }
    sseHead(res)
    res.write(chunkFrame("ok"))
    res.write("data: [DONE]\n\n")
    res.end()
  }

  const { result, error, logs } = await capturingLogs(() =>
    llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  )

  assert.equal(error, undefined, `unexpected error: ${String(error)}`)
  assert.equal(attempts, 2, "the 429 should have been retried exactly once")
  assert.equal(result?.type === "text" && result.content, "ok")
  assert.ok(
    logs.includes("llm attempt 1/2 failed: status=429 retry-after=10"),
    `no retry log line in ${JSON.stringify(logs)}`
  )
})
