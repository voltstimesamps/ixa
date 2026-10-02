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
  assert.deepEqual(out, [SYSTEM])
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
  assert.deepEqual(out, [SYSTEM], "a group that does not fit whole is dropped whole")
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
