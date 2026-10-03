import { Session, type ChatFn, type MessageOrigin } from "./session"
import { InMemorySessionStore, type SessionStore } from "./session-store"
import { cancelConfirmationsFor } from "./confirmation"
import type { ContextWindowLimits } from "./context-window"
import type { Connection } from "./connection"

export type SessionEndReason = "timeout" | "reset" | "shutdown"
export type SessionEndHandler = (session: Session, reason: SessionEndReason) => void

export interface SessionManagerOptions {
  idleTimeoutMs: number
  limits: ContextWindowLimits
  store?: SessionStore
  // Injectable LLM call, for tests. Production uses the real one.
  chat?: ChatFn
  // Passed to every session it creates: the active-preference block, rebuilt
  // per LLM call. See Session.messagesForCall.
  preferenceBlock?: () => string | null
}

// Owns sessions independently of client connections.
//
// The data model is multi-session, but the POLICY in Phase 3a is one shared
// "primary" session: every WebSocket connection, REST request and the REPL
// attaches to it. No session ID crosses the wire, and no client changed.
export class SessionManager {
  private readonly store: SessionStore
  private readonly idleTimeoutMs: number
  private readonly limits: ContextWindowLimits
  private readonly chat?: ChatFn
  private readonly preferenceBlock?: () => string | null
  private readonly endHandlers: SessionEndHandler[] = []
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private primaryId: string | null = null

  constructor(options: SessionManagerOptions) {
    this.store = options.store ?? new InMemorySessionStore()
    this.idleTimeoutMs = options.idleTimeoutMs
    this.limits = options.limits
    this.chat = options.chat
    this.preferenceBlock = options.preferenceBlock
  }

  // The current primary session, created on demand. A session that has ended
  // is never handed back out — the next caller gets a fresh one instead.
  primarySession(): Session {
    const current = this.primaryId ? this.store.get(this.primaryId) : undefined
    if (current && current.endedAt === null) return current
    return this.startPrimarySession()
  }

  private startPrimarySession(): Session {
    const session = new Session({
      limits: this.limits,
      chat: this.chat,
      preferenceBlock: this.preferenceBlock,
    })
    this.store.save(session)
    this.primaryId = session.id
    this.armIdleTimer(session)
    return session
  }

  // Attaches a connection to the primary session and returns it. Transports
  // call this on connect for the side effect; they must NOT cache the result
  // (see submitTurn).
  attach(connection: Connection): Session {
    const session = this.primarySession()
    session.attachedConnections.set(connection.id, connection)
    return session
  }

  // Detaches a connection from every session it is attached to and cancels
  // anything it was asked to confirm. The session itself lives on, including
  // any turn still in flight.
  detach(connectionId: string): void {
    for (const session of this.store.list()) {
      session.attachedConnections.delete(connectionId)
    }
    cancelConfirmationsFor(connectionId)
  }

  // Runs one turn. The session is resolved HERE, on every turn, and never
  // cached by a transport: a connection that stayed attached across an idle
  // timeout lands on the new primary session rather than writing into the
  // ended one.
  async submitTurn(
    input: string,
    connection: Connection,
    origin: MessageOrigin = "text"
  ): Promise<string> {
    const session = this.attach(connection)

    // Disarm while work is outstanding so an in-flight or queued turn can
    // never be timed out underneath itself; re-armed once the session goes
    // quiet again.
    session.pendingTurns++
    this.clearIdleTimer(session.id)

    try {
      return await session.send(input, connection, origin)
    } finally {
      session.pendingTurns--
      if (session.pendingTurns === 0 && session.endedAt === null) {
        session.lastTurnAt = Date.now()
        this.armIdleTimer(session)
      }
    }
  }

  // The existing REST reset (and any other explicit reset): end the current
  // primary session and start a fresh one. Attached connections need do
  // nothing — their next turn resolves the new primary by itself.
  resetPrimary(): Session {
    if (this.primaryId) this.endSession(this.primaryId, "reset")
    return this.startPrimarySession()
  }

  endSession(id: string, reason: SessionEndReason): void {
    const session = this.store.get(id)
    if (!session || session.endedAt !== null) return

    session.endedAt = Date.now()
    this.clearIdleTimer(id)
    if (this.primaryId === id) this.primaryId = null

    for (const handler of this.endHandlers) {
      try {
        handler(session, reason)
      } catch (err) {
        console.error("onSessionEnd handler failed:", err)
      }
    }
  }

  // Called with the ending session whenever a session ends, by idle timeout or
  // by reset.
  onSessionEnd(handler: SessionEndHandler): void {
    this.endHandlers.push(handler)
  }

  getSession(id: string): Session | undefined {
    return this.store.get(id)
  }

  shutdown(): void {
    for (const session of this.store.list()) {
      this.endSession(session.id, "shutdown")
    }
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
  }

  private armIdleTimer(session: Session): void {
    this.clearIdleTimer(session.id)
    const timer = setTimeout(() => {
      // Guard: a turn may have started between the timer firing and this
      // callback running.
      if (session.pendingTurns > 0) {
        this.armIdleTimer(session)
        return
      }
      console.log(`Session ${session.id} ended: idle for ${this.idleTimeoutMs}ms`)
      this.endSession(session.id, "timeout")
    }, this.idleTimeoutMs)

    // An idle session must not be the reason the process stays alive.
    timer.unref?.()
    this.idleTimers.set(session.id, timer)
  }

  private clearIdleTimer(id: string): void {
    const timer = this.idleTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(id)
    }
  }
}
