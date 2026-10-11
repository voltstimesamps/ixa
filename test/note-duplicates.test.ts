import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { captureLogs, makeNotebook, withTurn } from "./memory-helpers"
import { setNotebook } from "../src/memory/notebook"
import { saveNoteTool } from "../src/tools/notes"

// SEARCH-BEFORE-WRITE, MOVED OUT OF THE DESCRIPTION AND INTO THE CODE.
//
// save_note's description has said "call search_notes first, every time"
// since it was written. Verification measured the instruction being obeyed
// before three of eight writes — and one of the writes that skipped it
// produced a second note about the Groq Dev tier while the first was still
// sitting in the vault, under a different title, so neither the id collision
// rule nor anything else could catch it.
//
// So every save searches its own title and summary against the active notes
// and reports what it finds. Three properties matter and are each tested
// below: it never blocks the write, it has no score threshold, and it does not
// report a note that was already reported more precisely.

const GROQ = {
  type: "decision" as const,
  title: "Ixa is on the Groq Dev tier",
  summary: "Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.",
  sections: [{ heading: "The decision", body: "The paid Dev tier beat a local-LLM migration." }],
  source: "text" as const,
  sessionId: "seed",
  date: "2026-09-15",
}

// The same subject, a different title — the shape the title-collision rule
// cannot see, because the ids do not collide at all.
const GROQ_AGAIN = {
  ...GROQ,
  title: "Groq Dev Tier Status",
  summary: "We are on the Groq paid Dev tier now.",
  sections: [{ heading: "Status", body: "Paid Dev tier, not the free tier." }],
  date: "2026-10-10",
  sessionId: "s2",
}

// Offers every indexed chunk as a candidate, which is what Qdrant effectively
// does with no threshold: the notebook decides what comes back.
function offerEverything(h: ReturnType<typeof makeNotebook>, score = 0.62): void {
  h.index.nextHits = [...h.index.points.keys()].map((id) => ({ id, score }))
}

test("a note already covering the subject is surfaced, even under another title", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const first = await h.notebook.save(GROQ)
  offerEverything(h)

  const second = await h.notebook.save(GROQ_AGAIN)

  assert.equal(second.duplicates.length, 1)
  assert.equal(second.duplicates[0]!.note.id, first.note.id)
  assert.equal(second.duplicates[0]!.note.title, GROQ.title)
  assert.ok(second.duplicates[0]!.note.summary.length > 0, "the model needs enough to judge on")
})

test("the duplicate search embeds the title AND the summary as one query", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(GROQ)

  const query = h.embedder.calls.filter((call) => call.kind === "query").at(-1)
  assert.ok(query, "a save searches, whether or not the model did")
  assert.ok(query.text.includes(GROQ.title))
  assert.ok(
    query.text.includes(GROQ.summary),
    "the summary is what retrieval matches on; a title alone is often too short to embed"
  )
})

test("the search is capped at two and carries no score floor", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  for (let i = 0; i < 5; i++) {
    await h.notebook.save({ ...GROQ, title: `Groq note ${i}`, date: `2026-09-1${i}` })
  }
  offerEverything(h, 0.2)

  const result = await h.notebook.save(GROQ_AGAIN)

  assert.equal(result.duplicates.length, 2, "top 2, as decided")
  const search = h.index.searches.at(-1)!
  assert.equal(
    search.minScore,
    undefined,
    "the same measurement that removed the floor from retrieval applies here"
  )
  assert.ok(
    result.duplicates.every((hit) => hit.score === 0.2),
    "a weak match is still reported; the model judges it, not a number"
  )
})

test("an empty notebook reports no duplicates", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const result = await h.notebook.save(GROQ)

  assert.deepEqual(result.duplicates, [])
  assert.equal(result.indexed, true)
})

test("the note being superseded is not also offered as a duplicate", async (t) => {
  // It is the case most likely to match — same subject, by definition — and
  // the result already says it was superseded. Saying both would contradict
  // itself, which is the bug the title-clash advisory already had once.
  const h = makeNotebook()
  t.after(h.cleanup)

  const old = await h.notebook.save(GROQ)
  offerEverything(h)

  const replacement = await h.notebook.save({ ...GROQ_AGAIN, supersedes: old.note.id })

  assert.equal(replacement.superseded?.id, old.note.id)
  assert.deepEqual(replacement.duplicates, [])
})

test("a re-save is not reported as a duplicate of itself", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(GROQ)
  offerEverything(h)

  const again = await h.notebook.save(GROQ)

  assert.equal(again.note.id, "2026-09-15-ixa-is-on-the-groq-dev-tier")
  assert.deepEqual(again.duplicates, [], "the only match is the note being written")
})

test("a title clash is reported once, as a clash, not twice", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const first = await h.notebook.save(GROQ)
  offerEverything(h)

  const second = await h.notebook.save({
    ...GROQ,
    summary: "Something else entirely.",
    sections: [{ heading: "Different", body: "A different body." }],
  })

  assert.equal(second.titleClash?.id, first.note.id, "the precise message covers it")
  assert.deepEqual(second.duplicates, [])
})

// ------------------------------------------------- it can never cost a note

test("an index that is down costs the duplicate check, not the write", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(GROQ)
  offerEverything(h)
  h.index.fail = new Error("connect ECONNREFUSED 127.0.0.1:6333")

  const { result } = await captureLogs(() => h.notebook.save(GROQ_AGAIN))

  assert.deepEqual(result.duplicates, [], "silently, with no duplicate reported")
  assert.ok(
    fs.existsSync(path.join(h.vault, result.note.path)),
    "the user asked for a note; a dead index is not a reason to lose it"
  )
  assert.equal(result.indexed, false, "and the write still reports honestly that it is unindexed")
})

test("an embedder that is down costs the duplicate check, not the write", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  h.embedder.fail = new Error("connect ECONNREFUSED 127.0.0.1:11434")

  const { result } = await captureLogs(() => h.notebook.save(GROQ))

  assert.deepEqual(result.duplicates, [])
  assert.ok(fs.existsSync(path.join(h.vault, result.note.path)))
})

test("a search that times out costs the duplicate check, not the write", async (t) => {
  const h = makeNotebook({ limits: { searchTimeoutMs: 20 } })
  t.after(h.cleanup)

  h.embedder.delayMs = 60

  const { result } = await captureLogs(() => h.notebook.save(GROQ))

  assert.deepEqual(result.duplicates, [])
  assert.ok(fs.existsSync(path.join(h.vault, result.note.path)))
})

// ------------------------------------------------------------------ the tool

test("the tool tells the model to supersede the duplicate, with its id", async (t) => {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  const first = await h.notebook.save(GROQ)
  offerEverything(h)

  const output = String(
    await withTurn({ userText: "make a note that we're on the groq dev tier now" }, () =>
      saveNoteTool.execute({
        type: "decision",
        title: GROQ_AGAIN.title,
        summary: GROQ_AGAIN.summary,
        sections: GROQ_AGAIN.sections,
      })
    )
  )

  assert.match(output, /may cover this subject/)
  assert.match(output, new RegExp(`id ${first.note.id}`), "the id 'supersedes' needs")
  assert.match(output, /supersedes set to that id/)
  assert.match(output, /If none of them is about the same thing, ignore this/)
  // The read-back still comes first: the note WAS saved, and the reply has to
  // say so rather than reporting a near-miss as a failure.
  assert.ok(output.indexOf("Saved decision note") < output.indexOf("may cover this subject"))
})

test("nothing is said about duplicates when there are none", async (t) => {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  const output = String(
    await withTurn({ userText: "write that down" }, () =>
      saveNoteTool.execute({
        type: "decision",
        title: GROQ.title,
        summary: GROQ.summary,
        sections: GROQ.sections,
      })
    )
  )

  assert.match(output, /Saved decision note/)
  assert.ok(!output.includes("may cover this subject"))
})
