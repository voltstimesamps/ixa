import { Session } from "./session"
import { createStdinConfirmer, stdinLineGenerator } from "./confirmation"
export async function runHarness(): Promise<void> {
  const session = new Session(createStdinConfirmer())

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
      await session.send(trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\nError: ${msg}\n`)
    }

    process.stdout.write("You: ")
  }

  console.log("\nGoodbye.")
}
