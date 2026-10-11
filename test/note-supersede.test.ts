import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { makeNotebook, withTurn } from "./memory-helpers"
import { parseNote } from "../src/memory/notes-markdown"
import { setNotebook } from "../src/memory/notebook"
import { saveNoteTool } from "../src/tools/notes"

// Supersede, not overwrite — the same shape preferences already have.
//
// The spike is why this is a feature rather than a convention: asked to
// supersede a note, the model replaced three sections of reasoning with a
// single line. So the model cannot write the old note at all. The ONLY thing
// that touches it is a stamp added in code.

const OLD = {
  type: "decision" as const,
  title: "Brave is the search provider",
  summary: "Search goes through Brave Search.",
  sections: [
    { heading: "The choice", body: "Brave was picked for its independent index." },
    { heading: "The cost", body: "It needs an API key and bills per query." },
    { heading: "What was rejected", body: "A metasearch front end, for latency reasons." },
  ],
  source: "text" as const,
  sessionId: "s1",
  date: "2026-09-01",
}

const NEW = {
  type: "decision" as const,
  title: "Tavily replaced Brave for search",
  summary: "Search goes through Tavily now. This replaces the Brave decision.",
  sections: [
    { heading: "What changed", body: "Tavily returns extracted content rather than links." },
  ],
  source: "text" as const,
  sessionId: "s2",
  date: "2026-10-10",
}

async function supersede() {
  const h = makeNotebook()
  const old = await h.notebook.save(OLD)
  const replacement = await h.notebook.save({ ...NEW, supersedes: old.note.id })
  return { h, old, replacement }
}

test("the superseded note keeps its body, its path and its reasoning", async (t) => {
  const { h, old, replacement } = await supersede()
  t.after(h.cleanup)

  const absolute = path.join(h.vault, old.note.path)
  assert.ok(fs.existsSync(absolute), "the old note stays exactly where it was — no link breaks")

  const parsed = parseNote(fs.readFileSync(absolute, "utf8"))
  assert.ok(parsed)
  assert.deepEqual(
    parsed.sections,
    OLD.sections,
    "all three sections of reasoning survive verbatim"
  )
  assert.equal(parsed.meta.status, "superseded")
  assert.equal(parsed.meta.supersededBy, replacement.note.id)
  assert.equal(parsed.meta.title, OLD.title, "the title is not rewritten either")
})

test("the stamp is visible to a reader, not just to the parser", async (t) => {
  const { h, old } = await supersede()
  t.after(h.cleanup)

  const text = fs.readFileSync(path.join(h.vault, old.note.path), "utf8")
  assert.match(text, /> \*\*Superseded on 2026-10-10\*\*/)
  assert.match(text, /2026-10-10-tavily-replaced-brave-for-search/)
})

test("the row and the file agree about the supersede", async (t) => {
  const { h, old, replacement } = await supersede()
  t.after(h.cleanup)

  const row = h.store.byId(old.note.id)
  assert.ok(row)
  assert.equal(row.status, "superseded")
  assert.equal(row.supersededBy, replacement.note.id)
  assert.ok(row.supersededAt)

  assert.equal(replacement.superseded?.id, old.note.id, "the result names what it replaced")
  assert.equal(h.store.countActive(), 1)
  assert.equal(h.store.count(), 2, "nothing is deleted")
})

test("a superseded note's vectors are re-stamped, not deleted", async (t) => {
  const { h, old } = await supersede()
  t.after(h.cleanup)

  const oldPoints = [...h.index.points.values()].filter(
    (point) => point.payload.noteId === old.note.id
  )
  assert.ok(oldPoints.length > 0, "the note is still indexed — it still exists")
  for (const point of oldPoints) {
    assert.equal(
      point.payload.status,
      "superseded",
      "the payload is what the active-only filter reads, so it has to be current"
    )
  }
})

test("recency and the active filter both exclude it", async (t) => {
  const { h, old, replacement } = await supersede()
  t.after(h.cleanup)

  const recent = h.notebook.recent()
  assert.ok(recent.available)
  assert.deepEqual(
    recent.hits.map((hit) => hit.note.id),
    [replacement.note.id],
    "only the active note is recent"
  )

  // The index filter, exercised through a real search: every chunk is offered
  // as a hit, and the superseded note's chunks are removed by the payload
  // filter rather than by the code that reads the results.
  h.index.nextHits = [...h.index.points.keys()].map((id) => ({ id, score: 0.7 }))
  const found = await h.notebook.search("search provider")
  assert.ok(found.available)
  assert.ok(found.hits.length > 0)
  for (const hit of found.hits) {
    assert.notEqual(hit.note.id, old.note.id)
  }
})

test("a supersede that names the wrong note still writes the note, and says so", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const result = await h.notebook.save({ ...NEW, supersedes: "2026-01-01-a-note-that-never-existed" })

  assert.ok(result.supersedeProblem, "the model is told plainly")
  assert.match(result.supersedeProblem, /No note with the id/)
  assert.equal(result.superseded, null)
  assert.ok(
    fs.existsSync(path.join(h.vault, result.note.path)),
    "losing the content because a cross-reference was wrong would be the worse failure"
  )
})

test("a note cannot supersede itself, and a note cannot be superseded twice", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const first = await h.notebook.save(NEW)
  const itself = await h.notebook.save({ ...NEW, supersedes: first.note.id })
  assert.match(itself.supersedeProblem ?? "", /cannot supersede itself/)

  const old = await h.notebook.save(OLD)
  await h.notebook.save({ ...NEW, title: "Second replacement", supersedes: old.note.id })
  const again = await h.notebook.save({
    ...NEW,
    title: "Third replacement",
    supersedes: old.note.id,
  })
  assert.match(again.supersedeProblem ?? "", /already superseded/)
})

test("the replacement may reuse the title and still not destroy the original", async (t) => {
  // Verification found this exact shape: asked to replace a note, the model
  // wrote the replacement under the SAME title and set `supersedes` to the
  // note it was about to collide with. Both things have to hold — a distinct
  // id, and a real supersede rather than a self-referential one.
  const h = makeNotebook()
  t.after(h.cleanup)

  const old = await h.notebook.save(OLD)
  const replacement = await h.notebook.save({
    ...OLD,
    summary: "Search goes through a self-hosted Searx instance now. This replaces Brave.",
    sections: [{ heading: "What changed", body: "Searx replaces Brave." }],
    date: OLD.date,
    supersedes: old.note.id,
  })

  assert.notEqual(replacement.note.id, old.note.id)
  assert.equal(replacement.superseded?.id, old.note.id, "the supersede actually happened")
  assert.equal(replacement.supersedeProblem, undefined, "not refused as self-referential")

  const parsed = parseNote(fs.readFileSync(path.join(h.vault, old.note.path), "utf8"))
  assert.ok(parsed)
  assert.deepEqual(parsed.sections, OLD.sections, "all three sections of reasoning survive")
  assert.equal(parsed.meta.status, "superseded")
})

test("a reused title plus a supersede is not also advised to supersede", async (t) => {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  const old = await h.notebook.save(OLD)
  const output = String(
    await withTurn({ userText: "update that note" }, () =>
      saveNoteTool.execute({
        type: "decision",
        title: OLD.title,
        summary: "Searx replaces Brave now.",
        sections: [{ heading: "What changed", body: "Searx, self-hosted." }],
        supersedes: old.note.id,
      })
    )
  )

  assert.match(output, /Superseded "Brave is the search provider"/)
  assert.ok(
    !output.includes("call save_note again"),
    "it already superseded that note; advising it to do so contradicts the line above"
  )
})
