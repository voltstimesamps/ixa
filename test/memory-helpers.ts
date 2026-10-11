import fs from "fs"
import os from "os"
import path from "path"
import { openDatabase } from "../src/memory/db"
import { NoteStore } from "../src/memory/notes"
import { Notebook, type NotebookLimits } from "../src/memory/notebook"
import { runWithSessionControl } from "../src/core/session-context"
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
      // minScore is OPTIONAL, and undefined means no floor at all — the notes
      // path passes none, deliberately. Treating undefined as 0 here would
      // hide a caller that forgot to pass one.
      .filter((hit) => options.minScore === undefined || hit.score >= options.minScore)
      // Payload filters, the way Qdrant applies them: a `must` clause of
      // { key, match: { value } } against the stored point's payload. Modelled
      // rather than ignored so a test can prove a superseded note is excluded
      // by the index and not merely by the code that reads the results.
      .filter((hit) => {
        if (!options.filter) return true
        const payload = this.points.get(hit.id)?.payload
        return options.filter.every((clause) => {
          const key = clause.key as string | undefined
          const match = clause.match as { value?: unknown } | undefined
          if (!key || !match || !("value" in match)) return true
          return payload?.[key] === match.value
        })
      })
      .slice(0, options.limit)
      .map((hit) => {
        if (!options.withPayload) return hit
        const payload = this.points.get(hit.id)?.payload
        return payload ? { ...hit, payload } : hit
      })
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

// ------------------------------------------------------------- the notebook

export const NOTEBOOK_LIMITS: NotebookLimits = {
  searchLimit: 3,
  searchTimeoutMs: 300,
  minTokens: 150,
  maxTokens: 400,
}

export interface NotebookHarness {
  notebook: Notebook
  store: NoteStore
  embedder: FakeEmbedder
  index: FakeIndex
  // A throwaway vault directory. Every note test writes real files, because
  // the whole point of the write path is that the file is the source of truth.
  vault: string
  cleanup(): void
}

export function makeNotebook(
  options: { limits?: Partial<NotebookLimits> } = {}
): NotebookHarness {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "ixa-vault-test-"))
  const store = new NoteStore(openDatabase(":memory:"))
  const embedder = new FakeEmbedder()
  const index = new FakeIndex()
  const notebook = new Notebook({
    store,
    embedder,
    index,
    vaultPath: vault,
    limits: { ...NOTEBOOK_LIMITS, ...options.limits },
  })
  return {
    notebook,
    store,
    embedder,
    index,
    vault,
    cleanup: () => {
      notebook.stopBacklogSweep()
      fs.rmSync(vault, { recursive: true, force: true })
    },
  }
}

// save_note reads provenance and the price evidence off the turn, so a test
// that calls the tool has to supply one. Fails closed without it, which is
// itself asserted.
export function withTurn<T>(
  evidence: { userText?: string; searchResults?: string[]; source?: "voice" | "text"; sessionId?: string },
  run: () => T
): T {
  return runWithSessionControl(
    {
      requestNewConversation: () => {},
      evidence: {
        userText: evidence.userText ?? "",
        source: evidence.source ?? "text",
        sessionId: evidence.sessionId ?? "test-session",
        searchResults: evidence.searchResults ?? [],
      },
    },
    run
  )
}
