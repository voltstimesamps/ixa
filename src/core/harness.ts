import { chat, Message } from "./llm"
import { registry } from "../tools/registry"
import { timeTool } from "../tools/time"
import { dateTool } from "../tools/date"
import { echoTool } from "../tools/echo"

registry.register(timeTool)
registry.register(dateTool)
registry.register(echoTool)

const SYSTEM_PROMPT =
  "You are Ixa, a personal AI operating system. You are direct, concise, and capable. " +
  "You're running in text mode. Respond naturally and helpfully."

async function* stdinLines(): AsyncGenerator<string> {
  let buf = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    buf += chunk as string
    let nl: number
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl).replace(/\r$/, "")
      buf = buf.slice(nl + 1)
    }
  }
  if (buf) yield buf.replace(/\r$/, "")
}

async function runToolLoop(messages: Message[]): Promise<void> {
  const tools = registry.toOpenAI()

  for (let i = 0; i < 10; i++) {
    const response = await chat(messages, tools)

    if (response.type === "text") {
      if (response.content) {
        messages.push({ role: "assistant", content: response.content })
      }
      return
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: response.calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    for (const tc of response.calls) {
      const tool = registry.get(tc.name)
      let result: string

      if (!tool) {
        result = JSON.stringify({ error: `Unknown tool: ${tc.name}` })
      } else {
        try {
          const input = JSON.parse(tc.arguments || "{}")
          const output = await tool.execute(input)
          result = typeof output === "string" ? output : JSON.stringify(output)
        } catch (err) {
          result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      })
    }
  }

  throw new Error("Tool call limit (10) reached")
}

export async function runHarness(): Promise<void> {
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }]

  process.on("SIGINT", () => {
    console.log("\nGoodbye.")
    process.exit(0)
  })

  console.log("Ixa ready. Type to chat, Ctrl+C to exit.\n")
  process.stdout.write("You: ")

  for await (const line of stdinLines()) {
    const trimmed = line.trim()
    if (!trimmed) {
      process.stdout.write("You: ")
      continue
    }

    messages.push({ role: "user", content: trimmed })

    try {
      await runToolLoop(messages)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\nError: ${msg}\n`)
    }

    process.stdout.write("You: ")
  }

  console.log("\nGoodbye.")
}
