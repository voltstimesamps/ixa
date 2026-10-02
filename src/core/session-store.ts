import type { Session } from "./session"

// Session persistence sits behind this interface so Phase 3b can add a SQLite
// implementation without touching the SessionManager or any transport.
export interface SessionStore {
  get(id: string): Session | undefined
  save(session: Session): void
  delete(id: string): void
  list(): Session[]
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
