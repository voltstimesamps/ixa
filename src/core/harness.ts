import { createStdinConfirmer, stdinLineGenerator } from "./confirmation"
import type { SessionManager } from "./session-manager"
import type { Connection } from "./connection"

export async function runHarness(sessions: SessionManager): Promise<void> {
  // The REPL is just another connection onto the shared primary session.
  const connection: Connection = {
    id: "repl",
    confirmer: createStdinConfirmer(),
    isOpen: true,
    send: () => {},
    sendBinary: () => {},
  }

  process.on("SIGINT", () => {
    console.log("\nGoodbye.")
    process.exit(0)
  })

  console.log("Ixa ready. Type to chat, Ctrl+C to exit.\n")
  process.stdout.write("You: ")

  for await (const line of stdinLineGenerator()) {
    const trimmed = line.trim()
    if (!trimmed) {
      process.stdout.write("You: ")
      continue
    }

    try {
      await sessions.submitTurn(trimmed, connection, "text")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\nError: ${msg}\n`)
    }

    process.stdout.write("You: ")
  }

  console.log("\nGoodbye.")
}
