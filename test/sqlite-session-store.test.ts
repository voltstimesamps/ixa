import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionManager, type SessionEndReason } from "../src/core/session-manager"
import { SqliteSessionStore } from "../src/core/sqlite-session-store"
import { openDatabase, type Db } from "../src/memory/db"
import type { ChatFn, Session } from "../src/core/session"
import { makeConnection, TEST_LIMITS } from "./helpers"

const echoChat: ChatFn = async (messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
}

// A real file on disk, not :memory: — the whole point is surviving a process.
function tempDatabase(t: { after: (fn: () => void) => void }): { path: string; open: () => Db } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ixa-sessions-"))
  const file = path.join(dir, "ixa.db")
  const open = () => openDatabase(file)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { path: file, open }
}

test("a session round trips through the database file", async (t) => {
  const db = tempDatabase(t)

  const first = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  const connection = makeConnection({ id: "conn-roundtrip" })
  await first.submitTurn("the number is seven", connection, "text")
  const before = first.primarySession()

  // A second manager over the same file stands in for a backend restart.
  const second = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  const restored = second.restorePrimary()

  assert.ok(restored, "a live session was restored")
  assert.equal(restored!.id, before.id, "the same session id")
  assert.equal(restored!.createdAt, before.createdAt)
  assert.equal(restored!.lastTurnAt, before.lastTurnAt)
  assert.equal(restored!.endedAt, null)
  assert.deepEqual(
    restored!.history().map((m) => m.content),
    before.history().map((m) => m.content),
    "history came back intact",
  )
  assert.equal(second.primarySession().id, before.id, "and it is the primary session")

  // It is a working session, not a read-only snapshot.
  await second.submitTurn("what was the number?", connection, "text")
  assert.ok(
    second.primarySession().history().some((m) => String(m.content).includes("the number is seven")),
    "the restored session keeps answering with its old context",
  )

  first.shutdown()
  second.shutdown()
})

test("only serializable state is persisted", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(handle),
  })
  const connection = makeConnection({ id: "conn-serializable" })
  await sessions.submitTurn("hello", connection, "text")
  const session = sessions.primarySession()

  assert.ok(session.attachedConnections.has("conn-serializable"), "the connection is attached")

  const row = handle.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<
    string,
    unknown
  >
  assert.deepEqual(
    Object.keys(row).sort(),
    ["created_at", "ended_at", "id", "last_turn_at", "messages", "working_directory"],
    "no column exists for connections, confirmations or audio state",
  )
  assert.doesNotMatch(String(row.messages), /conn-serializable/)

  const restored = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  }).restorePrimary()!
  assert.equal(restored.attachedConnections.size, 0, "a restored session has no connections")
  assert.equal(restored.pendingTurns, 0, "and no turns in flight")

  sessions.shutdown()
})

test("the working directory is restored with the session", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(handle),
  })
  await sessions.submitTurn("hello", makeConnection({ id: "conn-cwd" }), "text")
  const id = sessions.primarySession().id

  // Stand in for a `cd` during the session.
  handle.prepare("UPDATE sessions SET working_directory = ? WHERE id = ?").run("/tmp/somewhere", id)

  const restored = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  }).restorePrimary()!
  assert.equal(restored.workingDirectory, "/tmp/somewhere")

  sessions.shutdown()
})

test("history is written after each completed turn", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(handle),
  })
  const connection = makeConnection({ id: "conn-writes" })

  const stored = (): unknown[] => {
    const row = handle.prepare("SELECT messages FROM sessions LIMIT 1").get() as
      | { messages: string }
      | undefined
    return row ? (JSON.parse(row.messages) as unknown[]) : []
  }

  // Sessions are created on demand; asking for the primary creates and stores it.
  sessions.primarySession()
  assert.equal(stored().length, 1, "a new session is stored with just its system prompt")

  await sessions.submitTurn("one", connection, "text")
  assert.equal(stored().length, 3, "system + user + assistant after the first turn")

  await sessions.submitTurn("two", connection, "text")
  assert.equal(stored().length, 5, "and grows by one turn at a time")

  sessions.shutdown()
})

test("a session still inside its idle timeout is restored, with the clock resumed", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(handle),
  })
  await sessions.submitTurn("remember seven", makeConnection({ id: "conn-fresh" }), "text")
  const id = sessions.primarySession().id
  sessions.shutdown()

  // Idle for 50s of a 60s timeout: restored, with ~10s left on the clock.
  handle
    .prepare("UPDATE sessions SET last_turn_at = ?, ended_at = NULL WHERE id = ?")
    .run(Date.now() - 50_000, id)

  const ended: SessionEndReason[] = []
  const next = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  next.onSessionEnd((_session, reason) => ended.push(reason))

  const restored = next.restorePrimary()
  assert.ok(restored, "restored rather than expired")
  assert.equal(restored!.id, id)
  assert.deepEqual(ended, [], "nothing ended")

  next.shutdown()
})

test("a session past its idle timeout starts fresh and fires onSessionEnd", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(handle),
  })
  await sessions.submitTurn("remember seven", makeConnection({ id: "conn-expired" }), "text")
  const id = sessions.primarySession().id
  sessions.shutdown()

  // Idle for 90s of a 60s timeout: expired while the backend was down.
  handle
    .prepare("UPDATE sessions SET last_turn_at = ?, ended_at = NULL WHERE id = ?")
    .run(Date.now() - 90_000, id)

  const ended: Array<{ session: Session; reason: SessionEndReason }> = []
  const next = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  next.onSessionEnd((session, reason) => ended.push({ session, reason }))

  const restored = next.restorePrimary()
  assert.equal(restored, null, "nothing was restored")
  assert.equal(ended.length, 1, "onSessionEnd fired for the expired session")
  assert.equal(ended[0]!.reason, "timeout")
  assert.equal(ended[0]!.session.id, id)
  assert.ok(
    ended[0]!.session.history().some((m) => String(m.content).includes("remember seven")),
    "the handler gets the real history, which Phase 3c will summarize",
  )

  const fresh = next.primarySession()
  assert.notEqual(fresh.id, id, "the next turn lands on a new session")
  assert.equal(
    fresh.history().some((m) => String(m.content).includes("remember seven")),
    false,
    "with none of the expired session's context",
  )
  assert.notEqual(
    (handle.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: number })
      .ended_at,
    null,
    "the expiry is recorded, so the next restart does not reconsider it",
  )

  next.shutdown()
})

test("leftover live sessions from a crash are closed out, not resumed", async (t) => {
  const db = tempDatabase(t)
  const handle = db.open()
  const now = Date.now()

  const insert = handle.prepare(
    `INSERT INTO sessions (id, created_at, last_turn_at, ended_at, working_directory, messages)
     VALUES (?, ?, ?, NULL, '/tmp', '[]')`,
  )
  insert.run("older", now - 20_000, now - 20_000)
  insert.run("newest", now - 1_000, now - 1_000)

  const ended: string[] = []
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  sessions.onSessionEnd((session) => ended.push(session.id))

  const restored = sessions.restorePrimary()
  assert.equal(restored!.id, "newest", "the most recent one is resumed")
  assert.deepEqual(ended, ["older"], "the other is ended rather than left live")

  sessions.shutdown()
})

test("an empty database restores nothing and says so", (t) => {
  const db = tempDatabase(t)
  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: echoChat,
    store: new SqliteSessionStore(db.open()),
  })
  assert.equal(sessions.restorePrimary(), null)
  assert.ok(sessions.primarySession(), "a fresh primary is still available on demand")
  sessions.shutdown()
})

test("a corrupt history row is skipped instead of taking startup down", (t) => {
  const db = tempDatabase(t)
  const handle = db.open()
  handle
    .prepare(
      `INSERT INTO sessions (id, created_at, last_turn_at, ended_at, working_directory, messages)
       VALUES ('broken', ?, ?, NULL, '/tmp', 'not json')`,
    )
    .run(Date.now(), Date.now())

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
  try {
    const sessions = new SessionManager({
      idleTimeoutMs: 60_000,
      limits: TEST_LIMITS,
      chat: echoChat,
      store: new SqliteSessionStore(db.open()),
    })
    assert.equal(sessions.restorePrimary(), null)
    sessions.shutdown()
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /skipping broken/)
})

test("the in-memory store is unaffected and has nothing to restore", (t) => {
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: echoChat })
  assert.equal(sessions.restorePrimary(), null, "loadPersisted is optional")
  sessions.shutdown()
})
