import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { chat as defaultChat, type LLMResponse, Message } from "./llm"
import { registry } from "../tools/registry"
import { requestConfirmation } from "./confirmation"
import { buildWindow, type ContextWindowLimits } from "./context-window"
import { runWithSessionControl } from "./session-context"
import type { Connection } from "./connection"
import type { PersistedSession } from "./session-store"

// Behavioural guidance only. The per-tool list that used to live here
// (web_search, get_time, get_date, echo, the shell tools) duplicated the tool
// registry, and a duplicate goes stale: the registry descriptions are the
// contract the model reads when it chooses a tool. What stays here is what a
// tool description cannot carry — who she is, what she can remember, and the
// rules that span every tool.
export const SYSTEM_PROMPT =
  "You are Ixa, a personal AI operating system. You are direct, concise, and capable.\n\n" +
  "YOUR MEMORY. You are not stateless, and you should never tell the user you are:\n" +
  "- Saved preferences: things the user has told you they prefer. Every one that is active is " +
  "given to you on every turn, and you apply them without being asked. You can add, update and " +
  "remove them.\n" +
  "- Past conversations: each conversation you finish is summarized and kept. Summaries that " +
  "look relevant to what the user just said are handed to you automatically, and you can search " +
  "the rest yourself at any time — including for the most recent ones, when the user asks what " +
  "you talked about last time.\n" +
  "- The conversation you are in now: it is held on the backend, so it survives a client " +
  "disconnecting, reconnecting, or the backend restarting. Picking up mid-thought after a " +
  "reconnect is normal.\n" +
  "You do NOT remember anything else: there is no record of a conversation you never finished, " +
  "and you cannot recall a document or a file unless you read it.\n\n" +
  "NEVER CLAIM AN ACTION YOU DID NOT TAKE. Do not tell the user you have reset, cleared, saved, " +
  "remembered, updated or forgotten anything unless you actually called the tool that does it " +
  "and it reported success. If you did not call it, say what you can do instead. Saying a thing " +
  "happened when it did not is worse than saying you cannot do it.\n\n" +
  "ANYTHING THAT CHANGES OVER TIME. Prices, what a product costs or whether it is still sold, " +
  "stock and availability, software versions and release dates, current events, who holds a " +
  "position, this week's weather: search the web before you answer. Do not state a figure, a " +
  "model name or a date from memory and do not estimate one. If you cannot search, say plainly " +
  "that you are not sure and that the number may be out of date — a wrong price stated " +
  "confidently costs the user money.\n\n" +
  "TOOLS. Use them whenever they are the right way to fulfill a request, and read their " +
  "descriptions for what each one does. For a purely conversational message with no action " +
  "required, just answer. When reading file contents, prefer head -n 50 over cat unless the " +
  "user explicitly asks for the whole file."

const DESCRIBE_ACTION_PROMPT =
  "You are describing an action about to be taken by an AI assistant. " +
  "Describe it in one clear, specific sentence from the perspective of the assistant. " +
  "Be concrete about what will happen — include relevant details like recipient, subject, " +
  "or target from the context. Do not ask for confirmation yourself."

// The prompt is the mechanism; sanitizeForSpeech (src/voice/sanitize.ts) is
// the backstop that catches what it fails to prevent. Both exist because one
// live reply ran to 87 seconds of speech, with numbered lists and bold.
//
// The previous version said "a few sentences at most unless the user is
// explicitly asking for something that requires more detail (e.g. reciting a
// list they asked for)" — an escape hatch the model took constantly, because
// almost any question can be read as inviting detail.
export const VOICE_RESPONSE_PROMPT =
  "THIS REPLY WILL BE SPOKEN ALOUD. It is read by a speech synthesizer, not shown as text.\n" +
  "- Length: one to three short sentences. That is the default, not a target to beat. Roughly " +
  "fifteen seconds of speech is already long for a spoken answer.\n" +
  "- No formatting of any kind: no numbered or bulleted lists, no headings, no bold or italics, " +
  "no code blocks, no tables, no links. None of it exists in speech — it is read out as literal " +
  "asterisks and numbers. Write plain spoken sentences.\n" +
  "- If the answer has several items, say the best one or two in a sentence and offer the rest: " +
  "\"there are a few more if you want them.\" Do not recite the list.\n" +
  "- If a full answer genuinely needs length or code, say so in a sentence and ask whether to go " +
  "on, rather than speaking an essay.\n" +
  "Say the useful part first. The user can always ask for more."

export type MessageOrigin = "voice" | "text"

// The LLM call, injectable so tests can drive the tool loop without a network
// round trip. Production always gets the real one.
export type ChatFn = typeof defaultChat

export interface SessionOptions {
  limits: ContextWindowLimits
  chat?: ChatFn
  // Returns the active-preference block to inject, or null when there is
  // nothing to say. A function, not a string: it is called per LLM call so a
  // preference saved mid-turn applies to the very next one. Injected rather
  // than imported so Session stays unaware of SQLite and tests can stub it.
  preferenceBlock?: () => string | null
  // Looks up episodes related to the user's message. Called ONCE per user
  // turn, before the first LLM call — not per call, because it costs a network
  // round trip and the question does not change inside a turn. Returns null
  // for "nothing to add", including on failure or timeout.
  recall?: (userInput: string) => Promise<string | null>
  // Rebuilds a session persisted by a previous process. Absent for a new one.
  restore?: PersistedSession
}

// The system prompt is code, not conversation. A session restored after the
// prompt was edited takes the CURRENT one; everything after it is the actual
// history and is restored verbatim.
function restoredMessages(messages: Message[]): Message[] {
  const system: Message = { role: "system", content: SYSTEM_PROMPT }
  if (messages.length === 0) return [system]
  return messages[0]!.role === "system"
    ? [system, ...messages.slice(1)]
    : [system, ...messages]
}

export class Session {
  readonly id: string
  readonly createdAt: number
  lastTurnAt: number
  endedAt: number | null = null

  // Clients currently attached. A session is perfectly valid with none — that
  // is the whole point of Phase 3a.
  readonly attachedConnections = new Map<string, Connection>()

  // Turns submitted but not yet finished, including queued ones. The manager
  // reads this to keep the idle timer disarmed while work is outstanding.
  pendingTurns = 0

  private readonly messages: Message[]
  private cwd: string
  private readonly limits: ContextWindowLimits
  private readonly chat: ChatFn
  private readonly preferenceBlock?: () => string | null
  private readonly recall?: (userInput: string) => Promise<string | null>

  // This turn's recalled episodes. Safe as a single field because turns are
  // serialized on turnChain: only one turn is ever in flight.
  private recalled: string | null = null

  // Set when a tool asked for this conversation to end (start_new_conversation).
  // Read and cleared by the manager at the turn boundary: ending the session
  // mid-turn would pull the history out from under the tool loop that is still
  // appending to it, and would leave the reply unrecorded in the episode.
  private endRequested = false

  // Turn serialization. Every turn chains onto the previous one, so only one
  // tool loop at a time ever appends to `messages`. Two concurrent loops would
  // interleave their assistant/tool messages and produce a history where a
  // tool result no longer follows its call — which the API rejects outright.
  private turnChain: Promise<unknown> = Promise.resolve()

  constructor(options: SessionOptions) {
    const restored = options.restore
    this.id = restored?.id ?? randomUUID()
    this.createdAt = restored?.createdAt ?? Date.now()
    this.lastTurnAt = restored?.lastTurnAt ?? Date.now()
    this.cwd = restored?.workingDirectory || process.env.HOME || os.homedir()
    this.messages = restored
      ? restoredMessages(restored.messages)
      : [{ role: "system", content: SYSTEM_PROMPT }]

    this.limits = options.limits
    this.chat = options.chat ?? defaultChat
    this.preferenceBlock = options.preferenceBlock
    this.recall = options.recall
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
    const run = (): Promise<string> =>
      // Binds the session-control channel for the whole turn, so a tool that
      // runs inside the loop can reach THIS session and no other.
      runWithSessionControl(
        { requestNewConversation: () => { this.endRequested = true } },
        async (): Promise<string> => {
          this.messages.push({ role: "user", content: userInput })
          // Once per turn, before the first LLM call. Already inside the turn
          // chain, so it cannot interleave with another turn's recall.
          this.recalled = this.recall ? await this.recall(userInput) : null
          try {
            return await this.runToolLoop(origin, connection)
          } finally {
            this.recalled = null
          }
        }
      )

    const result = this.turnChain.then(run, run)
    this.turnChain = result.catch(() => {})
    return result
  }

  // A read-only view of stored history, for the manager, tests, and the
  // Phase 3c summarizer. Stored history itself is never handed out.
  history(): readonly Message[] {
    return [...this.messages]
  }

  // True once, if a tool asked for a new conversation during the turn that
  // just finished. The manager calls this at the turn boundary; clearing on
  // read means one request ends one session and never the one after it.
  consumeEndRequest(): boolean {
    const requested = this.endRequested
    this.endRequested = false
    return requested
  }

  // Part of the persisted state: a restored session resumes in the directory
  // its history talks about, instead of silently snapping back to $HOME.
  get workingDirectory(): string {
    return this.cwd
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
  // Order: system prompt, preferences, recalled episodes, windowed history,
  // voice constraint.
  //
  // Neither the preference block nor the voice constraint is ever written to
  // history. Both are statements about THIS call, not things that were said:
  // building them fresh here means a preference saved a moment ago applies
  // immediately, a forgotten one stops applying immediately, and no context
  // budget can ever clip either one away.
  private messagesForCall(origin: MessageOrigin): Message[] {
    const windowed = buildWindow(this.messages, this.limits)

    // Both blocks go after the leading system prompt(s) and before any
    // history, preferences first: a standing instruction outranks a note about
    // something that happened once.
    const injected: Message[] = []
    const preferences = this.preferenceBlock?.()
    if (preferences) injected.push({ role: "system", content: preferences })
    if (this.recalled) injected.push({ role: "system", content: this.recalled })

    let messages = windowed
    if (injected.length > 0) {
      let lead = 0
      while (lead < messages.length && messages[lead]!.role === "system") lead++
      messages = [...messages.slice(0, lead), ...injected, ...messages.slice(lead)]
    }

    if (origin !== "voice") return messages
    return [...messages, { role: "system", content: VOICE_RESPONSE_PROMPT }]
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
            tc.arguments = JSON.stringify({ ...parsed, cwd: this.cwd })
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
              this.cwd = path.resolve(parsed.newCwd)
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
