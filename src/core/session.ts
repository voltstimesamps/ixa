import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { chat as defaultChat, type LLMResponse, Message } from "./llm"
import { registry } from "../tools/registry"
import { requestConfirmation } from "./confirmation"
import { buildWindow, type ContextWindowLimits } from "./context-window"
import type { Connection } from "./connection"

const SYSTEM_PROMPT =
  "You are Ixa, a personal AI operating system. You are direct, concise, and capable. " +
  "You have access to tools and must use them when they are relevant:\n" +
  "- web_search: search the web for current events, news, facts, or anything that may have changed recently. " +
  "Use this whenever the user asks about real-world information, news, or specific facts.\n" +
  "- get_time: return the current local time.\n" +
  "- get_date: return today's date.\n" +
  "- echo: repeat text back.\n" +
  "Use tools whenever they are the right way to fulfill the user's request. " +
  "Use shell_read for any filesystem, process, or system inspection tasks. " +
  "Use shell_write for any filesystem modifications or directory changes. " +
  "Use web_search for current events or facts you are uncertain about. " +
  "For purely conversational messages with no action required, respond directly without tools. " +
  "When reading file contents, prefer head -n 50 over cat to avoid large outputs unless the user explicitly asks for the full file."

const DESCRIBE_ACTION_PROMPT =
  "You are describing an action about to be taken by an AI assistant. " +
  "Describe it in one clear, specific sentence from the perspective of the assistant. " +
  "Be concrete about what will happen — include relevant details like recipient, subject, " +
  "or target from the context. Do not ask for confirmation yourself."

const VOICE_RESPONSE_PROMPT =
  "You are responding to a voice conversation. This response will be spoken aloud by a " +
  "text-to-speech system, not displayed as text. Keep your response concise — a few sentences " +
  "at most unless the user is explicitly asking for something that requires more detail (e.g. " +
  "reciting a list they asked for). Do not use markdown formatting, code blocks, bullet points, " +
  "headers, or any other visual formatting — write in plain spoken sentences only, since none of " +
  "that renders in speech. If the user's request genuinely requires a long or code-heavy answer, " +
  "say so briefly and ask if they'd like you to continue rather than producing a full " +
  "essay-length spoken response."

export type MessageOrigin = "voice" | "text"

// The LLM call, injectable so tests can drive the tool loop without a network
// round trip. Production always gets the real one.
export type ChatFn = typeof defaultChat

export interface SessionOptions {
  limits: ContextWindowLimits
  chat?: ChatFn
}

export class Session {
  readonly id: string = randomUUID()
  readonly createdAt: number = Date.now()
  lastTurnAt: number = Date.now()
  endedAt: number | null = null

  // Clients currently attached. A session is perfectly valid with none — that
  // is the whole point of Phase 3a.
  readonly attachedConnections = new Map<string, Connection>()

  // Turns submitted but not yet finished, including queued ones. The manager
  // reads this to keep the idle timer disarmed while work is outstanding.
  pendingTurns = 0

  private readonly messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }]
  private workingDirectory: string = process.env.HOME ?? os.homedir()
  private readonly limits: ContextWindowLimits
  private readonly chat: ChatFn

  // Turn serialization. Every turn chains onto the previous one, so only one
  // tool loop at a time ever appends to `messages`. Two concurrent loops would
  // interleave their assistant/tool messages and produce a history where a
  // tool result no longer follows its call — which the API rejects outright.
  private turnChain: Promise<unknown> = Promise.resolve()

  constructor(options: SessionOptions) {
    this.limits = options.limits
    this.chat = options.chat ?? defaultChat
  }

  // Queues a turn behind any turn already running on this session, whichever
  // connection it came from. The returned promise settles with THIS turn's
  // outcome; a turn that throws is isolated to its own caller and does not
  // break the queue for the turns behind it.
  send(
    userInput: string,
    connection: Connection,
    origin: MessageOrigin = "text"
  ): Promise<string> {
    const run = async (): Promise<string> => {
      this.messages.push({ role: "user", content: userInput })
      return this.runToolLoop(origin, connection)
    }

    const result = this.turnChain.then(run, run)
    this.turnChain = result.catch(() => {})
    return result
  }

  // A read-only view of stored history, for the manager, tests, and the
  // Phase 3c summarizer. Stored history itself is never handed out.
  history(): readonly Message[] {
    return [...this.messages]
  }

  private async generateDescription(toolName: string, args: string): Promise<string> {
    try {
      // A blind slice can start in the middle of a tool-call group and send a
      // tool result with no matching call, which the API rejects. Window it.
      const context = buildWindow(this.messages, {
        maxMessages: Math.min(6, this.limits.maxMessages),
        budgetChars: this.limits.budgetChars,
      }).filter((msg) => msg.role !== "system")
      const describeMessages: Message[] = [
        { role: "system", content: DESCRIBE_ACTION_PROMPT },
        ...context,
        {
          role: "user",
          content: `Tool: ${toolName}\nArguments: ${args}\nDescribe what this action will do.`,
        },
      ]
      const response = await this.chat(describeMessages, [], { silent: true })
      if (response.type === "text" && response.content) {
        return response.content
      }
    } catch {
      // fall through to fallback
    }
    return `Run tool '${toolName}' with arguments: ${args}`
  }

  // Builds the message array for one LLM call. Always a new array: stored
  // history is the record and is never trimmed or mutated here.
  //
  // The voice constraint is appended AFTER windowing on purpose — it is an
  // instruction about this reply, not history, so the budget must never be
  // able to drop it.
  private messagesForCall(origin: MessageOrigin): Message[] {
    const windowed = buildWindow(this.messages, this.limits)
    if (origin !== "voice") return windowed
    return [...windowed, { role: "system", content: VOICE_RESPONSE_PROMPT }]
  }

  private async runToolLoop(origin: MessageOrigin, connection: Connection): Promise<string> {
    const tools = registry.toOpenAI()
    let retrying = false

    for (let i = 0; i < 10; i++) {
      // On retry after a malformed tool call, pass no tools — forces a plain text response
      let response: LLMResponse
      try {
        response = await this.chat(this.messagesForCall(origin), retrying ? [] : tools)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!retrying && (
          msg.toLowerCase().includes("failed to call a function") ||
          msg.toLowerCase().includes("tool call validation failed") ||
          msg.toLowerCase().includes("malformed tool call") ||
          msg.toLowerCase().includes("parsing failed") ||
          msg.toLowerCase().includes("could not be parsed")
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
          const outcome = await requestConfirmation(connection.confirmer, description)
          if (outcome === "cancelled") {
            // Recorded distinctly from a decline so the LLM knows the action
            // did not happen because the asking client vanished, not because
            // the user refused. Nothing executed either way.
            result =
              "Action cancelled: the client that requested it disconnected before confirming. " +
              "Nothing was executed."
          } else if (outcome === "declined") {
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
