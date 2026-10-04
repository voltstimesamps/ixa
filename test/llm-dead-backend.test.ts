import { test, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"

// LLM_BASE_URL pointed at a port nothing is listening on.
//
// Its own file because config.ts reads the environment once, at import time,
// and this needs a different LLM_BASE_URL from the stub-server tests. Node's
// test runner gives each file its own process.

let llm: typeof import("../src/core/llm")

before(async () => {
  // Bind a port, learn its number, then give it back. Nothing is listening on
  // it afterwards, so connecting is refused at once.
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const deadPort = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  process.env.LLM_API_KEY = "test-key"
  process.env.LLM_MODEL = "stub-model"
  process.env.LLM_BASE_URL = `http://127.0.0.1:${deadPort}/v1`
  process.env.LLM_MAX_RETRIES = "1"
  process.env.LLM_REQUEST_TIMEOUT_MS = "5000"
  process.env.LLM_STREAM_IDLE_TIMEOUT_MS = "5000"

  llm = await import("../src/core/llm.js")
})

test("a dead backend fails fast, and every attempt is logged", async () => {
  const logs: string[] = []
  const realLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }

  const startedAt = Date.now()
  let error: unknown
  try {
    await llm.chat([{ role: "user", content: "hi" }], [], { silent: true })
  } catch (err) {
    error = err
  } finally {
    console.log = realLog
  }
  const elapsed = Date.now() - startedAt

  assert.ok(error, "expected the call to fail")
  // Connection refused is immediate; with one retry and the SDK's ~0.5s
  // backoff this must land well inside the 5000ms ceiling.
  assert.ok(elapsed < 4000, `took ${elapsed}ms — a refused connection should not wait`)

  const attempts = logs.filter((line) => /^llm attempt \d+\/2 failed: /.test(line))
  assert.equal(
    attempts.length,
    2,
    `expected one log line per attempt, got ${JSON.stringify(logs)}`
  )
})
