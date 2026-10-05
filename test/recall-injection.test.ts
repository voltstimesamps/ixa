import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { openDatabase } from "../src/memory/db"
import { PreferenceStore } from "../src/memory/preferences"
import type { ChatFn } from "../src/core/session"
import type { Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

function recordingChat(sent: Message[][]): ChatFn {
  return async (messages) => {
    sent.push(messages)
    return { type: "text", content: "ok" }
  }
}

interface Harness {
  sessions: SessionManager
  sent: Message[][]
  preferences: PreferenceStore
  recallCalls: string[]
  setRecall: (value: string | null) => void
  setLastEpisode: (value: string | null) => void
}

function setup(options: { limits?: typeof TEST_LIMITS } = {}): Harness {
  const preferences = new PreferenceStore(openDatabase(":memory:"), {
    maxInjected: 40,
    maxChars: 2000,
  })
  const sent: Message[][] = []
  const recallCalls: string[] = []
  let recalled: string | null = null
  let lastEpisode: string | null = null

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: options.limits ?? TEST_LIMITS,
    chat: recordingChat(sent),
    preferenceBlock: () => preferences.injectionBlock(),
    lastEpisode: () => lastEpisode,
    recall: async (userInput) => {
      recallCalls.push(userInput)
      return recalled
    },
  })

  return {
    sessions,
    sent,
    preferences,
    recallCalls,
    setRecall: (value) => {
      recalled = value
    },
    setLastEpisode: (value) => {
      lastEpisode = value
    },
  }
}

test("order is system prompt, preferences, episodes, history", async () => {
  const h = setup()
  h.preferences.remember({ topic: "coffee", value: "black", category: "food" })
  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Fixed the TTS chunking.")

  await h.sessions.submitTurn("why was TTS slow?", makeConnection({ id: "c1" }), "text")

  const messages = h.sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "system", "system", "user"])
  assert.match(String(messages[0]!.content), /You are Ixa/)
  assert.match(String(messages[1]!.content), /saved preferences/)
  assert.match(String(messages[2]!.content), /earlier conversations/)
  assert.equal(messages[3]!.content, "why was TTS slow?")

  h.sessions.shutdown()
})

test("on a voice turn the constraint still comes last", async () => {
  const h = setup()
  h.preferences.remember({ topic: "coffee", value: "black" })
  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Something.")

  await h.sessions.submitTurn("hello", makeConnection({ id: "c2" }), "voice")

  const messages = h.sent.at(-1)!
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "system", "system", "user", "system"],
  )
  assert.match(String(messages[1]!.content), /saved preferences/)
  assert.match(String(messages[2]!.content), /earlier conversations/)
  assert.match(String(messages.at(-1)!.content), /spoken aloud/i)

  h.sessions.shutdown()
})

test("episodes inject with no preferences, and vice versa", async () => {
  const h = setup()

  // Counts the leading system run, since the second turn also carries the
  // first turn's history behind it.
  const leadingSystems = (messages: Message[]): Message[] => {
    let lead = 0
    while (lead < messages.length && messages[lead]!.role === "system") lead++
    return messages.slice(0, lead)
  }

  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Something.")
  await h.sessions.submitTurn("one", makeConnection({ id: "c3" }), "text")
  let lead = leadingSystems(h.sent.at(-1)!)
  assert.equal(lead.length, 2, "system prompt + episodes only")
  assert.match(String(lead[1]!.content), /earlier conversations/)

  h.setRecall(null)
  h.preferences.remember({ topic: "units", value: "metric" })
  await h.sessions.submitTurn("two", makeConnection({ id: "c3" }), "text")
  lead = leadingSystems(h.sent.at(-1)!)
  assert.equal(lead.length, 2, "system prompt + preferences only")
  assert.match(String(lead[1]!.content), /units: metric/)

  h.sessions.shutdown()
})

test("nothing is injected when recall returns null", async () => {
  const h = setup()
  h.setRecall(null)

  await h.sessions.submitTurn("hello", makeConnection({ id: "c4" }), "text")

  assert.deepEqual(h.sent.at(-1)!.map((m) => m.role), ["system", "user"])
  h.sessions.shutdown()
})

// The reason recall lives in send() and not in runToolLoop.
test("recall runs once per user turn, not once per LLM call", async () => {
  const preferences = new PreferenceStore(openDatabase(":memory:"), {
    maxInjected: 40,
    maxChars: 2000,
  })
  const sent: Message[][] = []
  const recallCalls: string[] = []
  let call = 0

  // Two LLM calls in one turn: a tool call, then the final answer.
  const chat: ChatFn = async (messages) => {
    sent.push(messages)
    call++
    if (call === 1) {
      return {
        type: "tool_calls",
        calls: [{ id: "t1", name: "get_time", arguments: "{}" }],
      }
    }
    return { type: "text", content: "done" }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat,
    preferenceBlock: () => preferences.injectionBlock(),
    recall: async (userInput) => {
      recallCalls.push(userInput)
      return "Notes from earlier conversations.\n- Tue, 29 Sept 2026: Something."
    },
  })

  await sessions.submitTurn("what time is it?", makeConnection({ id: "c5" }), "text")

  assert.equal(call, 2, "the turn made two LLM calls")
  assert.deepEqual(recallCalls, ["what time is it?"], "but recall ran exactly once")
  for (const messages of sent) {
    assert.match(
      String(messages[1]!.content),
      /earlier conversations/,
      "and the block is present on every call of the turn",
    )
  }

  sessions.shutdown()
})

test("the recalled block is never written to history", async () => {
  const h = setup()
  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Something.")

  await h.sessions.submitTurn("hello", makeConnection({ id: "c6" }), "text")

  const history = h.sessions.primarySession().history()
  assert.deepEqual(history.map((m) => m.role), ["system", "user", "assistant"])
  assert.equal(
    history.some((m) => String(m.content).includes("earlier conversations")),
    false,
  )

  h.sessions.shutdown()
})

test("a recalled block survives a budget that drops all history", async () => {
  const h = setup({ limits: { maxMessages: 1, budgetChars: 1 } })
  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Something.")

  await h.sessions.submitTurn("hello", makeConnection({ id: "c7" }), "text")
  await h.sessions.submitTurn("again", makeConnection({ id: "c7" }), "text")

  const messages = h.sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "system"])
  assert.match(String(messages[1]!.content), /earlier conversations/)

  h.sessions.shutdown()
})

test("a recall that rejects does not take the turn down with it", async () => {
  const sent: Message[][] = []
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: recordingChat(sent),
    recall: async () => {
      throw new Error("memory exploded")
    },
  })

  // Recall is specified to swallow its own failures; if one ever escapes, the
  // user's turn must not be the thing that breaks.
  await assert.rejects(
    sessions.submitTurn("hello", makeConnection({ id: "c8" }), "text"),
    /memory exploded/,
    "an escaped recall error surfaces to the caller rather than corrupting state",
  )

  // The session is still usable afterwards.
  const working = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: recordingChat(sent),
    recall: async () => null,
  })
  const reply = await working.submitTurn("still fine?", makeConnection({ id: "c9" }), "text")
  assert.equal(reply, "ok")

  sessions.shutdown()
  working.shutdown()
})

// --------------------------------------------------- the recency line (item 2)
//
// "What did we talk about last time?" was answered from the preference block,
// because recall matches on meaning and that question has no subject in it, so
// the preferences were the only memory-shaped text in the request. These cover
// the line that now says there IS a last conversation.

test("the recency line is injected between preferences and recalled episodes", async () => {
  const h = setup()
  h.preferences.remember({ topic: "coffee", value: "black", category: "food" })
  h.setLastEpisode("Your most recent conversation with the user ended Sat 4 Oct 2026, 16:25.")
  h.setRecall("Notes from earlier conversations.\n- Tue, 29 Sept 2026: Fixed the TTS chunking.")

  await h.sessions.submitTurn("what did we talk about last time?", makeConnection({ id: "r1" }), "text")

  const messages = h.sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "system", "system", "system", "user"])
  assert.match(String(messages[1]!.content), /saved preferences/)
  assert.match(String(messages[2]!.content), /most recent conversation/)
  assert.match(String(messages[3]!.content), /earlier conversations/)

  h.sessions.shutdown()
})

test("the recency line is injected with no preferences and no recall", async () => {
  const h = setup()
  h.setLastEpisode("Your most recent conversation with the user ended Sat 4 Oct 2026, 16:25.")

  await h.sessions.submitTurn("what did we talk about?", makeConnection({ id: "r2" }), "text")

  const messages = h.sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "system", "user"])
  assert.match(String(messages[1]!.content), /most recent conversation/)

  h.sessions.shutdown()
})

test("nothing is injected when there are no episodes to name", async () => {
  const h = setup()
  h.setLastEpisode(null)

  await h.sessions.submitTurn("hello", makeConnection({ id: "r3" }), "text")

  const messages = h.sent.at(-1)!
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"])

  h.sessions.shutdown()
})

test("the recency line is rebuilt per call, so an episode saved mid-session appears", async () => {
  const h = setup()
  h.setLastEpisode(null)
  await h.sessions.submitTurn("one", makeConnection({ id: "r4" }), "text")
  assert.deepEqual(h.sent.at(-1)!.map((m) => m.role), ["system", "user"])

  h.setLastEpisode("Your most recent conversation with the user ended Sat 4 Oct 2026, 16:25.")
  await h.sessions.submitTurn("two", makeConnection({ id: "r4" }), "text")

  const messages = h.sent.at(-1)!
  assert.equal(messages[1]!.role, "system")
  assert.match(String(messages[1]!.content), /most recent conversation/)

  h.sessions.shutdown()
})

test("the preference block says it is not a record of past conversations", async () => {
  const h = setup()
  h.preferences.remember({ topic: "coffee", value: "black", category: "food" })

  await h.sessions.submitTurn("hello", makeConnection({ id: "r5" }), "text")

  const block = String(h.sent.at(-1)![1]!.content)
  assert.match(block, /NOT a record of past conversations/)
  assert.match(block, /search_memory/)

  h.sessions.shutdown()
})
