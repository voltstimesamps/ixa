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
//   npx tsx dev/scripts/voice-behavior-verify.ts lasttime     # 2
//   npx tsx dev/scripts/voice-behavior-verify.ts freshness    # 3
//   npx tsx dev/scripts/voice-behavior-verify.ts dismiss      # 5
//   npx tsx dev/scripts/voice-behavior-verify.ts priceguard   # 7
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

type IdVerdict = "correct" | "mangled" | "as digits" | "not named"

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

function minuteWords(minute: number): string[] {
  if (minute === 0) return ["o'clock", "oh clock"]
  if (minute < 10) return [`oh ${ONES_WORDS[minute]}`, `zero ${ONES_WORDS[minute]}`, ONES_WORDS[minute]!]
  if (minute < 20) return [ONES_WORDS[minute]!]
  const tens = TENS_WORDS[Math.floor(minute / 10)]!
  const ones = minute % 10
  return ones === 0 ? [tens] : [`${tens}-${ONES_WORDS[ones]}`, `${tens} ${ONES_WORDS[ones]}`]
}

function judgeClock(reply: string, at: Date): { verdict: IdVerdict; detail: string } {
  const flat = flatten(reply)
  const hour12 = at.getHours() % 12 === 0 ? 12 : at.getHours() % 12
  const hourWord = ONES_WORDS[hour12] ?? String(hour12)
  const minutes = minuteWords(at.getMinutes())
  const expected = `${hourWord} ${minutes[0]}`

  // Invented seconds are wrong whatever the rest says.
  if (/\bseconds?\b/.test(flat)) {
    return { verdict: "mangled", detail: `invented seconds; expected about "${expected}"` }
  }
  const hourOk = flat.includes(` ${hourWord} `) || flat.includes(`is ${hourWord}`) || flat.includes(`${hourWord} `)
  const minuteOk = minutes.some((form) => flat.includes(form))
  if (hourOk && minuteOk) return { verdict: "correct", detail: `"${expected}"` }
  if (!hourOk && !minuteOk) return { verdict: "not named", detail: `no time said; expected about "${expected}"` }
  return { verdict: "mangled", detail: `expected about "${expected}"` }
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
      // askedAt, not now: the reply took seconds to synthesize, and a minute
      // boundary crossed in between would fail a correct answer.
      const clock = judgeClock(answer, askedAt)
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
