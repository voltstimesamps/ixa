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
//   npx tsx dev/scripts/voice-behavior-verify.ts numbers      # 8
//   npx tsx dev/scripts/voice-behavior-verify.ts clock        # 9
//   npx tsx dev/scripts/voice-behavior-verify.ts detector     # 9b, offline
//   npx tsx dev/scripts/voice-behavior-verify.ts source       # 9c
//   npx tsx dev/scripts/voice-behavior-verify.ts nonsense     # 10
//   npx tsx dev/scripts/voice-behavior-verify.ts lasttime     # 2
//   npx tsx dev/scripts/voice-behavior-verify.ts freshness    # 3
//   npx tsx dev/scripts/voice-behavior-verify.ts dismiss      # 5
//   npx tsx dev/scripts/voice-behavior-verify.ts priceguard   # 7
//   npx tsx dev/scripts/voice-behavior-verify.ts tokens       # prompt cost
//   npx tsx dev/scripts/voice-behavior-verify.ts strays       # 6, read-only
//
// `detector` needs none of that: it checks the clock judge offline, against the
// replies two live failures actually produced. Run it before `clock`, because a
// twenty-ask run costs real time and real tokens and a judge with a hole in it
// spends both measuring nothing.
//
// `clock` forces each ask into a different minute, so it takes roughly as many
// minutes as it makes asks. That is not slack: a stale value thirty seconds old
// is still the right answer, and three of four asks in the live run were seconds
// apart and so could not have failed detectably.
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
import { findCurrencyAmounts } from "../../src/core/prices"
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
import {
  episodeRows,
  liveSession,
  messagesOf,
  sessionRows,
  toolCallsInLastTurn,
  toolResultsIn,
} from "./lib/db"

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

// ----------------------------------------------------------- 7: price guard

// The two questions that produced tiered prices with no search in live
// testing, plus a direct price question that SHOULD search — the guard must
// not fire on a reply whose figures were actually looked up.
const PRICE_CASES: Array<{ question: string; expectSearch: boolean }> = [
  { question: "What CPU should I get for local AI?", expectSearch: false },
  { question: "What GPU should I get for local AI?", expectSearch: false },
  { question: "How much does a used RTX 3060 cost right now?", expectSearch: true },
]

async function verifyPriceGuard(): Promise<void> {
  section("7. a reply cannot state a price without a search behind it")

  const client = await connect()
  for (const { question, expectSearch } of PRICE_CASES) {
    const reply = await say(client, question)
    const live = liveSession()
    const calls = live ? toolCallsInLastTurn(live) : []
    const searched = calls.filter((name) => name === "web_search").length
    const amounts = findCurrencyAmounts(reply.text)

    console.log(`    tools:   ${calls.join(", ") || "none"}`)
    console.log(`    prices:  ${amounts.join(", ") || "none"}`)

    check(`answered: ${question.slice(0, 44)}`, reply.text.trim().length > 0, `${reply.text.length} chars`)

    // The invariant, whichever way the turn went: a price in the DELIVERED
    // reply means a search happened in the same turn.
    check(
      amounts.length === 0 ? "no price stated" : "every stated price had a search behind it",
      amounts.length === 0 || searched > 0,
      amounts.length > 0 ? `${amounts.join(", ")} with ${searched} search(es)` : ""
    )

    if (expectSearch) {
      // A direct price question should search and keep its figures. If it
      // searched, the guard must have stayed out of the way entirely.
      check("a direct price question searched", searched > 0, `${searched} search(es)`)
    }
  }
  await client.close()

  console.log(
    "\n  The backend log shows every firing: grep for \"price guard:\". A line reading\n" +
      "  \"asking again\" is the retry; \"delivering it\" is the second draft going out\n" +
      "  anyway, which is the bounded-retry case rather than a loop."
  )
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

// ------------------------------------------------------------- 8: numbers

// Does the model actually write numbers as words when told to, AND keep an
// identifier an identifier? Those are two different questions, and the digit
// check only answers the first: "RTX three hundred sixty" has no digit in it
// and names a card that does not exist.
//
// `identifiers` lists what the reply has to get right if it names the thing at
// all. `accept` is how a person says it; `reject` is a form seen coming back
// from a live run. Letter-suffixed part numbers (12400, 7700X, 13700K) carry
// no expected form on purpose: Kokoro itself is inconsistent on them and human
// convention is unsettled, so there is no correct answer to score against.
// They are reported unscored.
interface IdentifierCheck {
  written: string
  accept: string[]
  reject: string[]
}

interface NumberQuestion {
  ask: string
  identifiers?: IdentifierCheck[]
  // Checked against the real clock at the moment it is asked, not a fixture.
  clock?: boolean
  unscored?: string
}

const GPU_3090: IdentifierCheck = {
  written: "RTX 3090",
  accept: ["thirty ninety", "thirty-ninety"],
  reject: ["three thousand ninety", "three hundred ninety", "thirty nine zero", "three zero nine zero", "three oh nine oh"],
}
const GPU_3060: IdentifierCheck = {
  written: "RTX 3060",
  accept: ["thirty sixty", "thirty-sixty"],
  reject: ["three thousand sixty", "three hundred sixty", "thirty six zero", "three zero six zero", "three sixty"],
}
const GPU_4070: IdentifierCheck = {
  written: "RTX 4070",
  accept: ["forty seventy", "forty-seventy"],
  reject: ["four thousand seventy", "four hundred seventy", "forty seven zero", "four zero seven zero", "four seventy"],
}

const NUMBER_QUESTIONS: NumberQuestion[] = [
  { ask: "How much is a used RTX 3090 right now?", identifiers: [GPU_3090] },
  { ask: "What GPU should I get for local AI?" },
  { ask: "What CPU should I get for local AI?", unscored: "CPU part numbers have no agreed spoken form" },
  { ask: "How much VRAM does a 3060 have?", identifiers: [GPU_3060] },
  { ask: "How much RAM do I need to run a 7B model?" },
  { ask: "How fast is a 4070 compared to a 3060?", identifiers: [GPU_4070, GPU_3060] },
  { ask: "What time is it?", clock: true },
  { ask: "What is fifteen percent of two hundred?" },
  // The hard cases: a standard, a version, and identifiers carrying a letter.
  {
    ask: "What RAM does a Ryzen 5 5600G take?",
    identifiers: [
      { written: "DDR4", accept: ["ddr4", "ddr four"], reject: ["ddr for", "d d r four"] },
      { written: "Ryzen 5 5600G", accept: ["fifty-six hundred g", "fifty six hundred g", "5600g"], reject: ["five thousand six hundred", "five six hundred g"] },
    ],
  },
  {
    ask: "What memory does a 3060 use?",
    identifiers: [GPU_3060, { written: "GDDR6", accept: ["gddr6", "gddr six"], reject: ["gddr sixth", "g d d r six"] }],
  },
  {
    ask: "What PCIe version does a 4070 use?",
    identifiers: [GPU_4070, { written: "PCIe 4.0", accept: ["pcie 4", "pcie four", "pci express four", "pcie gen four", "pcie gen 4"], reject: ["pcie forty", "pcie four thousand"] }],
  },
  {
    ask: "Which Ubuntu version should I install for local AI?",
    identifiers: [
      {
        written: "Ubuntu 24.04",
        accept: ["24.04", "twenty-four oh four", "twenty four oh four", "twenty-four point oh four", "twenty four point zero four", "twenty-four point zero four"],
        reject: ["twenty-four oh forty", "two thousand four", "twenty four hundred"],
      },
    ],
  },
  { ask: "Is an i5-12400 enough for local AI?", unscored: "12400 has no agreed spoken form" },
  { ask: "Is the RX 7800 XT good for local AI?", unscored: "7800 takes the hundred-form, which the pairs rule does not cover" },
]

// A compliant spoken reply has no digit and no currency or percent sign in it.
// Crude on purpose: it is the rule as written, and it is objective.
//
// It cannot tell whether a compliant reply SOUNDS right — "RTX three zero nine
// zero" has no digits and is still wrong — which is why every reply is printed
// verbatim and the identifier checks run alongside it.
const NUMERAL = /[\d$£€¥₹%]/

// Standards and versions are EXEMPT, because the prompt now tells the model to
// leave them as they are: Kokoro reads "DDR4" as "DDR four" and "Ubuntu 24.04"
// as "Ubuntu twenty four point zero four", both correct. Counting them as
// violations is what made the last run report "GDDR6" as a failure when
// nothing was wrong with it.
const STANDARD_TOKEN =
  /^(?:[a-z]*ddr\d|pcie|pci-e|usb\d?|sata\d?|hdmi\d?|ecc|lpddr\d|gen\d|\d+\.\d+|v\d+(?:\.\d+)*)$/i

function numeralsIn(text: string): string[] {
  const found: string[] = []
  for (const token of text.match(/\S+/g) ?? []) {
    if (!NUMERAL.test(token)) continue
    const cleaned = token.replace(/^[("']+|[)"'.,;:!?]+$/g, "")
    if (!cleaned || STANDARD_TOKEN.test(cleaned)) continue
    if (!found.includes(cleaned)) found.push(cleaned)
  }
  return found
}

// Normalized for substring matching: lowercase, curly quotes folded, and every
// hyphen and exotic space turned into one plain space.
//
// Hyphens have to GO, not be normalized to "-". The model hyphenates wherever
// it likes — it wrote "twenty‑four point zero‑four", which is the
// correct spoken form of Ubuntu 24.04 and was scored "not named" against an
// expected "twenty-four point zero four". Where a hyphen falls inside a spoken
// number is not a thing worth being strict about.
function flatten(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐-―\-   ]/g, " ")
    .replace(/\s+/g, " ")
}

// The last three come from judgeClock only, and exist because "mangled" hides
// the difference between a model that cannot say a time and a model that said a
// time it could SEE instead of the one it was given. See judgeClock.
type IdVerdict =
  | "correct"
  | "mangled"
  | "as digits"
  | "not named"
  | "missing oh"
  | "spurious oh"
  | "recited"
  | "stale"

// An identifier is only judged if the reply tried to name it. A reply about a
// different card is not evidence either way — but a reply that writes the
// identifier in DIGITS is not "not named", it is the original failure: Kokoro
// reads "RTX 3060" as "three thousand sixty". Scoring that as absent is what
// made the baseline look as accurate as the new prompt, when in fact it had
// simply left seven identifiers in digits for the synthesizer to mangle.
//
// Accept is tested before digits, because for a standard or a version the digit
// form IS the correct answer ("DDR4", "Ubuntu 24.04") and is listed in accept.
function judgeIdentifier(reply: string, check: IdentifierCheck): IdVerdict {
  const flat = flatten(reply)
  if (check.reject.some((form) => flat.includes(flatten(form)))) return "mangled"
  if (check.accept.some((form) => flat.includes(flatten(form)))) return "correct"
  // The bare number out of the written form: "RTX 3060" -> "3060".
  const digits = check.written.match(/\d[\d.]*/g) ?? []
  if (digits.some((run) => new RegExp(`(?:^|[^\\d.])${run.replace(/\./g, "\\.")}(?:[^\\d]|$)`).test(reply))) {
    return "as digits"
  }
  return "not named"
}

// The clock case, checked against the real time at the moment of asking. The
// failure it exists to catch is invented precision: "ten fifty-three AND
// FORTY-NINE SECONDS", and in another run "ten fifty-fourteen".
const ONES_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
]
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty"]

// A clock value as SPOKEN, on a twelve-hour face. The meridiem is kept
// separately because a spoken reply gives it in words ("in the evening") and
// get_time gives it as "PM": comparing the two needs them apart from the
// digits, and an hour that is right with the wrong half of the day is its own
// mistake rather than a wrong time.
interface ClockValue {
  hour: number // 1-12
  minute: number
  // True when a minute under ten was said without its "oh": 10:03 as "ten
  // three". The value parses to the right minute, which is exactly why this
  // flag has to exist — see judgeClock.
  missingOh?: boolean
  // The mirror of it, and found the same way — by reading what a baseline run
  // actually said. An "oh" on a minute of TEN OR MORE: 12:18 as "twelve oh
  // eighteen". Nobody says that, and it parses to the right minute too, so
  // without its own flag the judge calls it correct and the after-run reports a
  // compliance it has not got.
  spuriousOh?: boolean
  meridiem?: "am" | "pm"
  // The words the reply actually used. Without it the detail line quotes a
  // reply back at itself wrongly — an "in the afternoon" reply was reported as
  // "in the evening", because pm renders as evening and nothing kept what was
  // said.
  partOfDay?: "morning" | "afternoon" | "evening"
}

const HOUR_WORDS = ONES_WORDS.slice(1, 13).join("|")

// Every clock time a piece of text SAYS OUT LOUD.
//
// A parser rather than a pair of substring tests. The old judge looked for the
// hour anywhere in the reply and the minute anywhere else, independently, which
// is loose enough to pass a reply that names two different times — and it gave
// no VALUE back, so it could not say which time had been said. Scoring a
// recited or a stale time needs the value, not a yes/no.
//
// Shapes covered: "ten fifty-three in the evening", "ten oh three in the
// morning", "ten o'clock". Hyphens are already spaces by the time flatten is
// done with them.
function parseSpokenTimes(text: string): ClockValue[] {
  const flat = flatten(text)
  const found: ClockValue[] = []

  const withMinutes = new RegExp(
    String.raw`\b(${HOUR_WORDS})\s+((?:oh\s+|zero\s+)?[a-z]+(?:\s+[a-z]+)?)\s+in the (morning|afternoon|evening)\b`,
    "g"
  )
  for (const match of flat.matchAll(withMinutes)) {
    const hour = ONES_WORDS.indexOf(match[1]!)
    const minute = parseMinutePhrase(match[2]!)
    if (minute === null) continue
    const partOfDay = match[3] as "morning" | "afternoon" | "evening"
    found.push({
      hour,
      minute: minute.value,
      missingOh: minute.missingOh,
      spuriousOh: minute.spuriousOh,
      meridiem: partOfDay === "morning" ? "am" : "pm",
      partOfDay,
    })
  }

  const onTheHour = new RegExp(String.raw`\b(${HOUR_WORDS})\s+o'?\s?clock\b`, "g")
  for (const match of flat.matchAll(onTheHour)) {
    found.push({ hour: ONES_WORDS.indexOf(match[1]!), minute: 0 })
  }

  return found
}

// "fifty three" -> 53. "oh three" -> 3. "three" -> 3, flagged: a minute under
// ten said without its "oh" is the leading-zero bug.
function parseMinutePhrase(
  phrase: string
): { value: number; missingOh: boolean; spuriousOh: boolean } | null {
  const bare = phrase.replace(/^(?:oh|zero)\s+/, "")
  const hadOh = bare !== phrase
  const words = bare.split(/\s+/)

  if (words.length === 1) {
    const value = ONES_WORDS.indexOf(words[0]!)
    if (value < 0) return null
    if (value >= 20) return null
    return {
      value,
      missingOh: value > 0 && value < 10 && !hadOh,
      spuriousOh: value >= 10 && hadOh,
    }
  }
  if (words.length === 2) {
    const tens = TENS_WORDS.indexOf(words[0]!)
    const ones = ONES_WORDS.indexOf(words[1]!)
    if (tens < 2 || ones < 1 || ones > 9) return null
    return { value: tens * 10 + ones, missingOh: false, spuriousOh: hadOh }
  }
  return null
}

// Every clock time a piece of text writes in DIGITS: "10:53", and get_time's
// own "8:43:48 PM". The seconds are deliberately not kept — they are not part
// of a spoken time and the clock rule says never to say them.
function parseDigitTimes(text: string): ClockValue[] {
  const found: ClockValue[] = []
  for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/gi)) {
    const rawHour = Number(match[1])
    const minute = Number(match[2])
    if (rawHour > 23 || minute > 59) continue
    const hour = rawHour % 12 === 0 ? 12 : rawHour % 12
    const meridiem = match[3]
      ? (match[3].toLowerCase() as "am" | "pm")
      : rawHour >= 12
        ? "pm"
        : undefined
    found.push({ hour, minute, meridiem })
  }
  return found
}

function clockValueOf(at: Date): ClockValue {
  return {
    hour: at.getHours() % 12 === 0 ? 12 : at.getHours() % 12,
    minute: at.getMinutes(),
    meridiem: at.getHours() >= 12 ? "pm" : "am",
  }
}

function sameClock(a: ClockValue, b: ClockValue): boolean {
  return a.hour === b.hour && a.minute === b.minute
}

function minuteForms(minute: number): string[] {
  if (minute === 0) return ["o'clock"]
  if (minute < 10) return [`oh ${ONES_WORDS[minute]}`]
  if (minute < 20) return [ONES_WORDS[minute]!]
  const tens = TENS_WORDS[Math.floor(minute / 10)]!
  const ones = minute % 10
  return ones === 0 ? [tens] : [`${tens}-${ONES_WORDS[ones]}`]
}

function spoken(value: ClockValue): string {
  const part = value.partOfDay
    ? ` in the ${value.partOfDay}`
    : value.meridiem === "am"
      ? " in the morning"
      : value.meridiem === "pm"
        ? " in the evening"
        : ""
  return `${ONES_WORDS[value.hour]} ${minuteForms(value.minute)[0]}${part}`
}

// The times VOICE_RESPONSE_PROMPT itself contains, read OUT OF THE PROMPT.
//
// Listing them by hand is how a detector goes quietly blind: the clock example
// is the thing under change, and a hardcoded "ten fifty three" would keep
// passing while measuring nothing at all. Parsed instead, so whatever times the
// prompt holds are the ones checked — the spoken form and the digit form the
// rewrite rule shows as its input.
const PROMPT_EXAMPLE_TIMES: ClockValue[] = (() => {
  const found = [
    ...parseSpokenTimes(VOICE_RESPONSE_PROMPT),
    ...parseDigitTimes(VOICE_RESPONSE_PROMPT),
  ]
  const unique: ClockValue[] = []
  for (const value of found) {
    if (!unique.some((seen) => sameClock(seen, value))) unique.push(value)
  }
  return unique
})()

// What the model could have said instead of the clock: the prompt's examples,
// and every time get_time already returned in this session.
interface ClockContext {
  examples: ClockValue[]
  stale: ClockValue[]
}

const NO_CLOCK_CONTEXT: ClockContext = { examples: PROMPT_EXAMPLE_TIMES, stale: [] }

// Judged against the REAL CLOCK, sampled TWICE.
//
// Twice because one sample is not enough. askedAt is taken before STT, the LLM
// call, the tool run and synthesis, so a turn that straddles :59 would fail a
// correct answer — the old judge took askedAt alone and would have called that
// reply mangled. Either minute is accepted; the reply is wrong only if it
// matches neither.
//
// Three failures are named rather than lumped into "mangled", because a bare
// correctness check cannot tell them apart from ordinary nonsense and the fix
// for each is different:
// - MISSING OH: the right minute said without its "oh" (10:03 as "ten three").
//   The old minuteWords listed the bare ones-form among the ACCEPTED forms, so
//   the judge scored that reply "correct" — it could not see the bug the clock
//   rule was written to fix, and a passing run inside the first nine minutes of
//   an hour meant nothing.
// - RECITED: one of VOICE_RESPONSE_PROMPT's own example times, said over a live
//   tool result.
// - STALE: a time get_time returned EARLIER in this session. The value is real.
//   It is just not the current one.
function judgeClock(
  reply: string,
  samples: Date[],
  context: ClockContext = NO_CLOCK_CONTEXT
): { verdict: IdVerdict; detail: string } {
  const flat = flatten(reply)
  const real = samples.map(clockValueOf)
  const expected = real
    .map((value) => `"${spoken(value)}"`)
    .filter((text, i, all) => all.indexOf(text) === i)
    .join(" or ")

  // Invented seconds are wrong whatever the rest says.
  if (/\bseconds?\b/.test(flat)) {
    return { verdict: "mangled", detail: `invented seconds; expected ${expected}` }
  }

  const said = [...parseSpokenTimes(reply), ...parseDigitTimes(reply)]
  if (said.length === 0) {
    return { verdict: "not named", detail: `no time said; expected ${expected}` }
  }

  const onTheClock = said.filter((value) => real.some((now) => sameClock(now, value)))
  if (onTheClock.length > 0) {
    const missingOh = onTheClock.find((value) => value.missingOh)
    if (missingOh) {
      return {
        verdict: "missing oh",
        detail: `said the right minute without its "oh"; expected ${expected}`,
      }
    }
    const spuriousOh = onTheClock.find((value) => value.spuriousOh)
    if (spuriousOh) {
      return {
        verdict: "spurious oh",
        detail:
          `put an "oh" on a minute of ten or more — "${ONES_WORDS[spuriousOh.hour]} oh ` +
          `${minuteForms(spuriousOh.minute)[0]}"; expected ${expected}`,
      }
    }
    const wrongHalf = onTheClock.find(
      (value) => value.meridiem && real[0]!.meridiem && value.meridiem !== real[0]!.meridiem
    )
    if (wrongHalf) {
      return { verdict: "mangled", detail: `right time, wrong half of the day; expected ${expected}` }
    }
    return { verdict: "correct", detail: expected }
  }

  // Not the clock. Was it something the model could SEE?
  for (const value of said) {
    if (context.examples.some((example) => sameClock(example, value))) {
      return {
        verdict: "recited",
        detail:
          `said "${spoken(value)}" — VOICE_RESPONSE_PROMPT's own example time, ` +
          `over a live tool result; expected ${expected}`,
      }
    }
  }
  for (const value of said) {
    if (context.stale.some((seen) => sameClock(seen, value))) {
      return {
        verdict: "stale",
        detail:
          `said "${spoken(value)}" — a time already in this conversation, from an ` +
          `earlier get_time result or an earlier reply; expected ${expected}`,
      }
    }
  }

  return { verdict: "mangled", detail: `said "${spoken(said[0]!)}"; expected ${expected}` }
}

async function verifyNumbers(): Promise<void> {
  section("8. spoken replies write numbers as words")

  const limitsOff = config.voice.maxSpokenSentences < 1 && config.voice.maxSpokenWords < 1
  console.log(
    `  backstop: ${limitsOff ? "OFF (both limits disabled)" : `${config.voice.maxSpokenSentences} sentences / ${config.voice.maxSpokenWords} words`}`
  )
  console.log(`  model:    ${config.llm.model}\n`)

  const firesBefore = backstopFiresInHistory().length
  const rows: Array<{
    question: string
    text: string
    seconds: number
    words: number
    trimmed: boolean
    numerals: string[]
    identifiers: Array<{ written: string; verdict: IdVerdict; detail?: string }>
    unscored?: string
  }> = []

  const client = await connect()
  for (const item of NUMBER_QUESTIONS) {
    console.log(`  > (spoken) ${item.ask}`)
    // Synthesized, so the turn is genuinely voice-origin: the constraint only
    // goes on the request for a voice turn, so a typed question measures
    // nothing at all.
    const pcm = await synthesize(item.ask)
    const askedAt = new Date()
    let reply: Reply
    try {
      reply = await client.askAudio(pcm)
    } catch (err) {
      check(`answered: ${item.ask.slice(0, 40)}`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const repliedAt = new Date()

    // Counted exactly as the scoreboard counts: the offer the backstop appends
    // is the backstop talking, not the answer, so it is excluded from the word
    // count and from the numeral scan.
    const trimmed = reply.text.trimEnd().endsWith(CONTINUE_OFFER)
    const answer = trimmed ? reply.text.trimEnd().slice(0, -CONTINUE_OFFER.length).trimEnd() : reply.text
    const counted = shortenForSpeech(answer, { maxUnits: 0, maxWords: 0 })

    const identifiers: Array<{ written: string; verdict: IdVerdict; detail?: string }> = (
      item.identifiers ?? []
    ).map((check) => ({ written: check.written, verdict: judgeIdentifier(answer, check) }))
    if (item.clock) {
      // Both ends of the turn, not just askedAt: synthesis, the LLM call and
      // the tool run all happen in between, so a minute crossed mid-turn must
      // not fail a correct answer.
      const clock = judgeClock(answer, [askedAt, repliedAt])
      identifiers.push({ written: "the time", verdict: clock.verdict, detail: clock.detail })
    }

    rows.push({
      question: item.ask,
      text: reply.text,
      seconds: audioSeconds(reply.audioChunks),
      words: counted.totalWords,
      trimmed,
      numerals: numeralsIn(answer),
      identifiers,
      unscored: item.unscored,
    })

    console.log(`  < ${reply.text}`)
    console.log(
      `    ${counted.totalWords} word(s), ${audioSeconds(reply.audioChunks).toFixed(1)}s spoken` +
        `${trimmed ? ", trimmed by the backstop" : ""}` +
        `${rows.at(-1)!.numerals.length ? `, NUMERALS: ${rows.at(-1)!.numerals.join(" ")}` : ", no numerals"}`
    )
    for (const id of identifiers) {
      console.log(`    ${id.written}: ${id.verdict.toUpperCase()}${id.detail ? ` — ${id.detail}` : ""}`)
    }
    if (item.unscored) console.log(`    (unscored: ${item.unscored})`)
    console.log("")
  }
  await client.close()

  const fires = backstopFiresInHistory().slice(firesBefore)
  const answered = rows.length
  // An empty reply has no numerals in it and is not evidence of compliance.
  // Scored as compliant it would make the rate look better the more often the
  // model said nothing at all.
  const spoke = rows.filter((row) => row.text.trim().length > 0)
  const empty = rows.filter((row) => row.text.trim().length === 0)
  const compliant = spoke.filter((row) => row.numerals.length === 0)

  // Every reply in full. A digit test cannot hear "RTX three zero nine zero",
  // so the transcript is the evidence and the ear is the judge.
  console.log("  every reply, verbatim:")
  for (const row of rows) {
    console.log(`\n    Q: ${row.question}`)
    console.log(`    A: ${row.text}`)
    console.log(
      `       ${row.words} words, ${row.seconds.toFixed(1)}s` +
        `${row.numerals.length ? `, numerals: ${row.numerals.join(" ")}` : ""}`
    )
    for (const id of row.identifiers) {
      console.log(`       ${id.written}: ${id.verdict.toUpperCase()}${id.detail ? ` — ${id.detail}` : ""}`)
    }
    if (row.unscored) console.log(`       (unscored: ${row.unscored})`)
  }

  const words = spoke.map((row) => row.words)
  const meanWords = words.reduce((sum, value) => sum + value, 0) / (spoke.length || 1)
  const worstWords = Math.max(0, ...words)

  // IDENTIFIER ACCURACY is the headline. "Not named" is neither credit nor
  // blame: a reply that answers about a different card is not evidence that the
  // rule works or that it fails.
  const judged = spoke.flatMap((row) => row.identifiers)
  const idCorrect = judged.filter((id) => id.verdict === "correct")
  const idMangled = judged.filter((id) => id.verdict === "mangled")
  const idDigits = judged.filter((id) => id.verdict === "as digits")
  const idAbsent = judged.filter((id) => id.verdict === "not named")
  const idScored = idCorrect.length + idMangled.length + idDigits.length

  console.log(`\n  answered:        ${answered}/${NUMBER_QUESTIONS.length}`)
  if (empty.length) console.log(`  EMPTY replies:   ${empty.length} (excluded from the rates below)`)
  console.log(
    `  IDENTIFIERS:     ${idCorrect.length}/${idScored} correct` +
      `${idScored ? ` (${((idCorrect.length / idScored) * 100).toFixed(0)}%)` : ""}` +
      `, ${idMangled.length} mangled, ${idDigits.length} left as digits, ${idAbsent.length} not named`
  )
  console.log(`  compliant:       ${compliant.length}/${spoke.length} (no digits or currency symbols)`)
  console.log(`  mean words:      ${meanWords.toFixed(1)}`)
  console.log(`  most words:      ${worstWords}`)
  console.log(`  backstop fired:  ${fires.length}/${answered}${fires.length ? ` (${fires.map((f) => `${f.kept}/${f.total}`).join(", ")})` : ""}`)

  const violations = rows.filter((row) => row.numerals.length > 0)
  if (violations.length) {
    console.log("\n  numeral violations:")
    for (const row of violations) {
      console.log(`    ${row.numerals.join(" ")}  <- ${row.question}`)
    }
  }

  const badRows = spoke.filter((row) =>
    row.identifiers.some((id) => id.verdict === "mangled" || id.verdict === "as digits")
  )
  if (badRows.length) {
    console.log("\n  identifiers that will not survive the synthesizer:")
    for (const row of badRows) {
      for (const id of row.identifiers.filter(
        (entry) => entry.verdict === "mangled" || entry.verdict === "as digits"
      )) {
        console.log(
          `    ${id.written}: ${id.verdict}${id.detail ? ` — ${id.detail}` : ""}  <- ${row.question}`
        )
      }
    }
  }

  const unscored = rows.filter((row) => row.unscored)
  if (unscored.length) {
    console.log("\n  unscored by design (no agreed spoken form to check against):")
    for (const row of unscored) console.log(`    ${row.question} — ${row.unscored}`)
  }

  // Spelling numbers out costs words, so the 40-word budget binds sooner and
  // the backstop fires more. That is expected, not a failure of the rule — the
  // useful output is the cap that would have left these replies alone.
  if (limitsOff) {
    console.log(
      `\n  word cap that would leave every reply here untrimmed: ${worstWords}` +
        ` (current ${config.voice.maxSpokenWords})`
    )
  } else {
    console.log(
      "\n  For the cap these replies would need, re-run with the backstop off:\n" +
        "  IXA_VOICE_MAX_SENTENCES=0 IXA_VOICE_MAX_WORDS=0 ... npm run dev"
    )
  }

  check(
    "every question got a non-empty reply",
    spoke.length === NUMBER_QUESTIONS.length,
    `${spoke.length}/${NUMBER_QUESTIONS.length}${empty.length ? `, ${empty.length} empty` : ""}`
  )
  // Reported, not gated. The point of this run is the rate itself: a poor one
  // sizes the deterministic backstop in a later branch, and patching around it
  // here would hide the number that decision needs.
  console.log(
    `\n  Reported, not enforced. Identifier accuracy ${idCorrect.length}/${idScored} is the` +
      ` headline; compliance ${compliant.length}/${spoke.length} is the older number and no longer` +
      " the interesting one." +
      "\n  A reply with no digits in it can still be WRONG, which is what the identifier" +
      "\n  verdicts exist to catch: \"RTX three hundred sixty\" passes the digit check and" +
      "\n  names a card that does not exist."
  )
}

// ---------------------------------------------------------------- 9: clock

// Does the model state the time it was GIVEN?
//
// Two failures seen live, both with a correct answer sitting in the tool
// result, and neither one audible as a mistake — a wrong time is plausible, so
// nothing about the output says it is wrong:
//
//   RECITED. get_time returned "8:43:48 PM". The reply was "It is ten
//   fifty-three in the evening" — the example time written into
//   VOICE_RESPONSE_PROMPT's clock rule, said over a live tool result.
//
//   STALE. Asked the time at 9:01 PM, answered "eight forty-three in the
//   evening" — get_time's result from a turn eighteen minutes earlier, still in
//   the context window. get_time was never called. 1 of 5 asks.
//
// What this run has to establish, which the old five-ask version could not:
//
// 1. BOTH SHAPES ARE INTERMITTENT, so a clean run proves nothing at n=5. At
//    twenty asks a true one-in-five rate survives untouched with probability
//    0.8^20, about one percent.
// 2. CORRECTNESS IS NOT THE ONLY QUESTION. Live, the model skipped the call and
//    was RIGHT BY LUCK: a correct value was twenty seconds old. Three of four
//    trailing asks were seconds apart and so could not have failed detectably.
//    So the tool call is evidence in its own right, read from the recorded
//    history, and every ask is forced into a different minute from the one
//    before it — otherwise reusing a stale value is indistinguishable from
//    reading the clock.
// 3. THE DENOMINATOR FOR STALENESS IS NOT TWENTY. It is the asks where a stale
//    value was both IN the window and already wrong. That is counted, not
//    assumed.
const TIME_ASKS = Number(process.env.IXA_TIME_ASKS ?? 20)

// The asks are split across SESSIONS rather than run as one long conversation.
// Across blocks the first ask starts from a conversation with no times in it;
// within a block the asks share one, which is what the STALE shape needs —
// nothing can go stale in a session with no history.
//
// WHAT THIS SPLIT DOES NOT EXPLAIN. It was introduced on the theory that the
// failure is sticky inside a session: one ask answered without get_time being
// precedent for every ask behind it. That theory is NOT established, and the
// data that looked like it says something else. Two runs of identical code:
// one called get_time 8/20, the next 20/20. Their first four asks ran under
// exactly the same conditions — the first reset does not fire until ask five —
// and went 0/4 and 4/4. Same code, same conditions, opposite outcomes, so the
// dominant term is RUN-TO-RUN VARIANCE, not session depth.
//
// Within one run the behaviour is strikingly self-consistent, which is what the
// stickiness story was built on and is also what makes a single twenty-ask run a
// poor estimate: it behaves more like one draw repeated than twenty samples. The
// split is kept because an independent first ask per block is the right design
// either way, but the run is NOT a substitute for repeating it — and for the
// question of whether the tool gets called at all, `source` is the instrument
// with the power, not this one.
const TIME_ASKS_PER_SESSION = Number(process.env.IXA_TIME_ASKS_PER_SESSION ?? 4)

const REST_URL = process.env.IXA_REST_URL ?? "http://localhost:3000"

// Ends the shared primary session, so the next ask starts a conversation with
// no times in it. The same reset phase3a-verify and phase3b-verify use.
async function resetSession(): Promise<void> {
  await fetch(`${REST_URL}/reset`, { method: "POST" })
}

// Filler between time asks. Cheap on purpose — no tool call, no web_search — so
// the run's cost is the time asks and a little. Its job is to put other turns
// between one time ask and the next: live, the stale value the model preferred
// was twenty-one messages back, not the message before.
const TIME_FILLER = [
  "What is fifteen percent of two hundred?",
  "How many bits are in a byte?",
]

interface TimeAsk {
  askedAt: Date
  repliedAt: Date
  text: string
  verdict: IdVerdict
  detail: string
  calledGetTime: boolean
  // Every tool the turn called, in order. Not a yes/no on get_time: the first
  // baseline run answered the time out of WEB_SEARCH results, which a
  // get_time-only flag records as "no tool call" and so describes as a model
  // that answered from nothing. It reached for the wrong tool, which is a
  // different failure with a different fix.
  toolsCalled: string[]
  // Which block of the run, and which ask inside it. The first ask of a block
  // starts from a conversation with no times in it; the rest can go stale.
  block: number
  firstInBlock: boolean
  // What get_time returned on THIS turn, if it ran.
  returned: string | null
  // The newest time already in the conversation when this ask was made, and how
  // far off the clock it was by then. The shape-2 denominator: an ask with no
  // stale value available, or one that is still right, cannot exercise it.
  staleAvailable: ClockValue | null
  staleOffByMinutes: number | null
}

// Every clock value already sitting in the live session, from both places one
// can come from.
//
// get_time's results are the obvious half. The other half is the times IXA
// HERSELF stated on earlier turns, and leaving them out undercounted the very
// failure being measured: in the first baseline run ask 1 invented "twelve
// thirty-three in the afternoon" with no tool call, and ask 2 said it straight
// back. That is the stale shape exactly — a value preferred because it was
// visible — and scoring it "mangled" filed it as though the model could not say
// a time at all.
//
// A value that is still the current minute is not counted against anything:
// judgeClock tests the real clock first, so a correct answer can never be
// called stale.
function timesAlreadyInContext(): ClockValue[] {
  const row = liveSession()
  if (!row) return []

  const fromTool = toolResultsIn(row, "get_time").flatMap((result) => parseDigitTimes(result))
  const fromIxa = messagesOf(row)
    .filter((message) => message.role === "assistant" && typeof message.content === "string")
    .flatMap((message) => parseSpokenTimes(message.content!))

  const unique: ClockValue[] = []
  for (const value of [...fromTool, ...fromIxa]) {
    if (!unique.some((seen) => sameClock(seen, value))) unique.push(value)
  }
  return unique
}

// How far apart two twelve-hour clock values are, in minutes, taking the
// smaller way round the face. Twelve-hour because that is all a spoken reply
// gives: "eight forty-three in the evening" and get_time's "8:43:48 PM" are the
// same value, and the half of the day is checked separately.
function minutesApart(a: ClockValue, b: ClockValue): number {
  const toMinutes = (value: ClockValue): number => (value.hour % 12) * 60 + value.minute
  const gap = Math.abs(toMinutes(a) - toMinutes(b))
  return Math.min(gap, 720 - gap)
}

// Hold until the wall clock leaves `minute`, so the next ask cannot be answered
// correctly from the previous ask's value. Without this the run measures
// nothing about staleness: a value thirty seconds old is still the right
// answer, which is how three of the four live asks "passed".
async function waitForNewMinute(minute: number | null): Promise<number> {
  if (minute === null) return 0
  const startedAt = Date.now()
  while (new Date().getMinutes() === minute) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return Date.now() - startedAt
}

async function verifyClock(): Promise<void> {
  section("9. the clock: does the model state the time it was given?")
  console.log(`  model:    ${config.llm.model}`)
  console.log(
    `  prompt example times: ${
      PROMPT_EXAMPLE_TIMES.length
        ? PROMPT_EXAMPLE_TIMES.map((value) => `"${spoken(value)}"`).join(", ")
        : "NONE — the prompt holds no concrete time"
    }`
  )
  console.log(`  asks:     ${TIME_ASKS}, each forced into a different minute from the one before\n`)

  // Optional second argument: hold until the wall clock reaches this minute
  // before the first ask. The leading-zero case — a minute between :01 and :09,
  // the only one that needs an "oh" — can only be exercised by a run that spans
  // it, and twenty asks a minute apart span twenty minutes. Starting at :50
  // covers :50 through :09, so one run covers the leading-zero case and the
  // ordinary one both.
  const startMinute = process.argv[3] === undefined ? null : Number(process.argv[3])
  if (startMinute !== null && Number.isInteger(startMinute) && startMinute >= 0 && startMinute < 60) {
    while (new Date().getMinutes() !== startMinute) {
      console.log(
        `  holding for :${String(startMinute).padStart(2, "0")} — it is ${new Date().toLocaleTimeString()}`
      )
      await new Promise((resolve) => setTimeout(resolve, 20000))
    }
  }

  const rows: TimeAsk[] = []
  const client = await connect()
  let previousMinute: number | null = null

  for (let i = 0; i < TIME_ASKS; i++) {
    const block = Math.floor(i / TIME_ASKS_PER_SESSION)
    const firstInBlock = i % TIME_ASKS_PER_SESSION === 0
    if (firstInBlock && i > 0) {
      await resetSession()
      console.log(`\n  --- session ${block + 1}: reset, nothing in context ---`)
      previousMinute = null
    }

    // Filler first, then the wait: the turns take real seconds, so some of the
    // minute is spent usefully rather than idling.
    for (const filler of TIME_FILLER) {
      try {
        // Spoken, not typed. A typed turn gets no VOICE_RESPONSE_PROMPT, so
        // text filler would leave the window alternating between having the
        // constraint and not having it — which changes the thing under test.
        console.log(`  > (spoken) ${filler}`)
        await client.askAudio(await synthesize(filler))
      } catch {
        // A filler turn is scaffolding. Losing one costs context, not a result.
      }
    }
    const waited = await waitForNewMinute(previousMinute)

    const before = timesAlreadyInContext()
    const pcm = await synthesize("What time is it?")
    const askedAt = new Date()
    let reply: Reply
    try {
      reply = await client.askAudio(pcm)
    } catch (err) {
      check(`ask ${i + 1} answered`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const repliedAt = new Date()
    previousMinute = repliedAt.getMinutes()

    // Read AFTER the reply, which is safe: the manager saves the session at the
    // turn boundary, inside the finally that the reply promise waits on, so the
    // row is on disk before the client is told the turn is over.
    const row = liveSession()
    const toolsCalled = row ? toolCallsInLastTurn(row) : []
    const calledGetTime = toolsCalled.includes("get_time")
    const after = row ? toolResultsIn(row, "get_time") : []
    const returned = calledGetTime ? (after.at(-1) ?? null) : null

    const newest = before.at(-1) ?? null
    const staleOffByMinutes = newest ? minutesApart(newest, clockValueOf(askedAt)) : null

    const clock = judgeClock(reply.text, [askedAt, repliedAt], {
      examples: PROMPT_EXAMPLE_TIMES,
      stale: before,
    })

    rows.push({
      askedAt,
      repliedAt,
      text: reply.text,
      verdict: clock.verdict,
      detail: clock.detail,
      calledGetTime,
      toolsCalled,
      block,
      firstInBlock,
      returned,
      staleAvailable: newest,
      staleOffByMinutes,
    })

    console.log(
      `  ask ${String(i + 1).padStart(2)} (session ${block + 1}${firstInBlock ? ", first" : ""})` +
        ` at :${String(askedAt.getMinutes()).padStart(2, "0")}` +
        `${waited ? ` (waited ${(waited / 1000).toFixed(0)}s for the minute to turn)` : ""}`
    )
    console.log(
      `    get_time: ${calledGetTime ? `called, returned ${JSON.stringify(returned)}` : "NOT CALLED"}` +
        `${toolsCalled.length ? `  (tools: ${toolsCalled.join(", ")})` : "  (no tool at all)"}`
    )
    if (newest) {
      console.log(
        `    in context: "${spoken(newest)}", off by ${staleOffByMinutes} minute(s) by now`
      )
    }
    console.log(`    < ${reply.text}`)
    console.log(`    ${clock.verdict.toUpperCase()} — ${clock.detail}\n`)
  }
  await client.close()

  // ------------------------------------------------------------------ rates

  const answered = rows.length
  const called = rows.filter((row) => row.calledGetTime)
  const correct = rows.filter((row) => row.verdict === "correct")
  const recited = rows.filter((row) => row.verdict === "recited")
  const stale = rows.filter((row) => row.verdict === "stale")
  const missingOh = rows.filter((row) => row.verdict === "missing oh")
  const spuriousOh = rows.filter((row) => row.verdict === "spurious oh")
  const other = rows.filter(
    (row) => !["correct", "recited", "stale", "missing oh", "spurious oh"].includes(row.verdict)
  )

  // Right by luck: no call, and the answer happened to be the clock anyway.
  // Counted as its own line because a correctness check scores it a pass and it
  // is the exact failure shape 2 is.
  const luckyHits = rows.filter((row) => !row.calledGetTime && row.verdict === "correct")

  // Shape 2's real denominator: a stale value was in the window AND had already
  // gone wrong. An ask with nothing stale on offer cannot exercise it.
  const couldHaveBeenStale = rows.filter(
    (row) => row.staleOffByMinutes !== null && row.staleOffByMinutes >= 1
  )

  const leadingZero = rows.filter((row) => {
    const minute = row.askedAt.getMinutes()
    return minute > 0 && minute < 10
  })

  const searchedInstead = rows.filter(
    (row) => !row.calledGetTime && row.toolsCalled.includes("web_search")
  )
  const noToolAtAll = rows.filter((row) => row.toolsCalled.length === 0)

  console.log(`  answered:              ${answered}/${TIME_ASKS}`)
  console.log(`  called get_time:       ${called.length}/${answered}`)
  console.log(`  SEARCHED THE WEB:      ${searchedInstead.length} (reached for web_search instead)`)
  console.log(`  no tool at all:        ${noToolAtAll.length}`)
  console.log(`  stated the real time:  ${correct.length}/${answered}`)
  console.log(`  RECITED a prompt time: ${recited.length}`)
  console.log(`  STALE value:           ${stale.length}`)
  console.log(`  missing "oh":          ${missingOh.length}`)
  console.log(`  SPURIOUS "oh":         ${spuriousOh.length} (an "oh" on a minute of ten or more)`)
  console.log(`  wrong some other way:  ${other.length}`)
  console.log(
    `  right by luck:         ${luckyHits.length}` +
      " (no call, correct anyway — a pass only to a correctness check)"
  )
  console.log(
    `  asks that could have gone stale: ${couldHaveBeenStale.length}/${answered}` +
      " (a value in context, already off by a minute or more)"
  )

  // The first ask of each block is the only near-independent sample of "does it
  // reach for the tool at all", because nothing in the conversation has set a
  // precedent yet. Reported on its own: a run where every block's first ask
  // calls get_time and the rest follow is a different result from one where the
  // tool is never reached for.
  const firstAsks = rows.filter((row) => row.firstInBlock)
  const firstCalled = firstAsks.filter((row) => row.calledGetTime)
  const laterAsks = rows.filter((row) => !row.firstInBlock)
  const laterCalled = laterAsks.filter((row) => row.calledGetTime)
  console.log(
    `\n  first ask of each session:  ${firstCalled.length}/${firstAsks.length} called get_time` +
      "  (the near-independent samples — no precedent in context yet)"
  )
  console.log(
    `  every later ask:           ${laterCalled.length}/${laterAsks.length} called get_time` +
      "  (these follow whatever the first one did)"
  )

  if (leadingZero.length === 0) {
    console.log(
      `\n  THE LEADING-ZERO CASE WAS NOT EXERCISED: every ask landed at :${rows
        .map((row) => String(row.askedAt.getMinutes()).padStart(2, "0"))
        .join(" :")}. A minute between :01 and :09 is the only one that needs an "oh".` +
        " Start the run so it spans the first nine minutes of an hour."
    )
  } else {
    const ok = leadingZero.filter((row) => row.verdict === "correct")
    console.log(`\n  leading-zero asks:     ${ok.length}/${leadingZero.length} correct`)
    for (const row of leadingZero) {
      console.log(
        `    :${String(row.askedAt.getMinutes()).padStart(2, "0")} ${row.verdict.toUpperCase()} — ${row.detail}`
      )
    }
  }

  const wrong = rows.filter((row) => row.verdict !== "correct")
  if (wrong.length) {
    console.log("\n  every reply that was not the clock, verbatim:")
    for (const row of wrong) {
      console.log(
        `\n    asked :${String(row.askedAt.getMinutes()).padStart(2, "0")}, get_time ${
          row.calledGetTime ? JSON.stringify(row.returned) : "NOT CALLED"
        }, tools: ${row.toolsCalled.join(", ") || "none"}`
      )
      console.log(`    said: ${row.text}`)
      console.log(`    ${row.verdict.toUpperCase()} — ${row.detail}`)
    }
  }

  check(
    "every ask called get_time",
    called.length === answered,
    `${called.length}/${answered}`
  )
  check(
    "every ask stated the time get_time returned",
    answered === TIME_ASKS && correct.length === answered,
    `${correct.length}/${answered}`
  )
}

// ------------------------------------------------ 9c: where the time came from

// Does the model reach for get_time at all, and does it say what get_time said?
//
// The companion to `clock`, and the one with the statistical power. `clock`
// spends a minute per ask because the STALE shape needs the value in context to
// have gone wrong, which caps it at about twenty asks an hour — and two
// twenty-ask runs of identical code came back 8/20 and 20/20 on the tool call,
// so twenty is not enough to say what the rate is.
//
// This asks in a FRESH SESSION every time, with nothing before it, so no
// spacing is needed and sixty asks take minutes. What it gives up is staleness:
// a session with no history has nothing to go stale. What it keeps is both of
// the other two, at full power:
//
// - whether get_time is called, which the baseline runs disagreed about most.
// - RECITED, which needs no history at all. VOICE_RESPONSE_PROMPT is appended to
//   every single request, so the example time is in context on every ask whether
//   the session is fresh or not. This is the right instrument for shape 1.
//
// Each ask is its own session, so these are as close to independent samples as
// this setup gets.
const SOURCE_ASKS = Number(process.env.IXA_SOURCE_ASKS ?? 60)

async function verifySource(): Promise<void> {
  section("9c. where the time came from, in a fresh session every time")
  console.log(`  model:    ${config.llm.model}`)
  console.log(
    `  prompt example times: ${
      PROMPT_EXAMPLE_TIMES.length
        ? PROMPT_EXAMPLE_TIMES.map((value) => `"${spoken(value)}"`).join(", ")
        : "NONE — the prompt holds no concrete time"
    }`
  )
  console.log(`  asks:     ${SOURCE_ASKS}, each in a session of its own\n`)

  const rows: Array<{
    askedAt: Date
    text: string
    verdict: IdVerdict
    detail: string
    toolsCalled: string[]
    calledGetTime: boolean
    returned: string | null
  }> = []

  const client = await connect()
  for (let i = 0; i < SOURCE_ASKS; i++) {
    // Reset BEFORE each ask, including the first: a run started against a
    // database with a session already in it would not be measuring a fresh
    // conversation at all.
    await resetSession()

    const pcm = await synthesize("What time is it?")
    const askedAt = new Date()
    let reply: Reply
    try {
      reply = await client.askAudio(pcm)
    } catch (err) {
      check(`ask ${i + 1} answered`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const repliedAt = new Date()

    const row = liveSession()
    const toolsCalled = row ? toolCallsInLastTurn(row) : []
    const calledGetTime = toolsCalled.includes("get_time")
    const returned = calledGetTime ? (toolResultsIn(row!, "get_time").at(-1) ?? null) : null

    // Nothing stale is possible in a fresh session, so the stale set is empty by
    // construction. The examples are always there.
    const clock = judgeClock(reply.text, [askedAt, repliedAt], {
      examples: PROMPT_EXAMPLE_TIMES,
      stale: [],
    })

    rows.push({ askedAt, text: reply.text, verdict: clock.verdict, detail: clock.detail, toolsCalled, calledGetTime, returned })

    console.log(
      `  ${String(i + 1).padStart(2)}  ${clock.verdict.toUpperCase().padEnd(10)} ` +
        `${calledGetTime ? `get_time ${JSON.stringify(returned)}` : `NO get_time (${toolsCalled.join(", ") || "no tool"})`}`
    )
    console.log(`      < ${reply.text}`)
  }
  await client.close()

  const answered = rows.length
  const called = rows.filter((row) => row.calledGetTime)
  const correct = rows.filter((row) => row.verdict === "correct")
  const recited = rows.filter((row) => row.verdict === "recited")
  const missingOh = rows.filter((row) => row.verdict === "missing oh")
  const spuriousOh = rows.filter((row) => row.verdict === "spurious oh")
  const invented = rows.filter((row) => row.detail.includes("invented seconds"))
  const searched = rows.filter((row) => !row.calledGetTime && row.toolsCalled.includes("web_search"))
  const noTool = rows.filter((row) => row.toolsCalled.length === 0)
  const luckyHits = rows.filter((row) => !row.calledGetTime && row.verdict === "correct")

  const pct = (n: number): string => (answered ? ` (${((n / answered) * 100).toFixed(0)}%)` : "")

  console.log(`\n  answered:              ${answered}/${SOURCE_ASKS}`)
  console.log(`  called get_time:       ${called.length}/${answered}${pct(called.length)}`)
  console.log(`  stated the real time:  ${correct.length}/${answered}${pct(correct.length)}`)
  console.log(`  RECITED a prompt time: ${recited.length}${pct(recited.length)}`)
  console.log(`  missing "oh":          ${missingOh.length}`)
  console.log(`  SPURIOUS "oh":         ${spuriousOh.length} (an "oh" on a minute of ten or more)`)
  console.log(`  INVENTED SECONDS:      ${invented.length}${pct(invented.length)}`)
  console.log(`  searched the web:      ${searched.length}`)
  console.log(`  no tool at all:        ${noTool.length}`)
  console.log(`  right by luck:         ${luckyHits.length} (no call, correct anyway)`)

  const leadingZero = rows.filter((row) => {
    const minute = row.askedAt.getMinutes()
    return minute > 0 && minute < 10
  })
  if (leadingZero.length) {
    const ok = leadingZero.filter((row) => row.verdict === "correct")
    console.log(`  leading-zero asks:     ${ok.length}/${leadingZero.length} correct`)
  }

  const wrong = rows.filter((row) => row.verdict !== "correct")
  if (wrong.length) {
    console.log("\n  every reply that was not the clock, verbatim:")
    for (const row of wrong) {
      console.log(
        `\n    get_time ${row.calledGetTime ? JSON.stringify(row.returned) : "NOT CALLED"}` +
          `, tools: ${row.toolsCalled.join(", ") || "none"}`
      )
      console.log(`    said: ${row.text}`)
      console.log(`    ${row.verdict.toUpperCase()} — ${row.detail}`)
    }
  }

  check("every ask called get_time", called.length === answered, `${called.length}/${answered}`)
  check(
    "every ask stated the time get_time returned",
    answered === SOURCE_ASKS && correct.length === answered,
    `${correct.length}/${answered}`
  )
}

// ------------------------------------------------- 9b: the detector itself

// Does the clock detector see the failures it was written for?
//
// Offline — no backend, no model, no spend. It exists because the detector had
// a hole exactly like the one it is now checked against: minuteWords listed the
// bare ones-form among the ACCEPTED forms for a minute under ten, so "ten three
// in the evening" at 10:03 scored CORRECT. The leading-zero rule was
// unmeasurable, and a green run inside the first nine minutes of an hour said
// nothing at all.
//
// The two live replies are quoted verbatim, curly hyphens and all, because that
// is what came back over the wire.
const DETECTOR_CASES: Array<{
  what: string
  reply: string
  samples: string[]
  stale: string[]
  expect: IdVerdict
}> = [
  {
    what: "recited: the prompt's example time over a live tool result (live, 8:43 PM)",
    reply: "It is ten fifty‑three in the evening.",
    samples: ["2026-10-06T20:43:50", "2026-10-06T20:43:56"],
    stale: [],
    expect: "recited",
  },
  {
    what: "stale: a get_time result from eighteen minutes earlier (live, 9:01 PM)",
    reply: "It is eight forty‑three in the evening.",
    samples: ["2026-10-06T21:01:05", "2026-10-06T21:01:11"],
    stale: ["8:43:48 PM"],
    expect: "stale",
  },
  {
    what: "the same reply with nothing stale on offer is just wrong, not stale",
    reply: "It is eight forty‑three in the evening.",
    samples: ["2026-10-06T21:01:05", "2026-10-06T21:01:11"],
    stale: [],
    expect: "mangled",
  },
  {
    what: 'missing "oh": the leading-zero bug the old judge scored CORRECT',
    reply: "It is ten three in the evening.",
    samples: ["2026-10-06T22:03:10", "2026-10-06T22:03:14"],
    stale: [],
    expect: "missing oh",
  },
  {
    what: 'the same minute said properly',
    reply: "It is ten oh three in the evening.",
    samples: ["2026-10-06T22:03:10", "2026-10-06T22:03:14"],
    stale: [],
    expect: "correct",
  },
  {
    // From the first sixty-ask baseline, where the judge scored it CORRECT.
    what: 'spurious "oh": an "oh" on a minute of ten or more',
    reply: "It is twelve oh eighteen in the morning.",
    samples: ["2026-10-07T00:18:43"],
    stale: [],
    expect: "spurious oh",
  },
  {
    what: 'the same minute said properly takes no "oh"',
    reply: "It is twelve eighteen in the morning.",
    samples: ["2026-10-07T00:18:43"],
    stale: [],
    expect: "correct",
  },
  {
    what: "a two-word minute with an \"oh\" bolted on is wrong too",
    reply: "It is ten oh fifty-three in the evening.",
    samples: ["2026-10-06T22:53:50"],
    stale: [],
    expect: "spurious oh",
  },
  {
    what: "a minute crossed mid-turn is not a wrong answer",
    reply: "It is nine oh one in the evening.",
    samples: ["2026-10-06T21:00:59", "2026-10-06T21:01:03"],
    stale: [],
    expect: "correct",
  },
  {
    what: "a stale value that is still the current minute is not a failure",
    reply: "It is nine oh one in the evening.",
    samples: ["2026-10-06T21:01:05", "2026-10-06T21:01:40"],
    stale: ["9:01:21 PM"],
    expect: "correct",
  },
  {
    what: "invented seconds",
    reply: "It is ten fifty-three and forty-eight seconds in the evening.",
    samples: ["2026-10-06T22:53:50"],
    stale: [],
    expect: "mangled",
  },
  {
    what: "right time, wrong half of the day",
    reply: "It is nine oh one in the morning.",
    samples: ["2026-10-06T21:01:05"],
    stale: [],
    expect: "mangled",
  },
  {
    what: "no time said at all",
    reply: "Sorry, I did not catch that. Could you say it again?",
    samples: ["2026-10-06T21:01:05"],
    stale: [],
    expect: "not named",
  },
]

function verifyDetector(): void {
  section("9b. the clock detector, checked offline against the recorded failures")

  console.log(
    `  prompt example times, parsed out of VOICE_RESPONSE_PROMPT: ${
      PROMPT_EXAMPLE_TIMES.length
        ? PROMPT_EXAMPLE_TIMES.map((value) => `${value.hour}:${String(value.minute).padStart(2, "0")}`).join(", ")
        : "NONE"
    }`
  )
  // Parsed, not listed: if the prompt stops holding a concrete time this goes
  // empty, and a "recited" verdict stops being reachable — which is the point of
  // the change, and has to be visible rather than silent.
  check(
    "the example times are read out of the prompt, not hardcoded",
    PROMPT_EXAMPLE_TIMES.length === 0 ||
      PROMPT_EXAMPLE_TIMES.every((value) =>
        flatten(VOICE_RESPONSE_PROMPT).includes(flatten(`${ONES_WORDS[value.hour]} ${minuteForms(value.minute)[0]}`)) ||
        VOICE_RESPONSE_PROMPT.includes(`${value.hour}:${String(value.minute).padStart(2, "0")}`)
      ),
    `${PROMPT_EXAMPLE_TIMES.length} found`
  )
  console.log("")

  for (const item of DETECTOR_CASES) {
    const judged = judgeClock(
      item.reply,
      item.samples.map((iso) => new Date(iso)),
      { examples: PROMPT_EXAMPLE_TIMES, stale: item.stale.flatMap((raw) => parseDigitTimes(raw)) }
    )
    check(
      item.what,
      judged.verdict === item.expect,
      `expected ${item.expect.toUpperCase()}, got ${judged.verdict.toUpperCase()} — ${judged.detail}`
    )
  }
}

// ------------------------------------------------------------- 10: nonsense

// A badly misheard transcript is a recognition failure, not a request. Live
// failures: "Let's cheat last here" (actually "what's two plus two") was
// REFUSED — "I'm sorry, but I can't help with that" — and "Refita." got a
// full GPU recommendation.
//
// These are spoken through the synthesizer like every other turn here, so what
// the model sees is STT's reading of synthesized nonsense rather than the
// string below. That is the point: the transcript the backend recorded is
// printed alongside the reply, because that is what was actually asked.
interface NonsenseCase {
  sent: string
  // Set when the transcript is NOT nonsense by the rule's test, with the
  // reason. Reported, not scored.
  unscored?: string
}

const NONSENSE: NonsenseCase[] = [
  { sent: "Refita." },
  { sent: "Let's cheat last here." },
  { sent: "And then the of the about it." },
  { sent: "Can you grommet the sandwich of the fourth." },
  // Whisper's stock hallucination on near-silence, and the limit of a rule
  // written around "does not make sense as something a person would say":
  // this one makes perfect sense. Nothing in the transcript marks it as
  // invented, so "you're welcome" is the right answer to what was asked. It is
  // here to show where the rule stops, not to be scored by it.
  { sent: "Thank you for watching.", unscored: "grammatical and meaningful — indistinguishable from a real utterance" },
]

// What Ixa said she did with it. "Did not catch" is the fix working; a refusal
// and a confident answer are the two live failures.
type NonsenseVerdict = "did not catch" | "refused" | "answered"

const DID_NOT_CATCH =
  /did ?n[o']?t (?:quite )?(?:catch|get|hear|follow)|(?:catch|hear|get) that|say (?:that )?again|repeat that|come again|missed that|not sure (?:what|I)|unclear/i
const REFUSED = /can(?:no|')?t help|cannot help|unable to help|won'?t be able|not able to help/i

function judgeNonsense(reply: string): NonsenseVerdict {
  if (DID_NOT_CATCH.test(reply)) return "did not catch"
  if (REFUSED.test(reply)) return "refused"
  return "answered"
}

// The transcript STT produced for the turn just taken, read back from the
// recorded history rather than from the wire: the backend does not send the
// transcript to the client, and what it RECORDED is what the model was given.
function lastTranscript(): string {
  const row = liveSession()
  if (!row) return "(no live session)"
  const users = messagesOf(row).filter((message) => message.role === "user")
  return users.at(-1)?.content ?? "(none)"
}

async function verifyNonsense(): Promise<void> {
  section("10. a misheard transcript is not a request")
  console.log(`  model:    ${config.llm.model}\n`)

  const rows: Array<{
    sent: string
    heard: string
    text: string
    verdict: NonsenseVerdict
    unscored?: string
  }> = []
  const client = await connect()
  for (const item of NONSENSE) {
    console.log(`  > (spoken) ${item.sent}`)
    const pcm = await synthesize(item.sent)
    let reply: Reply
    try {
      reply = await client.askAudio(pcm)
    } catch (err) {
      check(`answered: ${item.sent}`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const heard = lastTranscript()
    const verdict = judgeNonsense(reply.text)
    rows.push({ sent: item.sent, heard, text: reply.text, verdict, unscored: item.unscored })
    console.log(`    heard as: ${JSON.stringify(heard)}`)
    console.log(`  < ${reply.text}`)
    console.log(`    ${verdict.toUpperCase()}${item.unscored ? ` (unscored: ${item.unscored})` : ""}\n`)
  }
  await client.close()

  console.log("  every reply, verbatim:")
  for (const row of rows) {
    console.log(`\n    sent:  ${row.sent}`)
    console.log(`    heard: ${row.heard}`)
    console.log(`    said:  ${row.text}`)
    console.log(`    ${row.verdict.toUpperCase()}${row.unscored ? ` (unscored: ${row.unscored})` : ""}`)
  }

  const scored = rows.filter((row) => !row.unscored)
  const caught = scored.filter((row) => row.verdict === "did not catch")
  const refused = scored.filter((row) => row.verdict === "refused")
  const answered = scored.filter((row) => row.verdict === "answered")
  console.log(
    `\n  answered:        ${rows.length}/${NONSENSE.length}` +
      `\n  DID NOT CATCH:   ${caught.length}/${scored.length}` +
      `\n  refused:         ${refused.length}` +
      `\n  answered anyway: ${answered.length}`
  )
  for (const row of rows.filter((entry) => entry.unscored)) {
    console.log(`  unscored:        ${JSON.stringify(row.sent)} — ${row.unscored}`)
  }

  // The phrase match is a proxy for a judgement a person makes by reading, so
  // the transcript above is the evidence and this is the summary of it.
  check(
    "every misheard transcript was treated as a mishearing",
    rows.length === NONSENSE.length && caught.length === scored.length,
    `${caught.length}/${scored.length}`
  )
}

// ------------------------------------------------------------------- main

const commands: Record<string, () => void | Promise<void>> = {
  scoreboard: verifyScoreboard,
  numbers: verifyNumbers,
  lasttime: verifyLastTime,
  freshness: verifyFreshness,
  dismiss: verifyDismiss,
  priceguard: verifyPriceGuard,
  strays: verifyStrays,
  tokens: verifyTokens,
  clock: verifyClock,
  detector: verifyDetector,
  source: verifySource,
  nonsense: verifyNonsense,
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
