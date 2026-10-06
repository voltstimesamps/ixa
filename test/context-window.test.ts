import { test } from "node:test"
import assert from "node:assert/strict"
import { buildWindow } from "../src/core/context-window"
import type { Message } from "../src/core/llm"

const SYSTEM: Message = { role: "system", content: "system prompt" }

function toolGroup(id: string): Message[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "echo", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: id, content: `result for ${id}` },
  ]
}

test("keeps leading system prompts even when the budget is tiny", () => {
  const messages: Message[] = [SYSTEM, { role: "user", content: "hello" }]
  const out = buildWindow(messages, { maxMessages: 1, budgetChars: 1 })
  assert.equal(out[0], SYSTEM)
})

// The newest group is not optional. It used to be dropped like any other when
// it did not fit, and because the walk stops at the first group that does not
// fit, that dropped the whole conversation: the model was handed its system
// prompt and nothing else, and answered with an empty reply. Four parallel
// web_search results are ~21.5k chars against the 24000 default, so one
// ordinary turn could reach it.
test("the newest group survives a budget it does not fit in", () => {
  const messages: Message[] = [SYSTEM, { role: "user", content: "hello" }]
  const out = buildWindow(messages, { maxMessages: 1, budgetChars: 1 })
  assert.deepEqual(
    out.map((m) => m.content),
    ["system prompt", "hello"],
    "a window with no conversation in it is not a request the model can answer",
  )
})

test("an oversized newest group goes out whole, never sliced", () => {
  const big = "x".repeat(50_000)
  const call: Message = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "web_search", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "web_search", arguments: "{}" } },
    ],
  }
  const messages: Message[] = [
    SYSTEM,
    { role: "user", content: "how much is it" },
    call,
    { role: "tool", tool_call_id: "a", content: big },
    { role: "tool", tool_call_id: "b", content: big },
  ]

  const out = buildWindow(messages, { maxMessages: 40, budgetChars: 24000 })

  assert.deepEqual(
    out.map((m) => m.role),
    ["system", "assistant", "tool", "tool"],
    "the group is over budget, so it travels alone — but it does travel, and whole",
  )
  assert.equal(
    out.filter((m) => m.role === "tool").length,
    2,
    "both results travel with their call",
  )
})

test("keeps only the most recent messages under a message cap", () => {
  const messages: Message[] = [SYSTEM]
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `u${i}` })
    messages.push({ role: "assistant", content: `a${i}` })
  }

  // 1 system + 4 conversational messages.
  const out = buildWindow(messages, { maxMessages: 5, budgetChars: 100000 })
  assert.equal(out.length, 5)
  assert.equal(out[0], SYSTEM)
  assert.deepEqual(
    out.slice(1).map((m) => m.content),
    ["u8", "a8", "u9", "a9"],
  )
})

test("keeps only the most recent messages under a character budget", () => {
  const messages: Message[] = [SYSTEM]
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "x".repeat(100) })

  const out = buildWindow(messages, { maxMessages: 1000, budgetChars: 600 })
  assert.ok(out.length > 1, "should keep some history")
  assert.ok(out.length < messages.length, "should have dropped something")
  const chars = out.reduce((n, m) => n + JSON.stringify(m).length, 0)
  assert.ok(chars <= 600, `window of ${chars} chars must stay inside the 600 budget`)
})

test("never sends a tool result without its call", () => {
  const [call, result] = toolGroup("call_1") as [Message, Message]
  const messages: Message[] = [SYSTEM, { role: "user", content: "run it" }, call, result]

  // A cap that would slice the group in half if groups were not atomic.
  const out = buildWindow(messages, { maxMessages: 2, budgetChars: 100000 })

  const tools = out.filter((m) => m.role === "tool")
  const calls = out.filter((m) => m.role === "assistant" && "tool_calls" in m)
  assert.equal(tools.length, calls.length, "tool results and tool calls must come in pairs")
  assert.deepEqual(
    out.map((m) => m.role),
    ["system", "assistant", "tool"],
    "the group is taken whole — and the user message behind it is what gets clipped",
  )
})

// The same atomicity rule where the group that does not fit is NOT the newest
// one, which is the case the newest-group exception does not cover.
test("an older group that does not fit is dropped whole", () => {
  const messages: Message[] = [
    SYSTEM,
    ...toolGroup("old_call"),
    { role: "user", content: "newest" },
  ]

  // Room for the system prompt and the newest message, and not a byte more.
  const out = buildWindow(messages, { maxMessages: 2, budgetChars: 100000 })

  assert.deepEqual(
    out.map((m) => m.role),
    ["system", "user"],
    "neither half of the older group came along",
  )
})

test("keeps a tool-call group intact when it does fit", () => {
  const group = toolGroup("call_1")
  const messages: Message[] = [SYSTEM, { role: "user", content: "old" }, ...group]
  const out = buildWindow(messages, { maxMessages: 3, budgetChars: 100000 })

  assert.equal(out.length, 3)
  assert.equal(out[0], SYSTEM)
  assert.equal(out[1], group[0], "the tool call")
  assert.equal(out[2], group[1], "its result")
})

test("keeps a multi-result tool group intact", () => {
  const call: Message = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "echo", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "echo", arguments: "{}" } },
    ],
  }
  const messages: Message[] = [
    SYSTEM,
    { role: "user", content: "two at once" },
    call,
    { role: "tool", tool_call_id: "a", content: "ra" },
    { role: "tool", tool_call_id: "b", content: "rb" },
  ]

  const out = buildWindow(messages, { maxMessages: 4, budgetChars: 100000 })
  assert.deepEqual(
    out.map((m) => m.role),
    ["system", "assistant", "tool", "tool"],
    "both results travel with their single call message",
  )
})

test("drops an orphan tool result that has no call", () => {
  const messages: Message[] = [SYSTEM, { role: "tool", tool_call_id: "ghost", content: "orphan" }]
  const out = buildWindow(messages, { maxMessages: 100, budgetChars: 100000 })
  assert.deepEqual(out, [SYSTEM])
})

test("never mutates the stored history it is given", () => {
  const messages: Message[] = [SYSTEM, ...toolGroup("call_1"), { role: "user", content: "hi" }]
  const snapshot = JSON.stringify(messages)
  const length = messages.length

  buildWindow(messages, { maxMessages: 1, budgetChars: 10 })

  assert.equal(messages.length, length)
  assert.equal(JSON.stringify(messages), snapshot)
})
