import type { Session } from "./session"
import type { Message } from "./llm"

// The serializable half of a Session. Connections, pending confirmations, the
// turn chain and audio state are deliberately absent: they belong to a process
// and a socket, and restoring them would be restoring something that is gone.
export interface PersistedSession {
  id: string
  createdAt: number
  lastTurnAt: number
  endedAt: number | null
  workingDirectory: string
  messages: Message[]
}

// Session persistence sits behind this interface so Phase 3b can add a SQLite
// implementation without touching the SessionManager or any transport.
export interface SessionStore {
  get(id: string): Session | undefined
  save(session: Session): void
  delete(id: string): void
  list(): Session[]

  // Live sessions written by a previous process, newest turn first. Only a
  // durable store has anything to return, hence optional; the manager turns
  // these records back into Sessions, so the store never needs to know how a
  // Session is built.
  loadPersisted?(): PersistedSession[]
}

// In-memory implementation: sessions do not survive a backend restart. That is
// expected for Phase 3a — the gap this phase closes is reconnects, not restarts.
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>()

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  save(session: Session): void {
    this.sessions.set(session.id, session)
  }

  delete(id: string): void {
    this.sessions.delete(id)
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
  }
}
