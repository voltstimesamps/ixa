import { openDatabase } from "../src/memory/db"
import { EpisodeStore } from "../src/memory/episodes"
import { EpisodicMemory, type EpisodicMemoryLimits } from "../src/memory/episodic-memory"
import type { Embedder, EmbeddingKind } from "../src/memory/embeddings"
import type { SearchHit, SearchOptions, VectorIndex, VectorPoint } from "../src/memory/qdrant"
import type { ChatFn } from "../src/core/session"

export const MEMORY_LIMITS: EpisodicMemoryLimits = {
  recallTopK: 3,
  recallMinScore: 0.6,
  recallTimeoutMs: 300,
  recallMaxChars: 1500,
  minUserTurns: 2,
  summaryInputChars: 12000,
  indexRetryMs: 60_000,
  searchLimit: 5,
}

export class FakeEmbedder implements Embedder {
  readonly model = "fake-embed"
  readonly calls: Array<{ text: string; kind: EmbeddingKind }> = []
  fail: Error | null = null
  delayMs = 0

  async embed(text: string, kind: EmbeddingKind, signal?: AbortSignal): Promise<number[]> {
    this.calls.push({ text, kind })

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs)
        signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        })
      })
    }

    if (this.fail) throw this.fail
    return [1, 0, 0]
  }
}

// Stands in for Qdrant, including its score_threshold and limit semantics, so
// a test can prove that below-threshold hits never reach the model.
export class FakeIndex implements VectorIndex {
  readonly points = new Map<number, VectorPoint>()
  readonly searches: SearchOptions[] = []
  readonly deleted: number[] = []
  nextHits: SearchHit[] = []
  ensuredSize: number | null = null
  recreated = 0
  fail: Error | null = null

  async ensureCollection(vectorSize: number): Promise<void> {
    if (this.fail) throw this.fail
    this.ensuredSize = vectorSize
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (this.fail) throw this.fail
    for (const point of points) this.points.set(point.id, point)
  }

  async search(_vector: number[], options: SearchOptions): Promise<SearchHit[]> {
    if (this.fail) throw this.fail
    this.searches.push(options)
    return this.nextHits
      .filter((hit) => hit.score >= options.minScore)
      .slice(0, options.limit)
  }

  async deletePoints(ids: number[]): Promise<void> {
    if (this.fail) throw this.fail
    for (const id of ids) {
      this.deleted.push(id)
      this.points.delete(id)
    }
  }

  async recreate(vectorSize: number): Promise<void> {
    if (this.fail) throw this.fail
    this.points.clear()
    this.recreated++
    this.ensuredSize = vectorSize
  }

  async health(): Promise<boolean> {
    return this.fail === null
  }
}

// A summarizer stand-in: replies with well-formed JSON built from the turn.
export function summarizingChat(summary = "They discussed the TTS chunking fix.", tags = ["tts"]): ChatFn {
  return async () => ({ type: "text", content: JSON.stringify({ summary, tags }) })
}

export interface MemoryHarness {
  memory: EpisodicMemory
  store: EpisodeStore
  embedder: FakeEmbedder
  index: FakeIndex
}

export function makeMemory(
  options: { chat?: ChatFn; limits?: Partial<EpisodicMemoryLimits> } = {}
): MemoryHarness {
  const store = new EpisodeStore(openDatabase(":memory:"))
  const embedder = new FakeEmbedder()
  const index = new FakeIndex()
  const memory = new EpisodicMemory({
    store,
    embedder,
    index,
    chat: options.chat ?? summarizingChat(),
    limits: { ...MEMORY_LIMITS, ...options.limits },
  })
  return { memory, store, embedder, index }
}

// Captures console.warn/log for assertions about log-once behaviour.
export async function captureLogs<T>(
  run: () => Promise<T>
): Promise<{ result: T; warnings: string[]; logs: string[] }> {
  const warnings: string[] = []
  const logs: string[] = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
  console.log = (...args: unknown[]) => logs.push(args.join(" "))
  try {
    const result = await run()
    return { result, warnings, logs }
  } finally {
    console.warn = originalWarn
    console.log = originalLog
  }
}
