import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  chat as defaultChat,
  describeCost,
  isParsingFailure,
  isToolChoiceRejection,
  LLMDeadlineError,
  logFailedGeneration,
  type LLMResponse,
  type Message,
  type ToolCall,
} from "./llm"
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

// Spoken when the model returns a reply with nothing in it, and recorded as
// the assistant's reply to that turn. Same contract as TURN_FAILURE_APOLOGY,
// and here for the same reason: one constant, so the words the user hears and
// the words history says they heard are the same words.
//
// Worded as a lost thought rather than a fault, because that is what it is:
// nothing failed, no tool broke and no deadline fired — the model was asked a
// question and produced no text. Deliberately not the mishearing line ("I did
// not catch that"), which would blame the user's microphone for the model's
// silence.
export const EMPTY_REPLY_FALLBACK =
  "Sorry, I lost my train of thought there. Could you ask me again?"

// Spoken when the tool-call budget ran out and the wind-up could not get an
// answer out of the model either, and recorded as the reply to that turn. Same
// one-constant contract as the two above.
//
// It offers to continue because that is the truthful next step: the work is
// not wrong, it is unfinished, and the user's "yes" starts a fresh turn with a
// fresh budget. It does not name the limit — "fifteen tool calls" is an
// implementation detail the user did not ask about — and it does not apologise
// for a fault, because there was none.
export const BUDGET_EXHAUSTED_FALLBACK =
  "I ran out of tool calls before I could finish that one. Want me to keep going?"

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

// The assistant message recorded for a turn the model answered with nothing.
//
// Until this existed, the empty branch recorded NOTHING: stored history held
// the user's question, the tool calls underneath it, and no reply — the exact
// shape turnFailureReply was written to prevent, and found three times in the
// live database (two of them the context-budget case buildWindow now handles,
// one a nine-tool-call turn where the window was only 9165 of 24000 chars).
// An unanswered question in history is one the model answers again later, and
// a user who heard silence is not told they heard anything.
//
// The bracketed note is for the model, like the one in turnFailureReply: a
// turn that ran ten tool calls and then said nothing reads differently from
// one that said nothing straight away.
export function emptyReplyRecord(toolCalls: number): string {
  const calls = toolCalls === 1 ? "1 tool call" : `${toolCalls} tool calls`
  return `${EMPTY_REPLY_FALLBACK} [no reply was produced after ${calls}]`
}

// The same, for a turn the provider could not parse twice.
//
// The spoken words are EMPTY_REPLY_FALLBACK's, because from where the user is
// sitting it is the same event — they asked, they heard nothing, they can ask
// again — and inventing a second apology for a provider-side parse failure
// would be a distinction drawn for the machine's benefit. The bracketed note
// is where the difference belongs: it is read by the model, and "could not be
// parsed" is a different thing to have happened from "returned no content".
export function parsingFailureRecord(toolCalls: number): string {
  const calls = toolCalls === 1 ? "1 tool call" : `${toolCalls} tool calls`
  return (
    `${EMPTY_REPLY_FALLBACK} [no reply was produced after ${calls}: the model's output ` +
    `could not be parsed, twice]`
  )
}

// The same, for a turn whose budget ran out and whose wind-up call could not
// be made to answer. The bracketed note is for the model: restored into this
// history it can see that the work stopped on a limit rather than finishing,
// which is what makes "yes, keep going" answerable.
export function budgetExhaustedRecord(toolCalls: number): string {
  return `${BUDGET_EXHAUSTED_FALLBACK} [tool budget spent after ${toolCalls} calls; no answer produced]`
}

// What a tool result says when the turn failed before that call ever ran.
// Truthful on purpose: the model is told nothing happened, not handed a
// vague error it might read as "the action may have gone through".
const NOT_EXECUTED =
  "not executed: the turn failed before this tool ran. Nothing happened."

// The same shape for a call the per-turn budget could not pay for. A sibling
// of NOT_EXECUTED rather than NOT_EXECUTED itself, because that one says "the
// turn failed" and this turn did not fail: it is still running and is about to
// answer. A tool result that reads as a fault is an invitation to retry, which
// is the behaviour the cap exists to stop — the same reasoning as
// searchCapReached below.
const NOT_EXECUTED_OVER_BUDGET =
  "not executed: this turn's tool-call limit was reached before this call ran. Nothing " +
  "happened, nothing is wrong, and the tool is working. Do not try it again in this turn."

// The one line that tells Ixa where her shell tools are standing. Kept short
// on purpose — it is on every call of every turn — and naming both tools,
// because the directory is what `cd` through shell_write changes.
function workingDirectoryLine(cwd: string): string {
  return (
    `shell_read and shell_write run in ${cwd}; relative paths are resolved from there. ` +
    // The second sentence is the cheapest fix for the failure all three live
    // turns began with: a whole-home-directory listing to find a path that was
    // already written down. search_notes was never called in any of them.
    `Project and file locations may be in search_notes.`
  )
}

// A tool call's identity, for "has this exact call already failed this turn?".
//
// Normalized rather than compared raw, because the model writes the same call
// with its keys in a different order — {"command":"ls","args":["-R"]} and
// {"args":["-R"],"command":"ls"} are one call, and a string comparison would
// call them two. Falls back to the raw string when the arguments do not parse,
// which is the honest answer: unparseable arguments are handled elsewhere and
// are not something to be clever about here.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

function callSignature(name: string, args: string): string {
  let normalized = args
  try {
    normalized = stableStringify(JSON.parse(args || "{}"))
  } catch {
    // raw it is
  }
  return `${name}\u0000${normalized}`
}

// What a repeat of an already-failed call is told. Short, because the original
// result is a few messages above it and saying the whole thing twice wastes
// the budget it is trying to protect — but it carries the first line, because
// the window may have evicted the original by now.
//
// "Try a different command" rather than "do not try again": the model has a
// goal it has not reached, and a refusal with no next move is how a turn ends
// up spending fifteen calls on nothing.
function repeatedFailureResult(reason: string): string {
  return (
    `Not run: this exact call already failed this turn (${reason}). Running it again gives ` +
    `the same result. Try a different command or a different approach.`
  )
}

// Injected for ONE call when the tool-call budget is spent, and never stored:
// it is a statement about this call, not something that was said. Paired with
// passing no tools on that call, so the instruction and what is possible agree
// — a model told to answer while still holding tools reaches for one.
function toolBudgetSpentPrompt(limit: number): string {
  return (
    `You have used all ${limit} tool calls for this turn. Answer with what you found, or ` +
    `say plainly what you could not find out.`
  )
}

// The firmer version, injected after a call made with NO tools came back
// holding a tool call anyway and was rejected by the provider before it ran
// (see isToolChoiceRejection). Re-sending the same request would earn the same
// rejection, so what changes is the request: the instruction above says what
// to do and this one says what cannot be done and why.
//
// "Rejected before it runs" is in there deliberately. A model told merely that
// tools are unavailable can read that as a reason to try a different tool; a
// model told the attempt is refused outright has nothing to aim at.
const NO_TOOL_CALL_CORRECTION =
  "Your last reply tried to call a tool. No tools are available to you on this call, and " +
  "an attempted call is rejected before it runs, so it cannot work however it is written. " +
  "Reply in words only. Say what you found and what you could not find out, and do not " +
  "call a tool."

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

// Why a tool-reported failure failed, for the log line. One line, bounded: a
// find error is short, but an 8000-character result that happens to start with
// a failure prefix is not.
const TOOL_LOG_REASON_CHARS = 100

function firstLine(result: string): string {
  const line = result.split("\n")[0]!.trim()
  return line.length > TOOL_LOG_REASON_CHARS
    ? `${line.slice(0, TOOL_LOG_REASON_CHARS - 1)}…`
    : line
}

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

  // The tool-budget notice, set for the calls made after the budget is spent.
  // Same single-field, never-stored reasoning as priceCorrection.
  private toolBudgetNotice: string | null = null

  // The firm "do not call a tool" correction, set once a no-tools call has
  // been rejected for calling one. Same reasoning again: a statement about the
  // calls that follow, never a thing that was said.
  private noToolCallNotice: string | null = null

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
            this.toolBudgetNotice = null
            this.noToolCallNotice = null
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

    // Where the shell tools are standing. Below the history rather than up in
    // the injected block, with the other statements about this CALL, and
    // deliberately late: the model reads it just before it chooses a path.
    //
    // Injected rather than written into shell_read's description, which is the
    // cheaper place, because a description is STATIC and this value is not —
    // `cd` through shell_write moves it mid-session and a restored session
    // resumes wherever its history left off. The static alternative is a clause
    // saying "run pwd to find out", which spends a tool call to learn something
    // that costs 86 characters to say.
    //
    // Why it is said at all: live, asked to read her own architecture document,
    // Ixa spent three of nine tool calls working out where she was standing.
    // Nothing in the system prompt, the tool descriptions or the schemas named
    // the directory.
    messages = [...messages, { role: "system", content: workingDirectoryLine(this.cwd) }]

    if (origin === "voice") {
      messages = [...messages, { role: "system", content: VOICE_RESPONSE_PROMPT }]
    }

    if (this.toolBudgetNotice) {
      messages = [...messages, { role: "system", content: this.toolBudgetNotice }]
    }

    // Right behind the budget notice, because the two are a pair: that one
    // says what to do, this one says what cannot be done.
    if (this.noToolCallNotice) {
      messages = [...messages, { role: "system", content: this.noToolCallNotice }]
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
      // A tool that catches its own errors and returns them as a result is
      // doing right by the model and used to lie to the log: fifteen
      // consecutive failed shell_read calls in one live turn logged fifteen
      // "ok" lines. The tool says which of its own results are failures; this
      // only picks the word, and the result handed back is untouched.
      if (tool.isFailure?.(result)) {
        logToolCall(tool.name, "failed", startedAt, tc.arguments, firstLine(result))
      } else {
        logToolCall(tool.name, "ok", startedAt, tc.arguments)
      }
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
    // because the loop bounds ITERATIONS and one iteration may carry any
    // number of parallel calls — so the bound has to be on the calls. The
    // generic budget below is the same argument applied to every tool.
    let searchesThisTurn = 0
    // The price guard retries once and once only. A model that states prices
    // twice is not going to stop on the third ask, and a loop here would spend
    // the turn's budget arguing with it.
    let priceGuardUsed = false
    // The empty-reply retry, once per turn for the same reason.
    let emptyRetryUsed = false
    // The "do not call a tool" retry, once per turn for the same reason: a
    // model that calls a tool on a call that has none, twice, having been told
    // plainly that the attempt is rejected, is not going to stop on the third.
    let noToolCallRetryUsed = false
    // The unparseable-output retry, once. Same reasoning as withArgumentRetry:
    // the request was fine and the sampled tokens were not, so the fix is
    // another sample — and a third sample of a request the provider has
    // refused to parse twice is a loop, not a strategy.
    let parsingRetryUsed = false
    // Tool calls spent against the per-turn budget, parallel ones counted
    // individually. A call the user declined, one the search cap refused and
    // one that timed out all count — each reached the registry or the user.
    // A call the budget could not pay for does not, because it never existed.
    // Also read by the empty-reply record, so a turn that said nothing after
    // nine calls says so.
    let toolCallsThisTurn = 0
    const callBudget = config.tools.maxToolCallsPerTurn
    let budgetNoticeLogged = false
    // Calls that ran this turn and failed, by signature, with the first line
    // of what they returned. Per TURN, not per session: a command that failed
    // because a file was missing may well work after the next one creates it.
    const failedCalls = new Map<string, string>()

    // AN ITERATION IS NOT A CALL, which is why this is no longer the limit.
    //
    // It was a hard-coded 10, and the live turn that prompted all this made
    // nine single-call iterations — one iteration short of a ceiling that
    // would have ended it in the failure apology. A turn that answers after
    // every call needs one iteration per call plus one to answer in, and the
    // malformed-tool-call, price-guard and empty-reply retries each spend an
    // iteration while making no call at all. So the iteration bound sits well
    // above the call budget: the call budget is the limit that is meant to
    // bind, and this one exists only so a loop that makes no progress cannot
    // spin forever.
    const maxIterations = (callBudget > 0 ? callBudget : 20) + 5

    for (let i = 0; i < maxIterations; i++) {
      // Once the budget is spent, every remaining call goes out with no tools
      // and with one line saying so. Both halves matter: a model told to
      // answer while still holding tools reaches for one.
      const budgetSpent = callBudget > 0 && toolCallsThisTurn >= callBudget
      this.toolBudgetNotice = budgetSpent ? toolBudgetSpentPrompt(callBudget) : null
      if (budgetSpent && !budgetNoticeLogged) {
        budgetNoticeLogged = true
        console.log(
          `tool budget: all ${callBudget} tool calls used this turn — ` +
            `asking for an answer with no tools`
        )
      }

      // On retry after a malformed tool call, pass no tools — forces a plain text response
      let response: LLMResponse
      // Built once and kept, so the empty-reply diagnostic below describes the
      // array that was actually sent rather than a second, rebuilt one.
      const sent = this.messagesForCall(origin)
      try {
        response = await this.chat(sent, retrying || budgetSpent ? [] : tools)
      } catch (err) {
        // A deadline is never a malformed tool call, and asking again without
        // tools would just spend the budget twice.
        if (err instanceof LLMDeadlineError) throw err
        const msg = err instanceof Error ? err.message : String(err)

        // A call made with NO tools whose reply held a tool call anyway, which
        // the provider rejects before anything runs: "Tool choice is none, but
        // model called a tool". Measured live on the budget wind-up — the one
        // call in the turn that was meant to produce the answer — and it was
        // fatal, because it matches neither the patterns below nor
        // isArgumentRejection in llm.ts, so it propagated and the turn died in
        // the apology with fifteen calls of work on the floor.
        //
        // All FOUR no-tools paths are exposed to it, not just the wind-up: the
        // malformed-tool-call retry, the unparseable-arguments retry, the
        // empty-reply retry and the budget wind-up all send `tools: []`. They
        // are handled here together, because the fix does not depend on which
        // one withheld the tools.
        //
        // Re-sending the same request would earn the same rejection, so what
        // changes is the request: the correction is injected and the call goes
        // again. Once. Then a fallback, chosen by WHY the tools were withheld
        // — a spent budget is a different thing to tell the user from a model
        // that would not answer.
        if (isToolChoiceRejection(err)) {
          if (!noToolCallRetryUsed) {
            noToolCallRetryUsed = true
            this.noToolCallNotice = NO_TOOL_CALL_CORRECTION
            console.log(
              `llm retry: a call made with no tools produced a tool call anyway ` +
                `(${msg}) — asking again, firmly`
            )
            continue
          }
          const record = budgetSpent
            ? budgetExhaustedRecord(toolCallsThisTurn)
            : emptyReplyRecord(toolCallsThisTurn)
          this.messages.push({ role: "assistant", content: record })
          console.warn(
            `tool choice rejected twice after ${toolCallsThisTurn} tool calls — ` +
              `delivering the ${budgetSpent ? "budget" : "empty reply"} fallback`
          )
          return budgetSpent ? BUDGET_EXHAUSTED_FALLBACK : EMPTY_REPLY_FALLBACK
        }

        // Output the provider could not parse at all. Ordered BEFORE the
        // malformed-tool-call list below, which matches the words "parsing
        // failed" and used to swallow this: that list's lever is to drop the
        // tools, and dropping the tools is the wrong answer to a sampling
        // fluke — it changes what the model is allowed to do instead of
        // getting another sample of what it was asked. Live, the no-tools
        // retry failed in exactly the same way and the turn died with seven
        // tool calls of work already done.
        //
        // So: the SAME call again, once, with nothing changed. Then a
        // fallback, because a provider that has refused to parse the same
        // request twice will refuse it a third time.
        if (isParsingFailure(err)) {
          logFailedGeneration(err)
          if (!parsingRetryUsed) {
            parsingRetryUsed = true
            console.log(`llm retry, same call: ${msg}`)
            continue
          }
          const record = parsingFailureRecord(toolCallsThisTurn)
          this.messages.push({ role: "assistant", content: record })
          console.warn(
            `parsing failed twice after ${toolCallsThisTurn} tool calls — delivering the fallback`
          )
          return EMPTY_REPLY_FALLBACK
        }

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

        // The model returned a text response with nothing in it.
        //
        // What the line says is how much conversation the call carried,
        // because that is what distinguishes the two causes. A call that
        // carried the conversation and still came back empty is the model. A
        // call that carried only system prompts was starved by the context
        // budget, which is the shape buildWindow used to produce from four
        // parallel web_search results. finish_reason and whether reasoning
        // tokens arrived tell apart a model that stopped from one that was cut
        // off or spent the completion where this code cannot see it.
        console.warn(
          `empty reply: the model returned no content on call ${i + 1} of this turn — ` +
            `the call carried ${sent.length} messages ` +
            `(${sent.filter((m) => m.role !== "system").length} of them conversation), ` +
            `finish_reason=${response.finishReason ?? "unknown"}, ` +
            `reasoning tokens ${response.reasoning ? "arrived" : "did not arrive"}, ` +
            // What the completion actually cost. Added because the one shape
            // this warning could not explain was `finish_reason=length` with
            // reasoning deltas and no content: the provider had cut the reply
            // off and nothing could say whether it spent two hundred tokens or
            // sixty-five thousand doing it, which is the difference between a
            // prompt problem and a completion cap.
            describeCost(response.cost)
        )

        // Asked again once, with no tools, which is the lever the malformed
        // tool call path already pulls: with nothing to call, a reply can only
        // be text. Measured at roughly one empty attempt in three against
        // openai/gpt-oss-20b when the window was starved, so a second sample
        // is worth one call.
        //
        // Not retried when `retrying` is already set: the call that just came
        // back empty was itself a no-tools call, and issuing the identical
        // request again would spend a call to ask the same question twice.
        if (!emptyRetryUsed && !retrying) {
          emptyRetryUsed = true
          retrying = true
          console.log("llm retry without tools: the reply was empty")
          continue
        }

        // Twice is not a fluke. The user has heard nothing and is waiting, so
        // they get something short and true, and history records the same
        // words — see emptyReplyRecord for why recording nothing was worse.
        const record = emptyReplyRecord(toolCallsThisTurn)
        this.messages.push({ role: "assistant", content: record })
        console.warn(`empty reply: delivering the fallback after ${toolCallsThisTurn} tool calls`)
        return EMPTY_REPLY_FALLBACK
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
      // How many of this group the remaining budget can pay for.
      //
      // A group is issued whole by the model and must be ANSWERED whole — an
      // assistant tool_calls message with a missing result is rejected by the
      // API — but it does not have to be RUN whole. The calls past the budget
      // get the over-budget placeholder instead of an execution, in the same
      // loop, so the group is complete either way and nothing special happens
      // to history. Without this, a single iteration of parallel calls could
      // walk straight past a budget that is checked only between iterations.
      const affordable =
        callBudget > 0
          ? Math.min(response.calls.length, Math.max(0, callBudget - toolCallsThisTurn))
          : response.calls.length
      // Counted here rather than per execution: a call the user declined, one
      // the search cap refused and one that timed out were all still calls
      // that reached the registry or the user. A discarded iteration
      // (unparseable arguments, above) never reaches this line, and a call the
      // budget could not pay for is not counted because it never ran.
      toolCallsThisTurn += affordable

      // Which calls in this group already have their result in history. The
      // group is only valid once every call does — see completeToolGroup.
      const answered = new Set<string>()
      try {
        for (const [index, tc] of response.calls.entries()) {
          if (index >= affordable) {
            this.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: NOT_EXECUTED_OVER_BUDGET,
            })
            answered.add(tc.id)
            logToolCall(
              tc.name,
              "over-budget",
              Date.now(),
              tc.arguments,
              `all ${callBudget} tool calls for this turn were already used`
            )
            continue
          }

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

          // Computed AFTER the cwd injection above: the same command in a
          // different directory is a different call, and the directory is part
          // of the arguments by the time anything runs.
          const signature = callSignature(tc.name, tc.arguments)
          const alreadyFailed = failedCalls.get(signature)

          if (!tool) {
            result = JSON.stringify({ error: `Unknown tool: ${tc.name}` })
            logToolCall(tc.name, "unknown", Date.now(), tc.arguments)
          } else if (tool.dedupeFailures && alreadyFailed !== undefined) {
            // The same call, byte for byte, that already failed this turn.
            //
            // Measured: one live turn ran `ls -R` in $HOME FOUR times, each
            // time getting the same "output too large" result, and another
            // re-sent nine identical piped commands. A result that explains
            // itself is not enough — the model re-reads its own history, sees
            // a command it believes in, and tries it again.
            //
            // Only calls that actually RAN and FAILED are remembered, and only
            // for tools that OPT IN with `dedupeFailures`, so this can never
            // block a call that worked or one whose outcome is not knowable.
            // It still costs a tool call: the budget is there to bound the
            // turn, and a repeat is still the model choosing to spend one.
            //
            // The opt-in is a flag of its own rather than "has isFailure",
            // which is what it used to be. Only a tool whose result is a pure
            // function of its arguments may enrol — `save_note` is the
            // counter-example, and registry.ts carries the reasoning.
            result = repeatedFailureResult(alreadyFailed)
            logToolCall(tool.name, "repeat", Date.now(), tc.arguments, "identical call already failed")
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

          // Remembered only for a call that RAN, that the tool itself calls a
          // failure, and that belongs to a tool enrolled in the refusal. A
          // declined, cancelled, capped or over-budget call did not fail — it
          // did not happen — and this map is read nowhere else, so recording a
          // tool that will never be refused would only grow it.
          if (ran && tool?.dedupeFailures && tool.isFailure?.(result)) {
            failedCalls.set(signature, firstLine(result))
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

    // Not the tool-call cap — that one ends in an answer, above. Reaching this
    // means the loop made `maxIterations` LLM calls without ever producing
    // text, which no normal turn can do: it is the runaway guard, and a
    // runaway is a failed turn.
    throw new Error(`LLM call limit (${maxIterations} calls in one turn) reached`)
  }
}
