import { test } from "node:test"
import assert from "node:assert/strict"
import "../src/tools/register"
import { SessionManager, type SessionEndReason } from "../src/core/session-manager"
import { handleLocalCommand } from "../src/core/harness"
import { registry } from "../src/tools/registry"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// A chat that fails the test if the LLM is reached at all. "/reset" being sent
// to the model is the bug this covers.
const neverCalled: ChatFn = async () => {
  throw new Error("the LLM must not be called")
}

// Calls start_new_conversation on the first turn, then answers.
function resettingChat(reply = "Starting fresh."): ChatFn {
  let called = false
  return async (): Promise<LLMResponse> => {
    if (!called) {
      called = true
      return {
        type: "tool_calls",
        calls: [{ id: "call-1", name: "start_new_conversation", arguments: "{}" }],
      }
    }
    return { type: "text", content: reply }
  }
}

// ------------------------------------------------------------- REPL "/reset"

test('the REPL handles "/reset" locally and never sends it to the LLM', async () => {
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: neverCalled })
  const ended: Array<[string, SessionEndReason]> = []
  sessions.onSessionEnd((session, reason) => ended.push([session.id, reason]))

  const before = sessions.primarySession()
  const handled = handleLocalCommand("/reset", sessions)

  assert.equal(handled, true, "the line is consumed locally")
  assert.notEqual(sessions.primarySession().id, before.id, "a fresh session is primary")
  assert.notEqual(before.endedAt, null, "the old session ended")
  assert.deepEqual(ended, [[before.id, "reset"]], "it ended through the normal reset path")
  sessions.shutdown()
})

test('"/reset" is matched regardless of case and surrounding space', async () => {
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: neverCalled })
  assert.equal(handleLocalCommand("  /RESET  ", sessions), true)
  sessions.shutdown()
})

test("anything that is not a local command is left for the LLM", async () => {
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: neverCalled })
  const before = sessions.primarySession().id

  for (const line of ["reset", "/resets", "please /reset the conversation", "/help", "hello"]) {
    assert.equal(handleLocalCommand(line, sessions), false, `"${line}" is not consumed`)
  }
  assert.equal(sessions.primarySession().id, before, "no session was ended")
  sessions.shutdown()
})

// ------------------------------------------------- the start_new_conversation tool

test("the tool is registered, ungated, and takes no arguments", () => {
  const tool = registry.get("start_new_conversation")
  assert.ok(tool, "start_new_conversation is registered")
  assert.equal(tool.requiresConfirmation, false)
  assert.deepEqual(tool.inputSchema, { type: "object", properties: {} })
})

test("the tool ends the session AFTER the turn, not mid-turn", async () => {
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: resettingChat("Starting fresh."),
  })
  const ended: Array<[string, SessionEndReason]> = []
  sessions.onSessionEnd((session, reason) => ended.push([session.id, reason]))

  const connection = makeConnection({ id: "conn-reset" })
  await sessions.submitTurn("let's start a new conversation", connection, "text")
  const old = sessions.getSession(ended[0]![0])!

  assert.equal(ended.length, 1, "exactly one session ended")
  assert.equal(ended[0]![1], "reset", "through the same path as POST /reset")

  // Mid-turn ending would have cut these out of the history the summarizer reads.
  const roles = old.history().map((m) => m.role)
  assert.deepEqual(
    roles,
    ["system", "user", "assistant", "tool", "assistant"],
    "the whole turn, including the tool result and the reply, is in the ended session's history"
  )
  assert.equal(
    old.history().at(-1)!.content,
    "Starting fresh.",
    "the reply that announced the reset was recorded before the session ended"
  )
  sessions.shutdown()
})

test("the next turn after the tool runs in a fresh session", async () => {
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: resettingChat(),
  })
  const connection = makeConnection({ id: "conn-fresh" })

  const first = sessions.primarySession()
  await sessions.submitTurn("start over", connection, "text")

  const second = sessions.primarySession()
  assert.notEqual(second.id, first.id, "a different session is primary")
  assert.equal(second.endedAt, null, "and it is live")
  assert.deepEqual(
    second.history().map((m) => m.role),
    ["system"],
    "the fresh session carries no prior context"
  )
  sessions.shutdown()
})

test("one request ends one session, not the one after it", async () => {
  // Two turns: the first resets, the second is an ordinary reply. If the
  // request leaked, the second session would end too.
  let turn = 0
  const chat: ChatFn = async () => {
    turn++
    if (turn === 1) {
      return { type: "tool_calls", calls: [{ id: "c1", name: "start_new_conversation", arguments: "{}" }] }
    }
    return { type: "text", content: `reply ${turn}` }
  }

  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const ended: string[] = []
  sessions.onSessionEnd((session) => ended.push(session.id))
  const connection = makeConnection({ id: "conn-once" })

  await sessions.submitTurn("start over", connection, "text")
  await sessions.submitTurn("hello again", connection, "text")

  assert.equal(ended.length, 1, "only the session that asked to end has ended")
  assert.equal(sessions.primarySession().endedAt, null, "the new session is still live")
  assert.deepEqual(
    sessions.primarySession().history().map((m) => m.role),
    ["system", "user", "assistant"],
    "the second turn landed in the new session and stayed there"
  )
  sessions.shutdown()
})

test("a turn queued behind the resetting turn still runs in the old session", async () => {
  // The queued turn was submitted before the reset was requested, so it
  // belongs to the old conversation. The end waits for it.
  let turn = 0
  const chat: ChatFn = async () => {
    turn++
    if (turn === 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { type: "tool_calls", calls: [{ id: "c1", name: "start_new_conversation", arguments: "{}" }] }
    }
    return { type: "text", content: `reply ${turn}` }
  }

  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const ended: string[] = []
  sessions.onSessionEnd((session) => ended.push(session.id))
  const connection = makeConnection({ id: "conn-queued" })

  const first = sessions.primarySession()
  const a = sessions.submitTurn("start over", connection, "text")
  const b = sessions.submitTurn("and one more thing", connection, "text")
  await Promise.all([a, b])

  assert.deepEqual(ended, [first.id], "the old session ended once both turns were done")
  const userMessages = first.history().filter((m) => m.role === "user").map((m) => m.content)
  assert.deepEqual(
    userMessages,
    ["start over", "and one more thing"],
    "the queued turn ran in the old session rather than being cut off"
  )
  sessions.shutdown()
})

test("calling the tool outside a turn reports failure instead of lying", async () => {
  const tool = registry.get("start_new_conversation")!
  const result = String(await tool.execute({}))
  assert.match(result, /could not/i, "it says it did not happen")
  assert.doesNotMatch(result, /will start/i, "and does not claim a reset was scheduled")
})
