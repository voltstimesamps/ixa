import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { shellReadTool } from "../src/tools/shell-read"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse, Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// A failing call the model believes in, repeated.
//
// Three live turns, same pattern: a result that explains itself is not enough,
// because the model re-reads its own history, sees a command it still thinks
// is right, and sends it again. Measured:
//
//   `ls -R` in $HOME, four times, same "output too large" every time
//   nine identical piped `find … | sort -nr | head -n 1` calls in one turn
//
// Those are twelve of a fifteen-call budget spent learning nothing.

function sessions(chat: ChatFn): SessionManager {
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

// A probe that fails the way shell_read does, so the real isFailure predicate
// decides — this must not work by a test-only convention.
let probeRuns = 0
let probeResult = "Command failed: find: unknown predicate `-R'"
registry.register({
  name: "repeat_probe",
  description: "A probe that fails the way the shell tools fail.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  isFailure: shellReadTool.isFailure,
  execute: async () => {
    probeRuns++
    return probeResult
  },
})

function call(id: string, args: Record<string, unknown>): LLMResponse {
  return {
    type: "tool_calls",
    calls: [{ id, name: "repeat_probe", arguments: JSON.stringify(args) }],
  }
}

// The live shape, verbatim: `{"args":["-R"],"command":"ls"}` four times.
test("four identical failing calls run once and are refused three times", async () => {
  probeRuns = 0
  probeResult =
    "Output too large to return: the command produced more than 1 MB before it was stopped"

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n <= 4) return call(`c${n}`, { args: ["-R"], command: "ls" })
    return { type: "text", content: "I could not list that." }
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("find the python files", makeConnection(), "text")

  assert.equal(reply, "I could not list that.")
  assert.equal(probeRuns, 1, "the command ran once; the other three were refused")

  const results = manager
    .primarySession()
    .history()
    .filter((m) => m.role === "tool")
  assert.equal(results.length, 4, "every call still has a result — the group stays complete")
  assert.match(String(results[0]!.content), /^Output too large/)
  for (const refused of results.slice(1)) {
    assert.match(String(refused.content), /^Not run: this exact call already failed this turn/)
    // It carries why, because the window may have evicted the original.
    assert.match(String(refused.content), /Output too large/)
    assert.match(String(refused.content), /Try a different command or a different approach/)
    assert.ok(String(refused.content).length < 260, "the refusal stays short")
  }

  manager.shutdown()
})

// Key-order is not identity: the model writes the same call both ways.
test("the same call with its keys reordered is still the same call", async () => {
  probeRuns = 0
  probeResult = "Command failed: find: unknown predicate `-R'"

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n === 1) return call("a", { args: ["-R"], command: "ls" })
    if (n === 2) return call("b", { command: "ls", args: ["-R"] })
    return { type: "text", content: "done" }
  }

  const manager = sessions(chat)
  await manager.submitTurn("list it", makeConnection(), "text")
  assert.equal(probeRuns, 1, "argument order is not identity")

  manager.shutdown()
})

// The refusal must not become a wall. A model that changes its approach —
// which is the whole point of telling it to — has to be able to run.
test("a different command after a failure runs normally", async () => {
  probeRuns = 0
  probeResult = "Command failed: find: unknown predicate `-R'"

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n === 1) return call("a", { args: ["-R"], command: "ls" })
    if (n === 2) {
      probeResult = "main.py"
      return call("b", { args: ["-1"], command: "ls" })
    }
    return { type: "text", content: "main.py is the biggest." }
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("list it", makeConnection(), "text")

  assert.equal(reply, "main.py is the biggest.")
  assert.equal(probeRuns, 2, "a different argument list is a different call")

  manager.shutdown()
})

test("a call that succeeded can be repeated as often as the model likes", async () => {
  probeRuns = 0
  probeResult = "main.py"

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n <= 3) return call(`c${n}`, { args: ["-1"], command: "ls" })
    return { type: "text", content: "read it three times" }
  }

  const manager = sessions(chat)
  await manager.submitTurn("list it", makeConnection(), "text")
  assert.equal(probeRuns, 3, "only FAILED calls are remembered")

  manager.shutdown()
})

// Only tools that can say what a failure looks like take part. Everything else
// — the memory tools, web_search, an MCP tool in Phase 4 — is untouched,
// because a result this layer cannot judge must not be guessed at.
test("a tool with no isFailure is never deduplicated", async () => {
  let runs = 0
  registry.register({
    name: "opaque_probe",
    description: "A probe with no opinion about its own results.",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => {
      runs++
      return "Command failed: this looks like a failure but nothing here says so"
    },
  })

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n <= 2) {
      return {
        type: "tool_calls",
        calls: [{ id: `o${n}`, name: "opaque_probe", arguments: "{}" }],
      }
    }
    return { type: "text", content: "done" }
  }

  const manager = sessions(chat)
  await manager.submitTurn("try it", makeConnection(), "text")
  assert.equal(runs, 2)

  manager.shutdown()
})

// A refused repeat is still the model choosing to spend a call. The budget is
// there to bound the turn, and exempting repeats would let a model that only
// repeats itself run forever.
test("a refused repeat still costs a tool call", async () => {
  const { config } = await import("../src/config.js")
  const limit = config.tools.maxToolCallsPerTurn
  probeRuns = 0
  probeResult = "Command failed: find: unknown predicate `-R'"

  let n = 0
  const sent: Message[][] = []
  const chat: ChatFn = async (messages, tools) => {
    sent.push(messages)
    n++
    if (!tools || tools.length === 0) return { type: "text", content: "I gave up." }
    return call(`c${n}`, { args: ["-R"], command: "ls" })
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("keep trying", makeConnection(), "text")

  assert.equal(reply, "I gave up.", "the budget still ends the turn in an answer")
  assert.equal(probeRuns, 1, "one execution for an unbounded number of repeats")
  assert.equal(
    sent.flat().filter((m) => String(m.content ?? "").includes("tool calls for this turn")).length >
      0,
    true,
    `the wind-up notice still fired, so all ${limit} calls were charged`,
  )

  manager.shutdown()
})
