import type { Db } from "../memory/db"
import type { Message } from "./llm"
import type { Session } from "./session"
import type { PersistedSession, SessionStore } from "./session-store"

// Durable session storage.
//
// This is a write-through cache, not a rehydration layer. The live Session
// objects stay in memory exactly as the in-memory store keeps them — get()
// must return the SAME object, or a transport's attached connections, its
// in-flight turn chain and its pending-turn count would be silently replaced
// by copies. save() additionally writes the serializable half to SQLite.
//
// Nothing here persists connections, pending confirmations or audio state.
export class SqliteSessionStore implements SessionStore {
  private readonly db: Db
  private readonly live = new Map<string, Session>()

  constructor(db: Db) {
    this.db = db
  }

  get(id: string): Session | undefined {
    return this.live.get(id)
  }

  save(session: Session): void {
    this.live.set(session.id, session)
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, last_turn_at, ended_at, working_directory, messages)
         VALUES (@id, @createdAt, @lastTurnAt, @endedAt, @workingDirectory, @messages)
         ON CONFLICT(id) DO UPDATE SET
           last_turn_at      = excluded.last_turn_at,
           ended_at          = excluded.ended_at,
           working_directory = excluded.working_directory,
           messages          = excluded.messages`
      )
      .run({
        id: session.id,
        createdAt: session.createdAt,
        lastTurnAt: session.lastTurnAt,
        endedAt: session.endedAt,
        workingDirectory: session.workingDirectory,
        messages: JSON.stringify(session.history()),
      })
  }

  delete(id: string): void {
    this.live.delete(id)
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
  }

  list(): Session[] {
    return Array.from(this.live.values())
  }

  loadPersisted(): PersistedSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, last_turn_at, ended_at, working_directory, messages
         FROM sessions WHERE ended_at IS NULL ORDER BY last_turn_at DESC`
      )
      .all() as Array<{
      id: string
      created_at: number
      last_turn_at: number
      ended_at: number | null
      working_directory: string
      messages: string
    }>

    const restored: PersistedSession[] = []
    for (const row of rows) {
      let messages: Message[]
      try {
        messages = JSON.parse(row.messages) as Message[]
      } catch {
        // A corrupt history row must not take the backend down at startup.
        // Skipping it loses that conversation and nothing else.
        console.warn(`sessions: skipping ${row.id}, stored history is not valid JSON`)
        continue
      }
      restored.push({
        id: row.id,
        createdAt: row.created_at,
        lastTurnAt: row.last_turn_at,
        endedAt: row.ended_at,
        workingDirectory: row.working_directory,
        messages,
      })
    }
    return restored
  }
}
