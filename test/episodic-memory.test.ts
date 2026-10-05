import { test } from "node:test"
import assert from "node:assert/strict"
import { LATEST_SCHEMA_VERSION, openDatabase, schemaVersion } from "../src/memory/db"
import { EpisodeStore } from "../src/memory/episodes"
import { SessionManager } from "../src/core/session-manager"
import type { ChatFn, Session } from "../src/core/session"
import { makeConnection, TEST_LIMITS } from "./helpers"
import { captureLogs, makeMemory, summarizingChat } from "./memory-helpers"

const echoChat: ChatFn = async (messages) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  return { type: "text", content: `heard: ${String(lastUser?.content ?? "")}` }
}

// Builds a real ended Session with `turns` user messages.
async function endedSession(turns: number): Promise<Session> {
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat: echoChat })
  const connection = makeConnection({ id: "conn-episode" })
  for (let i = 0; i < turns; i++) {
    await sessions.submitTurn(`turn ${i}`, connection, "text")
  }
  const session = sessions.primarySession()
  sessions.endSession(session.id, "timeout")
  sessions.shutdown()
  return session
}

// ------------------------------------------------------------- migration 2

test("migration 2 adds the episodes table to an existing v1 database", (t) => {
  const file = `/tmp/ixa-migration-${process.pid}-${Date.now()}.db`
  t.after(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        require("node:fs").rmSync(`${file}${suffix}`, { force: true })
      } catch {
        // best effort
      }
    }
  })

  const db = openDatabase(file)
  const store = new EpisodeStore(db)
  store.save({ sessionId: "s1", startedAt: 1, endedAt: 2, summary: "kept", tags: [] })

  // Rewind to v1, as if the database predates this phase.
  db.exec("DROP TABLE episodes; DELETE FROM schema_version WHERE version = 2;")
  assert.equal(schemaVersion(db), 1)
  db.close()

  const upgraded = openDatabase(file)
  assert.equal(schemaVersion(upgraded), LATEST_SCHEMA_VERSION)
  assert.ok(
    upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'preferences'").get(),
    "migration 2 is additive — earlier tables survive",
  )
  assert.equal(new EpisodeStore(upgraded).count(), 0, "the dropped table starts empty")
})

test("episodes are keyed one per session", () => {
  const { store } = makeMemory()
  const first = store.save({ sessionId: "s1", startedAt: 1, endedAt: 2, summary: "a", tags: ["x"] })
  store.markIndexed(first.id, "fake-embed")

  const second = store.save({ sessionId: "s1", startedAt: 1, endedAt: 9, summary: "b", tags: [] })
  assert.equal(second.id, first.id, "a rewrite replaces rather than duplicates")
  assert.equal(store.count(), 1)
  assert.equal(second.indexedAt, null, "and goes back into the backlog, since the text changed")
})

// ------------------------------------------------------------- write path

test("the episode is saved to SQLite before it is indexed", async () => {
  const { memory, store, index } = makeMemory()
  index.fail = new Error("qdrant is down")
  const session = await endedSession(2)

  const { warnings } = await captureLogs(async () => {
    await memory.summarizeAndStore(session)
  })

  assert.equal(store.count(), 1, "the episode exists despite the index failing")
  const episode = store.all()[0]!
  assert.equal(episode.indexedAt, null, "marked not indexed")
  assert.equal(episode.embeddingModel, null)
  assert.equal(episode.summary, "They discussed the TTS chunking fix.")
  assert.deepEqual(episode.tags, ["tts"])
  assert.ok(warnings.some((w) => w.includes("not indexed")))
})

test("a successful write indexes the episode and records the model", async () => {
  const { memory, store, index, embedder } = makeMemory()
  const session = await endedSession(2)

  await captureLogs(async () => memory.summarizeAndStore(session))

  const episode = store.all()[0]!
  assert.notEqual(episode.indexedAt, null)
  assert.equal(episode.embeddingModel, "fake-embed")
  assert.equal(index.points.size, 1)

  const point = index.points.get(episode.id)!
  assert.equal(point.payload.episodeId, episode.id)
  assert.equal(point.payload.sessionId, session.id)
  assert.equal(point.payload.endedAt, episode.endedAt)
  assert.deepEqual(point.payload.tags, ["tts"])
  assert.equal(
    embedder.calls.at(-1)!.kind,
    "document",
    "stored summaries embed as documents, not queries",
  )
})

test("the backlog is drained once the index comes back", async () => {
  const { memory, store, index } = makeMemory()
  index.fail = new Error("qdrant is down")
  await captureLogs(async () => memory.summarizeAndStore(await endedSession(2)))
  assert.equal(store.countNotIndexed(), 1)

  index.fail = null
  const { result, logs } = await captureLogs(async () => memory.indexBacklog())

  assert.equal(result, 1)
  assert.equal(store.countNotIndexed(), 0)
  assert.equal(index.points.size, 1)
  assert.ok(logs.some((l) => l.includes("indexed 1 backlogged")))
})

test("a still-down index leaves the backlog alone", async () => {
  const { memory, store, index } = makeMemory()
  index.fail = new Error("qdrant is down")
  await captureLogs(async () => memory.summarizeAndStore(await endedSession(2)))

  const { result } = await captureLogs(async () => memory.indexBacklog())
  assert.equal(result, 0)
  assert.equal(store.countNotIndexed(), 1, "still queued for the next sweep")
})

test("a trivial session is skipped and logged", async () => {
  const { memory, store } = makeMemory()
  const session = await endedSession(1)

  const { logs } = await captureLogs(async () => {
    memory.handleSessionEnd(session, "timeout")
    await memory.waitForPending()
  })

  assert.equal(store.count(), 0, "no episode written")
  assert.ok(logs.some((l) => l.includes("1 user turn(s)") && l.includes("skipping episode")))
})

test("a session with enough turns is summarized from the end hook", async () => {
  const { memory, store } = makeMemory()
  const session = await endedSession(2)

  await captureLogs(async () => {
    memory.handleSessionEnd(session, "timeout")
    await memory.waitForPending()
  })

  assert.equal(store.count(), 1)
  assert.equal(store.all()[0]!.sessionId, session.id)
})

test("shutdown does not summarize, and says why", async () => {
  const { memory, store } = makeMemory()
  const session = await endedSession(3)

  const { logs } = await captureLogs(async () => {
    memory.handleSessionEnd(session, "shutdown")
    await memory.waitForPending()
  })

  assert.equal(store.count(), 0)
  assert.ok(logs.some((l) => l.includes("not summarizing") && l.includes("shutdown")))
})

test("a failing summarizer never throws out of the end hook", async () => {
  const failingChat: ChatFn = async () => {
    throw new Error("groq exploded")
  }
  const { memory, store } = makeMemory({ chat: failingChat })
  const session = await endedSession(2)

  const { logs } = await captureLogs(async () => {
    // The assertion is that this does not reject or throw.
    memory.handleSessionEnd(session, "timeout")
    await memory.waitForPending()
  })

  assert.equal(store.count(), 0)
  assert.ok(logs.length >= 0)
})

// -------------------------------------------------------------- read path

async function seedEpisode(
  harness: ReturnType<typeof makeMemory>,
  summary: string,
  tags: string[] = [],
  endedAt = Date.now(),
) {
  const episode = harness.store.save({
    sessionId: `s-${summary.slice(0, 8)}-${Math.random()}`,
    startedAt: endedAt - 1000,
    endedAt,
    summary,
    tags,
  })
  await harness.memory.indexEpisode(episode)
  return episode
}

test("recall injects matching episodes with their date", async () => {
  const harness = makeMemory()
  const when = new Date("2026-09-29T18:00:00Z").getTime()
  const episode = await seedEpisode(harness, "Fixed the TTS chunking.", ["tts"], when)
  harness.index.nextHits = [{ id: episode.id, score: 0.81 }]

  const { result } = await captureLogs(async () => harness.memory.recall("why is TTS slow?"))

  assert.ok(result)
  assert.match(result!, /Notes from earlier conversations/)
  assert.match(result!, /Fixed the TTS chunking\./)
  assert.match(result!, /Sept 2026/, "the date is included so the model can say when")
  assert.match(result!, /\[tts\]/)
  assert.equal(harness.embedder.calls.at(-1)!.kind, "query", "the user's text embeds as a query")
})

test("recall passes the configured K and threshold to the index", async () => {
  const harness = makeMemory({ limits: { recallTopK: 7, recallMinScore: 0.42 } })
  await seedEpisode(harness, "something")
  await captureLogs(async () => harness.memory.recall("anything"))

  const search = harness.index.searches.at(-1)!
  assert.equal(search.limit, 7)
  assert.equal(search.minScore, 0.42)
})

test("an episode below the threshold is never injected", async () => {
  const harness = makeMemory({ limits: { recallMinScore: 0.6 } })
  const episode = await seedEpisode(harness, "Talked about dinner.")
  harness.index.nextHits = [{ id: episode.id, score: 0.54 }]

  const { result, logs } = await captureLogs(async () => harness.memory.recall("unrelated question"))

  assert.equal(result, null)
  assert.ok(logs.some((l) => l.includes("no episode above 0.6")))
})

test("recall is capped by characters, keeping whole episodes", async () => {
  // The header is ~150 chars, each episode line ~145: room for exactly one.
  const harness = makeMemory({ limits: { recallMaxChars: 320 } })
  const a = await seedEpisode(harness, `A: ${"x".repeat(120)}`)
  const b = await seedEpisode(harness, `B: ${"y".repeat(120)}`)
  const c = await seedEpisode(harness, `C: ${"z".repeat(120)}`)
  harness.index.nextHits = [
    { id: a.id, score: 0.9 },
    { id: b.id, score: 0.8 },
    { id: c.id, score: 0.7 },
  ]

  const { result, warnings } = await captureLogs(async () => harness.memory.recall("q"))

  assert.ok(result)
  assert.ok(result!.length <= 320, `block is ${result!.length} chars`)
  assert.match(result!, /A: x/)
  assert.doesNotMatch(result!, /C: z/, "the lowest-scoring episode is the one dropped")
  assert.ok(warnings.some((w) => w.includes("capped at 320 chars")))
})

test("a cap too small for one episode yields nothing, not an empty block", async () => {
  const harness = makeMemory({ limits: { recallMaxChars: 40 } })
  const episode = await seedEpisode(harness, "A reasonably long episode summary goes here.")
  harness.index.nextHits = [{ id: episode.id, score: 0.9 }]

  const { result, warnings } = await captureLogs(async () => harness.memory.recall("q"))

  assert.equal(result, null, "null, so no empty system message is injected")
  assert.ok(warnings.some((w) => w.includes("too small")))
})

test("recall over the latency budget is skipped, not waited on", async () => {
  const harness = makeMemory({ limits: { recallTimeoutMs: 20 } })
  const episode = await seedEpisode(harness, "Fixed the TTS chunking.")
  harness.index.nextHits = [{ id: episode.id, score: 0.9 }]
  harness.embedder.delayMs = 200

  const startedAt = Date.now()
  const { result, warnings } = await captureLogs(async () => harness.memory.recall("why so slow?"))
  const elapsed = Date.now() - startedAt

  assert.equal(result, null, "the turn proceeds with no recall")
  assert.ok(elapsed < 150, `gave up after ${elapsed}ms rather than waiting 200ms`)
  assert.ok(warnings.some((w) => w.includes("over the 20ms budget")))
})

test("a vector whose episode was deleted is dropped and cleaned up", async () => {
  const harness = makeMemory()
  const kept = await seedEpisode(harness, "Kept episode.")
  const forgotten = await seedEpisode(harness, "Forgotten episode.")

  // Exactly what dev/scripts/forget-episode.ts does when Qdrant is unreachable:
  // the row goes, the point survives.
  harness.store.delete(forgotten.id)
  harness.index.nextHits = [
    { id: forgotten.id, score: 0.95 },
    { id: kept.id, score: 0.7 },
  ]

  const { result, warnings } = await captureLogs(async () => harness.memory.recall("q"))

  assert.ok(result)
  assert.doesNotMatch(result!, /Forgotten/, "a deleted episode can never come back")
  assert.match(result!, /Kept episode\./)
  assert.ok(harness.index.deleted.includes(forgotten.id), "and the stale vector is deleted")
  assert.ok(warnings.some((w) => w.includes("no episode row")))
})

// ------------------------------------------------------------ degradation

test("recall degrades to nothing and warns exactly once", async () => {
  const harness = makeMemory()
  harness.embedder.fail = new Error("ollama is down")

  const { warnings } = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) await harness.memory.recall("question")
  })

  assert.equal(harness.memory.isAvailable, false)
  assert.equal(
    warnings.filter((w) => w.includes("episodic recall is unavailable")).length,
    1,
    "one warning for the outage, not one per turn",
  )
})

test("recovery is logged once, after which recall works again", async () => {
  const harness = makeMemory()
  const episode = await seedEpisode(harness, "Fixed the TTS chunking.")
  harness.index.nextHits = [{ id: episode.id, score: 0.9 }]

  harness.embedder.fail = new Error("ollama is down")
  await captureLogs(async () => harness.memory.recall("q"))
  assert.equal(harness.memory.isAvailable, false)

  harness.embedder.fail = null
  const { result, logs } = await captureLogs(async () => harness.memory.recall("q"))

  assert.ok(result)
  assert.equal(harness.memory.isAvailable, true)
  assert.equal(logs.filter((l) => l.includes("available again")).length, 1)
})

test("search_memory reports unavailability instead of pretending", async () => {
  const harness = makeMemory()
  harness.index.fail = new Error("qdrant is down")

  const { result } = await captureLogs(async () => harness.memory.search("tts"))
  assert.equal(result.available, false)
})

test("search passes an inclusive date range through to the index", async () => {
  const harness = makeMemory()
  const episode = await seedEpisode(harness, "Fixed the TTS chunking.")
  harness.index.nextHits = [{ id: episode.id, score: 0.9 }]

  const { result } = await captureLogs(async () =>
    harness.memory.search("tts", { from: 1000, to: 2000 }),
  )

  assert.equal(result.available, true)
  assert.equal(harness.index.searches.at(-1)!.from, 1000)
  assert.equal(harness.index.searches.at(-1)!.to, 2000)
  assert.equal(result.available && result.episodes[0]!.id, episode.id)
})

test("startup sizes the collection from the model and drains the backlog", async () => {
  const harness = makeMemory()
  harness.index.fail = new Error("qdrant is down")
  await captureLogs(async () => harness.memory.summarizeAndStore(await endedSession(2)))
  assert.equal(harness.store.countNotIndexed(), 1)

  harness.index.fail = null
  await captureLogs(async () => harness.memory.start())
  harness.memory.stopBacklogSweep()

  assert.equal(harness.index.ensuredSize, 3, "collection sized from a real embedding")
  assert.equal(harness.store.countNotIndexed(), 0, "backlog drained at startup")
})

test("startup with everything down warns once and does not throw", async () => {
  const harness = makeMemory()
  harness.embedder.fail = new Error("ollama is down")
  harness.index.fail = new Error("qdrant is down")

  const { warnings } = await captureLogs(async () => harness.memory.start())
  harness.memory.stopBacklogSweep()

  assert.equal(
    warnings.filter((w) => w.includes("episodic recall is unavailable")).length,
    1,
  )
  assert.equal(harness.memory.isAvailable, false)
})

test("an empty or whitespace message never hits the services", async () => {
  const harness = makeMemory()
  assert.equal(await harness.memory.recall("   "), null)
  assert.equal(harness.embedder.calls.length, 0)
})

test("the summarizer is called with no tools and silently", async () => {
  let sawTools: unknown = "unset"
  let sawSilent: unknown = "unset"
  const chat: ChatFn = async (_messages, tools, options) => {
    sawTools = tools
    sawSilent = options?.silent
    return { type: "text", content: JSON.stringify({ summary: "s", tags: [] }) }
  }
  const harness = makeMemory({ chat })
  await captureLogs(async () => harness.memory.summarizeAndStore(await endedSession(2)))

  assert.deepEqual(sawTools, [], "background work must not call tools")
  assert.equal(sawSilent, true, "and must not print to the REPL")
})

test("summarizingChat wiring produces the tags that reach the payload", async () => {
  const harness = makeMemory({ chat: summarizingChat("Decided on oat milk.", ["food", "coffee"]) })
  await captureLogs(async () => harness.memory.summarizeAndStore(await endedSession(2)))

  const episode = harness.store.all()[0]!
  assert.deepEqual(episode.tags, ["food", "coffee"])
  assert.deepEqual(harness.index.points.get(episode.id)!.payload.tags, ["food", "coffee"])
})

// ------------------------------------------------------- the recency line

test("lastEpisodeLine names the most recent episode, with its tags", () => {
  const { memory, store } = makeMemory()
  const endedAt = new Date(2026, 9, 4, 16, 25).getTime()
  store.save({
    sessionId: "s-old",
    startedAt: endedAt - 7_200_000,
    endedAt: endedAt - 3_600_000,
    summary: "An older conversation.",
    tags: ["3d-printing"],
  })
  store.save({
    sessionId: "s-new",
    startedAt: endedAt - 600_000,
    endedAt,
    summary: "GPU options for a budget build.",
    tags: ["gpu", "budget"],
  })

  const line = memory.lastEpisodeLine()!

  assert.match(line, /most recent conversation/)
  assert.match(line, /Sun, 4 Oct 2026, 16:25/)
  assert.match(line, /\[gpu, budget\]/)
  assert.ok(!line.includes("3d-printing"), "only the newest episode is named")
  // The summary is deliberately left out: the line exists to make the model
  // reach for search_memory, not to replace it.
  assert.ok(!line.includes("GPU options for a budget build"), "the summary is not inlined")
  // Date, time and tags and nothing else. SYSTEM_PROMPT, the search_memory
  // description and the preference header already carry the instructions this
  // line used to repeat on every call.
  assert.ok(line.length <= 130, `${line.length} chars`)
})

test("lastEpisodeLine is null when there are no episodes", () => {
  const { memory } = makeMemory()
  assert.equal(memory.lastEpisodeLine(), null)
})

test("lastEpisodeLine omits the tag clause when an episode has no tags", () => {
  const { memory, store } = makeMemory()
  store.save({
    sessionId: "s-untagged",
    startedAt: Date.now() - 600_000,
    endedAt: Date.now(),
    summary: "Something.",
    tags: [],
  })

  const line = memory.lastEpisodeLine()!
  assert.ok(!line.includes("["), "no empty tag list")
  assert.match(line, /most recent conversation/)
})

// Recency is the one memory question that must survive an outage, because it
// reads the source of truth rather than the index over it.
test("lastEpisodeLine works with the embedder and index both down", () => {
  const { memory, store, embedder, index } = makeMemory()
  embedder.fail = new Error("ollama is down")
  index.fail = new Error("qdrant is down")
  store.save({
    sessionId: "s-degraded",
    startedAt: Date.now() - 600_000,
    endedAt: Date.now(),
    summary: "Something.",
    tags: ["tts"],
  })

  assert.match(memory.lastEpisodeLine()!, /most recent conversation/)
})
