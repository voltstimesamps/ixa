import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager, type SessionEndReason } from "../src/core/session-manager"
import type { Session, ChatFn } from "../src/core/session"
import { makeConnection, TEST_LIMITS, sleep } from "./helpers"

const echoChat: ChatFn = async (messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
}

test("a session ends after the idle timeout and fires onSessionEnd", async () => {
  const ended: Array<{ session: Session; reason: SessionEndReason }> = []
  const sessions = new SessionManager({ idleTimeoutMs: 40, limits: TEST_LIMITS, chat: echoChat })
  sessions.onSessionEnd((session, reason) => ended.push({ session, reason }))

  const connection = makeConnection({ id: "conn-idle" })
  await sessions.submitTurn("remember the number seven", connection, "text")
  const first = sessions.getSession(ended[0]?.session.id ?? "") ?? sessions.primarySession()

  await sleep(120)

  assert.equal(ended.length, 1, "onSessionEnd fired exactly once")
  assert.equal(ended[0]!.reason, "timeout")
  assert.equal(ended[0]!.session.id, first.id)
  assert.notEqual(ended[0]!.session.endedAt, null)

  sessions.shutdown()
})

// Requirement (b): transports must never cache a Session. A connection that
// stayed attached across a timeout has to land on the NEW primary session.
test("a still-attached connection gets the new session after a timeout", async () => {
  const sessions = new SessionManager({ idleTimeoutMs: 40, limits: TEST_LIMITS, chat: echoChat })
  const connection = makeConnection({ id: "conn-survivor" })

  await sessions.submitTurn("the number is seven", connection, "text")
  const before = sessions.primarySession()
  assert.ok(before.attachedConnections.has("conn-survivor"), "still attached")

  await sleep(120)
  assert.notEqual(before.endedAt, null, "the first session ended")

  await sessions.submitTurn("what was the number?", connection, "text")
  const after = sessions.primarySession()

  assert.notEqual(after.id, before.id, "the next turn landed on a fresh session")
  assert.equal(after.endedAt, null)
  assert.ok(after.attachedConnections.has("conn-survivor"), "re-attached by submitTurn")

  const carried = after.history().some((m) => String(m.content).includes("the number is seven"))
  assert.equal(carried, false, "an ended session's history does not leak into the new one")
  assert.equal(
    before.history().some((m) => String(m.content).includes("what was the number?")),
    false,
    "nothing was written into the ended session",
  )

  sessions.shutdown()
})

test("an in-flight or queued turn is never timed out underneath itself", async () => {
  const ended: SessionEndReason[] = []
  const slowChat: ChatFn = async (messages) => {
    await sleep(120)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
  }

  const sessions = new SessionManager({ idleTimeoutMs: 40, limits: TEST_LIMITS, chat: slowChat })
  sessions.onSessionEnd((_session, reason) => ended.push(reason))

  const connection = makeConnection({ id: "conn-slow" })
  const before = sessions.primarySession()

  // Two turns, each longer than the idle timeout; the second is queued.
  const [a, b] = await Promise.all([
    sessions.submitTurn("first", connection, "text"),
    sessions.submitTurn("second", connection, "text"),
  ])

  assert.equal(a, "heard: first")
  assert.equal(b, "heard: second")
  assert.deepEqual(ended, [], "no session ended while turns were outstanding")
  assert.equal(sessions.primarySession().id, before.id, "same session throughout")

  sessions.shutdown()
})

test("an explicit reset ends the session and starts a fresh primary", async () => {
  const ended: Array<{ id: string; reason: SessionEndReason }> = []
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: echoChat })
  sessions.onSessionEnd((session, reason) => ended.push({ id: session.id, reason }))

  const connection = makeConnection({ id: "conn-reset" })
  await sessions.submitTurn("the number is seven", connection, "text")
  const before = sessions.primarySession()

  const after = sessions.resetPrimary()

  assert.deepEqual(ended, [{ id: before.id, reason: "reset" }])
  assert.notEqual(after.id, before.id)
  assert.equal(
    after.history().some((m) => String(m.content).includes("seven")),
    false,
    "a reset starts from a clean history",
  )

  sessions.shutdown()
})
