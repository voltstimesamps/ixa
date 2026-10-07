// The verification scripts' read-only view of what the backend actually
// recorded.
//
// Tool calls are verified from the PERSISTED SESSION HISTORY in SQLite, not
// from the reply text: a model saying "I searched my memory" is exactly the
// claim under test, so the evidence has to be the recorded tool_calls. Same
// for the spoken-length backstop — the bracketed note it leaves in history is
// the evidence that it fired, rather than a line of stdout.
import Database from "better-sqlite3"
import { config } from "../../../src/config"

// --------------------------------------------------------------- SQLite view

export interface SessionRow {
  id: string
  created_at: number
  last_turn_at: number
  ended_at: number | null
  messages: string
}

export interface StoredMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

export function withDb<T>(run: (db: Database.Database) => T): T {
  const db = new Database(config.data.dbPath, { readonly: true })
  try {
    return run(db)
  } finally {
    db.close()
  }
}

export function sessionRows(): SessionRow[] {
  return withDb((db) =>
    db
      .prepare("SELECT id, created_at, last_turn_at, ended_at, messages FROM sessions ORDER BY created_at")
      .all() as SessionRow[]
  )
}

export function messagesOf(row: SessionRow): StoredMessage[] {
  try {
    return JSON.parse(row.messages) as StoredMessage[]
  } catch {
    return []
  }
}

// Every tool name called since the LAST user message — this turn's calls, not
// the session's. A check that reads the whole session passes on a call some
// earlier turn made, which is how an empty reply once "passed" a check that
// a web_search had happened.
export function toolCallsInLastTurn(row: SessionRow): string[] {
  const messages = messagesOf(row)
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i
      break
    }
  }
  return messages
    .slice(lastUser + 1)
    .flatMap((message) => (message.tool_calls ?? []).map((call) => call.function?.name ?? "?"))
}

// Every result one named tool returned in this session, oldest first.
//
// Paired by tool_call_id rather than by position: a turn can carry several
// parallel calls, so the result that follows a call in the array is not
// necessarily that call's.
//
// What this is for: a time already in the conversation is the value the model
// preferred over a fresh one, so measuring that failure means knowing exactly
// which values were on offer. The reply text cannot say — "eight forty-three"
// is a real time either way, and only the recorded results show it was one
// get_time returned eighteen minutes earlier.
export function toolResultsIn(row: SessionRow, name: string): string[] {
  const messages = messagesOf(row)
  const wanted = new Set<string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name === name && call.id) wanted.add(call.id)
    }
  }
  const results: string[] = []
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue
    if (!wanted.has(message.tool_call_id)) continue
    if (typeof message.content === "string") results.push(message.content)
  }
  return results
}

// Every tool name the session called, in order.
export function toolCallsIn(row: SessionRow): string[] {
  return messagesOf(row).flatMap((message) =>
    (message.tool_calls ?? []).map((call) => call.function?.name ?? "?")
  )
}

export function liveSession(): SessionRow | undefined {
  return sessionRows().filter((row) => row.ended_at === null).at(-1)
}

export function episodeRows(): Array<{ id: number; session_id: string; summary: string; indexed_at: number | null }> {
  return withDb(
    (db) =>
      db.prepare("SELECT id, session_id, summary, indexed_at FROM episodes ORDER BY id").all() as Array<{
        id: number
        session_id: string
        summary: string
        indexed_at: number | null
      }>
  )
}
