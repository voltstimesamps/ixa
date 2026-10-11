import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import {
  EMPTY_REPLY_FALLBACK,
  TURN_FAILURE_APOLOGY,
  type ChatFn,
} from "../src/core/session"
import { isParsingFailure, failedGeneration, LLMDeadlineError } from "../src/core/llm"
import type { LLMResponse } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// Groq returns a 400 when it cannot parse the model's harmony output into tool
// calls at all:
//
//   Parsing failed. The model generated output that could not be parsed.
//   Please adjust your prompt or try again. See 'failed_generation' for the
//   raw output.
//
// Live, that ended a turn with seven tool calls already behind it. It was not
// unhandled — the malformed-tool-call list in the tool loop matches the words
// "parsing failed", so the turn did retry — but that lever DROPS THE TOOLS,
// which is the wrong answer to a sampling fluke, and when the second attempt
// failed identically there was nothing behind it.

// The real error, as the SDK builds it: `err.error` is the response body's
// `error` object, so `failed_generation` sits beside `message` and `code`.
function parsingFailure(generation = '<|channel|>commentary to=functions.shell_read'): Error {
  const err = new Error(
    "400 Parsing failed. The model generated output that could not be parsed. " +
      "Please adjust your prompt or try again. See 'failed_generation' for the raw output.",
  ) as Error & { status?: number; error?: unknown; code?: string }
  err.status = 400
  err.code = "tool_use_failed"
  err.error = {
    message: "Parsing failed. … See 'failed_generation' for the raw output.",
    type: "invalid_request_error",
    code: "tool_use_failed",
    failed_generation: generation,
  }
  return err
}

function sessions(chat: ChatFn): SessionManager {
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

// ------------------------------------------------------ the classifier

test("the classifier matches the real error and nothing like it", () => {
  assert.equal(isParsingFailure(parsingFailure()), true)

  // Both phrases are required, so an unrelated 400 does not match. These are
  // real ones: a bad parameter, a context-length error, and the schema
  // rejection that has its OWN retry inside withArgumentRetry and must not be
  // given a second one here.
  const unrelated = [
    "400 Invalid value for 'temperature': must be <= 2",
    "400 Please reduce the length of the messages: this model's maximum context length is 8192 tokens",
    "400 tool call validation failed: parameters for tool search_memory did not match schema: " +
      "errors: [`/query`: expected string, but got null]",
    "400 Failed to parse tool call arguments as JSON",
    "parsing failed",
    "429 Rate limit reached",
    "Connection error.",
  ]
  for (const message of unrelated) {
    const err = new Error(message) as Error & { status?: number }
    err.status = 400
    assert.equal(isParsingFailure(err), false, `should not match: ${message.slice(0, 60)}`)
  }

  // Our own deadline is never the provider's parser.
  assert.equal(isParsingFailure(new LLMDeadlineError("no chunk for 15000ms")), false)
  assert.equal(isParsingFailure("not an error"), false)
})

test("the raw generation is read off the error when the provider sends one", () => {
  assert.match(String(failedGeneration(parsingFailure())), /functions\.shell_read/)
  assert.equal(failedGeneration(new Error("400 Parsing failed … failed_generation")), null)
})

// ------------------------------------------------------ one retry

test("a parsing failure is retried as the SAME call and recovers", async () => {
  registry.register({
    name: "parse_probe",
    description: "A probe.",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => "probe ran",
  })

  let call = 0
  const toolsSeen: number[] = []
  const chat: ChatFn = async (_messages, tools) => {
    call++
    toolsSeen.push(tools?.length ?? 0)
    if (call === 1) {
      return { type: "tool_calls", calls: [{ id: "a", name: "parse_probe", arguments: "{}" }] }
    }
    if (call === 2) throw parsingFailure()
    return { type: "text", content: "main.py is the biggest one." }
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("which is biggest", makeConnection(), "text")

  assert.equal(reply, "main.py is the biggest one.", "another sample of the same request answers")
  assert.equal(call, 3, "exactly one retry")
  // THE POINT: the retry keeps its tools. The old path dropped them, which is
  // the wrong lever for output the provider could not read.
  assert.ok(toolsSeen[2]! > 0, `the retry kept its tools, saw ${toolsSeen[2]}`)

  manager.shutdown()
})

test("a parsing failure twice falls back, and the turn does not fail", async () => {
  let call = 0
  const chat: ChatFn = async () => {
    call++
    if (call === 1) {
      return { type: "tool_calls", calls: [{ id: "a", name: "parse_probe", arguments: "{}" }] }
    }
    throw parsingFailure()
  }

  const manager = sessions(chat)
  // Does not reject: the turn finished, badly.
  const reply = await manager.submitTurn("which is biggest", makeConnection(), "text")

  assert.equal(reply, EMPTY_REPLY_FALLBACK)
  assert.notEqual(reply, TURN_FAILURE_APOLOGY)
  assert.equal(call, 3, "one retry, then the fallback — never a third sample")

  const history = manager.primarySession().history()
  const last = history.at(-1)!
  assert.equal(last.role, "assistant")
  assert.ok(String(last.content).startsWith(EMPTY_REPLY_FALLBACK))
  // The spoken words are the empty-reply ones, because the user's experience
  // is the same; the bracketed note carries the difference, for the model.
  assert.match(
    String(last.content),
    /\[no reply was produced after 1 tool call: the model's output could not be parsed, twice\]/,
    `got: ${String(last.content)}`,
  )

  // History stays valid: the rejection lands at the LLM call, so every
  // tool_calls message still has all of its results.
  const issued = history
    .filter((m) => m.role === "assistant" && "tool_calls" in m)
    .reduce((n, m) => n + ((m as { tool_calls: unknown[] }).tool_calls?.length ?? 0), 0)
  assert.equal(history.filter((m) => m.role === "tool").length, issued)

  manager.shutdown()
})

// An unrelated 400 must still end the turn the way it always did, or this
// classifier has quietly become a catch-all for provider errors.
test("an unrelated 400 still fails the turn", async () => {
  const chat: ChatFn = async () => {
    const err = new Error("400 Invalid value for 'temperature': must be <= 2") as Error & {
      status?: number
    }
    err.status = 400
    throw err
  }

  const manager = sessions(chat)
  await assert.rejects(
    () => manager.submitTurn("hello", makeConnection(), "text"),
    /Invalid value for 'temperature'/,
  )
  assert.ok(String(manager.primarySession().history().at(-1)!.content).startsWith(TURN_FAILURE_APOLOGY))

  manager.shutdown()
})

// The three other no-tools paths all funnel into the same chat() call, so a
// parsing failure can arrive on any of them. The budget wind-up is the one
// worth proving: it is where the live failure landed.
test("a parsing failure on the budget wind-up falls back rather than failing", async () => {
  const { config } = await import("../src/config.js")
  const limit = config.tools.maxToolCallsPerTurn

  let probes = 0
  registry.register({
    name: "windup_probe",
    description: "A probe.",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => {
      probes++
      return "probe ran"
    },
  })

  let call = 0
  const chat: ChatFn = async (_messages, tools) => {
    call++
    if (tools && tools.length > 0) {
      return {
        type: "tool_calls",
        calls: [{ id: `c${call}`, name: "windup_probe", arguments: "{}" }],
      } as LLMResponse
    }
    // The wind-up call, and the retry behind it.
    throw parsingFailure()
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("hunt for it", makeConnection(), "text")

  assert.equal(reply, EMPTY_REPLY_FALLBACK, "the turn ends in words, not an apology")
  assert.equal(probes, limit, "the budget still held")
  assert.match(
    String(manager.primarySession().history().at(-1)!.content),
    new RegExp(`after ${limit} tool calls: the model's output could not be parsed`),
  )

  manager.shutdown()
})
