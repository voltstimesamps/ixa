import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { chat as defaultChat, LLMDeadlineError, type LLMResponse, type Message, type ToolCall } from "./llm"
import { registry, type Tool } from "../tools/registry"
import { config } from "../config"
import { requestConfirmation } from "./confirmation"
import { buildWindow, type ContextWindowLimits } from "./context-window"
import { currentTurnEvidence, runWithSessionControl } from "./session-context"
import { shortenForSpeech } from "../voice/shorten"
import { findCurrencyAmounts, priceCorrectionPrompt } from "./prices"
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
  "confidently costs the user money.\n" +
  "This is about the FACT, not about the question. It applies just as much when the user never " +
  "asked: a price, a street price, an availability or a current product named in passing inside " +
  "a recommendation, a comparison or an aside needs the same search a direct \"how much is it\" " +
  "would. If you have not searched, name the product without the number and say you would have " +
  "to look up what it costs now.\n" +
  "The clock and the calendar belong on that list, and they are the one case where the web is " +
  "the WRONG place to look: call get_time or get_date. A search tells you somebody else's " +
  "timezone, and you cannot work out the time by reasoning about it.\n\n" +
  "A VALUE YOU CAN ALREADY SEE IS NOT THE CURRENT VALUE. A time, a price, a version or any " +
  "other figure already sitting in front of you — in a tool result from an earlier turn, in a " +
  "note about a past conversation, or in an example in these instructions — is a record of what " +
  "it was when it was written. It is not what it is now, and an EXAMPLE was never a measurement " +
  "of anything. When a tool can give you the live value, call it on THIS turn and state what " +
  "THAT call returned, even if you answered the same question a minute ago and even if the old " +
  "figure looks reasonable. If the only figure you have is one you are reading back, say where " +
  "it came from and when, instead of stating it as current. A wrong value that sounds plausible " +
  "is worse than no value, because nothing about it tells the user it is wrong.\n\n" +
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
//
// The numbers rule is in three cases because two was wrong. Written as one
// rule — "numbers as words", with model numbers listed among the things it
// covered — the model obeyed by turning identifiers into amounts: a 3060
// became "RTX three hundred sixty", a 4090 "RTX four hundred ninety", and the
// clock grew seconds it was never given. None of those contain a digit, so the
// compliance check passed every one of them. An identifier is a NAME that
// happens to be spelled with digits, and naming it as a quantity produces
// hardware that does not exist.
//
// Measured: Kokoro reads every bare four-digit model number as place value
// ("RTX 3090" → "three thousand ninety"), which is why this rule has to exist
// at all. It also reads DDR4, PCIe 4.0 and Ubuntu 24.04 correctly as written,
// which is why the rule says to leave those alone — an instruction to convert
// them would be churn with a chance of invention and no upside.
//
// The clock rule got its leading-zero example from a live reply: 10:03 was
// spoken as "ten three in the evening". The hour and the minute were both
// right, so no check caught it — only the "oh" was missing, and only in the
// first nine minutes of an hour.
//
// NO EXAMPLE HERE ANSWERS A QUESTION WITH A VALUE A TOOL WOULD HAVE SUPPLIED.
// That is a rule about writing examples, and it was learnt the expensive way.
//
// There used to be a pair reading "User: What time is it? / Ixa: It is ten
// fifty-three in the evening." Live, with get_time having returned "8:43:48
// PM", Ixa said "It is ten fifty-three in the evening" — the example, recited
// over the tool result. It is the worst possible shape for an example: the
// question matches the user's verbatim, the answer is a bare scalar of exactly
// the type the tool returns, and the whole prompt is appended AFTER the tool
// result, so the fake exchange is the most recent thing in the request.
//
// The price pair ("How much is a used RTX 3090 going for?" / "around thirteen
// hundred sixty dollars") went for the same reason. It carried no evidence
// against it only because it was masked by coincidence: a live search returned
// $1361, so a recited example and an obeyed instruction produced the same
// sentence and nothing could tell them apart.
//
// Both were redundant anyway. The three number rules above are already written
// as rewrites with their INPUT visible — "three hundred fifty dollars", not
// "$350"; 10:53 becomes "ten fifty-three" — and a rewrite cannot be recited
// without contradicting the input shown next to it. The forms survive; only the
// fabricated answers are gone. What the pairs added was a demonstration in a
// sentence of the right length, and the three length examples below still do
// that, GPU names included.
//
// The mishearing rule is about transcripts, not about requests. "Let's cheat
// last here" (STT for "what's two plus two") was refused as if the user had
// asked for something improper, and "Refita." got a full GPU recommendation.
// Both are recognition failures, and the one thing that must not happen is
// answering them. It is on the voice prompt alone: a typed message that reads
// as nonsense was typed on purpose.
export const VOICE_RESPONSE_PROMPT =
  "THIS REPLY WILL BE SPOKEN ALOUD. It is read by a speech synthesizer, not shown as text.\n" +
  "- Length: about THIRTY-FIVE WORDS in total, in one to three short sentences. That is the " +
  "default, not a target to beat. Keep the sentences short too — one that runs past about " +
  "fifteen words takes too long to say out loud, so split it or cut it. Roughly fifteen seconds " +
  "of speech is already long for a spoken answer.\n" +
  "- No formatting of any kind: no numbered or bulleted lists, no headings, no bold or italics, " +
  "no code blocks, no tables, no links. None of it exists in speech — it is read out as literal " +
  "asterisks and numbers. Write plain spoken sentences.\n" +
  "- SPELL NUMBERS OUT, the way a person says them aloud. Three kinds, not said alike:\n" +
  "  - A QUANTITY is an amount: \"three hundred fifty dollars\", not \"$350\"; \"sixteen " +
  "gigabytes\", not \"16 GB\".\n" +
  "  - A MODEL OR PART NUMBER IS A NAME, NOT AN AMOUNT. Say it in pairs, and never drop a " +
  "digit: \"RTX thirty ninety\" for RTX 3090, \"RTX forty seventy\" for RTX 4070, \"Ryzen " +
  "five fifty-six hundred G\" for Ryzen 5 5600G. Never \"three thousand ninety\", \"three " +
  "hundred sixty\" or \"thirty nine zero\" — those are not cards.\n" +
  "  - A CLOCK TIME is a time, and you say the one you were GIVEN. Rewrite the clock you were " +
  "handed, hour then minute, and NOTHING ELSE: 10:53 becomes \"ten fifty-three in the " +
  "evening\". A minute under ten takes an \"oh\": 10:03 becomes \"ten oh three in the " +
  "evening\", never \"ten three\". A minute of ten or more takes NO \"oh\": 12:18 becomes " +
  "\"twelve eighteen in the morning\", never \"twelve oh eighteen\". Never say seconds, and " +
  "never offer them.\n" +
  "  Leave standards and versions alone: DDR4, GDDR6, PCIe 4.0, Ubuntu 24.04 are already right.\n" +
  "- If the answer has several items, say the best one or two in a sentence and offer the rest: " +
  "\"there are a few more if you want them.\" Do not recite the list.\n" +
  "- If a full answer genuinely needs length or code, say so in a sentence and ask whether to go " +
  "on, rather than speaking an essay.\n" +
  "- A request that makes no sense as something a person would say was MISHEARD: say you did " +
  "not catch it, rather than answering or refusing it.\n" +
  "Say the useful part first. The user can always ask for more.\n\n" +
  "These are the right length — about thirty words each — in questions that all invite a list:\n" +
  "User: Recommend some GPUs for a budget gaming build.\n" +
  "Ixa: The RTX thirty sixty is the safe pick at that budget, or the RTX forty seventy if you " +
  "have a bit more to spend. I can go through a few others if you like.\n" +
  "User: Why is my 3D print failing?\n" +
  "Ixa: Nine times out of ten it is bed adhesion or a first layer printed too cold. Tell me what " +
  "it looks like and I will narrow it down.\n" +
  "User: How do I set up Tailscale on this machine?\n" +
  "Ixa: Install the client, run tailscale up, and sign in — that is a basic node done. Do you " +
  "want the exit-node version?\n\n" +

  "And this is a mishearing, not a question:\n" +
  "User: Let's cheat last here.\n" +
  "Ixa: Sorry, I did not catch that. Could you say it again?"

// Spoken when a turn fails, and recorded as the assistant's reply to the turn
// that failed. Short, fixed, and free of any suggestion about what went wrong:
// the user is mid-conversation and wants to know they can try again, not to
// hear a stack trace read aloud.
//
// It lives here, not in the WebSocket transport that speaks it, so the words
// the user HEARS and the words history SAYS they heard cannot drift apart.
export const TURN_FAILURE_APOLOGY =
  "Sorry, something went wrong on my end. Could you try that again?"

// A voice reply with no sentence boundary in it cannot be trimmed, so past
// this length it is logged instead. Only diagnostics: nothing branches on it.
const UNBROKEN_REPLY_CHARS = 400

// How much of the underlying error goes into the bracketed reason. Enough to
// tell a timeout from a dead backend, not so much that a stack-shaped message
// crowds out the conversation on every later turn.
const FAILURE_REASON_MAX = 80

// The assistant message recorded for a turn that failed.
//
// Without it, history said the user asked and was never answered — and the
// model, restored into that history, dutifully answered every stale question
// at once on the next turn. The user had already been told something went
// wrong; the record has to say the same thing they heard.
//
// The bracketed reason is for the model, not the user: it is the difference
// between "I could not reach my language model" and "that took too long",
// which changes what Ixa should say if asked about it.
export function turnFailureReply(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  let reason = raw.replace(/\s+/g, " ").trim().replace(/\.$/, "")
  // Lower-case the opening word so it reads as a clause, unless it is an
  // acronym ("LLM call aborted…") that lower-casing would mangle.
  if (!/^[A-Z]{2}/.test(reason)) reason = reason.charAt(0).toLowerCase() + reason.slice(1)
  if (reason.length > FAILURE_REASON_MAX) {
    reason = `${reason.slice(0, FAILURE_REASON_MAX - 1).trimEnd()}…`
  }
  return `${TURN_FAILURE_APOLOGY} [turn failed: ${reason || "unknown error"}]`
}

// What a tool result says when the turn failed before that call ever ran.
// Truthful on purpose: the model is told nothing happened, not handed a
// vague error it might read as "the action may have gone through".
const NOT_EXECUTED =
  "not executed: the turn failed before this tool ran. Nothing happened."

// What a tool result says when the per-turn search cap is reached.
//
// It must not read as a failure. A result that looks like a broken search is
// an invitation to retry it, and retrying is the exact behaviour the cap
// exists to stop — the live turn that fired eight searches repeated several
// queries verbatim. So the message says three things in order: the search did
// not run, the reason is a limit rather than a fault, and what to do instead.
//
// "Nothing is wrong" is stated outright because the model cannot tell a cap
// from an outage by inference, and the honest reading of an unexplained empty
// result is that the network is down.
function searchCapReached(limit: number): string {
  return (
    `This search was NOT run. You have already used all ${limit} web_search calls allowed ` +
    `in this turn, and that is the limit — nothing is wrong, nothing failed, and the ` +
    `search tool is working. Running another one is not possible in this turn, so do not ` +
    `try again. Answer from the search results you already have above. If they genuinely ` +
    `do not contain what you need, say which part you could not confirm rather than ` +
    `guessing at it or stating a figure from memory.`
  )
}

// Arguments are truncated in the log: a web_search query is short, but a
// shell command or a remembered preference is not, and a log line that wraps
// four times is a log nobody reads.
const TOOL_LOG_ARG_CHARS = 120

function logToolCall(
  name: string,
  status: string,
  startedAt: number,
  args: string,
  note?: string
): void {
  const shown =
    args.length > TOOL_LOG_ARG_CHARS ? `${args.slice(0, TOOL_LOG_ARG_CHARS)}…` : args
  console.log(
    `tool ${name} ${status} ${Date.now() - startedAt}ms ${shown}${note ? ` — ${note}` : ""}`
  )
}

export class ToolTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(
      `Tool '${name}' did not finish within ${ms}ms and was abandoned. Its work may still ` +
        `complete — do not tell the user it did not happen, and do not run it again without asking.`
    )
    this.name = "ToolTimeoutError"
  }
}

// A backstop deadline around one tool execution.
//
// The tool's promise cannot be cancelled from here — execute() owns whatever
// it started, and there is no generic way to reach in and stop it. So this
// stops the TURN waiting, not the work. Both the log line and the result
// handed to the model say exactly that, because a tool that is still running
// is not the same thing as a tool that did not run.
function withToolDeadline<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(name, ms)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

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
  // Returns the one-line recency fact to inject, or null when there are no
  // episodes. A function for the same reason preferenceBlock is one: it is a
  // local SQLite read, so calling it per LLM call costs nothing and means a
  // conversation that ends mid-session is reflected on the very next call.
  lastEpisode?: () => string | null
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
  private readonly lastEpisode?: () => string | null
  private readonly recall?: (userInput: string) => Promise<string | null>

  // This turn's recalled episodes. Safe as a single field because turns are
  // serialized on turnChain: only one turn is ever in flight.
  private recalled: string | null = null

  // The price guard's corrective instruction, set for exactly one retry. Same
  // single-field reasoning as `recalled`, and like it, never written to stored
  // history — see priceCorrectionPrompt.
  private priceCorrection: string | null = null

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
    this.lastEpisode = options.lastEpisode
    this.recall = options.recall
  }

  // Queues a turn behind any turn already running on this session, whichever
  // connection it came from. The returned promise settles with THIS turn's
  // outcome; a turn that throws is isolated to its own caller and does not
  // break the queue for the turns behind it.
  //
  // `onUserMessage` fires once the user's message is in history and before
  // any LLM call. It has to run INSIDE the turn chain — called from outside,
  // it would race the serialization and could persist a history snapshot
  // belonging to a different turn. The manager uses it to make the question
  // durable before the work that might fail begins.
  send(
    userInput: string,
    connection: Connection,
    origin: MessageOrigin = "text",
    onUserMessage?: () => void
  ): Promise<string> {
    const run = (): Promise<string> =>
      // Binds the session-control channel for the whole turn, so a tool that
      // runs inside the loop can reach THIS session and no other.
      runWithSessionControl(
        {
          requestNewConversation: () => { this.endRequested = true },
          // What this turn has seen, for save_note's price rule. The user's
          // words are known now; search results are appended by the tool loop
          // as they come back.
          evidence: {
            userText: userInput,
            source: origin,
            sessionId: this.id,
            searchResults: [],
          },
        },
        async (): Promise<string> => {
          this.messages.push({ role: "user", content: userInput })
          onUserMessage?.()
          try {
            // Once per turn, before the first LLM call. Already inside the
            // turn chain, so it cannot interleave with another turn's recall.
            this.recalled = this.recall ? await this.recall(userInput) : null
            return await this.runToolLoop(origin, connection)
          } catch (err) {
            // Here rather than in a transport, so the WebSocket, REST and the
            // REPL all record the same thing. runToolLoop has already closed
            // any tool group it cut short, so this lands after the group's
            // results and the ordering stays valid.
            this.messages.push({ role: "assistant", content: turnFailureReply(err) })
            throw err
          } finally {
            this.recalled = null
            this.priceCorrection = null
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
  // Order: system prompt, preferences, the recency line, recalled episodes,
  // windowed history, voice constraint.
  //
  // Neither the preference block nor the voice constraint is ever written to
  // history. Both are statements about THIS call, not things that were said:
  // building them fresh here means a preference saved a moment ago applies
  // immediately, a forgotten one stops applying immediately, and no context
  // budget can ever clip either one away.
  private messagesForCall(origin: MessageOrigin): Message[] {
    const windowed = buildWindow(this.messages, this.limits)

    // All three blocks go after the leading system prompt(s) and before any
    // history, preferences first: a standing instruction outranks a note about
    // something that happened once. The recency line sits next to the recalled
    // episodes because both are facts about past conversations, and before
    // them because it is the one that is always true.
    const injected: Message[] = []
    const preferences = this.preferenceBlock?.()
    if (preferences) injected.push({ role: "system", content: preferences })
    const lastEpisode = this.lastEpisode?.()
    if (lastEpisode) injected.push({ role: "system", content: lastEpisode })
    if (this.recalled) injected.push({ role: "system", content: this.recalled })

    let messages = windowed
    if (injected.length > 0) {
      let lead = 0
      while (lead < messages.length && messages[lead]!.role === "system") lead++
      messages = [...messages.slice(0, lead), ...injected, ...messages.slice(lead)]
    }

    if (origin === "voice") {
      messages = [...messages, { role: "system", content: VOICE_RESPONSE_PROMPT }]
    }

    // Last, so it is the most recent thing the model is told: it is a
    // correction to the draft it just produced, and it outranks everything
    // above it for this one call.
    if (this.priceCorrection) {
      messages = [...messages, { role: "system", content: this.priceCorrection }]
    }

    return messages
  }

  // Applies the spoken-length backstop to a voice reply, and says both what to
  // speak and what to record.
  //
  // The two differ by a bracketed note, the same trick turnFailureReply uses
  // in reverse: what the user HEARS is the trimmed reply, and what history
  // SAYS is that same text plus a note that it was shortened. That note is for
  // the model — restored into this history it can see the answer was cut off
  // and offer the rest, without having an example of a long spoken reply to
  // imitate. The dropped sentences are deliberately not kept: if the user asks
  // for more, generating it again under the same prompt is better than reciting
  // a list the prompt exists to prevent.
  //
  // A text turn is returned untouched — a text client asked for text.
  private shortenIfSpoken(
    content: string,
    origin: MessageOrigin
  ): { text: string; recorded: string } {
    if (origin !== "voice") return { text: content, recorded: content }

    const result = shortenForSpeech(content, {
      maxUnits: config.voice.maxSpokenSentences,
      maxWords: config.voice.maxSpokenWords,
    })
    if (!result.trimmed) {
      // Nothing to cut can still mean the reply was too long: one unbroken
      // 200-word sentence has no boundary to cut at, and the backstop leaves
      // it alone by design. Worth a line, because it is the one shape of
      // over-long reply only the prompt can fix.
      if (result.total <= 1 && content.length > UNBROKEN_REPLY_CHARS) {
        console.log(
          `voice backstop: nothing to trim — ${result.totalWords} words in one unbroken sentence`
        )
      }
      return { text: content, recorded: content }
    }

    console.log(
      `voice backstop: spoke ${result.kept} of ${result.total} sentences, ` +
        `${result.words} of ${result.totalWords} words ` +
        `(${content.length} chars → ${result.spoken.length})`
    )
    return {
      text: result.spoken,
      recorded: `${result.spoken} [reply shortened for speech: spoke ${result.kept} of ${result.total} sentences]`,
    }
  }

  // Runs one tool call under the generic ceiling, and logs it. Every path
  // that actually invokes a tool goes through here, so there is exactly one
  // place where a tool can hang and exactly one place that reports it.
  private async executeTool(tool: Tool, tc: ToolCall): Promise<string> {
    const startedAt = Date.now()
    try {
      const input = JSON.parse(tc.arguments || "{}")
      const output = await withToolDeadline(
        Promise.resolve(tool.execute(input)),
        config.tools.timeoutMs,
        tool.name
      )
      const result = typeof output === "string" ? output : JSON.stringify(output)
      logToolCall(tool.name, "ok", startedAt, tc.arguments)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof ToolTimeoutError) {
        logToolCall(
          tool.name,
          "timeout",
          startedAt,
          tc.arguments,
          "abandoned; its underlying work may still complete"
        )
      } else {
        logToolCall(tool.name, "error", startedAt, tc.arguments, message)
      }
      return JSON.stringify({ error: message })
    }
  }

  // Closes a tool-call group that a failure cut short.
  //
  // Calls that ran keep their real results: a tool with side effects has
  // already had them, and the model cannot account for what it is not told.
  // Calls that never ran get an explicit placeholder. Either way the group
  // ends up complete — an assistant `tool_calls` message whose results are
  // missing is rejected outright by the API, so leaving one in history would
  // make every later turn in this session fail, not just the one that broke.
  private completeToolGroup(calls: ToolCall[], answered: Set<string>): void {
    for (const tc of calls) {
      if (answered.has(tc.id)) continue
      this.messages.push({ role: "tool", tool_call_id: tc.id, content: NOT_EXECUTED })
      console.log(`tool ${tc.name} not-executed — the turn failed before it ran`)
    }
  }

  private async runToolLoop(origin: MessageOrigin, connection: Connection): Promise<string> {
    const tools = registry.toOpenAI()
    let retrying = false
    // Did a web_search actually happen in THIS turn? The freshness rule is
    // about this turn's facts, so a search two turns ago does not license a
    // price now.
    let searchedThisTurn = false
    // How many have run, for the per-turn cap. Counted rather than flagged
    // because the loop caps ITERATIONS at 10 and one iteration may carry any
    // number of parallel calls — so the bound has to be on the calls.
    let searchesThisTurn = 0
    // The price guard retries once and once only. A model that states prices
    // twice is not going to stop on the third ask, and a loop here would spend
    // the turn's budget arguing with it.
    let priceGuardUsed = false

    for (let i = 0; i < 10; i++) {
      // On retry after a malformed tool call, pass no tools — forces a plain text response
      let response: LLMResponse
      // Built once and kept, so the empty-reply diagnostic below describes the
      // array that was actually sent rather than a second, rebuilt one.
      const sent = this.messagesForCall(origin)
      try {
        response = await this.chat(sent, retrying ? [] : tools)
      } catch (err) {
        // A deadline is never a malformed tool call, and asking again without
        // tools would just spend the budget twice.
        if (err instanceof LLMDeadlineError) throw err
        const msg = err instanceof Error ? err.message : String(err)
        if (!retrying && (
          msg.toLowerCase().includes("failed to call a function") ||
          msg.toLowerCase().includes("tool call validation failed") ||
          msg.toLowerCase().includes("malformed tool call") ||
          msg.toLowerCase().includes("parsing failed") ||
          msg.toLowerCase().includes("could not be parsed")
        )) {
          console.log(`llm retry without tools: ${msg}`)
          retrying = true
          continue
        }
        throw err
      }

      if (response.type === "text") {
        if (response.content) {
          // The price guard, before anything is recorded or delivered. The
          // rejected draft is deliberately NOT pushed to history: the user
          // never heard it, and history claiming she said it would be the same
          // drift the turn-failure path exists to prevent.
          const amounts = findCurrencyAmounts(response.content)
          if (amounts.length > 0 && !searchedThisTurn) {
            if (!priceGuardUsed) {
              priceGuardUsed = true
              this.priceCorrection = priceCorrectionPrompt(amounts)
              console.log(
                `price guard: draft stated ${amounts.join(", ")} with no web_search this turn — ` +
                  `asking again`
              )
              continue
            }
            // Delivered anyway. Looping is worse than one unsearched price,
            // and the user is waiting.
            console.warn(
              `price guard: second draft still states ${amounts.join(", ")} with no ` +
                `web_search — delivering it`
            )
          }
          this.priceCorrection = null

          const spoken = this.shortenIfSpoken(response.content, origin)
          this.messages.push({ role: "assistant", content: spoken.recorded })
          return spoken.text
        }

        // The model returned a text response with nothing in it. Logged
        // rather than papered over: the transport already handles it
        // correctly — speak() is never reached with an empty string, and
        // replyEnd still fires — and a stand-in apology would put words in
        // history the user never heard.
        //
        // What the line says is how much conversation the call carried,
        // because that is what distinguishes the two causes. A call that
        // carried the conversation and still came back empty is the model. A
        // call that carried only system prompts was starved by the context
        // budget, which is the shape buildWindow used to produce from four
        // parallel web_search results.
        console.warn(
          `empty reply: the model returned no content on call ${i + 1} of this turn — ` +
            `the call carried ${sent.length} messages ` +
            `(${sent.filter((m) => m.role !== "system").length} of them conversation)`
        )
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
        console.log("llm retry without tools: tool call arguments were not valid JSON")
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

      // Which calls in this group already have their result in history. The
      // group is only valid once every call does — see completeToolGroup.
      const answered = new Set<string>()
      try {
        for (const tc of response.calls) {
          const tool = registry.get(tc.name)
          let result: string
          // Whether the tool actually ran, as opposed to being unknown,
          // declined or cancelled. The price guard asks "did a search
          // happen", and a search the user declined did not happen.
          let ran = false

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
            logToolCall(tc.name, "unknown", Date.now(), tc.arguments)
          } else if (
            tool.name === "web_search" &&
            config.tools.maxSearchesPerTurn > 0 &&
            searchesThisTurn >= config.tools.maxSearchesPerTurn
          ) {
            // `ran` stays false, so a capped call cannot satisfy the price
            // guard's "did a search happen" question on its own. In practice
            // the guard is already satisfied — the cap is only reachable once
            // real searches have run — but a capped call is not a search and
            // must not be counted as one.
            result = searchCapReached(config.tools.maxSearchesPerTurn)
            logToolCall(
              tool.name,
              "capped",
              Date.now(),
              tc.arguments,
              `${searchesThisTurn} already run this turn`
            )
          } else if (tool.requiresConfirmation) {
            const description = await this.generateDescription(tc.name, tc.arguments)
            // Deliberately OUTSIDE the tool deadline. The user may take as
            // long as they like to answer, and the confirmer has its own
            // 30-second limit; charging their thinking time to the tool's
            // budget would time out tools that had not started yet.
            const askedAt = Date.now()
            const outcome = await requestConfirmation(connection.confirmer, description)
            if (outcome === "cancelled") {
              // Recorded distinctly from a decline so the LLM knows the action
              // did not happen because the asking client vanished, not because
              // the user refused. Nothing executed either way.
              result =
                "Action cancelled: the client that requested it disconnected before confirming. " +
                "Nothing was executed."
              logToolCall(tool.name, "cancelled", askedAt, tc.arguments)
            } else if (outcome === "declined") {
              result = "Action declined by user."
              logToolCall(tool.name, "declined", askedAt, tc.arguments)
            } else {
              result = await this.executeTool(tool, tc)
              ran = true
            }
          } else {
            result = await this.executeTool(tool, tc)
            ran = true
          }

          if (ran && tc.name === "web_search") {
            searchedThisTurn = true
            searchesThisTurn++
            // Recorded for the turn, not just counted: save_note has to check
            // a figure against what the search actually returned, and "a
            // search happened" does not say which number came back.
            currentTurnEvidence()?.searchResults.push(result)
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
          answered.add(tc.id)
        }
      } catch (err) {
        // executeTool turns a failing tool into an error RESULT, so reaching
        // here means the turn itself came apart — a confirmation that threw,
        // an abort. Close the group before the error leaves, or history is
        // left in a state the API will reject on every subsequent turn.
        this.completeToolGroup(response.calls, answered)
        throw err
      }
    }

    throw new Error("Tool call limit (10) reached")
  }
}
