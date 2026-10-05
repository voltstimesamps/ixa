import { config } from "../config"
import { chat as defaultChat } from "../core/llm"
import type { ChatFn, Session } from "../core/session"
import type { SessionEndReason } from "../core/session-manager"
import type { Embedder } from "./embeddings"
import { formatEpisodeWhen, type Episode, type EpisodeStore } from "./episodes"
import type { VectorIndex } from "./qdrant"
import { countUserTurns, summarizeSession } from "./summarizer"

// Episodic memory: the write path (a session ends → summarize → store → index)
// and the read path (a user turn starts → recall related episodes).
//
// Two rules shape everything here:
//
//   1. SQLite is the source of truth. The episode row is written BEFORE any
//      embedding is attempted, so a Qdrant or Ollama outage costs an index
//      entry, never a memory. Unindexed rows are the backlog and are retried.
//   2. Memory is never allowed to break or slow a conversation. Summarization
//      runs detached from the session-end path, recall runs under a hard
//      timeout, and every failure degrades to "no recall this turn".

export interface EpisodicMemoryLimits {
  recallTopK: number
  recallMinScore: number
  recallTimeoutMs: number
  recallMaxChars: number
  minUserTurns: number
  summaryInputChars: number
  indexRetryMs: number
  searchLimit: number
}

export interface EpisodicMemoryOptions {
  store: EpisodeStore
  embedder: Embedder
  index: VectorIndex
  chat?: ChatFn
  limits?: EpisodicMemoryLimits
}

export interface SearchRange {
  from?: number
  to?: number
}

export type SearchResult =
  | { available: true; episodes: Episode[] }
  | { available: false; reason: string }

const RECALL_HEADER =
  "Notes from earlier conversations that may be relevant. Use them only if they actually bear " +
  "on what the user is asking now, and do not mention them otherwise."

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export class EpisodicMemory {
  private readonly store: EpisodeStore
  private readonly embedder: Embedder
  private readonly index: VectorIndex
  private readonly chat: ChatFn
  private readonly limits: EpisodicMemoryLimits

  // Degradation state. One warning when memory goes away, one line when it
  // comes back — never a warning per turn.
  private available = true
  private lastDownReason: string | null = null
  private sweepTimer: NodeJS.Timeout | null = null

  // Summarizations in flight, so a shutdown or a test can wait for them.
  private readonly pending = new Set<Promise<unknown>>()

  constructor(options: EpisodicMemoryOptions) {
    this.store = options.store
    this.embedder = options.embedder
    this.index = options.index
    this.chat = options.chat ?? defaultChat
    this.limits = options.limits ?? config.memory
  }

  // ---------------------------------------------------------------- health

  private markDown(reason: string): void {
    if (this.available) {
      this.available = false
      console.warn(
        `memory: episodic recall is unavailable (${reason}). Ixa will keep working without it; ` +
          `episodes are still saved and will be indexed when it returns.`
      )
    }
    this.lastDownReason = reason
  }

  private markUp(): void {
    if (!this.available) {
      this.available = true
      this.lastDownReason = null
      console.log("memory: episodic recall is available again")
    }
  }

  get isAvailable(): boolean {
    return this.available
  }

  // ----------------------------------------------------------- write path

  // The onSessionEnd handler. Returns immediately: summarization is an LLM
  // call, and nothing about ending a session may wait on it.
  handleSessionEnd(session: Session, reason: SessionEndReason): void {
    if (reason === "shutdown") {
      // A summary takes seconds and shutdown gives us under a second. The
      // session row stays live in SQLite, so the next startup either restores
      // it (the conversation continues) or expires it, which ends it with
      // reason "timeout" and summarizes it then. Nothing is lost by waiting.
      console.log(`memory: not summarizing ${session.id} on shutdown; it will be summarized later`)
      return
    }

    const userTurns = countUserTurns(session.history())
    if (userTurns < this.limits.minUserTurns) {
      console.log(
        `memory: skipping episode for ${session.id} — ${userTurns} user turn(s), ` +
          `minimum is ${this.limits.minUserTurns}`
      )
      return
    }

    this.track(
      this.summarizeAndStore(session).catch((err) => {
        console.error(
          `memory: failed to write an episode for ${session.id}:`,
          err instanceof Error ? err.message : String(err)
        )
      })
    )
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise))
  }

  // Lets tests and scripts wait for detached summarization to settle.
  async waitForPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  async summarizeAndStore(session: Session): Promise<Episode> {
    const { summary, tags } = await summarizeSession(session.history(), this.chat, {
      inputChars: this.limits.summaryInputChars,
    })

    // SQLite first, always. Indexing is best effort from here on.
    const episode = this.store.save({
      sessionId: session.id,
      startedAt: session.createdAt,
      endedAt: session.endedAt ?? Date.now(),
      summary,
      tags,
    })
    console.log(`memory: episode #${episode.id} saved for session ${session.id} [${tags.join(", ")}]`)

    await this.indexEpisode(episode)
    return episode
  }

  // Embeds and upserts one episode. Returns false (without throwing) when the
  // services are down: the row stays unindexed and the sweep retries it.
  async indexEpisode(episode: Episode): Promise<boolean> {
    try {
      const vector = await this.embedder.embed(episode.summary, "document")
      await this.index.upsert([
        {
          id: episode.id,
          vector,
          payload: {
            episodeId: episode.id,
            sessionId: episode.sessionId,
            startedAt: episode.startedAt,
            endedAt: episode.endedAt,
            tags: episode.tags,
          },
        },
      ])
      this.store.markIndexed(episode.id, this.embedder.model)
      this.markUp()
      return true
    } catch (err) {
      // Only on the way down. During a sustained outage the sweep retries
      // every few minutes, and one line per episode per retry would bury the
      // single warning that actually matters.
      const wasAvailable = this.available
      this.markDown(err instanceof Error ? err.message : String(err))
      if (wasAvailable) {
        console.warn(`memory: episode #${episode.id} saved but not indexed; queued for retry`)
      }
      return false
    }
  }

  // Indexes everything still marked unindexed. Runs at startup and on a timer.
  async indexBacklog(): Promise<number> {
    const backlog = this.store.notIndexed()
    if (backlog.length === 0) return 0

    let indexed = 0
    for (const episode of backlog) {
      const ok = await this.indexEpisode(episode)
      if (!ok) break // Still down; leave the rest for the next sweep.
      indexed++
    }

    if (indexed > 0) {
      console.log(`memory: indexed ${indexed} backlogged episode(s)`)
    }
    return indexed
  }

  startBacklogSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      void this.indexBacklog().catch(() => undefined)
    }, this.limits.indexRetryMs)
    // A retry timer must not be the reason the process stays alive.
    this.sweepTimer.unref?.()
  }

  stopBacklogSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  // Startup: probe, warm the embedding model so the first real turn does not
  // pay the model load, and drain anything left unindexed.
  async start(): Promise<void> {
    const backlog = this.store.countNotIndexed()
    try {
      const vector = await this.embedder.embed("warm up", "query")
      await this.index.ensureCollection(vector.length)
      this.markUp()
      console.log(
        `memory: ready — ${this.store.count()} episode(s), ${backlog} awaiting indexing`
      )
    } catch (err) {
      this.markDown(err instanceof Error ? err.message : String(err))
    }

    await this.indexBacklog().catch(() => undefined)
    this.startBacklogSweep()
  }

  // ------------------------------------------------------------ read path

  // Called once per user turn, before the first LLM call. Returns the block to
  // inject, or null for "nothing to add" — including every failure case.
  async recall(text: string): Promise<string | null> {
    const query = text.trim()
    if (!query) return null

    const startedAt = Date.now()
    // One budget for the whole thing: embedding plus search plus hydration.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.limits.recallTimeoutMs)

    try {
      const vector = await this.embedder.embed(query, "query", controller.signal)
      const hits = await this.index.search(vector, {
        limit: this.limits.recallTopK,
        minScore: this.limits.recallMinScore,
        signal: controller.signal,
      })
      this.markUp()

      if (hits.length === 0) {
        console.log(`memory: no episode above ${this.limits.recallMinScore} (${Date.now() - startedAt}ms)`)
        return null
      }

      const episodes = this.hydrate(hits)
      if (episodes.length === 0) return null

      const block = this.renderRecallBlock(episodes)
      if (!block) return null
      console.log(
        `memory: recalled ${episodes.length} episode(s) in ${Date.now() - startedAt}ms ` +
          `(top score ${hits[0]!.score.toFixed(3)})`
      )
      return block
    } catch (err) {
      if (controller.signal.aborted) {
        // Not a failure of memory, a failure to be fast enough. Never let it
        // hold up a voice reply.
        console.warn(
          `memory: recall skipped — over the ${this.limits.recallTimeoutMs}ms budget`
        )
        return null
      }
      this.markDown(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // Resolves hits against SQLite, in score order. A hit whose row no longer
  // exists is dropped AND its point is deleted: that is what guarantees a
  // forgotten episode can never come back through a stale vector.
  private hydrate(hits: Array<{ id: number; score: number }>): Episode[] {
    const found = new Map(this.store.byIds(hits.map((hit) => hit.id)).map((e) => [e.id, e]))

    const orphans = hits.filter((hit) => !found.has(hit.id)).map((hit) => hit.id)
    if (orphans.length > 0) {
      console.warn(`memory: dropping ${orphans.length} vector(s) with no episode row`)
      void this.index.deletePoints(orphans).catch(() => undefined)
    }

    return hits
      .map((hit) => found.get(hit.id))
      .filter((episode): episode is Episode => episode !== undefined)
  }

  // Dated so the model can say "last Tuesday" instead of "previously".
  private renderRecallBlock(episodes: Episode[]): string {
    const lines: string[] = []
    let chars = RECALL_HEADER.length

    for (const episode of episodes) {
      const tags = episode.tags.length > 0 ? ` [${episode.tags.join(", ")}]` : ""
      const line = `- ${formatDate(episode.endedAt)}: ${episode.summary}${tags}`
      if (chars + line.length + 1 > this.limits.recallMaxChars) break
      lines.push(line)
      chars += line.length + 1
    }

    if (lines.length === 0) {
      console.warn(
        `memory: recall skipped — ${this.limits.recallMaxChars} char cap is too small for even ` +
          `one episode summary`
      )
      return ""
    }
    if (lines.length < episodes.length) {
      console.warn(
        `memory: recall block capped at ${this.limits.recallMaxChars} chars — ` +
          `injected ${lines.length} of ${episodes.length}`
      )
    }
    return [RECALL_HEADER, ...lines].join("\n")
  }

  // One line naming the most recent conversation, injected into every LLM
  // call. Null when there are no episodes yet.
  //
  // Why this exists at all: recall matches on MEANING, and "what did we talk
  // about last time?" has no subject in it, so it embeds to a vector near
  // nothing and falls under the score threshold. Nothing was injected, and the
  // only memory-shaped text left in context was the preference block — so that
  // is what the model answered from. Having search_memory answer recency
  // (Phase 3c) was necessary but not sufficient: the model has to know there
  // is something to look up before it will go looking.
  //
  // Deliberately the date, the time and the tags and nothing else: enough to
  // recognise a question about recency as answerable, and small enough to
  // afford on every call. The summary is not inlined and the tool is not
  // explained here — SYSTEM_PROMPT already says past conversations can be
  // searched, search_memory's own description says a question about recency
  // needs it with no query, and the preference block's header says not to
  // answer from preferences. Repeating all of that per call cost 160 tokens to
  // say what three other places already said.
  //
  // Straight SQLite, like recent() — no embedding, no network, no timeout
  // budget, so the one memory fact in every request survives Qdrant and Ollama
  // both being down.
  lastEpisodeLine(): string | null {
    const [latest] = this.store.recent(1)
    if (!latest) return null

    const tags = latest.tags.length > 0 ? ` [${latest.tags.join(", ")}]` : ""
    return `Your most recent conversation with the user ended ${formatEpisodeWhen(latest.endedAt)}${tags}.`
  }

  // The no-query half of search_memory: the N most recent episodes, newest
  // first, within an optional date range.
  //
  // Always `available: true`. It reads SQLite, the source of truth, so a
  // question about recent conversations is answerable with Qdrant and Ollama
  // both down — the one memory question that never needs an embedding.
  recent(range: SearchRange = {}): SearchResult {
    return {
      available: true,
      episodes: this.store.recent(this.limits.searchLimit, range),
    }
  }

  // The search_memory tool. Unlike recall, this one reports its own failure:
  // the user asked a direct question and deserves a straight answer.
  async search(query: string, range: SearchRange = {}): Promise<SearchResult> {
    try {
      const vector = await this.embedder.embed(query, "query")
      const hits = await this.index.search(vector, {
        limit: this.limits.searchLimit,
        minScore: this.limits.recallMinScore,
        from: range.from,
        to: range.to,
      })
      this.markUp()
      return { available: true, episodes: this.hydrate(hits) }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.markDown(reason)
      return { available: false, reason }
    }
  }
}

let shared: EpisodicMemory | null = null

export function getEpisodicMemory(): EpisodicMemory | null {
  return shared
}

export function setEpisodicMemory(memory: EpisodicMemory | null): void {
  shared = memory
}
