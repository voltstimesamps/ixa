import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { type ChatFn } from "../src/core/session"
import type { CallCost } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

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
