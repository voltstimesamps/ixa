import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import type { ChatFn } from "../src/core/session"
import { makeConnection, TEST_LIMITS, sleep } from "./helpers"

test("two turns from different connections run one after the other", async () => {
  let inFlight = 0
  let maxInFlight = 0
  const order: string[] = []

  // Each reply takes a tick, so overlapping loops would be visible.
  const chat: ChatFn = async (messages) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const content = String(lastUser?.content ?? "")
    order.push(content)
    await sleep(20)
    inFlight--
    return { type: "text", content: `reply to ${content}` }
  }

  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const a = makeConnection({ id: "conn-a" })
  const b = makeConnection({ id: "conn-b" })

  const [ra, rb] = await Promise.all([
    sessions.submitTurn("from A", a, "text"),
    sessions.submitTurn("from B", b, "text"),
  ])

  assert.equal(maxInFlight, 1, "only one tool loop may touch a session's history at a time")
  assert.equal(ra, "reply to from A")
  assert.equal(rb, "reply to from B")
  assert.deepEqual(order, ["from A", "from B"], "turns ran in submission order")

  // History must be a sane alternation, not interleaved.
  const history = sessions.primarySession().history()
  assert.deepEqual(
    history.map((m) => `${m.role}:${String(m.content)}`),
    [
      `system:${String(history[0]!.content)}`,
      "user:from A",
      "assistant:reply to from A",
      "user:from B",
      "assistant:reply to from B",
    ],
  )

  sessions.shutdown()
})

test("a turn that throws reaches its own caller and leaves the queue working", async () => {
  const chat: ChatFn = async (messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const content = String(lastUser?.content ?? "")
    await sleep(5)
    if (content === "boom") throw new Error("LLM exploded")
    return { type: "text", content: `ok: ${content}` }
  }

  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const a = makeConnection({ id: "conn-a" })
  const b = makeConnection({ id: "conn-b" })

  const failing = sessions.submitTurn("boom", a, "text")
  const following = sessions.submitTurn("still here", b, "text")

  await assert.rejects(failing, /LLM exploded/, "the error goes to the caller that submitted it")
  assert.equal(await following, "ok: still here", "the next turn still runs")

  // A third turn afterwards proves the chain was not poisoned.
  assert.equal(await sessions.submitTurn("and again", a, "text"), "ok: and again")

  sessions.shutdown()
})
