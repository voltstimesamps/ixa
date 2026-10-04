import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { PassThrough } from "node:stream"
import type { AddressInfo } from "node:net"
import { SessionManager } from "../src/core/session-manager"
import { createRestServer } from "../src/api/rest"
import { runHarness } from "../src/core/harness"
import type { ChatFn } from "../src/core/session"
import { TEST_LIMITS } from "./helpers"

// The other two transports. The WebSocket has to speak an apology and hold
// the socket open; REST just answers with an error, and the REPL prints one
// and carries on taking input. All three must leave the session usable.

let chatBehaviour: ChatFn = async () => ({ type: "text", content: "ok" })
let server: Awaited<ReturnType<typeof createRestServer>>
let port: number

before(async () => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: (...args) => chatBehaviour(...args),
  })
  server = await createRestServer(port, sessions)
})

after(() => {
  server?.close()
})

test("REST answers a failed turn with an error response and stays up", async () => {
  chatBehaviour = async () => {
    throw new Error("LLM call aborted: no chunk for 15000ms (stream inactivity)")
  }

  const failed = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "what is the weather" }),
  })

  assert.equal(failed.status, 500)
  const body = (await failed.json()) as { error?: string }
  assert.match(String(body.error), /stream inactivity/)

  // The server and the session both survive it.
  chatBehaviour = async () => ({ type: "text", content: "it is sunny" })
  const next = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "try again" }),
  })
  assert.equal(next.status, 200)
  assert.deepEqual(await next.json(), { response: "it is sunny" })
})

test("the REPL prints the error and keeps taking input", async () => {
  // runHarness reads process.stdin through the shared readline interface in
  // confirmation.ts, which is built lazily on first use — so swapping stdin
  // before the harness starts is enough to drive it.
  const stdin = new PassThrough()
  const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true })

  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "))
  }
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write

  const turns: string[] = []
  chatBehaviour = async (messages) => {
    const last = [...messages].reverse().find((m) => m.role === "user")
    const text = String(last?.content ?? "")
    turns.push(text)
    if (text === "first") throw new Error("LLM call aborted: call exceeded 120000ms")
    return { type: "text", content: "second worked" }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: (...args) => chatBehaviour(...args),
  })

  const harness = runHarness(sessions)
  stdin.write("first\n")
  stdin.write("second\n")
  stdin.end()
  await harness

  process.stdout.write = realWrite
  console.error = realError
  Object.defineProperty(process, "stdin", realStdin)

  // Both lines were taken: the failure did not stop the loop.
  assert.deepEqual(turns, ["first", "second"])
  assert.ok(
    errors.some((line) => /call exceeded 120000ms/.test(line)),
    `the error was not printed: ${JSON.stringify(errors)}`
  )
  // And the second turn's reply is in the session history.
  assert.ok(
    sessions
      .primarySession()
      .history()
      .some((m) => m.role === "assistant" && m.content === "second worked")
  )
})
