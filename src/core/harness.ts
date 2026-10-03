import { createStdinConfirmer, stdinLineGenerator } from "./confirmation"
import type { SessionManager } from "./session-manager"
import type { Connection } from "./connection"

// REPL commands handled locally, never sent to the LLM. "/reset" typed at the
// prompt used to go out as a user message, and the model would answer
// "Conversation reset. All previous context cleared" without a thing having
// happened — a believable lie, which is worse than an error. It now goes
// through the same SessionManager.resetPrimary() that POST /reset and the
// start_new_conversation tool use.
//
// Returns true when the line was a local command and must not be sent on.
// Anything that is not a known command is left alone and reaches the LLM as
// typed, so this cannot silently swallow a real message.
export function handleLocalCommand(line: string, sessions: SessionManager): boolean {
  if (line.trim().toLowerCase() !== "/reset") return false

  const session = sessions.resetPrimary()
  console.log(`\nConversation ended. New session ${session.id}.\n`)
  return true
}

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

    if (handleLocalCommand(trimmed, sessions)) {
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
