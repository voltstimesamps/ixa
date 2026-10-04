import { test, before } from "node:test"
import assert from "node:assert/strict"
import type { SessionManager as SessionManagerType } from "../src/core/session-manager"
import type { ChatFn } from "../src/core/session"
import type { Tool } from "../src/tools/registry"
import { makeConnection, TEST_LIMITS, sleep } from "./helpers"

// The generic per-tool ceiling in the tool loop.
//
// It is a backstop, not a tool's own limit: a tool that owns a network call
// or a subprocess bounds that itself. This catches the ones that do not —
// including MCP tools in Phase 4, whose timeout behaviour is not ours to set.
//
// config.ts reads the environment at import time, so the ceiling is set here
// and the modules are imported after it.
process.env.IXA_TOOL_TIMEOUT_MS = "300"
process.env.LLM_API_KEY = "test-key"

let SessionManager: typeof SessionManagerType
let registry: typeof import("../src/tools/registry").registry

before(async () => {
  ;({ SessionManager } = await import("../src/core/session-manager.js"))
  ;({ registry } = await import("../src/tools/registry.js"))
})

function managerFor(chat: ChatFn): SessionManagerType {
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

// One tool call, then whatever the model says next.
function scriptedChat(toolName: string, after: string): ChatFn {
  let called = false
  return async () => {
    if (called) return { type: "text", content: after }
    called = true
    return { type: "tool_calls", calls: [{ id: "call-1", name: toolName, arguments: "{}" }] }
  }
}

test("a tool that never finishes is abandoned, and the turn still completes", async () => {
  const release: { fn?: () => void } = {}
  const hanging: Tool = {
    name: "test_hangs",
    description: "never resolves on its own",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: false,
    // The shape of an unbounded fetch: nothing times it out from the inside.
    execute: () => new Promise((resolve) => { release.fn = () => resolve("late") }),
  }
  registry.register(hanging)

  const sessions = managerFor(scriptedChat("test_hangs", "I could not finish that"))
  const startedAt = Date.now()
  const reply = await sessions.submitTurn("do the slow thing", makeConnection(), "text")
  const elapsed = Date.now() - startedAt

  assert.equal(reply, "I could not finish that")
  assert.ok(elapsed >= 300 && elapsed < 2000, `took ${elapsed}ms`)

  // What the model was told: abandoned, not "did not happen".
  const history = sessions.primarySession().history()
  const result = history.find((m) => m.role === "tool")
  assert.ok(result)
  assert.match(String(result.content), /did not finish within 300ms and was abandoned/)
  assert.match(String(result.content), /may still complete/)

  release.fn?.()
})

test("waiting on a confirmation does not count against the tool ceiling", async () => {
  const slowToConfirm: Tool = {
    name: "test_confirmed",
    description: "runs quickly once confirmed",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: true,
    execute: async () => {
      await sleep(120)
      return "DONE"
    },
  }
  registry.register(slowToConfirm)

  // Twice the ceiling spent thinking about it, then a tool that runs well
  // inside the ceiling. If the two were added together this would time out.
  const connection = makeConnection({
    confirmer: async () => {
      await sleep(600)
      return "confirmed"
    },
  })

  const sessions = managerFor(scriptedChat("test_confirmed", "done"))
  const reply = await sessions.submitTurn("do the confirmed thing", connection, "text")

  assert.equal(reply, "done")
  const history = sessions.primarySession().history()
  const result = history.find((m) => m.role === "tool")
  assert.equal(result?.content, "DONE")
})

test("a tool that throws becomes an error result, not a failed turn", async () => {
  const broken: Tool = {
    name: "test_throws",
    description: "always throws",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => {
      throw new Error("the disk is on fire")
    },
  }
  registry.register(broken)

  const sessions = managerFor(scriptedChat("test_throws", "that did not work"))
  const reply = await sessions.submitTurn("break something", makeConnection(), "text")

  assert.equal(reply, "that did not work")
  const result = sessions.primarySession().history().find((m) => m.role === "tool")
  assert.match(String(result?.content), /the disk is on fire/)
})
