import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { openDatabase } from "../src/memory/db"
import { PreferenceStore } from "../src/memory/preferences"
import type { ChatFn } from "../src/core/session"
import type { Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// Captures exactly what each LLM call carried.
function recordingChat(sent: Message[][]): ChatFn {
  return async (messages) => {
    sent.push(messages)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
  }
}

function setup(options: { limits?: typeof TEST_LIMITS; prefLimits?: { maxInjected: number; maxChars: number } } = {}) {
  const store = new PreferenceStore(
    openDatabase(":memory:"),
    options.prefLimits ?? { maxInjected: 40, maxChars: 2000 },
  )
  const sent: Message[][] = []
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: options.limits ?? TEST_LIMITS,
    chat: recordingChat(sent),
    preferenceBlock: () => store.injectionBlock(),
  })
  return { store, sent, sessions, connection: makeConnection({ id: "conn-prefs" }) }
}

test("preferences sit between the system prompt and the history", async () => {
  const { store, sent, sessions, connection } = setup()
  store.remember({ topic: "coffee", value: "black, no sugar", category: "food" })

  await sessions.submitTurn("what should I order?", connection, "text")

  const messages = sent.at(-1)!
  assert.equal(messages[0]!.role, "system")
  assert.match(String(messages[0]!.content), /You are Ixa/, "the system prompt comes first")

  assert.equal(messages[1]!.role, "system")
  assert.match(String(messages[1]!.content), /saved preferences/, "then the preferences block")
  assert.match(String(messages[1]!.content), /- \[food\] coffee: black, no sugar/)

  assert.equal(messages[2]!.role, "user", "then the history")
  assert.equal(messages[2]!.content, "what should I order?")
  assert.equal(messages.length, 3)

  sessions.shutdown()
})

test("on a voice turn the order is system, preferences, history, voice constraint", async () => {
  const { store, sent, sessions, connection } = setup()
  store.remember({ topic: "coffee", value: "black" })

  await sessions.submitTurn("what should I order?", connection, "voice")

  const messages = sent.at(-1)!
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "system", "user", "system"],
  )
  assert.match(String(messages[0]!.content), /You are Ixa/)
  assert.match(String(messages[1]!.content), /saved preferences/)
  assert.match(String(messages.at(-1)!.content), /spoken aloud by a/, "the voice constraint is last")

  sessions.shutdown()
})

test("nothing is injected when no preference is active", async () => {
  const { store, sent, sessions, connection } = setup()
  store.remember({ topic: "coffee", value: "black" })
  store.forget("coffee")

  await sessions.submitTurn("hello", connection, "text")

  const messages = sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"], "no empty block is added")

  sessions.shutdown()
})

test("the block is never written to session history", async () => {
  const { store, sessions, connection } = setup()
  store.remember({ topic: "coffee", value: "black" })

  await sessions.submitTurn("hello", connection, "text")

  const history = sessions.primarySession().history()
  assert.deepEqual(history.map((m) => m.role), ["system", "user", "assistant"])
  assert.equal(
    history.some((m) => String(m.content).includes("saved preferences")),
    false,
    "preferences are context for a call, not something that was said",
  )

  sessions.shutdown()
})

test("a preference saved mid-session applies to the very next call", async () => {
  const { store, sent, sessions, connection } = setup()

  await sessions.submitTurn("first", connection, "text")
  assert.equal(sent.at(-1)!.length, 2, "nothing injected yet")

  store.remember({ topic: "units", value: "metric" })
  await sessions.submitTurn("second", connection, "text")
  assert.match(String(sent.at(-1)![1]!.content), /units: metric/, "applied without a restart")

  store.remember({ topic: "units", value: "imperial" })
  await sessions.submitTurn("third", connection, "text")
  assert.match(String(sent.at(-1)![1]!.content), /units: imperial/, "the update applies immediately")
  assert.doesNotMatch(String(sent.at(-1)![1]!.content), /metric/, "the old value is gone")

  store.forget("units")
  await sessions.submitTurn("fourth", connection, "text")
  assert.deepEqual(
    sent.at(-1)!.map((m) => m.role).slice(0, 2),
    ["system", "user"],
    "a forgotten preference stops being injected immediately",
  )

  sessions.shutdown()
})

// The whole point of building the block per call instead of storing it.
test("preferences survive a context budget that drops all history", async () => {
  const { store, sent, sessions, connection } = setup({
    limits: { maxMessages: 1, budgetChars: 1 },
  })
  store.remember({ topic: "coffee", value: "black" })

  await sessions.submitTurn("hello", connection, "text")
  await sessions.submitTurn("still there?", connection, "text")

  const messages = sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "system"])
  assert.match(String(messages[1]!.content), /coffee: black/)
  assert.equal(
    messages.some((m) => m.role === "user"),
    false,
    "history really was clipped away — the preference was not",
  )

  sessions.shutdown()
})

test("preferences survive a session reset", async () => {
  const { store, sent, sessions, connection } = setup()
  store.remember({ topic: "coffee", value: "black" })

  await sessions.submitTurn("before", connection, "text")
  const before = sessions.primarySession().id

  sessions.resetPrimary()
  await sessions.submitTurn("after", connection, "text")

  assert.notEqual(sessions.primarySession().id, before, "a new session")
  const messages = sent.at(-1)!
  assert.match(String(messages[1]!.content), /coffee: black/, "the preference outlives the session")
  assert.equal(
    messages.some((m) => m.content === "before"),
    false,
    "while the conversation itself did not",
  )

  sessions.shutdown()
})

test("a capped block still injects, and the cap is visible in the counts", async () => {
  const { store, sent, sessions, connection } = setup({
    prefLimits: { maxInjected: 2, maxChars: 100_000 },
  })
  store.remember({ topic: "a", value: "one" })
  store.remember({ topic: "b", value: "two" })
  store.remember({ topic: "c", value: "three" })

  const original = console.warn
  console.warn = () => {}
  try {
    await sessions.submitTurn("hello", connection, "text")
  } finally {
    console.warn = original
  }

  const block = String(sent.at(-1)![1]!.content)
  assert.doesNotMatch(block, /a: one/, "the oldest preference was dropped")
  assert.match(block, /b: two/)
  assert.match(block, /c: three/)
  assert.equal(store.buildInjection().truncated, true)

  sessions.shutdown()
})
