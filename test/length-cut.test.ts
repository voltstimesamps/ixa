import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry, type Tool } from "../src/tools/registry"
import {
  EMPTY_REPLY_FALLBACK,
  LENGTH_CUT_GENERIC,
  LENGTH_CUT_SAVE_NOTE,
  type ChatFn,
} from "../src/core/session"
import type { CallCost, LLMResponse, Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"
import type { ConfirmationOutcome } from "../src/core/confirmation"

// `finish_reason=length` with NO content: the provider cut the reply off
// before a single character of it arrived.
//
// Seen live on a SHORT voice turn — call 1, no tools yet — and reliably on the
// long-note case, where 4 of 10 turns came back this way with reasoning
// deltas and zero characters of content. The note was already on disk and
// correct, and the user heard "Sorry, I lost my train of thought there".
//
// This file is the session half. What the LLM layer reads off the stream is in
// test/llm-usage.test.ts.

function sessions(chat: ChatFn): SessionManager {
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

function cost(overrides: Partial<CallCost> = {}): CallCost {
  return {
    promptTokens: 1200,
    completionTokens: 65536,
    reasoningTokens: 65500,
    reasoningChars: 182000,
    elapsedMs: 31000,
    ...overrides,
  }
}

async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const real = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    return { result: await fn(), warnings }
  } finally {
    console.warn = real
  }
}

// The diagnosis this whole branch waited on. When the first empty reply was
// found, nothing logged could say whether the completion had been spent on two
// hundred tokens or sixty-five thousand — which is the difference between a
// prompt problem and a completion cap, and the two have different fixes.
test("the empty-reply warning says what the cut completion cost", async () => {
  const chat: ChatFn = async () => ({
    type: "text",
    content: "",
    finishReason: "length",
    reasoning: true,
    cost: cost(),
  })

  const manager = sessions(chat)
  const { warnings } = await capturingWarnings(() =>
    manager.submitTurn("write a long note about the backend", makeConnection(), "voice")
  )

  const line = warnings.find((entry) => entry.startsWith("empty reply: the model returned"))
  assert.ok(line, `no empty-reply warning in ${JSON.stringify(warnings)}`)
  assert.match(line, /finish_reason=length/)
  assert.match(line, /reasoning tokens arrived/)
  assert.match(line, /completion_tokens=65536/)
  assert.match(line, /reasoning_tokens=65500/)
  assert.match(line, /reasoning_chars=182000/)
  assert.match(line, /31000ms/)
})

// ------------------------------------------------- the honest degraded reply

// A stand-in registered under a REAL tool's name, because the name is half of
// what is under test: the session picks the sentence from it. Node's test
// runner gives each file its own process, so this cannot reach another test.
// Nothing here needs the notebook — what is being measured is what the session
// says when the provider cuts the reply off, not what save_note writes.
function stubTool(options: {
  name: string
  result?: string
  isFailure?: (result: string) => boolean
  throws?: boolean
  requiresConfirmation?: boolean
}): Tool & { ran: number } {
  const tool = {
    name: options.name,
    description: "a stand-in for a real tool",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: options.requiresConfirmation ?? false,
    ran: 0,
    execute: async () => {
      tool.ran++
      if (options.throws) throw new Error("the tool itself came apart")
      return options.result ?? "Saved reference note \"Where the backend runs\" (id 2026-10-14-x)."
    },
    ...(options.isFailure ? { isFailure: options.isFailure } : {}),
  }
  registry.register(tool)
  return tool
}

function callThen(name: string, then: () => LLMResponse): { chat: ChatFn; calls: () => number; sent: Message[][] } {
  let calls = 0
  const sent: Message[][] = []
  const chat: ChatFn = async (messages) => {
    sent.push(messages)
    calls++
    if (calls === 1) {
      return { type: "tool_calls", calls: [{ id: "c1", name, arguments: "{}" }] }
    }
    return then()
  }
  return { chat, calls: () => calls, sent }
}

// A reply the provider cut off: no content, finish_reason=length, and the
// reasoning tokens that say where the completion went.
function lengthCut(): LLMResponse {
  return { type: "text", content: "", finishReason: "length", reasoning: true, cost: cost() }
}

// The live failure, in one test. The note was on disk, correct, under the
// title the user asked for, and what they heard was "Sorry, I lost my train of
// thought there".
test("a length cut after a successful save_note says the note was saved", async () => {
  const tool = stubTool({ name: "save_note" })
  const { chat, calls, sent } = callThen("save_note", lengthCut)

  const manager = sessions(chat)
  const connection = makeConnection()
  const reply = await manager.submitTurn("write a long note about the backend", connection, "voice")

  assert.equal(reply, LENGTH_CUT_SAVE_NOTE)
  assert.notEqual(reply, EMPTY_REPLY_FALLBACK, "a finished action is not a lost thought")
  assert.equal(tool.ran, 1, "nothing is re-run")

  // The retry is not spent: the second call reasons just as much as the first
  // and is cut off in the same place, measured on every one of the four live
  // turns that found this.
  assert.equal(calls(), 2, "one tool call, one cut reply, and no retry behind it")

  // Never built from the result text, which is written for the model: it
  // carries the note id, and a reply that recites it reads the id out loud.
  assert.ok(!reply.includes("2026-10-14-x"), `the result text leaked into the reply: ${reply}`)
  assert.ok(!/read it back\./.test(reply.replace(LENGTH_CUT_SAVE_NOTE, "")))

  // HISTORY STAYS VALID, and says what the user heard. Read from the NEXT
  // turn's messages, which is the history the model is actually restored into
  // — the same session, because submitTurn resolves the primary one per turn.
  await manager.submitTurn("what was it called?", connection, "voice")

  const history = sent.at(-1)!
  const roles = history.filter((m) => m.role !== "system").map((m) => m.role)
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant", "user"], roles.join(","))

  // The tool group is complete — an assistant tool_calls message with a
  // missing result is rejected outright and would break every later turn.
  const group = history.find((m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls)
  assert.ok(group, "the tool call is still in history")
  assert.equal(history.filter((m) => m.role === "tool").length, 1)

  const recorded = history.filter((m) => m.role === "assistant" && typeof m.content === "string")
  const record = String(recorded.at(-1)!.content)
  assert.ok(record.startsWith(LENGTH_CUT_SAVE_NOTE), `recorded instead: ${record}`)
  // The bracketed half is for the model: it has to be able to answer "so did
  // you save it?" and "what was in it?", and the cut took the second away.
  assert.match(record, /\[the reply was cut off: finish_reason=length with no content/)
  assert.match(record, /save_note had already succeeded, and nothing was read back\]/)
})

// The other half of the rule. A tool that failed is not a tool that went
// through, so there is nothing truthful to report and the existing fallback is
// the honest one.
test("a length cut after a FAILED tool keeps the empty-reply fallback", async () => {
  stubTool({
    name: "save_note",
    result: "Nothing was saved: 'title' is required.",
    isFailure: (result) => result.startsWith("Nothing was saved"),
  })
  const { chat, calls } = callThen("save_note", lengthCut)

  const reply = await sessions(chat).submitTurn("note that down", makeConnection(), "voice")

  assert.equal(reply, EMPTY_REPLY_FALLBACK)
  assert.notEqual(reply, LENGTH_CUT_SAVE_NOTE, "nothing was saved, so nothing may be claimed")
  // Still no retry: the cut is what makes the retry pointless, not the tool.
  assert.equal(calls(), 2, "a length cut is never retried")
})

// A tool that came apart is the same answer. `executeTool` turns the throw
// into an error result, and `ok` is false — which is also the timeout's
// answer, and for the stronger reason: its work may still complete, so "I
// saved that note" would be a guess.
test("a length cut after a tool that threw keeps the empty-reply fallback", async () => {
  stubTool({ name: "save_note", throws: true })
  const { chat } = callThen("save_note", lengthCut)

  const reply = await sessions(chat).submitTurn("note that down", makeConnection(), "voice")
  assert.equal(reply, EMPTY_REPLY_FALLBACK)
})

// The shape seen live: a SHORT voice turn, call 1, no tools yet. Nothing has
// gone through, so nothing is claimed.
test("a length cut with no tool call at all keeps the empty-reply fallback", async () => {
  let calls = 0
  const chat: ChatFn = async () => {
    calls++
    return lengthCut()
  }

  const reply = await sessions(chat).submitTurn("what time is it", makeConnection(), "voice")
  assert.equal(reply, EMPTY_REPLY_FALLBACK)
  assert.equal(calls, 1, "the retry is not spent on a length cut")
})

// A call the user refused did not happen, which the price guard already knows
// and the fallback has to know too.
test("a length cut after a DECLINED tool keeps the empty-reply fallback", async () => {
  const tool = stubTool({ name: "shell_write", requiresConfirmation: true })
  const { chat } = callThen("shell_write", lengthCut)

  const connection = makeConnection({
    confirmer: async (): Promise<ConfirmationOutcome> => "declined",
  })
  // The confirmation prompt is described by an LLM call of its own, which this
  // chat answers with the tool-call script; what matters is that the user said
  // no and the tool never ran.
  const reply = await sessions(chat).submitTurn("delete that file", connection, "voice")

  assert.equal(reply, EMPTY_REPLY_FALLBACK)
  assert.equal(tool.ran, 0, "a declined tool does not run")
})

// A tool with no sentence of its own — including a Phase 4 MCP tool nobody
// here has seen — gets the generic one rather than a guess built from its name.
test("a tool with no sentence of its own gets the generic one", async () => {
  stubTool({ name: "frobnicate", result: "done" })
  const { chat } = callThen("frobnicate", lengthCut)

  const reply = await sessions(chat).submitTurn("frobnicate it", makeConnection(), "voice")
  assert.equal(reply, LENGTH_CUT_GENERIC)
  assert.ok(!reply.includes("frobnicate"), "the tool's name is not read out loud")
})

// THE GUARD ON THE CHANGE ITSELF. An empty reply the provider did NOT cut off
// is a different event with a different fix, and it keeps the retry that was
// measured at roughly one empty attempt in three.
test("an empty reply that was not cut off still gets its retry", async () => {
  stubTool({ name: "save_note" })
  let calls = 0
  const chat: ChatFn = async (_messages, tools) => {
    calls++
    if (calls === 1) {
      return { type: "tool_calls", calls: [{ id: "c1", name: "save_note", arguments: "{}" }] }
    }
    // No finishReason at all, which is the shape every pre-existing test
    // builds by hand, and "stop" would be the same question.
    if (calls === 2) return { type: "text", content: "" }
    assert.deepEqual(tools, [], "the retry is the no-tools call")
    return { type: "text", content: "" }
  }

  const reply = await sessions(chat).submitTurn("note that down", makeConnection(), "voice")
  assert.equal(reply, EMPTY_REPLY_FALLBACK)
  assert.equal(calls, 3, "the empty-reply retry is still spent when nothing was cut off")
})
