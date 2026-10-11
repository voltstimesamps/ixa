import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { makeNotebook, captureLogs } from "./memory-helpers"
import { parseNote } from "../src/memory/notes-markdown"

// The write path. THE FILE IS THE SOURCE OF TRUTH, so every one of these
// writes a real file into a throwaway vault and reads it back off disk — a
// test that only checked the SQLite row would be checking the index.

const BASE = {
  type: "decision" as const,
  title: "Tavily replaced Brave for search",
  summary: "Search goes through Tavily. Brave was dropped before any code shipped against it.",
  sections: [
    { heading: "The choice", body: "Tavily returns extracted content rather than links." },
    { heading: "Why not Brave", body: "It was evaluated and never wired in." },
  ],
  source: "text" as const,
  sessionId: "session-1",
  date: "2026-10-10",
}

test("the path is built from the title and date, and the note is on disk", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const result = await h.notebook.save(BASE)

  assert.equal(result.note.id, "2026-10-10-tavily-replaced-brave-for-search")
  assert.equal(
    result.note.path,
    "2026-10-10-tavily-replaced-brave-for-search.md",
    "flat: the path is the id, with no type directory"
  )

  const absolute = path.join(h.vault, result.note.path)
  assert.ok(fs.existsSync(absolute), "the markdown file exists")

  const parsed = parseNote(fs.readFileSync(absolute, "utf8"))
  assert.ok(parsed)
  assert.equal(parsed.meta.title, BASE.title)
  assert.equal(parsed.meta.status, "active")
  assert.deepEqual(parsed.sections, BASE.sections)
})

test("every type lands in one flat directory, with the type in the frontmatter", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  for (const type of ["decision", "project", "reference"] as const) {
    await h.notebook.save({ ...BASE, type, title: `A ${type} note`, date: "2026-10-10" })
  }

  const entries = fs.readdirSync(h.vault, { withFileTypes: true })
  assert.deepEqual(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    [],
    "no decisions/, projects/ or references/ — the type is not part of the path"
  )
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [
      "2026-10-10-a-decision-note.md",
      "2026-10-10-a-project-note.md",
      "2026-10-10-a-reference-note.md",
    ],
    "<id>.md, in the vault root"
  )

  // The type is still recorded — it moved to the frontmatter, it did not go
  // away, and search filters on it through the Qdrant payload.
  const parsed = parseNote(fs.readFileSync(path.join(h.vault, "2026-10-10-a-project-note.md"), "utf8"))
  assert.equal(parsed?.meta.type, "project")
})

test("provenance on disk comes from the harness, not from the caller's text", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const result = await h.notebook.save({ ...BASE, source: "voice", sessionId: "real-session" })
  const parsed = parseNote(fs.readFileSync(path.join(h.vault, result.note.path), "utf8"))

  assert.ok(parsed)
  assert.equal(parsed.meta.source, "voice")
  assert.equal(parsed.meta.sessionId, "real-session")
  assert.equal(parsed.meta.date, "2026-10-10")
})

test("a title that tries to escape the vault cannot", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  // The model never supplies a path, but a title is free text, and a slug is
  // built from it. Separators have to die in slugify or the whole ungating
  // argument fails.
  const result = await h.notebook.save({ ...BASE, title: "../../etc/passwd owned" })

  assert.ok(
    !result.note.path.includes(".."),
    `the path must stay inside the vault, got ${result.note.path}`
  )
  const absolute = path.resolve(h.vault, result.note.path)
  assert.ok(absolute.startsWith(path.resolve(h.vault) + path.sep))
  assert.ok(fs.existsSync(absolute))
})

test("the write leaves no temp file behind", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(BASE)

  const files = fs.readdirSync(h.vault)
  assert.deepEqual(files, ["2026-10-10-tavily-replaced-brave-for-search.md"])
  assert.ok(
    !files.some((name) => name.includes(".tmp-")),
    "a temp + rename write must not leave a .tmp- file for Syncthing to replicate"
  )
})

test("a failed write leaves neither a temp file nor a half-written note", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(BASE)
  const absolute = path.join(h.vault, "2026-10-10-tavily-replaced-brave-for-search.md")
  const before = fs.readFileSync(absolute, "utf8")

  // A read-only vault root: writeFileSync throws where the temp file wants to
  // go, which is the vault itself now that the layout is flat.
  fs.chmodSync(h.vault, 0o500)
  try {
    await assert.rejects(() => h.notebook.save({ ...BASE, summary: "a different summary" }))
  } finally {
    fs.chmodSync(h.vault, 0o700)
  }

  assert.equal(fs.readFileSync(absolute, "utf8"), before, "the old note is untouched")
  assert.ok(
    !fs.readdirSync(h.vault).some((name) => name.includes(".tmp-")),
    "the temp file is cleaned up on failure"
  )
})

// --------------------------------------------------------------- indexing

test("chunks are embedded once and the vectors carry the filterable metadata", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const result = await h.notebook.save(BASE)

  assert.equal(result.indexed, true)
  assert.ok(result.chunks.added > 0)
  assert.equal(h.index.points.size, result.chunks.added)

  const point = [...h.index.points.values()][0]!
  assert.equal(point.payload.noteId, result.note.id)
  assert.equal(point.payload.status, "active")
  assert.equal(point.payload.type, "decision")
  assert.equal(point.payload.date, "2026-10-10")
  assert.equal(point.payload.title, BASE.title)

  // Only the chunk text is embedded. The measured reason: gluing the title,
  // type and date in front of the text LOST a top-1 and bought nothing worth
  // having, so the metadata lives in the payload where it can be filtered.
  const documents = h.embedder.calls.filter((call) => call.kind === "document")
  assert.ok(documents.length > 0)
  for (const call of documents) {
    assert.ok(!call.text.includes("2026-10-10"), "the date is not in the embedded text")
    assert.ok(!call.text.includes("| decision |"), "no metadata prefix is glued on")
  }
})

test("re-saving an unchanged note re-embeds nothing", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  await h.notebook.save(BASE)
  // DOCUMENT embeddings only. Every save also embeds its own title and summary
  // as a QUERY, for the duplicate check, and that is not a re-embed of the
  // note — see note-duplicates.test.ts.
  const documents = () => h.embedder.calls.filter((call) => call.kind === "document").length
  const first = documents()
  const pointIds = [...h.index.points.keys()]

  const again = await h.notebook.save(BASE)

  assert.equal(documents(), first, "no embedding call for text that did not change")
  assert.equal(again.chunks.added, 0)
  assert.ok(again.chunks.kept > 0)
  assert.deepEqual([...h.index.points.keys()], pointIds, "the points keep their ids")
})

test("re-chunking with one section changed keeps the rest of the vectors", async (t) => {
  // At the store, which is the unit that implements hash matching. The save
  // path reaches it on an identical re-save and on a re-index (a rebuild, or
  // the reconcile scan later); a note whose CONTENT changed becomes a new note
  // by design — see the collision test below.
  const h = makeNotebook({ limits: { minTokens: 1 } })
  t.after(h.cleanup)

  await h.notebook.save(BASE)
  const before = h.store.chunksFor("2026-10-10-tavily-replaced-brave-for-search")
  assert.equal(before.length, 2, "two sections, two chunks, with the merge floor out of the way")

  const diff = h.store.replaceChunks("2026-10-10-tavily-replaced-brave-for-search", [
    { ordinal: 0, headingPath: "The choice", text: before[0]!.text, hash: before[0]!.hash },
    {
      ordinal: 1,
      headingPath: "Why not Brave",
      text: "## Why not Brave\n\nMeasured, not assumed.",
      hash: "a-new-hash",
    },
  ])

  assert.equal(diff.added.length, 1, "only the changed chunk is new")
  assert.equal(diff.kept.length, 1)
  assert.equal(diff.kept[0]!.id, before[0]!.id, "the unchanged chunk keeps its point id")
  assert.equal(diff.kept[0]!.indexedAt, before[0]!.indexedAt, "and its indexed_at")
  assert.deepEqual(diff.removedIds, [before[1]!.id], "the replaced chunk's vector is dropped")
})

test("a moved section is recognised as unchanged and keeps its vector", async (t) => {
  const h = makeNotebook({ limits: { minTokens: 1 } })
  t.after(h.cleanup)

  await h.notebook.save(BASE)
  const id = "2026-10-10-tavily-replaced-brave-for-search"
  const before = h.store.chunksFor(id)

  const diff = h.store.replaceChunks(id, [
    { ordinal: 0, headingPath: before[1]!.headingPath, text: before[1]!.text, hash: before[1]!.hash },
    { ordinal: 1, headingPath: before[0]!.headingPath, text: before[0]!.text, hash: before[0]!.hash },
  ])

  assert.equal(diff.added.length, 0, "the hash is over the text, not the position")
  assert.equal(diff.kept.length, 2)
  assert.deepEqual(diff.removedIds, [])
  assert.deepEqual(
    h.store.chunksFor(id).map((chunk) => chunk.id),
    [before[1]!.id, before[0]!.id],
    "they swapped ordinals without being re-inserted"
  )
})

test("a note written over an existing title gets its own id, never the other's content", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  const first = await h.notebook.save(BASE)
  const firstText = fs.readFileSync(path.join(h.vault, first.note.path), "utf8")

  // Same title, same day, different content. Found in verification: asked to
  // replace a note, the model reused the title, which collided the id — and
  // the first version of this wrote straight over three paragraphs of
  // reasoning.
  const second = await h.notebook.save({
    ...BASE,
    summary: "Something else entirely.",
    sections: [{ heading: "Different", body: "A different body." }],
  })

  assert.notEqual(second.note.id, first.note.id)
  assert.equal(second.note.id, `${first.note.id}-2`)
  assert.equal(
    fs.readFileSync(path.join(h.vault, first.note.path), "utf8"),
    firstText,
    "the first note is byte-identical"
  )
  assert.equal(second.titleClash?.id, first.note.id, "and the model is told it probably meant to supersede")
  assert.equal(h.store.count(), 2)
})

test("an index failure leaves the file as truth and the chunks as backlog", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  h.index.fail = new Error("connect ECONNREFUSED 127.0.0.1:6333")

  const { result, warnings } = await captureLogs(() => h.notebook.save(BASE))

  assert.equal(result.indexed, false, "the caller is told it is not searchable yet")
  assert.ok(
    fs.existsSync(path.join(h.vault, result.note.path)),
    "the note itself is never lost to an index failure"
  )
  assert.equal(h.store.countNotIndexedChunks(), result.chunks.added)
  assert.ok(
    warnings.some((line) => line.includes("queued for retry")),
    `expected a backlog warning, got ${JSON.stringify(warnings)}`
  )

  // And the backlog drains when the index comes back, exactly like episodes.
  h.index.fail = null
  const indexed = await h.notebook.indexBacklog()
  assert.equal(indexed, result.chunks.added)
  assert.equal(h.store.countNotIndexedChunks(), 0)
  assert.equal(h.index.points.size, result.chunks.added)
})

test("one warning for an index outage, not one per note", async (t) => {
  const h = makeNotebook()
  t.after(h.cleanup)

  h.index.fail = new Error("down")
  const { warnings } = await captureLogs(async () => {
    await h.notebook.save(BASE)
    await h.notebook.save({ ...BASE, title: "A second note", date: "2026-10-11" })
    await h.notebook.save({ ...BASE, title: "A third note", date: "2026-10-12" })
  })

  const outages = warnings.filter((line) => line.includes("note index is unavailable"))
  assert.equal(outages.length, 1, `expected one outage warning, got ${JSON.stringify(warnings)}`)
})
