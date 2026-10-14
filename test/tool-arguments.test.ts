import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import { makeMemory, makeNotebook, withTurn } from "./memory-helpers"
import { openDatabase } from "../src/memory/db"
import { setEpisodicMemory } from "../src/memory/episodic-memory"
import { setNotebook } from "../src/memory/notebook"
import { PreferenceStore, setPreferenceStore } from "../src/memory/preferences"
import { registry } from "../src/tools/registry"
import { searchMemoryTool } from "../src/tools/search-memory"
import { coerceNoteType, saveNoteTool, searchNotesTool } from "../src/tools/notes"
import { rememberPreferenceTool, listPreferencesTool } from "../src/tools/preferences"
import "../src/tools/register"

// WHAT HAPPENS WHEN THE MODEL SENDS SOMETHING THE SCHEMA DID NOT EXPECT.
//
// Groq validates every tool call against the schema BEFORE the tool runs, and
// a rejection is not a bad argument — it is a dead turn: no tool call, no
// answer, and whatever the model had already done that turn paid for nothing.
// Both failures measured in verification were this shape, so both are handled
// in code now, where a mistake is correctable.
//
// null IS HOW THE MODEL SPELLS "ABSENT".
//
// Every tool here has an optional string field whose description says to omit
// it. gpt-oss-20b sends an explicit null instead, often enough that it cost a
// whole turn in verification: asked "what did we talk about last time?" — the
// question search_memory's no-query path exists to answer — Groq rejected the
// call against the schema before Ixa saw it, and the turn produced no answer
// and no tool call at all.
//
// So the schemas say ["string", "null"] and the code treats null, "" and
// absent as one case. These tests are about the second half: null must not
// merely be *accepted*, it must behave identically to absent.

// ------------------------------------------------------- search_memory (the regression)

const PROBE_13_ARGS = { query: null, from: null, to: null }

test("the exact call that failed in verification now answers the question", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  h.store.save({
    sessionId: "s1",
    summary: "They fixed the TTS chunking.",
    tags: ["tts"],
    startedAt: 1000,
    endedAt: 2000,
  })

  // Verbatim from dev/scripts/notes-verify-report.md, request 13:
  //   Tool call validation failed: parameters for tool search_memory did not
  //   match schema: errors: [`/from`: expected string, but got null,
  //   `/query`: expected string, but got null, `/to`: expected string, but
  //   got null]
  const output = String(await searchMemoryTool.execute(PROBE_13_ARGS))

  assert.match(output, /most recent conversation/, "a null query means recency, not a search")
  assert.match(output, /TTS chunking/)
  assert.ok(
    !output.includes("in that date range"),
    "null bounds are no bounds, so the answer must not claim a range"
  )
  assert.equal(h.embedder.calls.length, 0, "null is not embedded as a query")
})

test("a null query is identical to an omitted one", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  h.store.save({
    sessionId: "s1",
    summary: "They talked about Qdrant.",
    tags: [],
    startedAt: 1000,
    endedAt: 2000,
  })

  const withNulls = String(await searchMemoryTool.execute(PROBE_13_ARGS))
  const withNothing = String(await searchMemoryTool.execute({}))
  assert.equal(withNulls, withNothing)
})

test("a null date bound does not become a date filter", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  h.store.save({
    sessionId: "s1",
    summary: "They talked about Qdrant.",
    tags: [],
    startedAt: 1000,
    endedAt: 2000,
  })
  h.index.nextHits = [{ id: 1, score: 0.9 }]

  await searchMemoryTool.execute({ query: "qdrant", from: null, to: null })

  const search = h.index.searches.at(-1)!
  assert.equal(search.from, undefined, "a null bound is no bound")
  assert.equal(search.to, undefined)
})

// --------------------------------------------------------------- the notes tools

test("search_notes with a null query returns recent notes", async (t) => {
  const h = makeNotebook()
  setNotebook(h.notebook)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })

  await h.notebook.save({
    type: "reference",
    title: "The backend runs in WSL2",
    summary: "The backend runs inside WSL2 on the gaming PC.",
    sections: [{ heading: "Where", body: "WSL2 on the gaming PC." }],
    source: "text",
    sessionId: "s1",
    date: "2026-10-10",
  })

  const queries = h.embedder.calls.filter((call) => call.kind === "query").length
  const output = String(await searchNotesTool.execute({ query: null }))

  assert.match(output, /most recent note/)
  assert.match(output, /The backend runs in WSL2/)
  assert.equal(
    h.embedder.calls.filter((call) => call.kind === "query").length,
    queries,
    "null is not embedded"
  )
})

test("save_note with a null supersedes saves without complaining about it", async (t) => {
  const h = makeNotebook()
  setNotebook(h.notebook)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })

  const output = String(
    await withTurn({ userText: "write down that the sidecar uses base.en" }, () =>
      saveNoteTool.execute({
        type: "reference",
        title: "The STT sidecar uses base.en",
        summary: "faster-whisper runs base.en, not small.",
        sections: [{ heading: "Model", body: "base.en with a hint list." }],
        supersedes: null,
      })
    )
  )

  assert.match(output, /Saved reference note/)
  assert.ok(
    !/No note with the id/.test(output),
    "a null supersedes is not a supersede that failed — it is no supersede at all"
  )
  assert.equal(h.store.countActive(), 1)
})

// --------------------------------------------------------------- preferences

test("a null category falls back to the default, and does not filter a listing", async (t) => {
  const store = new PreferenceStore(openDatabase(":memory:"))
  setPreferenceStore(store)
  t.after(() => setPreferenceStore(null))

  const saved = String(
    await rememberPreferenceTool.execute({ topic: "coffee", value: "black", category: null })
  )
  assert.match(saved, /Saved new preference \[general\] coffee: black/)

  const listed = String(await listPreferencesTool.execute({ category: null }))
  assert.match(listed, /coffee: black/, "a null filter is no filter")
  assert.ok(!listed.includes('category "null"'), "and it is not treated as a category name")
})

// --------------------------------------------------- a value outside the set

// REVERSED DELIBERATELY, and this is the test that used to say the opposite.
//
// It asserted that a type outside the set returned "Nothing was saved: 'type'
// must be one of …" and wrote nothing, which was right while the alternative
// was Groq killing the turn: a correctable mistake beats a dead turn.
//
// Then the log word got honest and the cost became visible. In TWENTY OF
// TWENTY spoken saves the model's FIRST save_note call carried a type outside
// the set ("note", "FACT"), was refused, and was corrected on the next
// iteration. Not a guard catching a mistake — a tax on every note the user
// has ever saved, one LLM round trip each, previously logged as `ok 0ms`.
test("a wrong note type is coerced and saved, not refused", async (t) => {
  const h = makeNotebook()
  setNotebook(h.notebook)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })

  const output = String(
    await withTurn({ userText: "a used 3090 is about $600 — write that down" }, () =>
      saveNoteTool.execute({
        type: "fact",
        title: "A used 3090 is about $600",
        summary: "Used 3090s sell for around $600.",
        sections: [{ heading: "Price", body: "About $600 used." }],
      })
    )
  )

  assert.match(output, /^Saved reference note/, "saved, and saved as reference")
  assert.ok(!output.startsWith("Nothing was saved"), "the old behaviour, gone on purpose")
  assert.match(
    output,
    /'type' was "fact", which is not one of decision, project, reference, so this was saved/,
    "and the model is told, so its reply does not call this a fact note"
  )
  assert.equal(h.store.count(), 1, "one row")
  assert.equal(h.store.all()[0]!.type, "reference", "with the coerced type, not the sent one")
  assert.equal(fs.readdirSync(h.vault).length, 1, "and one file")
})

// The five shapes the model is known to send, plus one that nothing sends.
// Case and surrounding whitespace are a typing slip; "FACT" and "note" are
// the model agreeing with the description and disagreeing with the
// vocabulary; "banana" is the case the mapping exists for at all.
test("every type the model sends resolves to one of the three", () => {
  const cases: Array<[unknown, string, string | null]> = [
    ["FACT", "reference", "FACT"],
    ["note", "reference", "note"],
    ["Decision", "decision", null],
    [" reference ", "reference", null],
    ["banana", "reference", "banana"],
    // Not in the brief, but `required` does not stop the model omitting it,
    // and an absent type must not be a dead save either.
    [undefined, "reference", ""],
    [null, "reference", ""],
  ]

  for (const [sent, expected, given] of cases) {
    const resolved = coerceNoteType(sent)
    assert.equal(resolved.type, expected, `${JSON.stringify(sent)} -> ${expected}`)
    assert.equal(resolved.given, given, `${JSON.stringify(sent)} reported as ${given}`)
  }
})

// A value that only needed trimming or lower-casing was never a mistake, so
// saying so would be noise in a spoken reply.
test("a type that was merely mistyped is corrected silently", async (t) => {
  const h = makeNotebook()
  setNotebook(h.notebook)
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })

  const output = String(
    await withTurn({ userText: "write down that we picked Tavily" }, () =>
      saveNoteTool.execute({
        type: "Decision",
        title: "Tavily replaced Brave for search",
        summary: "Search goes through Tavily now.",
        sections: [{ heading: "Why", body: "Brave's result bodies were too short." }],
      })
    )
  )

  assert.match(output, /^Saved decision note/, "the value the model meant")
  assert.ok(!output.includes("'type' was"), "and nothing to read out about it")
})

test("save_note's type carries no enum, so the model can be told instead", () => {
  const schema = saveNoteTool.inputSchema as {
    properties: Record<string, Record<string, unknown>>
  }
  assert.equal(
    schema.properties.type!.enum,
    undefined,
    "an enum here is validated by Groq, and a rejection costs the whole turn"
  )
  assert.ok(
    String(schema.properties.type!.description).includes("decision"),
    "the three values still have to be stated somewhere the model reads"
  )
})

// ------------------------------------------------------------- the schema guard

// The one test that covers tools nobody has written yet. Every optional string
// argument in the whole registry has to accept null, because the cost of
// getting it wrong is not a bad answer, it is a turn that fails before Ixa is
// reached.
test("every optional string argument in the registry accepts null", () => {
  const offenders: string[] = []

  for (const tool of registry.list()) {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: unknown }>
      required?: string[]
    }
    const required = new Set(schema.required ?? [])
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (required.has(name)) continue
      const type = property.type
      if (type === "string") offenders.push(`${tool.name}.${name}`)
      else if (Array.isArray(type) && type.includes("string") && !type.includes("null")) {
        offenders.push(`${tool.name}.${name}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `optional string arguments must be typed ["string","null"]: ${offenders.join(", ")}`
  )
})
