import { test } from "node:test"
import assert from "node:assert/strict"
import { makeNotebook, captureLogs } from "./memory-helpers"
import { setNotebook } from "../src/memory/notebook"
import { searchNotesTool } from "../src/tools/notes"

// The read path: top N notes, active only, AND NO SCORE FLOOR.
//
// The floor is absent on evidence. Measured over 19 questions against 24
// notes with this embedder, text that genuinely answered the question scored
// as low as 0.586 while text from an entirely unrelated note reached 0.755 —
// fully overlapping bands, with the episode threshold (0.60) inside the
// overlap. So retrieval ranks, filters on status, and tells the reader the
// hits may be unrelated.

function note(title: string, date: string, body: string) {
  return {
    type: "reference" as const,
    title,
    summary: `${title}: the short version.`,
    sections: [{ heading: "Detail", body }],
    source: "text" as const,
    sessionId: "s1",
    date,
  }
}

async function withNotes(count: number) {
  const h = makeNotebook()
  for (let i = 0; i < count; i++) {
    await h.notebook.save(
      note(`Note number ${i}`, `2026-10-${String(10 + i).padStart(2, "0")}`, `Body of note ${i}.`)
    )
  }
  // Every chunk is offered as a candidate; the notebook decides what comes
  // back, which is what these tests are about.
  h.index.nextHits = [...h.index.points.keys()].map((id, index) => ({
    id,
    score: 0.8 - index * 0.05,
  }))
  // A save runs its own duplicate search now, so seeding leaves records in
  // here. Cleared so these tests count the search under test and nothing else;
  // the save-time search is note-duplicates.test.ts's subject.
  h.index.searches.length = 0
  return h
}

test("search sends NO score threshold", async (t) => {
  const h = await withNotes(3)
  t.after(h.cleanup)

  await h.notebook.search("anything")

  assert.equal(h.index.searches.length, 1)
  assert.equal(
    h.index.searches[0]!.minScore,
    undefined,
    "a floor here would cut real answers: they go down to 0.586 while wrong notes reach 0.755"
  )
})

test("a weak match is still returned, because rank is the only signal", async (t) => {
  const h = await withNotes(1)
  t.after(h.cleanup)

  h.index.nextHits = [...h.index.points.keys()].map((id) => ({ id, score: 0.21 }))
  const result = await h.notebook.search("something barely related")

  assert.ok(result.available)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]!.score, 0.21)
})

test("search filters on status in the index, not after the fact", async (t) => {
  const h = await withNotes(1)
  t.after(h.cleanup)

  await h.notebook.search("anything")

  assert.deepEqual(h.index.searches[0]!.filter, [{ key: "status", match: { value: "active" } }])
  assert.equal(h.index.searches[0]!.withPayload, true)
})

test("several chunks of one note collapse to its best chunk", async (t) => {
  const h = makeNotebook({ limits: { minTokens: 1 } })
  t.after(h.cleanup)

  const saved = await h.notebook.save({
    ...note("A long note", "2026-10-10", "First body."),
    sections: [
      { heading: "One", body: "The first section body." },
      { heading: "Two", body: "The second section body." },
      { heading: "Three", body: "The third section body." },
    ],
  })
  assert.equal(saved.chunks.added, 3)

  const ids = [...h.index.points.keys()]
  h.index.nextHits = [
    { id: ids[1]!, score: 0.9 },
    { id: ids[0]!, score: 0.8 },
    { id: ids[2]!, score: 0.7 },
  ]

  const result = await h.notebook.search("section")
  assert.ok(result.available)
  assert.equal(result.hits.length, 1, "one note, not three")
  assert.equal(result.hits[0]!.score, 0.9, "its best chunk's score")
  assert.equal(result.hits[0]!.headingPath, "Two")
})

test("search returns at most the configured number of notes", async (t) => {
  const h = await withNotes(6)
  t.after(h.cleanup)

  const result = await h.notebook.search("note")
  assert.ok(result.available)
  assert.equal(result.hits.length, 3)
})

test("a vector whose chunk row is gone is dropped and deleted", async (t) => {
  const h = await withNotes(1)
  t.after(h.cleanup)

  // The real shape of this failure: the point is still IN Qdrant, with an
  // active payload, and the chunk row behind it is gone — a note was rewritten
  // and the vector delete did not land. A point that does not exist at all
  // cannot be returned by a search, so that is not the case worth testing.
  h.index.points.set(9999, {
    id: 9999,
    vector: [1, 0, 0],
    payload: {
      noteId: "2026-01-01-a-note-that-was-rewritten",
      title: "Gone",
      headingPath: "Detail",
      type: "reference",
      status: "active",
      date: "2026-01-01",
    },
  })
  h.index.nextHits = [{ id: 9999, score: 0.95 }, ...h.index.nextHits]

  const { result, warnings } = await captureLogs(() => h.notebook.search("note"))

  assert.ok(result.available)
  assert.ok(result.hits.every((hit) => hit.note.id !== undefined))
  assert.ok(h.index.deleted.includes(9999), "nothing gone from the source comes back via a vector")
  assert.ok(warnings.some((line) => line.includes("no chunk row")))
})

test("recency is answered from SQLite with no embedding at all", async (t) => {
  const h = await withNotes(4)
  t.after(h.cleanup)

  const before = h.embedder.calls.length
  const searchesBefore = h.index.searches.length

  const result = h.notebook.recent()

  assert.ok(result.available)
  assert.equal(h.embedder.calls.length, before, "no embedding")
  assert.equal(h.index.searches.length, searchesBefore, "no vector search")
  assert.deepEqual(
    result.hits.map((hit) => hit.note.title),
    ["Note number 3", "Note number 2", "Note number 1"],
    "newest first"
  )
})

test("an unreachable index is reported, not silently empty", async (t) => {
  const h = await withNotes(1)
  t.after(h.cleanup)

  h.index.fail = new Error("connect ECONNREFUSED")
  const { result } = await captureLogs(() => h.notebook.search("anything"))

  assert.equal(result.available, false)
})

// -------------------------------------------------------------- the tool

test("the tool result says the matches may be unrelated", async (t) => {
  const h = await withNotes(2)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  const output = String(await searchNotesTool.execute({ query: "note" }))

  assert.match(output, /closest matches by meaning, not necessarily answers/)
  assert.match(output, /say you have nothing written down if none of them do/)
  assert.match(output, /id 2026-10-1/, "each hit carries the id save_note's 'supersedes' needs")
})

test("a blank query means recency, the way search_memory treats one", async (t) => {
  const h = await withNotes(2)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  const before = h.embedder.calls.length
  const output = String(await searchNotesTool.execute({ query: "   " }))

  assert.match(output, /most recent note/)
  assert.equal(h.embedder.calls.length, before, "an empty string is not embedded")
})

test("an empty notebook says so plainly", async (t) => {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  assert.match(String(await searchNotesTool.execute({})), /notebook is empty/)
  assert.match(
    String(await searchNotesTool.execute({ query: "anything" })),
    /Nothing in your notebook matches/
  )
})

test("when the index is down the tool says not to write a note either", async (t) => {
  const h = await withNotes(1)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)

  h.index.fail = new Error("down")
  const { result } = await captureLogs(async () =>
    String(await searchNotesTool.execute({ query: "anything" }))
  )

  assert.match(result, /cannot be searched right now/)
  assert.match(
    result,
    /do not call save_note/,
    "save_note's own rule is to search first; it cannot be followed while search is down"
  )
})
