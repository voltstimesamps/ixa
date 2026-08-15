import { randomUUID } from "crypto"
import * as readline from "readline"
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

export type Confirmer = (description: string) => Promise<boolean>

export async function requestConfirmation(
  confirmer: Confirmer,
  description: string
): Promise<boolean> {
  return confirmer(description)
}

export function createStdinConfirmer(timeoutMs = 30_000): Confirmer {
  return async (description: string): Promise<boolean> => {
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

        if (result.kind !== "line") return false

        const normalized = result.value.trim().toLowerCase()
        if (normalized === "yes" || normalized === "y") return true
        if (normalized === "no" || normalized === "n") return false
        process.stdout.write("Please type yes or no.\nConfirm? (yes/no): ")
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// --- WebSocket confirmer ---

const pendingConfirmations = new Map<string, (answer: string) => void>()

export function createWsConfirmer(
  send: (msg: WsMessage) => void,
  timeoutMs = 30_000
): Confirmer {
  return (description: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const requestId = randomUUID()
      let settled = false

      const settle = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pendingConfirmations.delete(requestId)
        resolve(value)
      }

      const timer = setTimeout(() => {
        console.log("Confirmation timed out, treating as no.")
        settle(false)
      }, timeoutMs)

      pendingConfirmations.set(requestId, (answer: string) => {
        settle(answer === "yes")
      })

      send({ type: "confirm", content: description, requestId })
    })
}

export function resolveConfirmation(requestId: string, answer: string): void {
  const resolver = pendingConfirmations.get(requestId)
  if (!resolver) {
    console.warn(`resolveConfirmation: no pending request for id "${requestId}"`)
    return
  }
  resolver(answer)
}
