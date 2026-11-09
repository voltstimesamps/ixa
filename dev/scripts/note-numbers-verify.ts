// Replays the live turn that wrote "three hundred dollars" into a note body
// while the user's own words, and the note's summary, said "$300".
//
// THE LIVE TURN (2026-11-08, session 560f3451). The user said, by voice:
//
//   "...I don't think I'm going to find one below my price range of $300."
//
// save_note was called with
//   sections[0].body  "...I do not expect to find one below three hundred dollars."
//   summary           "...price above $300"
// The body is the file Obsidian shows and the thing a later search hands back.
// The summary kept the digits; the body did not. VOICE_RESPONSE_PROMPT tells a
// SPOKEN reply to write "three hundred fifty dollars", not "$350", and it is the
// last thing the model reads before it fills in tool arguments too.
//
// WHAT THIS MEASURES, per run, on the model's FIRST save_note call:
//   leak      the body says "three hundred" and has no "300" — the failure
//   words     any cardinal number word in the body at all ("one" excluded: it
//             is the pronoun in "find one below")
//   spoken    the final reply carries a digit, $ or % — the SPOKEN rule, which
//             a fix for the body must not weaken, so it is scored beside it
//   long      the reply says the note is long, split into INSTRUCTED (save_note's
//             own result told it to, because the body is over
//             BODY_READBACK_MAX_CHARS) and INVENTED (it was not told to)
//
// WHAT IS REAL: the tool registry and its descriptions, SYSTEM_PROMPT,
// VOICE_RESPONSE_PROMPT as the trailing system message, the request parameters
// a voice turn sends (reasoning_effort low), the saved preference block, and
// save_note / search_notes / remember_preference writing real markdown and
// real vectors. WHAT IS NOT: Session's guards (price, claim, empty-reply), the
// working-directory line, STT (the transcript is the one the live run produced).
//
// THE HISTORY IS READ, NOT COPIED. It is the live conversation, so it is
// pulled from data/ixa.db read-only at run time and never written anywhere;
// point IXA_REPLAY_DB at a database that still holds session 560f3451.
//
//   IXA_DB_PATH=/tmp/ixa-nn/verify.db QDRANT_COLLECTION=ixa_nn_ep \
//     IXA_NOTES_COLLECTION=ixa_nn_notes OBSIDIAN_VAULT_PATH=/tmp/ixa-nn/vault \
//     IXA_NN_LABEL=baseline IXA_NN_RUNS=30 \
//     npx tsx dev/scripts/note-numbers-verify.ts
//
// Needs Ollama, Qdrant and Groq. No backend, no sidecars. Refuses to run
// against the live database, vault or collections. Notes ACCUMULATE across the
// runs, as in `length`: later runs see earlier runs' note as a duplicate. That
// changes the advisory in save_note's RESULT, not the arguments the model sends
// to produce it, and the leak is scored on the arguments.
import fs from "fs"
import os from "os"
import path from "path"
import Database from "better-sqlite3"
import { config } from "../../src/config"
import { registry } from "../../src/tools/registry"
import { type Message } from "../../src/core/llm"
import { OllamaEmbedder } from "../../src/memory/embeddings"
import { QdrantIndex } from "../../src/memory/qdrant"
import { getNoteStore } from "../../src/memory/notes"
import { Notebook, setNotebook } from "../../src/memory/notebook"
import { getPreferenceStore } from "../../src/memory/preferences"
import { directTurn, type DirectTurn } from "./lib/direct-turn"

const SESSION_ID = process.env.IXA_REPLAY_SESSION ?? "560f3451-1453-484e-acc4-bece8f67b02a"
const REPLAY_DB = process.env.IXA_REPLAY_DB ?? "/home/wyatt/Projects/ixa/data/ixa.db"
const RUNS = Number(process.env.IXA_NN_RUNS ?? 30)
const LABEL = process.env.IXA_NN_LABEL ?? "run"
const OUT_DIR = process.env.IXA_NN_OUT ?? "/tmp/ixa-nn"

const SEARCH_STUB =
  "Search results:\n1. No relevant results.\n"

const CARDINAL =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i

// A digit that starts a token, or a currency or percent sign. "i5" and "DDR4"
// are identifiers, whose digits follow a letter, and are not what the spoken
// rule is about. (verifyNumbers has its own, stricter, scan with a standards
// list; this one only needs to tell "$300" from "i5/i7/i9".)
const NUMERAL = /[$£€¥₹%]|(?<![A-Za-z\d])\d/

interface Row {
  n: number
  saved: boolean
  body: string
  summary: string
  leak: boolean
  // The same test on the note FILE, which is what Obsidian shows and a later
  // search returns. The arguments can leak and the file not, if code fixed them.
  storedLeak: boolean
  words: boolean
  spokenNumeral: boolean
  long: boolean
  instructed: boolean
  invented: boolean
  reply: string
  llmCalls: number
  tokens: number
  error?: string
}

function replayHistory(): Message[] {
  const db = new Database(REPLAY_DB, { readonly: true })
  try {
    const row = db.prepare("SELECT messages FROM sessions WHERE id = ?").get(SESSION_ID) as
      | { messages: string }
      | undefined
    if (!row) throw new Error(`session ${SESSION_ID} not found in ${REPLAY_DB}`)
    const all = JSON.parse(row.messages) as Message[]
    // [0] is the system prompt, which the driver supplies from the CURRENT
    // code; [1..19] is everything up to and including the user turn that
    // produced the bad note.
    const history = all.slice(1, 20)
    const last = history[history.length - 1]
    if (last?.role !== "user" || !String(last.content).includes("price range of $300")) {
      throw new Error("history[19] is not the home-lab utterance — wrong session or database")
    }
    return history
  } finally {
    db.close()
  }
}

function firstSaveNote(turn: DirectTurn): { body: string; summary: string } | null {
  const call = turn.calls.find((c) => c.name === "save_note")
  if (!call) return null
  try {
    const args = JSON.parse(call.args) as {
      summary?: string
      sections?: Array<{ body?: string }>
    }
    return {
      body: (args.sections ?? []).map((s) => s.body ?? "").join("\n"),
      summary: args.summary ?? "",
    }
  } catch {
    return null
  }
}

function storedBody(turn: DirectTurn): string | null {
  const call = turn.calls.find((c) => c.name === "save_note")
  const id = call && /\(id ([^)\s]+)\)/.exec(call.result)?.[1]
  if (!id) return null
  try {
    // Past the front matter: the summary lives there, and it keeps its digits
    // in the failing turn, which would hide a body that lost them.
    return fs
      .readFileSync(path.join(config.notes.vaultPath, `${id}.md`), "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/, "")
  } catch {
    return null
  }
}

function score(n: number, turn: DirectTurn): Row {
  const saved = firstSaveNote(turn)
  const body = saved?.body ?? ""
  const summary = saved?.summary ?? ""
  const leak = saved !== null && /three hundred/i.test(body) && !/300/.test(body)
  const file = storedBody(turn)
  const storedLeak = file !== null && /three hundred/i.test(file) && !/\$?300/.test(file)
  const words = saved !== null && CARDINAL.test(body)
  // The final reply only: a turn that saved and then said nothing has no
  // evidence about the spoken rule.
  const spokenNumeral = NUMERAL.test(turn.reply)
  const long = /\blong\b/i.test(turn.reply)
  const instructed = turn.calls.some(
    (c) => c.name === "save_note" && c.result.includes("too long to read back")
  )
  return {
    n,
    saved: saved !== null,
    body,
    summary,
    leak,
    storedLeak,
    words,
    spokenNumeral,
    long,
    instructed,
    invented: long && !instructed,
    reply: turn.reply,
    llmCalls: turn.llmCalls,
    tokens: turn.tokens,
    ...(turn.error ? { error: turn.error } : {}),
  }
}

function refuseLive(): void {
  const live = {
    db: path.resolve(__dirname, "../../data/ixa.db"),
    vault: path.join(os.homedir(), "Ixa-Vault"),
    episodes: "ixa_episodes",
    notes: "ixa_notes",
  }
  if (path.resolve(config.data.dbPath) === live.db) throw new Error("refusing the live database")
  if (path.resolve(config.notes.vaultPath) === live.vault) throw new Error("refusing the live vault")
  if (config.notes.collection === live.notes || config.qdrant.collection === live.episodes) {
    throw new Error("refusing a live collection")
  }
  // The throwaway database must also not be the one being replayed from.
  if (path.resolve(config.data.dbPath) === path.resolve(REPLAY_DB)) {
    throw new Error("the replay source and the working database must differ")
  }
}

async function main(): Promise<void> {
  refuseLive()
  const history = replayHistory()

  const notebook = new Notebook({
    store: getNoteStore(),
    embedder: new OllamaEmbedder(),
    index: new QdrantIndex({
      collection: config.notes.collection,
      payloadIndexes: [{ field: "status", schema: "keyword" }],
    }),
  })
  setNotebook(notebook)
  await notebook.start()

  // The live turn carried the standing preference the user had just set, as a
  // system message ahead of the history. Real store, real injection text.
  await registry
    .get("remember_preference")!
    .execute({ category: "general", topic: "answer_length", value: "keep answers short" })
  const prefs = getPreferenceStore().injectionBlock()
  const injected: Message[] = prefs ? [{ role: "system", content: prefs }] : []

  const saveNote = registry.toOpenAI().find((t) => t.function.name === "save_note")
  console.log(`label:        ${LABEL}`)
  console.log(`model:        ${config.llm.model}`)
  console.log(`runs:         ${RUNS}`)
  console.log(`vault:        ${config.notes.vaultPath}`)
  console.log(`tools:        ${JSON.stringify(registry.toOpenAI()).length} chars of schema`)
  console.log(`save_note:    ${JSON.stringify(saveNote).length} chars\n`)

  const rows: Row[] = []
  for (let n = 1; n <= RUNS; n++) {
    const turn = await directTurn({ history: structuredClone(history), injected, searchStub: SEARCH_STUB })
    const row = score(n, turn)
    rows.push(row)
    console.log(
      `${String(n).padStart(2)} ${row.saved ? "saved " : "NOSAVE"} ` +
        `leak=${row.leak ? "Y" : "-"} stored=${row.storedLeak ? "LEAK" : "ok"} words=${row.words ? "Y" : "-"} ` +
        `spokenNum=${row.spokenNumeral ? "Y" : "-"} long=${row.long ? (row.instructed ? "told" : "INVENTED") : "-"} ` +
        `calls=${row.llmCalls}${row.error ? ` ERROR ${row.error.slice(0, 60)}` : ""}`
    )
    console.log(`     body:    ${row.body.slice(0, 150).replace(/\n/g, " ")}`)
    console.log(`     summary: ${row.summary.slice(0, 110)}`)
    console.log(`     reply:   ${row.reply.slice(0, 150).replace(/\n/g, " ")}`)
  }

  const count = (f: (r: Row) => boolean): string => `${rows.filter(f).length}/${rows.length}`
  const saves = rows.filter((r) => r.saved)
  console.log(`\n=== ${LABEL} ===`)
  console.log(`save_note called:                    ${count((r) => r.saved)}`)
  console.log(`LEAK in the model's arguments:       ${count((r) => r.leak)}`)
  console.log(`LEAK in the note FILE:               ${count((r) => r.storedLeak)}   <- the failure`)
  console.log(`  any number word in body:           ${count((r) => r.words)}`)
  console.log(`spoken reply carries a numeral:      ${count((r) => r.spokenNumeral)}   <- must not rise`)
  console.log(`reply says "long":                   ${count((r) => r.long)}`)
  console.log(`  told to by save_note's result:     ${count((r) => r.long && r.instructed)}`)
  console.log(`  INVENTED (not told):               ${count((r) => r.invented)}`)
  console.log(`mean tokens per run:                 ${(rows.reduce((s, r) => s + r.tokens, 0) / rows.length).toFixed(0)}`)
  console.log(`runs with an error:                  ${count((r) => r.error !== undefined)}`)
  void saves

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `results-${LABEL}.json`)
  fs.writeFileSync(out, JSON.stringify(rows, null, 1))
  console.log(`\nwrote ${out}`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
