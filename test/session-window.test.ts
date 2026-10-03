import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import type { ChatFn } from "../src/core/session"
import type { Message } from "../src/core/llm"
import { makeConnection } from "./helpers"

// Requirement 6 end to end: a long history is stored whole but sent clipped.
test("a long history sends only recent messages while storing everything", async () => {
  const sentArrays: Message[][] = []
  const chat: ChatFn = async (messages) => {
    sentArrays.push(messages)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
  }

  // Tiny budget: 1 system prompt + 4 conversational messages.
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: { maxMessages: 5, budgetChars: 1_000_000 },
    chat,
  })
  const connection = makeConnection({ id: "conn-window" })

  for (let i = 0; i < 10; i++) {
    await sessions.submitTurn(`turn ${i}`, connection, "text")
  }

  const session = sessions.primarySession()
  const history = session.history()

  // Stored: system + 10 × (user, assistant).
  assert.equal(history.length, 21, "stored history keeps every turn")
  assert.ok(history.some((m) => m.content === "turn 0"), "the oldest turn is still stored")

  const lastSent = sentArrays.at(-1)!
  assert.equal(lastSent.length, 5, "the request is capped at the configured budget")
  assert.equal(lastSent[0]!.role, "system")
  assert.deepEqual(
    lastSent.slice(1).map((m) => m.content),
    ["heard: turn 7", "turn 8", "heard: turn 8", "turn 9"],
    "only the most recent messages are sent",
  )
  assert.equal(
    lastSent.some((m) => m.content === "turn 0"),
    false,
    "old history is not sent",
  )

  sessions.shutdown()
})

test("the voice constraint survives windowing", async () => {
  const sentArrays: Message[][] = []
  const chat: ChatFn = async (messages) => {
    sentArrays.push(messages)
    return { type: "text", content: "spoken reply" }
  }

  // A budget so small that only the leading system prompt survives the walk.
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: { maxMessages: 1, budgetChars: 1 },
    chat,
  })
  const connection = makeConnection({ id: "conn-voice" })

  await sessions.submitTurn("hello there", connection, "voice")

  const sent = sentArrays.at(-1)!
  const last = sent.at(-1)!
  assert.equal(last.role, "system")
  assert.match(
    String(last.content),
    /spoken aloud/i,
    "the voice-only instruction is appended after windowing, so it can never be clipped",
  )

  sessions.shutdown()
})
