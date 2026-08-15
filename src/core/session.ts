import os from "os"
import path from "path"
import { chat, type LLMResponse, Message } from "./llm"
import { registry } from "../tools/registry"
import { type Confirmer, requestConfirmation } from "./confirmation"

const SYSTEM_PROMPT =
  "You are Ixa, a personal AI operating system. You are direct, concise, and capable. " +
  "You have access to tools and must use them when they are relevant:\n" +
  "- web_search: search the web for current events, news, facts, or anything that may have changed recently. " +
  "Use this whenever the user asks about real-world information, news, or specific facts.\n" +
  "- get_time: return the current local time.\n" +
  "- get_date: return today's date.\n" +
  "- echo: repeat text back.\n" +
  "When a tool is available that can answer the user's question, use it — do not claim you lack the ability. " +
  "For purely conversational messages with no informational need, respond directly without tools."

const DESCRIBE_ACTION_PROMPT =
  "You are describing an action about to be taken by an AI assistant. " +
  "Describe it in one clear, specific sentence from the perspective of the assistant. " +
  "Be concrete about what will happen — include relevant details like recipient, subject, " +
  "or target from the context. Do not ask for confirmation yourself."

export class Session {
  private readonly messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }]
  private readonly confirmer: Confirmer
  private workingDirectory: string = os.homedir()

  constructor(confirmer: Confirmer) {
    this.confirmer = confirmer
  }

  async send(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput })
    return this.runToolLoop()
  }

  private async generateDescription(toolName: string, args: string): Promise<string> {
    try {
      const context = this.messages.slice(-6)
      const describeMessages: Message[] = [
        { role: "system", content: DESCRIBE_ACTION_PROMPT },
        ...context,
        {
          role: "user",
          content: `Tool: ${toolName}\nArguments: ${args}\nDescribe what this action will do.`,
        },
      ]
      const response = await chat(describeMessages, [], { silent: true })
      if (response.type === "text" && response.content) {
        return response.content
      }
    } catch {
      // fall through to fallback
    }
    return `Run tool '${toolName}' with arguments: ${args}`
  }

  private async runToolLoop(): Promise<string> {
    const tools = registry.toOpenAI()
    let retrying = false

    for (let i = 0; i < 10; i++) {
      // On retry after a malformed tool call, pass no tools — forces a plain text response
      let response: LLMResponse
      try {
        response = await chat(this.messages, retrying ? [] : tools)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!retrying && (
          msg.toLowerCase().includes("failed to call a function") ||
          msg.toLowerCase().includes("tool call validation failed") ||
          msg.toLowerCase().includes("malformed tool call")
        )) {
          retrying = true
          continue
        }
        throw err
      }

      if (response.type === "text") {
        if (response.content) {
          this.messages.push({ role: "assistant", content: response.content })
        }
        return response.content
      }

      // Validate argument JSON for every call before touching message history.
      // If any call is unparseable and we haven't retried yet, discard this
      // iteration and retry without tools.
      let anyParseFailure = false
      for (const tc of response.calls) {
        try {
          JSON.parse(tc.arguments || "{}")
        } catch {
          anyParseFailure = true
          break
        }
      }

      if (anyParseFailure && !retrying) {
        retrying = true
        continue
      }

      this.messages.push({
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

        if (tool && (tool.name === "shell_read" || tool.name === "shell_write")) {
          try {
            const parsed = JSON.parse(tc.arguments || "{}") as Record<string, unknown>
            tc.arguments = JSON.stringify({ ...parsed, cwd: this.workingDirectory })
          } catch {
            // leave arguments unchanged if they're unparseable
          }
        }

        if (!tool) {
          result = JSON.stringify({ error: `Unknown tool: ${tc.name}` })
        } else if (tool.requiresConfirmation) {
          const description = await this.generateDescription(tc.name, tc.arguments)
          const confirmed = await requestConfirmation(this.confirmer, description)
          if (!confirmed) {
            result = "Action declined by user."
          } else {
            try {
              const input = JSON.parse(tc.arguments || "{}")
              const output = await tool.execute(input)
              result = typeof output === "string" ? output : JSON.stringify(output)
            } catch (err) {
              result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
            }
          }
        } else {
          try {
            const input = JSON.parse(tc.arguments || "{}")
            const output = await tool.execute(input)
            result = typeof output === "string" ? output : JSON.stringify(output)
          } catch (err) {
            result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
          }
        }

        if (tool?.name === "shell_write") {
          try {
            const parsed = JSON.parse(result) as { newCwd?: string; display?: string }
            if (parsed.newCwd) {
              this.workingDirectory = path.resolve(parsed.newCwd)
              result = parsed.display ?? result
            }
          } catch {
            // not a cd result, use result as-is
          }
        }

        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        })
      }
    }

    throw new Error("Tool call limit (10) reached")
  }
}
