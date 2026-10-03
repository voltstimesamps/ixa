// Acceptance run for the post-3c behaviour fixes.
//
// Most subcommands need a backend already running against a THROWAWAY
// database and Qdrant collection, so real memory is never touched:
//
//   IXA_DB_PATH=/tmp/ixa-verify.db QDRANT_COLLECTION=ixa_verify \
//     VOICE_MODE=true npm run dev
//
// and this script run with the same two variables set. "repl" and "tokens"
// start what they need themselves and want no backend.
//
//   npx tsx dev/scripts/behavior-verify.ts repl          # a
//   npx tsx dev/scripts/behavior-verify.ts conversation  # b
//   npx tsx dev/scripts/behavior-verify.ts memory        # c
//   npx tsx dev/scripts/behavior-verify.ts recent        # d
//   npx tsx dev/scripts/behavior-verify.ts voice         # e  (real audio in)
//   npx tsx dev/scripts/behavior-verify.ts freshness     # f
//   npx tsx dev/scripts/behavior-verify.ts tokens        # g
//   npx tsx dev/scripts/behavior-verify.ts status
//
// Tool calls are verified from the PERSISTED SESSION HISTORY in SQLite, not
// from the reply text: a model saying "I searched my memory" is exactly the
// claim under test, so the evidence has to be the recorded tool_calls.
import { spawn } from "child_process"
import Database from "better-sqlite3"
import { WebSocket } from "ws"
import { config } from "../../src/config"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"

let failures = 0

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
  return ok
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// --------------------------------------------------------------- SQLite view

interface SessionRow {
  id: string
  created_at: number
  last_turn_at: number
  ended_at: number | null
  messages: string
}

interface StoredMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

function withDb<T>(run: (db: Database.Database) => T): T {
  const db = new Database(config.data.dbPath, { readonly: true })
  try {
    return run(db)
  } finally {
    db.close()
  }
}

function sessionRows(): SessionRow[] {
  return withDb((db) =>
    db
      .prepare("SELECT id, created_at, last_turn_at, ended_at, messages FROM sessions ORDER BY created_at")
      .all() as SessionRow[]
  )
}

function messagesOf(row: SessionRow): StoredMessage[] {
  try {
    return JSON.parse(row.messages) as StoredMessage[]
  } catch {
    return []
  }
}

// Every tool name the session called, in order.
function toolCallsIn(row: SessionRow): string[] {
  return messagesOf(row).flatMap((message) =>
    (message.tool_calls ?? []).map((call) => call.function?.name ?? "?")
  )
}

function liveSession(): SessionRow | undefined {
  return sessionRows().filter((row) => row.ended_at === null).at(-1)
}

function episodeRows(): Array<{ id: number; session_id: string; summary: string; indexed_at: number | null }> {
  return withDb(
    (db) =>
      db.prepare("SELECT id, session_id, summary, indexed_at FROM episodes ORDER BY id").all() as Array<{
        id: number
        session_id: string
        summary: string
        indexed_at: number | null
      }>
  )
}

// ------------------------------------------------------------- WS client

interface Reply {
  text: string
  audioChunks: Buffer[]
  elapsedMs: number
}

interface Client {
  ask(text: string): Promise<Reply>
  askAudio(pcm16k: Buffer): Promise<Reply>
  close(): Promise<void>
}

async function connect(): Promise<Client> {
  const ws = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })

  let pending: {
    resolve: (reply: Reply) => void
    reject: (err: Error) => void
    startedAt: number
    text: string
    chunks: Buffer[]
  } | null = null

  ws.on("message", (data, isBinary) => {
    if (!pending) return
    if (isBinary) {
      pending.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      return
    }
    const msg = JSON.parse(data.toString()) as { type: string; content?: string }
    if (msg.type === "assistant") pending.text = msg.content ?? ""
    if (msg.type === "error") {
      const p = pending
      pending = null
      p.reject(new Error(msg.content ?? "ws error"))
    }
    // replyEnd is the one terminator per accepted turn: it arrives after the
    // last audio chunk, so waiting on it means no chunk is missed.
    if (msg.type === "replyEnd" || msg.type === "sessionEnd") {
      const p = pending
      pending = null
      p.resolve({ text: p.text, audioChunks: p.chunks, elapsedMs: Date.now() - p.startedAt })
    }
  })

  function await_(send: () => void): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out after 180s")), 180_000)
      pending = {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        startedAt: Date.now(),
        text: "",
        chunks: [],
      }
      send()
    })
  }

  return {
    ask: (text) => await_(() => ws.send(JSON.stringify({ type: "user", content: text }))),
    askAudio: (pcm) =>
      await_(() => {
        ws.send(JSON.stringify({ type: "audioStart" }))
        // 20ms of 16kHz mono 16-bit audio per frame, as the desktop client sends it.
        for (let offset = 0; offset < pcm.length; offset += 640) {
          ws.send(pcm.subarray(offset, Math.min(offset + 640, pcm.length)))
        }
        ws.send(JSON.stringify({ type: "audioInputEnd" }))
      }),
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve())
        ws.close()
      }),
  }
}

async function say(client: Client, text: string): Promise<Reply> {
  console.log(`  > ${text}`)
  const reply = await client.ask(text)
  console.log(`  < ${reply.text}  (${reply.elapsedMs}ms)`)
  return reply
}

// --------------------------------------------------------------- audio

// Each TTS frame is a standalone WAV. Pull the PCM out of the data chunk
// rather than assuming a 44-byte header, since Python's wave module may emit
// extra chunks.
function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  const sampleRate = wav.readUInt32LE(24)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === "data") {
      return { pcm: wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length)), sampleRate }
    }
    offset += 8 + size + (size % 2)
  }
  return { pcm: Buffer.alloc(0), sampleRate }
}

// Linear resample, 24kHz (Kokoro) → 16kHz (what the STT path assumes).
function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm
  const inSamples = Math.floor(pcm.length / 2)
  const outSamples = Math.floor((inSamples * to) / from)
  const out = Buffer.alloc(outSamples * 2)
  for (let i = 0; i < outSamples; i++) {
    const position = (i * from) / to
    const base = Math.floor(position)
    const frac = position - base
    const a = pcm.readInt16LE(Math.min(base, inSamples - 1) * 2)
    const b = pcm.readInt16LE(Math.min(base + 1, inSamples - 1) * 2)
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return out
}

// Speaks `text` with the TTS sidecar and returns it as 16kHz PCM, so a voice
// turn can be driven end to end without a microphone.
async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`${config.voice.ttsUrl}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`TTS returned ${response.status}`)

  const bytes = Buffer.from(await response.arrayBuffer())
  const pieces: Buffer[] = []
  let sampleRate = 24000
  let offset = 0
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const frame = bytes.subarray(offset + 4, offset + 4 + length)
    const { pcm, sampleRate: rate } = pcmFromWav(frame)
    sampleRate = rate
    pieces.push(pcm)
    offset += 4 + length
  }
  return resample(Buffer.concat(pieces), sampleRate, 16000)
}

function audioSeconds(chunks: Buffer[]): number {
  let samples = 0
  let rate = 24000
  for (const chunk of chunks) {
    const { pcm, sampleRate } = pcmFromWav(chunk)
    rate = sampleRate
    samples += pcm.length / 2
  }
  return samples / rate
}

const MARKDOWN_MARKERS = ["**", "__", "##", "```", "- ", "* ", "](", "~~"]

function markdownIn(text: string): string[] {
  const found = MARKDOWN_MARKERS.filter((marker) => text.includes(marker))
  if (/^\s*\d+[.)]\s/m.test(text)) found.push("numbered list")
  return found
}

// ------------------------------------------------------------------ a: REPL

// Starts a TEXT-mode backend (the REPL only runs when VOICE_MODE is not true),
// feeds it three lines, and reads the transcript back.
async function verifyRepl(): Promise<void> {
  section("a. the REPL handles /reset locally and the LLM never sees it")

  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VOICE_MODE: "false",
      // Nothing here needs speech, and spawning Kokoro costs ~30s.
      SIDECAR_AUTOSTART: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let output = ""
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString()
  })
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString()
  })

  const waitFor = (pattern: RegExp, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const started = Date.now()
      const poll = setInterval(() => {
        if (pattern.test(output)) {
          clearInterval(poll)
          resolve(true)
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll)
          resolve(false)
        }
      }, 200)
    })

  try {
    if (!(await waitFor(/Text mode: starting stdin REPL/, 60_000))) {
      check("the REPL started", false, output.slice(-400))
      return
    }

    child.stdin.write("Remember that my favourite GPU vendor is AMD.\n")
    await waitFor(/Ixa: /, 90_000)
    const beforeReset = output.length

    child.stdin.write("/reset\n")
    const announced = await waitFor(/Conversation ended\. New session /, 15_000)
    // Give the LLM time to answer, if it was wrongly sent the line at all.
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    const afterReset = output.slice(beforeReset)

    check("/reset is announced locally", announced, afterReset.trim().split("\n")[0] ?? "")
    check(
      "the LLM produced no reply to /reset",
      !afterReset.includes("Ixa: "),
      afterReset.includes("Ixa: ") ? "a reply came back — the line was sent to the model" : "no 'Ixa:' line"
    )
    check(
      "the session ended through the normal reset path",
      /ended \(reset\)/.test(afterReset),
      (/Session \S+ ended \(reset\).*/.exec(afterReset) ?? [""])[0]
    )

    child.stdin.write("Hello again.\n")
    await waitFor(/Ixa: /, 90_000)
    child.stdin.end()
  } finally {
    child.kill("SIGINT")
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    child.kill("SIGKILL")
  }

  const rows = sessionRows()
  check("two sessions exist afterwards", rows.length >= 2, `${rows.length} session row(s)`)
  const ended = rows.filter((row) => row.ended_at !== null)
  check("the first one is ended and kept", ended.length >= 1, `${ended.length} ended`)
  if (ended.length > 0) {
    const first = ended.at(-1)!
    const texts = messagesOf(first)
      .filter((m) => m.role === "user")
      .map((m) => String(m.content))
    check(
      "'/reset' is nowhere in the stored history",
      !texts.some((t) => t.trim().toLowerCase() === "/reset"),
      `user messages: ${JSON.stringify(texts)}`
    )
  }
}

// --------------------------------------------------- b: start_new_conversation

async function verifyConversation(): Promise<void> {
  section("b. asking to start a new conversation ends the session after the turn")

  const client = await connect()
  const before = liveSession()
  console.log(`  live session before: ${before?.id ?? "(none)"}`)

  // Two turns first, so the ending session clears IXA_EPISODE_MIN_USER_TURNS
  // and is worth summarizing.
  await say(client, "I'm planning a trip to Lisbon in March. Remember that.")
  await say(client, "What's the one thing I should book first?")

  const reply = await say(client, "Let's start a new conversation.")

  // The end is honoured at the turn boundary, which is before the reply is
  // spoken; give the detached summarizer a moment regardless.
  await new Promise((resolve) => setTimeout(resolve, 2_000))

  const rows = sessionRows()
  const ended = rows.find((row) => row.id === before?.id || (row.ended_at !== null && toolCallsIn(row).includes("start_new_conversation")))

  if (!check("the session that was asked to end has ended", !!ended && ended.ended_at !== null, ended?.id ?? "not found")) {
    await client.close()
    return
  }

  const calls = toolCallsIn(ended!)
  check("start_new_conversation was actually called", calls.includes("start_new_conversation"), `tools called: ${calls.join(", ") || "none"}`)

  const roles = messagesOf(ended!).map((m) => m.role)
  check(
    "the whole turn is in the ended session's history, reply included",
    roles.at(-1) === "assistant",
    `last stored message role: ${roles.at(-1)}`
  )
  check("the reply was not empty", reply.text.trim().length > 0, `${reply.text.length} chars`)

  const live = liveSession()
  check("a fresh session is live", !!live && live.id !== ended!.id, live?.id ?? "none")

  // The next turn must land in the fresh session with no prior context.
  const next = await say(client, "Where was I going again?")
  const afterTurn = sessionRows().find((row) => row.id === live?.id)
  const freshUsers = afterTurn ? messagesOf(afterTurn).filter((m) => m.role === "user").length : -1
  check("the next turn ran in the fresh session", freshUsers === 1, `${freshUsers} user message(s) in it`)
  console.log(`  (reply with no context: ${JSON.stringify(next.text.slice(0, 160))})`)

  for (let i = 0; i < 15 && !episodeRows().some((e) => e.session_id === ended!.id); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  const episode = episodeRows().find((e) => e.session_id === ended!.id)
  check("the old conversation became an episode", !!episode, episode ? `#${episode.id}: ${episode.summary.slice(0, 110)}` : "no episode row")

  await client.close()
}

// --------------------------------------------------------- c: memory awareness

async function verifyMemory(): Promise<void> {
  section("c. she uses memory instead of denying she has any")

  const client = await connect()
  const questions = ["Do you remember anything about me?", "Pull your memory."]
  const denials = [
    /no stored memor/i,
    /don'?t have (?:any )?(?:stored |saved |persistent )?memor/i,
    /do not have (?:any )?(?:stored |saved |persistent )?memor/i,
    /i (?:can'?t|cannot) remember anything/i,
    /i have no memory/i,
    /no (?:access to )?(?:any )?(?:previous|past) conversations/i,
    /i'?m stateless/i,
  ]

  for (const question of questions) {
    const reply = await say(client, question)
    const live = liveSession()
    const calls = live ? toolCallsIn(live) : []
    const used = calls.filter((name) => ["search_memory", "list_preferences"].includes(name))

    check(`"${question}" used a memory tool`, used.length > 0, `tools called: ${calls.join(", ") || "none"}`)
    const denied = denials.filter((pattern) => pattern.test(reply.text))
    check(`"${question}" did not deny having memory`, denied.length === 0, denied.length > 0 ? `matched ${denied[0]}` : "")
  }

  await client.close()
}

// ------------------------------------------------------------- d: recency

async function verifyRecent(): Promise<void> {
  section("d. a question about the last conversation is answered from recent episodes")

  const episodes = episodeRows()
  console.log(`  ${episodes.length} episode(s) available to recall`)
  if (episodes.length === 0) {
    check("there is at least one episode to recall", false, "run 'conversation' first")
    return
  }

  const client = await connect()
  const reply = await say(client, "What did we talk about last time?")

  const live = liveSession()
  const calls = live ? toolCallsIn(live) : []
  check("search_memory was called", calls.includes("search_memory"), `tools called: ${calls.join(", ") || "none"}`)

  // The point of the change: no query means recency rather than meaning.
  const args = live
    ? messagesOf(live)
        .flatMap((m) => m.tool_calls ?? [])
        .filter((c) => c.function?.name === "search_memory")
        .map((c) => c.function?.arguments ?? "{}")
    : []
  console.log(`  search_memory arguments: ${args.join(" | ") || "none"}`)
  const queryless = args.some((raw) => {
    try {
      const parsed = JSON.parse(raw) as { query?: string }
      return !parsed.query || parsed.query.trim() === ""
    } catch {
      return false
    }
  })
  check("it was called without a query (the recency path)", queryless, queryless ? "" : "a query was supplied")

  const newest = episodes.at(-1)!
  const topicWords = newest.summary
    .toLowerCase()
    .match(/[a-z]{5,}/g)
    ?.filter((word) => !["about", "there", "their", "which", "would", "could", "should", "conversation", "discussed", "assistant"].includes(word))
    ?.slice(0, 12) ?? []
  const hit = topicWords.filter((word) => reply.text.toLowerCase().includes(word))
  check(
    "the answer reflects the most recent episode",
    hit.length > 0,
    `overlapping terms: ${hit.join(", ") || "none"} (newest episode: ${newest.summary.slice(0, 110)})`
  )

  await client.close()
}

// ------------------------------------------------------- e: voice-origin reply

async function verifyVoice(): Promise<void> {
  section("e. a voice question that invites a list gets a short spoken answer")

  const question = "Recommend some GPUs for a budget gaming build."
  console.log(`  synthesizing the question so the turn really is voice-origin...`)
  const pcm = await synthesize(question)
  console.log(`  ${(pcm.length / 2 / 16000).toFixed(1)}s of 16kHz input audio`)

  const client = await connect()
  console.log(`  > (spoken) ${question}`)
  const reply = await client.askAudio(pcm)
  console.log(`  < ${reply.text}`)

  const seconds = audioSeconds(reply.audioChunks)
  const markers = markdownIn(reply.text)

  console.log(`\n  reply:        ${reply.text.length} chars`)
  console.log(`  audio:        ${reply.audioChunks.length} chunk(s), ${seconds.toFixed(1)}s of speech`)
  console.log(`  markdown:     ${markers.length > 0 ? markers.join(" ") : "none"}`)
  console.log(`  turn:         ${reply.elapsedMs}ms`)

  check("the turn was transcribed and answered", reply.text.trim().length > 0, `${reply.text.length} chars`)
  check("the spoken reply is short", seconds > 0 && seconds <= 25, `${seconds.toFixed(1)}s of audio`)
  check("no markdown reached TTS", markers.length === 0, markers.length > 0 ? `the model emitted ${markers.join(" ")} — the sanitizer strips it from the audio, but the prompt did not prevent it` : "")
  check("the reply was not truncated", !/\w$/.test(reply.text.trim()) || /[.!?]$/.test(reply.text.trim()), "ends on a sentence boundary")

  await client.close()
}

// ----------------------------------------------------------- f: freshness

async function verifyFreshness(): Promise<void> {
  section("f. a price question searches the web or admits uncertainty")

  const client = await connect()
  const reply = await say(client, "How much does a used RTX 3060 cost?")

  const live = liveSession()
  const calls = live ? toolCallsIn(live) : []
  const searched = calls.includes("web_search")

  const hedged = /not sure|can'?t be sure|cannot be sure|may be out of date|might be out of date|don'?t have (?:live|current|real-?time)|without searching|unable to search/i.test(reply.text)
  const statesPrice = /\$\s?\d|\d+\s?(?:dollars|usd)/i.test(reply.text)

  console.log(`  tools called: ${calls.join(", ") || "none"}`)
  check("web_search was called, or she said she was unsure", searched || hedged, searched ? "web_search called" : hedged ? "hedged without searching" : "neither")
  check(
    "no bare price stated from memory",
    searched || !statesPrice || hedged,
    statesPrice && !searched && !hedged ? "a figure was stated with no search and no hedge" : ""
  )

  await client.close()
}

// -------------------------------------------------------------- g: tokens

// Pulls a string literal constant out of a revision of session.ts, so the
// "before" prompts can be measured without checking the branch out.
function promptFromRevision(revision: string, name: string): string {
  const { execFileSync } = require("child_process") as typeof import("child_process")
  const source = execFileSync("git", ["show", `${revision}:src/core/session.ts`], { encoding: "utf8" })
  const match = new RegExp(`(?:export )?const ${name} =\\n?([\\s\\S]*?)\\n\\n`).exec(source)
  if (!match) throw new Error(`${name} not found in ${revision}`)
  return [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((piece) => piece[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"'))
    .join("")
}

async function verifyTokens(): Promise<void> {
  section("g. request token sizes, before and after")

  const { registry } = await import("../../src/tools/registry")
  await import("../../src/tools/register")
  const { SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT } = await import("../../src/core/session")
  const { buildWindow } = await import("../../src/core/context-window")
  const OpenAI = (await import("openai")).default

  const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey })

  // Measuring the limit costs tokens against the limit: every call here is
  // billed its full prompt_tokens even with max_tokens 1. Paced so the run
  // does not 429 itself halfway through and report nothing.
  const TPM_LIMIT = 8000
  const spent: Array<{ at: number; tokens: number }> = []

  async function pace(estimate: number): Promise<void> {
    for (;;) {
      const cutoff = Date.now() - 60_000
      while (spent.length > 0 && spent[0]!.at < cutoff) spent.shift()
      const used = spent.reduce((sum, entry) => sum + entry.tokens, 0)
      if (used + estimate <= TPM_LIMIT * 0.9) return
      const waitMs = Math.max(1_000, spent[0]!.at + 60_000 - Date.now() + 500)
      console.log(`    (pacing: ${used} tok used this minute, waiting ${Math.ceil(waitMs / 1000)}s)`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }

  // Exact input size, from the provider that enforces the limit. max_tokens 1
  // keeps the completion cost to nothing; prompt_tokens is what we are after.
  async function promptTokens(messages: unknown[], tools: unknown[]): Promise<number> {
    // Rough pre-estimate, only to decide whether to wait first.
    const estimate = Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3.5)
    await pace(estimate)

    const response = await client.chat.completions.create({
      model: config.llm.model,
      messages: messages as never,
      tools: tools.length > 0 ? (tools as never) : undefined,
      max_tokens: 1,
      temperature: 0,
    })
    const tokens = response.usage?.prompt_tokens ?? -1
    spent.push({ at: Date.now(), tokens: Math.max(tokens, estimate) })
    return tokens
  }

  const before = {
    system: promptFromRevision("main", "SYSTEM_PROMPT"),
    voice: promptFromRevision("main", "VOICE_RESPONSE_PROMPT"),
  }
  const after = { system: SYSTEM_PROMPT, voice: VOICE_RESPONSE_PROMPT }

  console.log("\n  Prompts (characters, and tokens as the API counts them):")
  for (const [label, prompts] of [["before", before], ["after", after]] as const) {
    const systemTokens = await promptTokens([{ role: "system", content: prompts.system }], [])
    const voiceTokens = await promptTokens([{ role: "system", content: prompts.voice }], [])
    console.log(
      `    ${label.padEnd(6)} SYSTEM_PROMPT ${String(prompts.system.length).padStart(5)} chars / ${String(systemTokens).padStart(4)} tok` +
        `   VOICE_RESPONSE_PROMPT ${String(prompts.voice.length).padStart(4)} chars / ${String(voiceTokens).padStart(4)} tok`
    )
  }

  // Tool schemas: sent on every call, and the largest fixed cost in a request.
  const toolsAfter = registry.toOpenAI()
  const toolsBefore = toolsAfter.filter((tool) => tool.function.name !== "start_new_conversation")
  console.log("\n  Tool schemas (every request carries these):")
  for (const [label, tools] of [["before", toolsBefore], ["after", toolsAfter]] as const) {
    const tokens = await promptTokens([{ role: "user", content: "hi" }], tools as unknown[])
    const baseline = await promptTokens([{ role: "user", content: "hi" }], [])
    console.log(
      `    ${label.padEnd(6)} ${String(tools.length).padStart(2)} tools, ${String(JSON.stringify(tools).length).padStart(5)} chars / ~${String(tokens - baseline).padStart(4)} tok`
    )
  }

  // A representative conversation, filled to each context budget so the
  // windowed history is realistic rather than a toy.
  // Messages long enough that the CHARACTER budget is what binds, not
  // maxMessages — otherwise 24000 and 12000 window identically and the
  // comparison says nothing. ~600 chars each: 40 messages is ~24000.
  const filler =
    "I've been working through the voice pipeline on the gaming PC, mostly the TTS sentence " +
    "chunking and the wake word threshold, and I want first audio under two seconds before " +
    "moving on to anything else. The Kokoro sidecar splits on the explicit pattern now, which " +
    "fixed the fourteen second wait, but the inter-chunk margin is still thin and I am not sure " +
    "whether that is the thread count or the real-time factor. "
  function conversation(budgetChars: number): Array<{ role: string; content: string }> {
    const history: Array<{ role: string; content: string }> = []
    for (let i = 0; i < 60; i++) {
      history.push({ role: "user", content: `${filler}Turn ${i}: what should I look at next?` })
      history.push({
        role: "assistant",
        content: `${filler}For turn ${i}, start with the sentence split pattern and re-measure.`,
      })
    }
    return buildWindow([{ role: "system", content: "" }, ...history] as never, {
      maxMessages: 40,
      budgetChars,
    }).slice(1) as Array<{ role: string; content: string }>
  }

  const preferenceBlock =
    "The user's saved preferences. Apply them without being asked.\n" +
    Array.from({ length: 8 }, (_, i) => `- [technical] preference ${i}: a sentence stating what the user prefers here.`).join("\n")
  const recallBlock =
    "Notes from earlier conversations that may be relevant.\n" +
    Array.from({ length: 3 }, (_, i) => `- Fri 3 Oct 2026, 14:${i}0: A summary of a past conversation covering several topics and what was decided in it.`).join("\n")

  console.log("\n  A full voice request (system + preferences + recall + history + voice constraint + tools):")
  console.log(`    Groq free tier: 8000 tokens per minute. ${"-".repeat(20)}`)
  for (const budget of [24000, 12000]) {
    const history = conversation(budget)
    for (const [label, prompts, tools] of [
      ["before", before, toolsBefore],
      ["after", after, toolsAfter],
    ] as const) {
      const messages = [
        { role: "system", content: prompts.system },
        { role: "system", content: preferenceBlock },
        { role: "system", content: recallBlock },
        ...history,
        { role: "system", content: prompts.voice },
      ]
      const tokens = await promptTokens(messages, tools as unknown[])
      const flag = tokens > 8000 ? "  OVER THE 8000 TPM LIMIT" : ""
      const historyChars = history.reduce((sum, m) => sum + String(m.content ?? "").length, 0)
      console.log(
        `    budget ${String(budget).padStart(5)} chars, ${label.padEnd(6)} ${String(tokens).padStart(5)} tok` +
          ` (${history.length} history messages, ${historyChars} chars)${flag}`
      )
    }
  }

  // The freshness rule will make web_search run far more often, so what one
  // search turn actually costs matters more than it used to.
  section("g (cont). the cost of one web_search turn")
  const searchTool = registry.get("web_search")!
  let result: string
  try {
    const output = await searchTool.execute({ query: "used RTX 3060 price" })
    result = typeof output === "string" ? output : JSON.stringify(output)
  } catch (err) {
    result = `(web_search failed: ${err instanceof Error ? err.message : String(err)})`
  }
  console.log(`  web_search result: ${result.length} chars`)
  if (result.startsWith("(web_search failed")) {
    check("web_search returned a result to measure", false, result)
    return
  }

  const history = conversation(12000)
  const base = [
    { role: "system", content: after.system },
    { role: "system", content: preferenceBlock },
    { role: "system", content: recallBlock },
    ...history,
    { role: "user", content: "How much does a used RTX 3060 cost?" },
  ]
  const callOne = await promptTokens([...base, { role: "system", content: after.voice }], toolsAfter as unknown[])

  const withResult = [
    ...base,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query: "used RTX 3060 price" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: result },
    { role: "system", content: after.voice },
  ]
  const callTwo = await promptTokens(withResult, toolsAfter as unknown[])

  console.log(`  call 1 (decides to search):      ${String(callOne).padStart(5)} tok`)
  console.log(`  call 2 (with the search result): ${String(callTwo).padStart(5)} tok`)
  console.log(`  whole turn, both calls:          ${String(callOne + callTwo).padStart(5)} tok  (limit is 8000 per MINUTE)`)
  check("one search turn fits inside the per-minute budget", callOne + callTwo <= 8000, `${callOne + callTwo} tok`)
}

// -------------------------------------------------------------- status

async function verifyStatus(): Promise<void> {
  section("status")
  console.log(`  database:   ${config.data.dbPath}`)
  console.log(`  collection: ${config.qdrant.collection}`)
  console.log(`  voice mode: ${config.voice.enabled}`)

  const rows = sessionRows()
  console.log(`\n  ${rows.length} session(s):`)
  for (const row of rows) {
    const users = messagesOf(row).filter((m) => m.role === "user").length
    const tools = toolCallsIn(row)
    console.log(
      `    ${row.id.slice(0, 8)} ${row.ended_at ? "ended " : "LIVE  "} ${String(users).padStart(2)} user turn(s)` +
        `${tools.length > 0 ? `  tools: ${tools.join(", ")}` : ""}`
    )
  }

  const episodes = episodeRows()
  console.log(`\n  ${episodes.length} episode(s):`)
  for (const episode of episodes) {
    console.log(`    #${episode.id} ${episode.indexed_at ? "indexed" : "NOT INDEXED"} — ${episode.summary.slice(0, 120)}`)
  }
}

// ---------------------------------------------------------------- main

const COMMANDS: Record<string, () => Promise<void>> = {
  repl: verifyRepl,
  conversation: verifyConversation,
  memory: verifyMemory,
  recent: verifyRecent,
  voice: verifyVoice,
  freshness: verifyFreshness,
  tokens: verifyTokens,
  status: verifyStatus,
}

async function main(): Promise<void> {
  const name = process.argv[2]
  const command = name ? COMMANDS[name] : undefined
  if (!command) {
    console.error(`usage: behavior-verify.ts <${Object.keys(COMMANDS).join(" | ")}>`)
    process.exit(2)
  }

  await command()
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("\nverification aborted:", err instanceof Error ? err.message : err)
  process.exit(1)
})
