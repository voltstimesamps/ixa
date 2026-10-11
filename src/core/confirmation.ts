import { randomUUID } from "crypto"
import * as readline from "readline"
import { config } from "../config"
import type { WsMessage } from "../api/types"

// --- Shared stdin line reader ---
//
// A single readline interface owns process.stdin. Both the harness and the
// stdin confirmer read from it through nextLine(). This avoids the conflict
// between Node's stream async iterator (used by the old stdinLines) and
// event listeners added by the confirmer.

type LineResult =
  | { kind: "line"; value: string }
  | { kind: "cancelled" }
  | { kind: "closed" }

interface Waiter {
  resolve: (result: LineResult) => void
  fn: (line: string) => void
}

let _rl: readline.Interface | null = null
const _waiters: Waiter[] = []
const _buf: string[] = []

function ensureReadline(): void {
  if (_rl) return
  _rl = readline.createInterface({ input: process.stdin, terminal: false })
  _rl.on("line", (line) => {
    if (_waiters.length > 0) {
      _waiters.shift()!.fn(line)
    } else {
      _buf.push(line)
    }
  })
  _rl.on("close", () => {
    for (const w of _waiters.splice(0)) w.resolve({ kind: "closed" })
  })
}

function nextLine(): { promise: Promise<LineResult>; cancel: () => void } {
  ensureReadline()

  if (_buf.length > 0) {
    return { promise: Promise.resolve({ kind: "line", value: _buf.shift()! }), cancel: () => {} }
  }

  let waiter!: Waiter
  const promise = new Promise<LineResult>((resolve) => {
    waiter = { resolve, fn: (line) => resolve({ kind: "line", value: line }) }
    _waiters.push(waiter)
  })

  const cancel = () => {
    const idx = _waiters.indexOf(waiter)
    if (idx !== -1) _waiters.splice(idx, 1)
    waiter.resolve({ kind: "cancelled" })
  }

  return { promise, cancel }
}

// Async generator for the harness to iterate over stdin lines.
export async function* stdinLineGenerator(): AsyncGenerator<string> {
  while (true) {
    const { promise } = nextLine()
    const result = await promise
    if (result.kind !== "line") break
    yield result.value
  }
}

// --- Confirmer ---

// Three outcomes, not a boolean: "declined" is the user saying no, while
// "cancelled" is the request going unanswered because the client that was
// asked went away. Both block execution, but they are recorded differently in
// history so the LLM can tell a refusal from an interruption.
export type ConfirmationOutcome = "confirmed" | "declined" | "cancelled"

export type Confirmer = (description: string) => Promise<ConfirmationOutcome>

export async function requestConfirmation(
  confirmer: Confirmer,
  description: string
): Promise<ConfirmationOutcome> {
  return confirmer(description)
}

export function createStdinConfirmer(timeoutMs = config.confirm.timeoutMs): Confirmer {
  return async (description: string): Promise<ConfirmationOutcome> => {
    process.stdout.write(`\n${description}\nConfirm? (yes/no): `)

    let pendingCancel: (() => void) | null = null

    const timer = setTimeout(() => {
      pendingCancel?.()
      process.stdout.write("\nConfirmation timed out, treating as no.\n")
    }, timeoutMs)

    try {
      while (true) {
        const { promise, cancel } = nextLine()
        pendingCancel = cancel

        const result = await promise
        pendingCancel = null

        if (result.kind !== "line") return "declined"

        const normalized = result.value.trim().toLowerCase()
        if (normalized === "yes" || normalized === "y") return "confirmed"
        if (normalized === "no" || normalized === "n") return "declined"
        process.stdout.write("Please type yes or no.\nConfirm? (yes/no): ")
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// --- WebSocket confirmer ---

interface PendingConfirmation {
  // The connection that was asked. Recorded so one client cannot answer
  // another client's prompt, and so a disconnect can cancel exactly the
  // prompts that belong to the socket that closed.
  connectionId: string
  settle: (outcome: ConfirmationOutcome) => void
}

const pendingConfirmations = new Map<string, PendingConfirmation>()

export function createWsConfirmer(
  connectionId: string,
  send: (msg: WsMessage) => void,
  timeoutMs = config.confirm.timeoutMs
): Confirmer {
  return (description: string): Promise<ConfirmationOutcome> =>
    new Promise<ConfirmationOutcome>((resolve) => {
      const requestId = randomUUID()
      let settled = false

      const settle = (outcome: ConfirmationOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pendingConfirmations.delete(requestId)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        console.log("Confirmation timed out, treating as no.")
        settle("declined")
      }, timeoutMs)

      pendingConfirmations.set(requestId, { connectionId, settle })

      // timeoutMs is sent so the client can show the time remaining and
      // decline locally. It is advisory: this timer is still the authority,
      // and a client that ignores the field behaves as it always did.
      send({ type: "confirm", content: description, requestId, timeoutMs })
    })
}

export function resolveConfirmation(
  requestId: string,
  answer: string,
  connectionId: string
): void {
  const pending = pendingConfirmations.get(requestId)
  if (!pending) {
    console.warn(`resolveConfirmation: no pending request for id "${requestId}"`)
    return
  }
  if (pending.connectionId !== connectionId) {
    console.warn(
      `resolveConfirmation: connection "${connectionId}" tried to answer a prompt owned by "${pending.connectionId}" — ignored`
    )
    return
  }
  pending.settle(answer === "yes" ? "confirmed" : "declined")
}

// Called when a connection goes away. Everything it was asked resolves as
// cancelled, so the tool loop stops waiting immediately instead of burning the
// full confirmation timeout against a socket that will never answer.
export function cancelConfirmationsFor(connectionId: string): void {
  for (const [requestId, pending] of pendingConfirmations) {
    if (pending.connectionId !== connectionId) continue
    pendingConfirmations.delete(requestId)
    pending.settle("cancelled")
  }
}

// Test seam: asserts no confirmation outlives the connection that owns it.
export function pendingConfirmationCount(): number {
  return pendingConfirmations.size
}
