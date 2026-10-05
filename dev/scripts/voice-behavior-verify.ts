// Acceptance run for the voice-behaviour branch.
//
// Every subcommand needs a backend already running against a THROWAWAY
// database and Qdrant collection, so real memory is never touched:
//
//   IXA_DB_PATH=/tmp/ixa-voice.db QDRANT_COLLECTION=ixa_voice \
//     VOICE_MODE=true npm run dev
//
// and this script run with the same two variables set.
//
//   npx tsx dev/scripts/voice-behavior-verify.ts scoreboard   # 1
//   npx tsx dev/scripts/voice-behavior-verify.ts lasttime     # 2
//   npx tsx dev/scripts/voice-behavior-verify.ts freshness    # 3
//   npx tsx dev/scripts/voice-behavior-verify.ts dismiss      # 5
//   npx tsx dev/scripts/voice-behavior-verify.ts tokens       # prompt cost
//   npx tsx dev/scripts/voice-behavior-verify.ts strays       # 6, read-only
//
// The scoreboard is run TWICE against the same build to separate the two
// length fixes, because the backstop can be switched off from the
// environment:
//
//   IXA_VOICE_MAX_SENTENCES=0 ... npm run dev   # prompt examples alone
//   ...                         npm run dev     # plus the backstop
//
// and once more with LLM_MODEL=openai/gpt-oss-120b (inline, never in .env) to
// tell a prompt problem from a model-size one.
//
// As in behavior-verify.ts, evidence comes from what the backend RECORDED,
// not from the reply text. A model saying "I searched" is the claim under
// test; the backstop's bracketed history note is how we know it fired.
import OpenAI from "openai"
import { config } from "../../src/config"
import "../../src/tools/register"
import { registry } from "../../src/tools/registry"
import { SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT } from "../../src/core/session"
import { shortenForSpeech, CONTINUE_OFFER } from "../../src/voice/shorten"
import { parseDismiss } from "../../src/voice/dismiss"
import { getPreferenceStore } from "../../src/memory/preferences"
import { formatEpisodeWhen, getEpisodeStore } from "../../src/memory/episodes"
import {
  audioSeconds,
  connect,
  markdownIn,
  say,
  synthesize,
  type Reply,
} from "./lib/voice"
import { episodeRows, liveSession, messagesOf, sessionRows, toolCallsInLastTurn } from "./lib/db"

let failures = 0

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
  return ok
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// The note the session layer leaves in history when the backstop cuts a
// reply. Matching it here rather than counting log lines keeps the evidence in
// the same place as every other check in these scripts.
const BACKSTOP_NOTE = /\[reply shortened for speech: spoke (\d+) of (\d+) sentences\]/

function backstopFiresInHistory(): Array<{ kept: number; total: number }> {
  const fires: Array<{ kept: number; total: number }> = []
  for (const row of sessionRows()) {
    for (const message of messagesOf(row)) {
      if (message.role !== "assistant" || typeof message.content !== "string") continue
      const match = BACKSTOP_NOTE.exec(message.content)
      if (match) fires.push({ kept: Number(match[1]), total: Number(match[2]) })
    }
  }
  return fires
}

// ------------------------------------------------------------ 1: scoreboard

// Six questions that all invite a list. None of them asks for brevity: the
// point is what Ixa does when nothing stops her.
const LIST_TEMPTING = [
  "Recommend some GPUs for a budget gaming build.",
  "What are the best local models to run on a 3060?",
  "What should I check first when a 3D print fails?",
  "How do I set up Tailscale across my machines?",
  "What are the main differences between Qdrant and other vector databases?",
  "What can you actually do for me?",
]

async function verifyScoreboard(): Promise<void> {
  section("1. spoken length on six list-tempting voice questions")
  const limitsOff = config.voice.maxSpokenSentences < 1 && config.voice.maxSpokenWords < 1
  console.log(
    `  backstop: ${limitsOff ? "OFF (both limits disabled)" : `${config.voice.maxSpokenSentences} sentences / ${config.voice.maxSpokenWords} words`}`
  )
  console.log(`  model:    ${config.llm.model}\n`)

  const firesBefore = backstopFiresInHistory().length
  const rows: Array<{
    question: string
    seconds: number
    sentences: number
    words: number
    chars: number
    markdown: string[]
  }> = []

  const client = await connect()
  for (const question of LIST_TEMPTING) {
    console.log(`  > (spoken) ${question}`)
    // Synthesized so the turn is genuinely voice-origin — the constraint and
    // the backstop both key off that, so a typed question would measure
    // nothing.
    const pcm = await synthesize(question)
    let reply: Reply
    try {
      reply = await client.askAudio(pcm)
    } catch (err) {
      check(`answered: ${question.slice(0, 40)}`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const seconds = audioSeconds(reply.audioChunks)
    // Counted with the backstop's own splitter, so "sentences" means the same
    // thing here as it does in the code being measured.
    //
    // The offer the backstop appends is itself a sentence, so a trimmed reply
    // would otherwise count as the limit plus one and fail a check it actually
    // passed. The column means sentences OF ANSWER.
    const trimmed = reply.text.trimEnd().endsWith(CONTINUE_OFFER)
    const counted = shortenForSpeech(reply.text, { maxUnits: 0, maxWords: 0 })
    const sentences = counted.total - (trimmed ? 1 : 0)
    // The offer is the backstop talking, not the answer, so it is excluded from
    // both counts — otherwise a reply that landed exactly on budget reads as
    // over it.
    const offerWords = trimmed
      ? shortenForSpeech(CONTINUE_OFFER, { maxUnits: 0, maxWords: 0 }).totalWords
      : 0
    const words = counted.totalWords - offerWords
    rows.push({ question, seconds, sentences, words, chars: reply.text.length, markdown: markdownIn(reply.text) })
    console.log(`  < ${reply.text}`)
    console.log(
      `    ${seconds.toFixed(1)}s spoken, ${words} word(s), ${sentences} sentence(s)` +
        `${trimmed ? " + offer" : ""}, ${reply.text.length} chars\n`
    )
  }
  await client.close()

  const fires = backstopFiresInHistory().slice(firesBefore)

  console.log("  scoreboard:")
  console.log("    seconds  words  sentences  question")
  for (const row of rows) {
    console.log(
      `    ${row.seconds.toFixed(1).padStart(7)}  ${String(row.words).padStart(5)}  ` +
        `${String(row.sentences).padStart(9)}  ${row.question.slice(0, 46)}`
    )
  }

  const answered = rows.length
  const seconds = rows.map((row) => row.seconds)
  const mean = seconds.reduce((sum, value) => sum + value, 0) / (answered || 1)
  const worst = Math.max(0, ...seconds)
  const overLimit = rows.filter((row) => row.sentences > Math.max(1, config.voice.maxSpokenSentences))
  const withMarkdown = rows.filter((row) => row.markdown.length > 0)

  const wordCounts = rows.map((row) => row.words)
  const meanWords = wordCounts.reduce((sum, value) => sum + value, 0) / (answered || 1)
  const worstWords = Math.max(0, ...wordCounts)

  console.log(`\n  answered:        ${answered}/${LIST_TEMPTING.length}`)
  console.log(`  mean spoken:     ${mean.toFixed(1)}s`)
  console.log(`  longest spoken:  ${worst.toFixed(1)}s`)
  console.log(`  mean words:      ${meanWords.toFixed(1)}`)
  console.log(`  most words:      ${worstWords}`)
  console.log(`  backstop fired:  ${fires.length}/${answered}${fires.length ? ` (${fires.map((f) => `${f.kept}/${f.total}`).join(", ")})` : ""}`)
  console.log(`  markdown:        ${withMarkdown.length}/${answered}`)

  check("every question was answered", answered === LIST_TEMPTING.length, `${answered}/${LIST_TEMPTING.length}`)
  // 25s is the comfort target the voice prompt describes ("roughly fifteen
  // seconds is already long"). It is reported rather than enforced as a hard
  // gate, because the backstop bounds SENTENCE COUNT and nothing bounds
  // sentence length — three sentences can still run past half a minute.
  check("no reply ran past 25 seconds of speech", worst <= 25, `longest ${worst.toFixed(1)}s`)
  console.log(
    `  (seconds per sentence: ${rows.map((row) => (row.sentences ? (row.seconds / row.sentences).toFixed(1) : "-")).join(", ")})`
  )
  check("no markdown reached TTS", withMarkdown.length === 0, withMarkdown.map((row) => row.markdown.join(" ")).join("; "))
  if (!limitsOff) {
    check(
      "no spoken reply exceeded the word budget",
      worstWords <= config.voice.maxSpokenWords,
      `most ${worstWords}, budget ${config.voice.maxSpokenWords}`
    )
  }
  if (config.voice.maxSpokenSentences > 0) {
    check(
      "no spoken reply exceeded the sentence limit",
      overLimit.length === 0,
      overLimit.map((row) => `${row.sentences} sentences`).join(", ")
    )
  } else {
    console.log("  (backstop off: sentence counts are the prompt's work alone)")
  }
}

// -------------------------------------------------------------- 2: lasttime

async function verifyLastTime(): Promise<void> {
  section("2. \"what did we talk about last time?\" names the most recent episode")

  const episodes = episodeRows()
  if (episodes.length === 0) {
    check("there is an episode to recall", false, "no episodes — run behavior-verify.ts recent first")
    return
  }
  const newest = episodes.at(-1)!
  console.log(`  newest episode #${newest.id}: ${newest.summary.slice(0, 120)}`)

  // The failure this fixes needs a preference whose topic OVERLAPS the
  // episode: that is what made the preference block look like an answer.
  const preferences = getPreferenceStore()
  const topic = "gpu-budget"
  if (!preferences.listActive().some((preference) => preference.topic === topic)) {
    preferences.remember({
      topic,
      value: "around $500 for a GPU, used is fine",
      category: "hardware",
    })
    console.log(`  seeded an overlapping preference [${topic}]`)
  }

  const client = await connect()
  const reply = await say(client, "What did we talk about last time?")
  await client.close()

  const live = liveSession()
  const calls = live ? toolCallsInLastTurn(live) : []
  console.log(`  tools called: ${calls.join(", ") || "none"}`)

  check("the question got a non-empty answer", reply.text.trim().length > 0, `${reply.text.length} chars`)
  check("search_memory was called", calls.includes("search_memory"), calls.join(", ") || "none")

  // Does the reply describe the episode, or the preference? Overlapping words
  // from the summary are the signal; the preference's own wording is the
  // counter-signal.
  const summaryWords = new Set(
    newest.summary.toLowerCase().match(/[a-z]{5,}/g)?.slice(0, 40) ?? []
  )
  const replyWords = new Set(reply.text.toLowerCase().match(/[a-z]{5,}/g) ?? [])
  const overlap = [...summaryWords].filter((word) => replyWords.has(word))

  check(
    "the reply describes the episode, not the preference",
    overlap.length >= 2,
    `overlapping terms: ${overlap.slice(0, 6).join(", ") || "none"}`
  )
}

// ------------------------------------------------------------- 3: freshness

async function verifyFreshness(): Promise<void> {
  section("3. an INCIDENTAL price inside a recommendation is searched")

  // Deliberately not a price question. The old rule read as being about
  // questions, so a price mentioned in passing escaped it.
  const question = "I want a quiet GPU for a small case. Which one should I get?"

  const client = await connect()
  const reply = await say(client, question)
  await client.close()

  const live = liveSession()
  // This turn's calls only — an earlier turn's search must not satisfy this.
  const calls = live ? toolCallsInLastTurn(live) : []
  const searched = calls.includes("web_search")
  const statesPrice = /\$\s?\d|\d+\s?(?:dollars|usd|pounds|quid)|£\s?\d/i.test(reply.text)
  const hedged =
    /not sure|can'?t be sure|cannot be sure|may be out of date|might be out of date|don'?t have (?:live|current|real-?time)|without searching|unable to search|look up|check (?:the )?current/i.test(
      reply.text
    )

  console.log(`  tools called:  ${calls.join(", ") || "none"}`)
  console.log(`  states price:  ${statesPrice}`)
  console.log(`  hedged:        ${hedged}`)

  // Without this, an empty reply satisfies "no price was stated from memory"
  // and the check passes having tested nothing.
  check("the question got a non-empty answer", reply.text.trim().length > 0, `${reply.text.length} chars`)
  check(
    "a price was searched for, or none was stated",
    searched || !statesPrice,
    statesPrice && !searched ? "a figure was stated with no search" : ""
  )
  check(
    "no bare figure from memory",
    searched || !statesPrice || hedged,
    statesPrice && !searched && !hedged ? "stated with no search and no hedge" : ""
  )
}

// --------------------------------------------------------------- 5: dismiss

async function verifyDismiss(): Promise<void> {
  section("5. a dismiss only at the end of an utterance, and never negated")

  // The parser first, with no backend involved: these are the exact
  // transcripts that motivated the change.
  const cases: Array<[string, boolean, string]> = [
    ["What's the capital of Japan? Stop listening.", true, "What's the capital of Japan?"],
    ["Don't stop listening.", false, ""],
    ["Stop listening.", true, ""],
    ["Okay, thanks. Stop listening.", true, ""],
    ["I told her to stop listening to him", false, ""],
  ]
  for (const [text, dismissed, remainder] of cases) {
    const result = parseDismiss(text)
    check(
      `${JSON.stringify(text)} → ${dismissed ? "dismiss" : "normal turn"}`,
      result.dismissed === dismissed && result.remainder === remainder,
      `got dismissed=${result.dismissed} remainder=${JSON.stringify(result.remainder)}`
    )
  }

  // Then end to end: the question is answered AND the window closes. The
  // client's own terminator tells us which happened — askAudio resolves on
  // replyEnd or sessionEnd, so a dismiss-with-question has to produce a real
  // reply first.
  console.log("\n  end to end, spoken:")
  const client = await connect()

  const pcm = await synthesize("What is the capital of Japan? Stop listening.")
  console.log("  > (spoken) What is the capital of Japan? Stop listening.")
  const reply = await client.askAudio(pcm)
  console.log(`  < ${reply.text}`)

  check(
    "the question before the dismiss was answered",
    /tokyo/i.test(reply.text),
    reply.text.slice(0, 80) || "empty reply"
  )

  const live = liveSession()
  const userTurns = live
    ? messagesOf(live).filter((message) => message.role === "user").map((message) => String(message.content))
    : []
  const lastTurn = userTurns.at(-1) ?? ""
  check(
    "the dismiss phrase was stripped from the recorded turn",
    lastTurn.length > 0 && !/stop listening/i.test(lastTurn),
    `recorded: ${JSON.stringify(lastTurn.slice(0, 80))}`
  )

  const negated = await synthesize("Don't stop listening.")
  console.log("  > (spoken) Don't stop listening.")
  const negatedReply = await client.askAudio(negated)
  console.log(`  < ${negatedReply.text}`)
  check(
    "a negated dismiss got a real reply instead of a goodbye",
    negatedReply.text.trim().length > 0 && negatedReply.text.trim() !== "Goodbye.",
    negatedReply.text.slice(0, 80) || "empty reply"
  )

  await client.close()
}

// ---------------------------------------------------------------- 6: strays

// Read-only. Reports; fixes nothing.
function verifyStrays(): void {
  section("6. stray recordings persisted as user turns")

  for (const row of sessionRows()) {
    const messages = messagesOf(row)
    // A user message with no assistant message after it before the next user
    // message: a turn that was recorded and never answered.
    const unanswered: string[] = []
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role !== "user") continue
      const next = messages.slice(i + 1).find((message) => message.role !== "system")
      if (!next || next.role === "user") unanswered.push(String(messages[i]!.content))
    }

    const presidents = messages
      .filter((message) => message.role === "user" && /president/i.test(String(message.content)))
      .map((message) => String(message.content))

    if (unanswered.length === 0 && presidents.length === 0) continue

    console.log(`\n  session ${row.id.slice(0, 8)} (${new Date(row.created_at).toLocaleString("en-GB")})`)
    for (const text of unanswered) {
      console.log(`    unanswered user turn: ${JSON.stringify(text.slice(0, 90))}`)
    }
    for (const text of presidents) {
      console.log(`    mentions a president:  ${JSON.stringify(text.slice(0, 90))}`)
    }
  }

  const apologies = sessionRows().flatMap((row) =>
    messagesOf(row).filter(
      (message) => message.role === "assistant" && /\[turn failed:/.test(String(message.content ?? ""))
    )
  )
  console.log(`\n  recorded turn failures: ${apologies.length}`)
  console.log(
    "  An unanswered user turn with no recorded apology beside it predates\n" +
      "  e9a1b35 (the commit that records a failed turn as the apology the user\n" +
      "  heard); the dead-LLM test ran on b22f6cf, one commit earlier."
  )
}

// ---------------------------------------------------------------- tokens

async function verifyTokens(): Promise<void> {
  section("prompt sizes after this branch")

  const client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey })

  async function promptTokens(messages: unknown[], tools: unknown[]): Promise<number> {
    const response = await client.chat.completions.create({
      model: config.llm.model,
      messages: messages as never,
      tools: tools.length > 0 ? (tools as never) : undefined,
      max_tokens: 1,
      temperature: 0,
    })
    return response.usage?.prompt_tokens ?? -1
  }

  // The recency line as the code actually builds it, from a real episode where
  // there is one, so this measures what ships rather than a paraphrase.
  const episodes = episodeRows()
  const newest = episodes.length > 0 ? getEpisodeStore().byId(episodes.at(-1)!.id) : null
  const recencyLine = newest
    ? `Your most recent conversation with the user ended ${formatEpisodeWhen(newest.endedAt)}` +
      `${newest.tags.length > 0 ? ` [${newest.tags.join(", ")}]` : ""}.`
    : "Your most recent conversation with the user ended Sun, 4 Oct 2026, 16:25 [gpu, budget]."

  const pieces: Array<[string, string]> = [
    ["SYSTEM_PROMPT", SYSTEM_PROMPT],
    ["VOICE_RESPONSE_PROMPT", VOICE_RESPONSE_PROMPT],
    ["recency line", recencyLine],
  ]

  for (const [name, text] of pieces) {
    const tokens = await promptTokens([{ role: "system", content: text }], [])
    console.log(`  ${name.padEnd(24)} ${String(text.length).padStart(5)} chars / ${String(tokens).padStart(4)} tok`)
  }

  const tools = registry.toOpenAI()
  const toolChars = JSON.stringify(tools).length
  const toolTokens = await promptTokens([{ role: "system", content: "x" }], tools as unknown[])
  console.log(`  ${"tool schemas".padEnd(24)} ${String(toolChars).padStart(5)} chars / ~${toolTokens} tok with a 1-char system`)

  // A full voice request at both context budgets, so the stale ~4500 figure in
  // ARCHITECTURE.md can be replaced with something measured.
  const filler = "The user asked about GPUs and Ixa answered at length. ".repeat(500)
  for (const budget of [24000, 12000]) {
    const history = filler.slice(0, budget)
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: "The user's saved preferences. " + "x".repeat(300) },
      { role: "system", content: recencyLine },
      { role: "system", content: "Notes from earlier conversations. " + "x".repeat(600) },
      { role: "user", content: history },
      { role: "system", content: VOICE_RESPONSE_PROMPT },
    ]
    const tokens = await promptTokens(messages, tools as unknown[])
    console.log(`  full voice request @ ${budget} chars: ${tokens} tok`)
  }

  console.log(`\n  episodes in this database: ${episodes.length}`)
}

// ------------------------------------------------------------------- main

const commands: Record<string, () => void | Promise<void>> = {
  scoreboard: verifyScoreboard,
  lasttime: verifyLastTime,
  freshness: verifyFreshness,
  dismiss: verifyDismiss,
  strays: verifyStrays,
  tokens: verifyTokens,
}

async function main(): Promise<void> {
  const name = process.argv[2]
  if (!name || !commands[name]) {
    console.error(`usage: voice-behavior-verify.ts <${Object.keys(commands).join("|")}>`)
    process.exit(2)
  }

  console.log(`database:   ${config.data.dbPath}`)
  console.log(`collection: ${config.qdrant.collection}`)

  await commands[name]!()

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("\nverification aborted:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
