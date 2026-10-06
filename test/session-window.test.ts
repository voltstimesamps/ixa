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

// The empty reply, end to end.
//
// A live voice session produced a turn with no text at all — the log line
// "Ixa:" and nothing after it — once four web_search calls had completed
// successfully. The next turn was fine.
//
// Cause: the four results arrive as ONE atomic group (an assistant message
// carrying four tool_calls plus the four tool messages answering it), and at
// ~5300 characters each that group is ~21.5k against the 24000 default
// budget. With the leading system prompt already charged, the group did not
// fit; buildWindow dropped it and, because the walk breaks at the first group
// that does not fit, took the user's question with it. The second LLM call
// carried the system prompt and nothing else. Asked to answer a conversation
// it could not see, the model returned an empty string — measured at roughly
// one attempt in three against openai/gpt-oss-20b, a generic "what would you
// like help with?" the rest of the time.
test("a turn whose tool results exceed the budget still sends the question", async () => {
  const RESULT = `1. Used RTX 3090 listings\nhttps://example.com\n${"x".repeat(5250)}`

  const { registry } = await import("../src/tools/registry.js")
  registry.register({
    name: "web_search",
    description: "Search the web.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    requiresConfirmation: false,
    execute: async () => RESULT,
  })

  const sent: Message[][] = []
  let call = 0
  const chat: ChatFn = async (messages) => {
    sent.push(messages)
    if (++call === 1) {
      return {
        type: "tool_calls",
        calls: Array.from({ length: 4 }, (_, i) => ({
          id: `call_${i}`,
          name: "web_search",
          arguments: JSON.stringify({ query: `used rtx 3090 price ${i}` }),
        })),
      }
    }
    const results = messages.filter((m) => m.role === "tool").length
    const queries = messages.filter((m) => m.role === "assistant" && "tool_calls" in m).length
    return { type: "text", content: `results:${results} callGroups:${queries}` }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    // The real defaults, because the exact numbers are what made this reachable.
    limits: { maxMessages: 40, budgetChars: 24_000 },
    chat,
  })

  const reply = await sessions.submitTurn(
    "how much is a used 3090 going for",
    makeConnection({ id: "conn-oversized" }),
    "text",
  )

  // What the model was actually given on the call that had to produce the answer.
  assert.equal(reply, "results:4 callGroups:1", "all four results reached the answering call")

  const second = sent[1]!
  assert.equal(
    second.filter((m) => m.role === "tool").length,
    4,
    "a tool group is sent whole or not at all — and this one is sent",
  )
  assert.ok(
    second.some((m) => m.role !== "system"),
    "the window is never nothing but system prompts",
  )

  // The user's question is still clipped: the group alone is ~21.4k of the
  // 24000 budget, so nothing fits behind it. That is the budget working, and
  // it is survivable — the four queries are in the assistant tool_calls
  // message, so the call still carries what was asked. Measured against
  // openai/gpt-oss-20b on this exact window: 4 of 4 attempts answered with
  // the searched price. On the window this used to produce — system prompts
  // and nothing else — 1 in 3 came back empty and the rest came back
  // "what would you like help with?".
  assert.equal(
    second.some((m) => m.role === "user"),
    false,
    "recency still binds behind the newest group; only the empty window was broken",
  )

  sessions.shutdown()
})
