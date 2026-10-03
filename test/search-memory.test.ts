import { test } from "node:test"
import assert from "node:assert/strict"
import "../src/tools/register"
import { registry } from "../src/tools/registry"
import { searchMemoryTool } from "../src/tools/search-memory"
import { setEpisodicMemory } from "../src/memory/episodic-memory"
import { makeMemory, type MemoryHarness } from "./memory-helpers"

// search_memory has two modes: by meaning (with a query, via the vector
// index) and by recency (without one, straight from SQLite).

const DAY = 24 * 60 * 60 * 1000

function harnessWithEpisodes(): MemoryHarness {
  const h = makeMemory()
  const now = Date.now()
  // Written out of chronological order on purpose: recency must come from
  // ended_at, not from insertion order.
  h.store.save({
    sessionId: "s-mid",
    startedAt: now - 2 * DAY,
    endedAt: now - 2 * DAY,
    summary: "Fixed the TTS sentence chunking.",
    tags: ["tts"],
  })
  h.store.save({
    sessionId: "s-old",
    startedAt: now - 9 * DAY,
    endedAt: now - 9 * DAY,
    summary: "Chose Qdrant for the vector index.",
    tags: ["qdrant"],
  })
  h.store.save({
    sessionId: "s-new",
    startedAt: now - 1000,
    endedAt: now - 1000,
    summary: "Planned the behaviour fixes after 3c.",
    tags: ["planning"],
  })
  setEpisodicMemory(h.memory)
  return h
}

function run(input: unknown): Promise<string> {
  return searchMemoryTool.execute(input) as Promise<string>
}

test("the tool declares no required arguments", () => {
  const schema = searchMemoryTool.inputSchema as { required?: string[] }
  assert.deepEqual(schema.required, [], "calling it with no query at all is valid")
  assert.equal(registry.get("search_memory")?.requiresConfirmation, false)
})

// ------------------------------------------------------------- with a query

test("with a query it searches the vector index", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))

  h.index.nextHits = [{ id: h.store.bySessionId("s-mid")!.id, score: 0.71 }]
  const result = await run({ query: "the TTS chunking work" })

  assert.equal(h.embedder.calls.length, 1, "the query was embedded")
  assert.equal(h.embedder.calls[0]!.kind, "query")
  assert.match(result, /matching that/)
  assert.match(result, /TTS sentence chunking/)
  assert.doesNotMatch(result, /Qdrant for the vector index/, "only the hit is returned")
})

test("with a query and no hits it says so", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  h.index.nextHits = []
  assert.match(await run({ query: "octoprint webhooks" }), /No past conversations match/)
})

test("with a query it reports unavailability rather than guessing", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  h.embedder.fail = new Error("ollama is down")

  const result = await run({ query: "anything" })
  assert.match(result, /unavailable/i)
  assert.match(result, /cannot search/i, "the model is told to say so, not to guess")
})

// ---------------------------------------------------------- without a query

test("with no query it returns the most recent episodes, newest first", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))

  const result = await run({})
  const order = ["behaviour fixes", "TTS sentence chunking", "Qdrant for the vector index"]
  let cursor = -1
  for (const fragment of order) {
    const at = result.indexOf(fragment)
    assert.ok(at > cursor, `"${fragment}" appears after the one before it`)
    cursor = at
  }
  assert.match(result, /most recent conversations, newest first/)
})

test("a blank query is treated as no query", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  h.index.nextHits = []

  for (const query of ["", "   "]) {
    const result = await run({ query })
    assert.match(result, /most recent/, `"${query}" fell through to recency`)
  }
  assert.equal(h.embedder.calls.length, 0, "an empty string is never embedded")
})

test("with no query it needs neither Ollama nor Qdrant", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  h.embedder.fail = new Error("ollama is down")
  h.index.fail = new Error("qdrant is down")

  const result = await run({})
  assert.match(result, /behaviour fixes/, "SQLite answered it on its own")
  assert.doesNotMatch(result, /unavailable/i)
})

test("with no query and nothing saved it says there are no conversations yet", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))
  assert.match(await run({}), /no saved conversations/i)
})

test("the recency list is capped by the configured search limit", async (t) => {
  const h = makeMemory({ limits: { searchLimit: 2 } })
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  for (let i = 0; i < 5; i++) {
    h.store.save({
      sessionId: `s-${i}`,
      startedAt: i,
      endedAt: i + 1,
      summary: `Conversation ${i}.`,
      tags: [],
    })
  }
  const result = await run({})
  assert.equal(result.split("\n").length, 3, "a header plus two episodes")
  assert.match(result, /Conversation 4/)
  assert.match(result, /Conversation 3/)
  assert.doesNotMatch(result, /Conversation 2/)
})

// ------------------------------------------------------------- date ranges

test("a date range narrows the recency list, inclusive of both whole days", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  // Local-time boundaries, matching how the tool parses from/to.
  const onFirst = new Date(2026, 0, 1, 0, 0, 0, 0).getTime()
  const lateOnThird = new Date(2026, 0, 3, 23, 30, 0, 0).getTime()
  const onFourth = new Date(2026, 0, 4, 9, 0, 0, 0).getTime()

  h.store.save({ sessionId: "a", startedAt: onFirst, endedAt: onFirst, summary: "First of Jan.", tags: [] })
  h.store.save({ sessionId: "b", startedAt: lateOnThird, endedAt: lateOnThird, summary: "Late on the third.", tags: [] })
  h.store.save({ sessionId: "c", startedAt: onFourth, endedAt: onFourth, summary: "Fourth of Jan.", tags: [] })

  const result = await run({ from: "2026-01-01", to: "2026-01-03" })
  assert.match(result, /First of Jan/, "the from bound includes the whole first day")
  assert.match(result, /Late on the third/, "the to bound includes the whole last day")
  assert.doesNotMatch(result, /Fourth of Jan/, "and stops there")
})

test("a date range with nothing in it is reported as such", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  assert.match(await run({ from: "1999-01-01", to: "1999-12-31" }), /in that date range/)
})

test("a date range is passed through to the index when there is a query", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  h.index.nextHits = []

  await run({ query: "anything", from: "2026-01-01", to: "2026-01-03" })
  const search = h.index.searches.at(-1)!
  assert.equal(search.from, new Date(2026, 0, 1).getTime(), "from is the local start of day")
  assert.equal(search.to, new Date(2026, 0, 3, 23, 59, 59, 999).getTime(), "to is the local end of day")
})

test("an unparseable date is ignored rather than failing the call", async (t) => {
  const h = harnessWithEpisodes()
  t.after(() => setEpisodicMemory(null))
  assert.match(await run({ from: "last Tuesday" }), /most recent/)
})

test("rendered dates are local time, not UTC", async (t) => {
  const h = makeMemory()
  setEpisodicMemory(h.memory)
  t.after(() => setEpisodicMemory(null))

  // 09:30 local, whatever the host's timezone is.
  const at = new Date(2026, 4, 7, 9, 30, 0, 0)
  h.store.save({ sessionId: "tz", startedAt: at.getTime(), endedAt: at.getTime(), summary: "Timezone check.", tags: [] })

  const result = await run({})
  assert.match(result, /09:30/, "the local wall-clock time is what the model sees")
  assert.match(result, /7 May 2026/)
})

test("memory that was never constructed is reported, not silently empty", async (t) => {
  setEpisodicMemory(null)
  t.after(() => setEpisodicMemory(null))
  assert.match(await run({}), /unavailable/i)
})
