// The duplicate advisory, measured: does the model act on it?
//
// save_note's result lists active notes that may cover the same subject and
// says to call again with `supersedes`. Live (2026-11-08), a voice save of
// "the STT sidecar uses base.en" got that advisory naming a note that said the
// same thing, and the model ignored it: two active notes on one subject.
// ARCHITECTURE.md had put the rate of acting on it at about one run in five.
//
// WHAT IS REAL: the Session (real tool loop, real guards, VOICE_RESPONSE_PROMPT,
// the preference block, the working-directory line), the full tool registry,
// the real save_note / search_notes, a real Notebook over real Ollama
// embeddings and a real Qdrant collection, and the model (Groq, from .env).
// WHAT IS NOT: web_search is not exercised (none of the cases need it), and the
// vault is a throwaway seeded with a copy of the notes the live vault held on
// 2026-11-08, written here, not read from it.
//
// EVERY TRIAL STARTS FROM THE SAME SEEDED STATE — a fresh database, vault and
// collection — because the note store has no hard delete and notes accumulate
// across runs, which turns a later trial into a different question.
//
// A trial is scored on the STATE it leaves, not on what the model said:
//
//   positive  the new text restates a seeded note. RESOLVED if no new active
//             note exists (nothing was written) or any seeded note was
//             superseded. DUPLICATE if a new active note sits beside a seed
//             that is still active.
//   negative  the new text is a different fact. CORRECT if a new active note
//             exists and no seed was superseded. FALSE SUPERSEDE if any seed
//             was superseded — information lost from the active set.
//             DROPPED if nothing was written at all.
//
//   npx tsx dev/scripts/note-duplicate-verify.ts --arm baseline --out /tmp/x.json
//   npx tsx dev/scripts/note-duplicate-verify.ts --only P1,N4 --scale 0.4
//   npx tsx dev/scripts/note-duplicate-verify.ts --cleanup
import { COLLECTION, RUN_DIR } from "./note-duplicate-env"
import fs from "fs"
import path from "path"
import { config } from "../../src/config"
import { Session } from "../../src/core/session"
import { openDatabase } from "../../src/memory/db"
import { OllamaEmbedder } from "../../src/memory/embeddings"
import { QdrantIndex } from "../../src/memory/qdrant"
import { NoteStore, type Note } from "../../src/memory/notes"
import { Notebook, setNotebook, type SaveNoteInput, type SaveResult } from "../../src/memory/notebook"
import { PreferenceStore } from "../../src/memory/preferences"
import { registry } from "../../src/tools/registry"
import "../../src/tools/register"
import { makeConnection, TEST_LIMITS } from "../../test/helpers"

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const ARM = flag("--arm") ?? "unnamed"
const OUT = flag("--out")
const ONLY = flag("--only")?.split(",")
const SCALE = Number(flag("--scale") ?? "1")

// -------------------------------------------------------------------- seeds
//
// The live vault on 2026-11-08, minus the notes that were superseded. Three of
// them are about the Groq tier — a pile-up the advisory exists to prevent.
interface Seed {
  key: string
  type: "decision" | "project" | "reference"
  title: string
  summary: string
  heading: string
  body: string
  date: string
}

const SEEDS: Seed[] = [
  {
    key: "stt",
    type: "reference",
    title: "STT sidecar uses base.en",
    summary: "STT sidecar uses base.en",
    heading: "STT Sidecar Configuration",
    body: "The STT sidecar uses the base.en language model for speech-to-text processing.",
    date: "2026-10-14",
  },
  {
    key: "rtx3090",
    type: "reference",
    title: "RTX 3090 Purchase Note",
    summary: "I paid six hundred dollars for the RTX 3090.",
    heading: "RTX 3090 Purchase",
    body: "I paid six hundred dollars for the RTX thirty ninety.",
    date: "2026-10-14",
  },
  {
    key: "rtx4090",
    type: "reference",
    title: "RTX 4090 Price Note",
    summary: "A 4090 costs two thousand dollars.",
    heading: "RTX 4090 Price",
    body: "A 4090 costs two thousand dollars.",
    date: "2026-10-14",
  },
  {
    key: "groq1",
    type: "reference",
    title: "Groq Dev Tier Note",
    summary: "Groq dev tier is dev.",
    heading: "Groq Dev Tier Status",
    body: "The Groq dev tier is designated as dev.",
    date: "2026-10-14",
  },
  {
    key: "groq2",
    type: "reference",
    title: "Groq Plan Note",
    summary: "We are on the dev plan for Groq.",
    heading: "Groq Plan Status",
    body: "We are on the dev plan for Groq.",
    date: "2026-10-14",
  },
  {
    key: "groq3",
    type: "reference",
    title: "Groq Tier Note",
    summary: "Ixa is on the Groq Dev tier.",
    heading: "Groq Tier",
    body: "Ixa is on the Groq Dev tier.",
    date: "2026-10-14",
  },
  {
    key: "repo",
    type: "reference",
    title: "Ixa repo location",
    summary: "The Ixa repo is at /home/wyatt/Projects/ixa.",
    heading: "Ixa repo location",
    body: "The Ixa repo is at /home/wyatt/Projects/ixa.",
    date: "2026-10-13",
  },
]

// ------------------------------------------------------------------- cases

interface Case {
  id: string
  kind: "positive" | "negative"
  // Seed keys that count as "the note this restates". Superseding one of
  // these is the right act; superseding anything else is a wrong target.
  targets?: string[]
  // Negative cases that are arguable (same entity, different attribute) are
  // reported on their own rather than counted against the clean negatives.
  adjacent?: boolean
  text: string
  runs: number
}

const CASES: Case[] = [
  // The live utterance, STT's wording and all.
  { id: "P1", kind: "positive", targets: ["stt"], runs: 10,
    text: "You can write and note that the STT-type sidecar uses base.en." },
  { id: "P2", kind: "positive", targets: ["groq1", "groq2", "groq3"], runs: 5,
    text: "Make a note that we're on the Groq dev plan now." },
  { id: "P3", kind: "positive", targets: ["rtx3090"], runs: 5,
    text: "Write a note that I paid six hundred dollars for the RTX 3090." },
  { id: "P4", kind: "positive", targets: ["rtx4090"], runs: 5,
    text: "Write down that a 4090 costs two thousand dollars." },
  // An UPDATE of a seeded note: the same subject with a changed value, which
  // is the duplicate that does the damage: two active notes that disagree.
  { id: "P5", kind: "positive", targets: ["rtx4090"], runs: 5,
    text: "Write a note that a 4090 costs twenty two hundred dollars now." },
  // Clean negatives: a different fact, the advisory lists the two nearest
  // notes anyway because it has no threshold.
  { id: "N1", kind: "negative", runs: 5,
    text: "Write a note that the Framework 13 runs the desktop voice client." },
  { id: "N2", kind: "negative", runs: 5,
    text: "Write a note that the TTS sidecar uses Kokoro with the af_nova voice." },
  // The live second save: a price the user said, two RTX notes listed as
  // "may cover this subject" and neither of them does.
  { id: "N4", kind: "negative", runs: 5,
    text: "You write a note about my home lab. I'm thinking I'll want a Dell Precision or a Dell OptiPlex with an i5, i7, or ideally i9, but I don't think I'm going to find one below my price range of $300." },
  { id: "N5", kind: "negative", runs: 5,
    text: "Write a note that the vault is a folder of markdown files that Obsidian can open." },
  { id: "N6", kind: "negative", runs: 5,
    text: "Write a note that we decided to use Qdrant for the vector store." },
  // HARD negatives: a different fact in the same sentence frame as a seeded
  // note, so the advisory's top hit scores high on text that is NOT a
  // restatement. Without these a score-gated behaviour is never tested
  // on the cases it could get wrong.
  { id: "N7", kind: "negative", runs: 5,
    text: "Write a note that a used 3080 costs about five hundred dollars." },
  { id: "N8", kind: "negative", runs: 5,
    text: "Write a note that I paid eight hundred dollars for the Framework 13." },
  // The hardest kind: a DIFFERENT thing in a sentence that is almost the
  // seeded one word for word, so the advisory scores it as a strong match
  // (the 0.80 line the strong wording keys on). A 3080 is not the 3090 that
  // was bought; replacing that note would lose a fact.
  // N9 is ARGUABLE and is scored apart from the clean negatives: said aloud, a
  // 3080 against a stored 3090 purchase can be a correction of a misheard
  // model number as easily as a second purchase. It was first written as a
  // clean negative and reclassified after the strong wording failed it; its
  // numbers are reported either way.
  { id: "N9", kind: "negative", adjacent: true, runs: 5,
    text: "Write a note that I paid six hundred dollars for the RTX 3080." },
  { id: "N10", kind: "negative", runs: 5,
    text: "Write a note that a 4080 costs one thousand dollars." },
  { id: "N11", kind: "negative", runs: 5,
    text: "Write a note that the TTS sidecar uses the Kokoro model for text to speech." },
  // Arguable: the same entity, another attribute. Not counted in the clean
  // negatives.
  { id: "A1", kind: "negative", adjacent: true, runs: 5,
    text: "Write a note that the STT sidecar listens on port five thousand and one." },
]

// ----------------------------------------------------------------- recording

interface CallRecord {
  name: string
  args: string
  result: string
}

let calls: CallRecord[] = []
for (const name of ["save_note", "search_notes"]) {
  const tool = registry.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  const original = tool.execute.bind(tool)
  tool.execute = async (input: unknown) => {
    const result = await original(input)
    calls.push({ name, args: JSON.stringify(input), result: String(result) })
    return result
  }
}

interface TrialResult {
  caseId: string
  kind: "positive" | "negative"
  adjacent: boolean
  run: number
  outcome: "resolved" | "duplicate" | "correct" | "false-supersede" | "dropped" | "error"
  route: string[]
  saveCalls: number
  actedOnAdvisory: boolean
  placeholderSupersedes: boolean
  wrongTarget: boolean
  supersededSeeds: string[]
  newActive: string[]
  advisoryScores: Array<{ seed: string; score: number }>
  reply: string
  error?: string
}

// ------------------------------------------------------------------- a trial

const embedder = new OllamaEmbedder()

async function dropCollection(): Promise<void> {
  await fetch(`${config.qdrant.url}/collections/${COLLECTION}`, { method: "DELETE" }).catch(
    () => undefined
  )
}

async function trial(c: Case, run: number, n: number): Promise<TrialResult> {
  const dir = path.join(RUN_DIR, `t${n}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  await dropCollection()

  const db = openDatabase(path.join(dir, "trial.db"))
  const store = new NoteStore(db)
  const index = new QdrantIndex({
    collection: COLLECTION,
    payloadIndexes: [{ field: "status", schema: "keyword" }],
  })
  const notebook = new Notebook({ store, embedder, index, vaultPath: path.join(dir, "vault") })
  setNotebook(notebook)
  await notebook.start()
  notebook.stopBacklogSweep()

  const seedIds = new Map<string, string>() // seed key -> note id
  for (const seed of SEEDS) {
    const saved = await notebook.save({
      type: seed.type,
      title: seed.title,
      summary: seed.summary,
      sections: [{ heading: seed.heading, body: seed.body }],
      source: "voice",
      sessionId: "seed",
      date: seed.date,
    })
    seedIds.set(seed.key, saved.note.id)
  }
  const keyOf = (id: string): string =>
    [...seedIds.entries()].find(([, v]) => v === id)?.[0] ?? id
  const seedIdSet = new Set(seedIds.values())

  // The advisory's own scores, which the tool result does not print.
  const advisory: Array<{ seed: string; score: number }> = []
  const originalSave = notebook.save.bind(notebook)
  let firstSave = true
  notebook.save = async (input: SaveNoteInput): Promise<SaveResult> => {
    const result = await originalSave(input)
    if (firstSave) {
      firstSave = false
      for (const hit of result.duplicates) {
        advisory.push({ seed: keyOf(hit.note.id), score: Number(hit.score.toFixed(3)) })
      }
    }
    return result
  }

  // The standing preference from the live session, so the voice block and the
  // preference block are both in the request as they were.
  const preferences = new PreferenceStore(db)
  preferences.remember({ topic: "answer_length", value: "keep answers short", category: "general" })

  calls = []
  const session = new Session({
    limits: TEST_LIMITS,
    preferenceBlock: () => preferences.injectionBlock(),
  })
  let reply = ""
  let error: string | undefined
  try {
    reply = await session.send(c.text, makeConnection(), "voice")
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const all = store.all()
  const newNotes = all.filter((note: Note) => !seedIdSet.has(note.id))
  const newActive = newNotes.filter((note) => note.status === "active").map((note) => note.id)
  const supersededSeeds = [...seedIds.entries()]
    .filter(([, id]) => store.byId(id)?.status !== "active")
    .map(([key]) => key)

  const saves = calls.filter((call) => call.name === "save_note")
  const supersedesOf = (call: CallRecord): string | null => {
    try {
      const value = (JSON.parse(call.args) as { supersedes?: unknown }).supersedes
      return typeof value === "string" && value ? value : null
    } catch {
      return null
    }
  }
  // A save_note call AFTER the first, naming a note to replace: the one
  // behaviour the advisory asks for. A supersedes on the first call is the
  // model having searched, which is a different route to the same state.
  const actedOnAdvisory = saves.slice(1).some((call) => supersedesOf(call) !== null)
  const placeholderSupersedes = saves.some((call) => {
    try {
      const s = (JSON.parse(call.args) as { supersedes?: unknown }).supersedes
      return typeof s === "string" && /[<>]/.test(s)
    } catch {
      return false
    }
  })
  const wrongTarget =
    c.kind === "positive" && supersededSeeds.some((key) => !(c.targets ?? []).includes(key))

  let outcome: TrialResult["outcome"]
  if (error) outcome = "error"
  else if (c.kind === "positive") {
    outcome = newActive.length === 0 || supersededSeeds.length > 0 ? "resolved" : "duplicate"
  } else if (supersededSeeds.length > 0) outcome = "false-supersede"
  else if (newActive.length === 0) outcome = "dropped"
  else outcome = "correct"

  notebook.stopBacklogSweep()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })

  return {
    caseId: c.id,
    kind: c.kind,
    adjacent: Boolean(c.adjacent),
    run,
    outcome,
    route: calls.map((call) => call.name),
    saveCalls: saves.length,
    actedOnAdvisory,
    placeholderSupersedes,
    wrongTarget,
    supersededSeeds,
    newActive,
    advisoryScores: advisory,
    reply,
    ...(error ? { error } : {}),
  }
}

// ------------------------------------------------------------------- report

function summarise(results: TrialResult[]): void {
  const by = (pred: (r: TrialResult) => boolean) => results.filter(pred)
  const count = (rs: TrialResult[], o: TrialResult["outcome"]) => rs.filter((r) => r.outcome === o).length

  console.log(`\n=== arm: ${ARM} ===`)
  const pos = by((r) => r.kind === "positive")
  console.log(
    `positive: ${count(pos, "resolved")}/${pos.length} resolved, ${count(pos, "duplicate")} duplicate left, ` +
      `${pos.filter((r) => r.wrongTarget).length} wrong target, ` +
      `${pos.filter((r) => r.placeholderSupersedes).length} placeholder supersedes, ` +
      `${count(pos, "error")} errors`
  )
  for (const id of [...new Set(pos.map((r) => r.caseId))]) {
    const rs = by((r) => r.caseId === id)
    console.log(
      `  ${id}: ${count(rs, "resolved")}/${rs.length} resolved; route ` +
        [...new Set(rs.map((r) => r.route.join("→") || "(none)"))].join(" | ")
    )
  }
  const neg = by((r) => r.kind === "negative" && !r.adjacent)
  console.log(
    `negative (clean): ${count(neg, "correct")}/${neg.length} correct, ` +
      `${count(neg, "false-supersede")} false supersede, ${count(neg, "dropped")} dropped, ` +
      `${count(neg, "error")} errors`
  )
  for (const id of [...new Set(neg.map((r) => r.caseId))]) {
    const rs = by((r) => r.caseId === id)
    console.log(
      `  ${id}: ${count(rs, "correct")}/${rs.length} correct; ` +
        `${count(rs, "false-supersede")} false supersede, ${count(rs, "dropped")} dropped`
    )
  }
  const adj = by((r) => r.adjacent)
  if (adj.length > 0) {
    console.log(
      `adjacent (not scored): ${count(adj, "correct")}/${adj.length} kept separate, ` +
        `${count(adj, "false-supersede")} superseded the seed`
    )
  }
  const scored = results.flatMap((r) =>
    r.advisoryScores.map((s) => ({ ...s, kind: r.kind, caseId: r.caseId }))
  )
  const fmt = (xs: number[]) =>
    xs.length ? `n=${xs.length} min ${Math.min(...xs).toFixed(3)} max ${Math.max(...xs).toFixed(3)}` : "n=0"
  console.log(
    `advisory scores — top hit on positive cases that is a target: ` +
      fmt(
        results
          .filter((r) => r.kind === "positive")
          .flatMap((r) => {
            const c = CASES.find((k) => k.id === r.caseId)!
            return r.advisoryScores.filter((s) => (c.targets ?? []).includes(s.seed)).map((s) => s.score)
          })
      )
  )
  console.log(
    `advisory scores — every hit on negative cases: ${fmt(
      scored.filter((s) => s.kind === "negative").map((s) => s.score)
    )}`
  )
}

async function main(): Promise<void> {
  if (argv.includes("--cleanup")) {
    await dropCollection()
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    console.log(`dropped ${COLLECTION}, removed ${RUN_DIR}`)
    return
  }
  if (config.notes.collection !== COLLECTION) {
    throw new Error(`collection is ${config.notes.collection}, expected the throwaway ${COLLECTION}`)
  }

  const results: TrialResult[] = []
  let n = 0
  for (const c of CASES) {
    if (ONLY && !ONLY.includes(c.id)) continue
    const runs = Math.max(1, Math.round(c.runs * SCALE))
    for (let run = 1; run <= runs; run++) {
      const result = await trial(c, run, n++)
      results.push(result)
      console.log(
        `${c.id}#${run} ${result.outcome.padEnd(15)} ${result.route.join("→") || "(no tool)"}` +
          (result.supersededSeeds.length ? `  superseded[${result.supersededSeeds}]` : "") +
          (result.error ? `  ERROR ${result.error}` : "")
      )
    }
  }
  summarise(results)
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ arm: ARM, at: new Date().toISOString(), results }, null, 1))
  await dropCollection()
}

main().catch((err) => {
  console.error("verify failed:", err instanceof Error ? err.stack : err)
  process.exit(1)
})
