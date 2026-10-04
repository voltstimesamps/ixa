import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionManager } from "../src/core/session-manager"
import { SqliteSessionStore } from "../src/core/sqlite-session-store"
import { openDatabase, type Db } from "../src/memory/db"
import type { Message } from "../src/core/llm"
import type { ChatFn } from "../src/core/session"
import { registry, type Tool } from "../src/tools/registry"
import { makeConnection, TEST_LIMITS } from "./helpers"

// What survives a turn that fails: the user's message, and a history the API
// will still accept on the next turn.

function tempDatabase(t: { after: (fn: () => void) => void }): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ixa-resilience-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return openDatabase(path.join(dir, "ixa.db"))
}

function storedMessages(db: Db, id: string): Message[] {
  const row = db.prepare("SELECT messages FROM sessions WHERE id = ?").get(id) as
    | { messages: string }
    | undefined
  return row ? (JSON.parse(row.messages) as Message[]) : []
}

function hasToolCalls(msg: Message): boolean {
  return (
    msg.role === "assistant" &&
    Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls) &&
    ((msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0
  )
}

// The invariant the API enforces: every tool_call in an assistant message has
// a tool message answering it, and every tool message answers a call.
function assertNoDanglingToolCalls(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (!hasToolCalls(msg)) {
      if (msg.role === "tool") {
        assert.fail(`orphan tool result at index ${i}`)
      }
      continue
    }
    const calls = (msg as { tool_calls: Array<{ id: string }> }).tool_calls
    const answers = new Set<string>()
    let j = i + 1
    while (j < messages.length && messages[j]!.role === "tool") {
      answers.add((messages[j] as { tool_call_id: string }).tool_call_id)
      j++
    }
    for (const call of calls) {
      assert.ok(
        answers.has(call.id),
        `tool_call ${call.id} (${JSON.stringify(msg)}) has no result — the API would reject this history`
      )
    }
    i = j - 1
  }
}

test("the user message is persisted before the turn runs, not after", async (t) => {
  const db = tempDatabase(t)
  let seenDuringTurn: Message[] = []
  let sessionId = ""

  // Reads the database from INSIDE the LLM call: at this moment the turn has
  // not produced anything, so whatever is on disk is what a crash here would
  // leave behind.
  const chat: ChatFn = async () => {
    seenDuringTurn = storedMessages(db, sessionId)
    return { type: "text", content: "answered" }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat,
    store: new SqliteSessionStore(db),
  })
  sessionId = sessions.primarySession().id

  await sessions.submitTurn("remember this question", makeConnection(), "text")

  const user = seenDuringTurn.find((m) => m.role === "user")
  assert.ok(user, "the user message was not on disk while the turn was running")
  assert.equal(user.content, "remember this question")
})

test("a turn that fails keeps the user message on disk", async (t) => {
  const db = tempDatabase(t)
  const chat: ChatFn = async () => {
    throw new Error("LLM call aborted: no chunk for 15000ms (stream inactivity)")
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat,
    store: new SqliteSessionStore(db),
  })
  const sessionId = sessions.primarySession().id

  await assert.rejects(
    sessions.submitTurn("what is the weather", makeConnection(), "text"),
    /stream inactivity/
  )

  const stored = storedMessages(db, sessionId)
  assert.ok(
    stored.some((m) => m.role === "user" && m.content === "what is the weather"),
    `the question was lost: ${JSON.stringify(stored)}`
  )
  assertNoDanglingToolCalls(stored)
})

test("a failure mid tool-call group leaves the group complete and truthful", async (t) => {
  const db = tempDatabase(t)

  let ran = 0
  const sideEffecting: Tool = {
    name: "test_side_effect",
    description: "records that it ran",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: true,
    execute: async () => {
      ran++
      return "DID THE THING"
    },
  }

  // Confirms the first call, then throws — standing in for any failure that
  // escapes the tool loop partway through a group (an aborted turn, a
  // transport that died mid-confirmation).
  let asked = 0
  const connection = makeConnection({
    confirmer: async () => {
      asked++
      if (asked === 1) return "confirmed"
      throw new Error("connection died mid-group")
    },
  })

  const chat: ChatFn = async () => ({
    type: "tool_calls",
    calls: [
      { id: "call-ran", name: "test_side_effect", arguments: "{}" },
      { id: "call-never", name: "test_side_effect", arguments: "{}" },
    ],
  })

  registry.register(sideEffecting)

  {
    const sessions = new SessionManager({
      idleTimeoutMs: 60_000,
      limits: TEST_LIMITS,
      chat,
      store: new SqliteSessionStore(db),
    })
    const sessionId = sessions.primarySession().id

    await assert.rejects(
      sessions.submitTurn("do both things", connection, "text"),
      /connection died mid-group/
    )

    const stored = storedMessages(db, sessionId)

    // The question survives.
    assert.ok(stored.some((m) => m.role === "user" && m.content === "do both things"))

    // The group is complete, so the next turn can be sent at all.
    assertNoDanglingToolCalls(stored)

    // The call that ran keeps its REAL result: it had side effects, and the
    // model has to be able to see that.
    assert.equal(ran, 1)
    const executed = stored.find(
      (m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "call-ran"
    )
    assert.ok(executed)
    assert.match(String(executed.content), /DID THE THING/)

    // The call that never ran says so, in as many words.
    const skipped = stored.find(
      (m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "call-never"
    )
    assert.ok(skipped)
    assert.match(String(skipped.content), /not executed/)
    assert.match(String(skipped.content), /Nothing happened/)
  }
})

test("the session keeps working after a failed turn", async (t) => {
  const db = tempDatabase(t)
  let calls = 0
  const chat: ChatFn = async () => {
    calls++
    if (calls === 1) throw new Error("LLM call aborted: call exceeded 120000ms")
    return { type: "text", content: "second time lucky" }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat,
    store: new SqliteSessionStore(db),
  })
  const sessionId = sessions.primarySession().id
  const connection = makeConnection()

  await assert.rejects(sessions.submitTurn("first", connection, "text"))
  const reply = await sessions.submitTurn("second", connection, "text")

  assert.equal(reply, "second time lucky")
  // Same session: a failed turn does not end the conversation.
  assert.equal(sessions.primarySession().id, sessionId)

  const stored = storedMessages(db, sessionId)
  assert.ok(stored.some((m) => m.role === "user" && m.content === "first"))
  assert.ok(stored.some((m) => m.role === "user" && m.content === "second"))
  assertNoDanglingToolCalls(stored)
})
