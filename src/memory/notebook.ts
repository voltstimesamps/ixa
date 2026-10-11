import { config } from "../config"
import type { Embedder } from "./embeddings"
import { chunkSections, type NoteChunk } from "./note-chunks"
import {
  buildId,
  buildPath,
  readNoteFile,
  renderNote,
  stampSuperseded,
  writeNoteFile,
  type NoteMeta,
  type NoteSection,
  type NoteType,
} from "./notes-markdown"
import type { Note, NoteStore, StoredChunk } from "./notes"
import type { Payload, VectorIndex } from "./qdrant"

// Ixa's notebook: the write path (asked to note something → markdown on disk
// → chunks → vectors) and the read path (search by meaning, or by recency).
//
// THE ORDER OF THE WRITE IS THE DESIGN. The markdown file lands first, and
// atomically. Everything after it — the SQLite rows, the embeddings, the
// Qdrant points — is derived and rebuildable, so an Ollama or Qdrant outage
// costs an index entry and never a note. That is the same shape as the
// episode path with the source of truth moved: there, SQLite is truth and
// Qdrant is the index; here the FILE is truth, because the file is the
// artifact — it is what Obsidian renders and what Syncthing replicates.
//
// SHE IS THE ONLY WRITER, so there is no watcher. The thing that writes a
// note and the thing that indexes it are the same call.

// How many possible duplicates a save reports. Two: enough to catch the note
// that should have been superseded, short enough that the read-back stays a
// read-back rather than a search result.
const DUPLICATES = 2

export interface NotebookLimits {
  searchLimit: number
  searchTimeoutMs: number
  minTokens: number
  maxTokens: number
}

export interface NotebookOptions {
  store: NoteStore
  embedder: Embedder
  index: VectorIndex
  vaultPath?: string
  limits?: NotebookLimits
}

// What the tool hands in. The first four fields come from the model; the last
// three are stamped by the harness and are NOT in the tool schema — asked for
// provenance in the spike, the model invented a session id ("?").
export interface SaveNoteInput {
  type: NoteType
  title: string
  summary: string
  sections: NoteSection[]
  supersedes?: string
  source: "voice" | "text"
  sessionId?: string
  date: string
}

export interface SaveResult {
  note: Note
  // The note this one replaced, if any. Null when nothing was superseded.
  superseded: Note | null
  // Set when the model named a note to supersede and it could not be used —
  // wrong id, or already superseded. The note is still written: refusing the
  // whole write because a cross-reference was wrong would lose the content
  // the user asked for.
  supersedeProblem?: string
  // Set when a note already existed under this title and date with different
  // content, so this one was given a distinct id rather than written over it.
  // Worth telling the model: it probably meant to supersede.
  titleClash?: Note
  // Active notes that may already cover this subject, found by searching on
  // the new note's own title and summary BEFORE it was written. Advisory: the
  // write never waits on this and never fails because of it.
  duplicates: NoteHit[]
  // False means the file is on disk and the vectors are not. The note exists;
  // it is not searchable yet.
  indexed: boolean
  chunks: { added: number; kept: number; removed: number }
}

export interface NoteHit {
  note: Note
  score: number
  headingPath: string
  text: string
}

export type NoteSearchResult =
  | { available: true; hits: NoteHit[] }
  | { available: false; reason: string }

export class Notebook {
  private readonly store: NoteStore
  private readonly embedder: Embedder
  private readonly index: VectorIndex
  private readonly vaultPath: string
  private readonly limits: NotebookLimits

  // Degradation state, same contract as episodic memory: one warning when the
  // index goes away, one line when it comes back, never one per call.
  private available = true
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(options: NotebookOptions) {
    this.store = options.store
    this.embedder = options.embedder
    this.index = options.index
    this.vaultPath = options.vaultPath ?? config.notes.vaultPath
    this.limits = options.limits ?? config.notes
  }

  get isAvailable(): boolean {
    return this.available
  }

  get vaultRoot(): string {
    return this.vaultPath
  }

  private markDown(reason: string): void {
    if (this.available) {
      this.available = false
      console.warn(
        `notebook: the note index is unavailable (${reason}). Notes are still written to disk ` +
          `and will be indexed when it returns.`
      )
    }
  }

  private markUp(): void {
    if (!this.available) {
      this.available = true
      console.log("notebook: the note index is available again")
    }
  }

  // ----------------------------------------------------------- write path

  // Whether an existing note is the SAME note being written again, as opposed
  // to a different note that happens to slug to the same id. Compared on what
  // is already stored — type, summary and the chunk hashes — so no extra
  // column is needed to answer it.
  private sameContent(existing: Note, input: SaveNoteInput, chunks: NoteChunk[]): boolean {
    if (existing.type !== input.type || existing.summary !== input.summary) return false
    const have = this.store.chunksFor(existing.id).map((chunk) => chunk.hash)
    const want = chunks.map((chunk) => chunk.hash)
    return have.length === want.length && have.every((hash, i) => hash === want[i])
  }

  private freeId(id: string): string {
    for (let suffix = 2; ; suffix++) {
      const candidate = `${id}-${suffix}`
      if (!this.store.byId(candidate)) return candidate
    }
  }

  // SEARCH-BEFORE-WRITE, IN CODE. `save_note`'s description says to call
  // search_notes first, every time. Verification measured that instruction
  // being obeyed on three writes out of eight — and the write that skipped it
  // produced a second, near-identical Groq-tier note. A description is not a
  // mechanism, so the duplicate check runs here, where skipping it is not an
  // option.
  //
  // It is ADVISORY ONLY and cannot stop the write. The user asked for a note;
  // a near-duplicate is a thing to tell the model about, not a reason to lose
  // what they said. Hence no threshold either — the same measurement that
  // removed the score floor from retrieval applies: the model reads the
  // candidates and judges them.
  private async possibleDuplicates(
    input: SaveNoteInput,
    exclude: Set<string>
  ): Promise<NoteHit[]> {
    // Title AND summary, because the summary is what retrieval matches on and
    // the title alone is often too short to embed usefully.
    const result = await this.search(`${input.title}\n${input.summary}`, DUPLICATES + exclude.size)
    if (!result.available) return [] // Index down: silent, by design.
    return result.hits.filter((hit) => !exclude.has(hit.note.id)).slice(0, DUPLICATES)
  }

  async save(input: SaveNoteInput): Promise<SaveResult> {
    const chunks = chunkSections(input.sections, this.limits)

    // AN ID COLLISION MUST NEVER DESTROY A NOTE. The id is date + title slug,
    // so two notes written on one day under one title collide — and the first
    // version of this wrote the second one straight over the first.
    //
    // Found in verification, in the exact case it matters: asked to replace
    // the Tavily note, the model wrote the replacement under the SAME title
    // and set `supersedes` to the note it was about to overwrite. The
    // supersede was refused as self-referential and three paragraphs of
    // reasoning went under the new text — the content loss that
    // supersede-not-overwrite exists to prevent, arriving through a different
    // door. So a collision whose content differs gets a fresh id, and only a
    // genuinely identical re-save (a rebuild, a reconcile scan, a retry)
    // updates in place.
    let id = buildId(input.date, input.title)
    let titleClash: Note | null = null
    const existing = this.store.byId(id)
    if (existing && !this.sameContent(existing, input, chunks)) {
      titleClash = existing
      id = this.freeId(id)
    }

    const path = buildPath(id)

    // Resolved BEFORE the new note is written, so that a bad reference is
    // reported rather than leaving a half-applied supersede behind.
    let superseded: Note | null = null
    let supersedeProblem: string | undefined
    if (input.supersedes) {
      const target = this.store.byId(input.supersedes)
      if (!target) {
        supersedeProblem = `No note with the id "${input.supersedes}" exists, so nothing was superseded.`
      } else if (target.id === id) {
        supersedeProblem = `A note cannot supersede itself, so nothing was superseded.`
      } else if (target.status !== "active") {
        supersedeProblem = `Note "${input.supersedes}" was already superseded, so nothing changed.`
      } else {
        superseded = target
      }
    }

    // Before the file lands, so the new note cannot match itself. The
    // excluded ids are the ones already reported more precisely: a note being
    // superseded, and a title clash (or an identical re-save) under this id.
    const duplicates = await this.possibleDuplicates(
      input,
      new Set([id, buildId(input.date, input.title), ...(superseded ? [superseded.id] : [])])
    )

    const meta: NoteMeta = {
      id,
      type: input.type,
      title: input.title,
      summary: input.summary,
      date: input.date,
      status: "active",
      source: input.source,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }

    // The file, first and atomically.
    writeNoteFile(this.vaultPath, path, renderNote(meta, input.sections))

    const note = this.store.save({ ...meta, path, createdAt: Date.now() })

    // The old note is stamped only AFTER the replacement exists on disk: a
    // crash between the two leaves both notes active, which a later read can
    // sort out, where the reverse leaves the user with neither.
    if (superseded) this.stamp(superseded, id, input.date)

    const diff = this.store.replaceChunks(id, chunks)

    const indexed = await this.indexChunks(note, diff.added, diff.removedIds)

    return {
      note,
      superseded,
      ...(supersedeProblem ? { supersedeProblem } : {}),
      ...(titleClash ? { titleClash } : {}),
      duplicates,
      indexed,
      chunks: { added: diff.added.length, kept: diff.kept.length, removed: diff.removedIds.length },
    }
  }

  // The supersede stamp: a status and a pointer, in the file and in SQLite.
  // THE BODY IS NOT TOUCHED. Asked to supersede a note in the spike, the
  // model rewrote three sections of reasoning into one line — which is
  // overwriting under another name, and the old reasoning is the thing worth
  // keeping. So the model never writes the old note; this does, and all it
  // can do is stamp.
  private stamp(target: Note, by: string, date: string): void {
    const existing = readNoteFile(this.vaultPath, target.path)
    if (existing) {
      const stamped = stampSuperseded(existing, by, date)
      if (stamped) writeNoteFile(this.vaultPath, target.path, stamped)
      else console.warn(`notebook: could not parse ${target.path}; left the file unstamped`)
    } else {
      console.warn(`notebook: ${target.path} is missing; stamping the row only`)
    }
    this.store.markSuperseded(target.id, by)
    // The superseded note's chunks must stop being searchable as active text.
    // Its vectors carry status in the payload, so they are re-upserted rather
    // than deleted: the note still exists and a later question about what
    // changed should be able to find it.
    void this.reindexStatus(target.id).catch(() => undefined)
  }

  private payloadFor(note: Note, chunk: StoredChunk): Payload {
    return {
      noteId: note.id,
      title: note.title,
      headingPath: chunk.headingPath,
      type: note.type,
      // THE FILTERED FIELD. Measured: a superseded note outranked its
      // replacement for two of three changed facts, so retrieval filters on
      // this rather than hoping the newer note scores higher.
      status: note.status,
      date: note.date,
    }
  }

  // Embeds and upserts the chunks that are new, and drops the vectors of
  // chunks whose text is gone. Returns false (without throwing) when the
  // services are down: the rows stay unindexed and the sweep retries them.
  private async indexChunks(
    note: Note,
    added: StoredChunk[],
    removedIds: number[]
  ): Promise<boolean> {
    if (added.length === 0 && removedIds.length === 0) return true
    try {
      if (removedIds.length > 0) await this.index.deletePoints(removedIds)
      if (added.length > 0) {
        const points = []
        for (const chunk of added) {
          points.push({
            id: chunk.id,
            vector: await this.embedder.embed(chunk.text, "document"),
            payload: this.payloadFor(note, chunk),
          })
        }
        await this.index.upsert(points)
        for (const chunk of added) {
          this.store.markChunkIndexed(chunk.id, this.embedder.model)
        }
      }
      this.markUp()
      return true
    } catch (err) {
      this.markDown(err instanceof Error ? err.message : String(err))
      console.warn(
        `notebook: note "${note.id}" is written to disk but ${added.length} chunk(s) are not ` +
          `indexed; queued for retry`
      )
      return false
    }
  }

  // Re-upserts a note's existing vectors so their payload matches the row —
  // used when only the STATUS changed, where the text (and so the embedding)
  // is identical and re-embedding would be wasted work.
  private async reindexStatus(noteId: string): Promise<void> {
    const note = this.store.byId(noteId)
    if (!note) return
    const chunks = this.store.chunksFor(noteId).filter((chunk) => chunk.indexedAt !== null)
    if (chunks.length === 0) return
    try {
      const points = []
      for (const chunk of chunks) {
        points.push({
          id: chunk.id,
          vector: await this.embedder.embed(chunk.text, "document"),
          payload: this.payloadFor(note, chunk),
        })
      }
      await this.index.upsert(points)
      this.markUp()
    } catch (err) {
      // The row says superseded, so the note is already out of the active
      // list. A stale payload means one search could still return it; the
      // sweep does not catch this (the chunks are indexed), so it is logged
      // loudly rather than silently retried.
      console.warn(
        `notebook: "${noteId}" is marked superseded in SQLite but its vectors still say ` +
          `active (${err instanceof Error ? err.message : String(err)}). Re-run ` +
          `dev/scripts/rebuild-note-index.ts to fix the payloads.`
      )
    }
  }

  // Indexes every chunk still marked unindexed. Startup and on a timer.
  async indexBacklog(): Promise<number> {
    const backlog = this.store.notIndexedChunks()
    if (backlog.length === 0) return 0

    let indexed = 0
    for (const chunk of backlog) {
      const note = this.store.byId(chunk.noteId)
      if (!note) continue
      const ok = await this.indexChunks(note, [chunk], [])
      if (!ok) break // Still down; leave the rest for the next sweep.
      indexed++
    }

    if (indexed > 0) console.log(`notebook: indexed ${indexed} backlogged chunk(s)`)
    return indexed
  }

  startBacklogSweep(intervalMs = config.memory.indexRetryMs): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      void this.indexBacklog().catch(() => undefined)
    }, intervalMs)
    this.sweepTimer.unref?.()
  }

  stopBacklogSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  async start(): Promise<void> {
    try {
      const vector = await this.embedder.embed("warm up", "query")
      await this.index.ensureCollection(vector.length)
      this.markUp()
      console.log(
        `notebook: ready — ${this.store.countActive()} active note(s), ` +
          `${this.store.countChunks()} chunk(s), ${this.store.countNotIndexedChunks()} awaiting ` +
          `indexing, vault ${this.vaultPath}`
      )
    } catch (err) {
      this.markDown(err instanceof Error ? err.message : String(err))
    }

    await this.indexBacklog().catch(() => undefined)
    this.startBacklogSweep()
  }

  // ------------------------------------------------------------ read path

  // Search by meaning. TOP N NOTES, ACTIVE ONLY, AND NO SCORE FLOOR.
  //
  // The floor is absent on evidence, not oversight: over 19 questions against
  // 24 notes, text that genuinely answered the question scored as low as
  // 0.586 while text from an entirely unrelated note reached 0.755. Any
  // threshold in that range cuts real answers and keeps wrong ones, so the
  // tool returns its best few and says plainly that they may be unrelated —
  // the reader discards a weak match, not a number.
  async search(query: string, limit = this.limits.searchLimit): Promise<NoteSearchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.limits.searchTimeoutMs)
    try {
      const vector = await this.embedder.embed(query, "query", controller.signal)
      const hits = await this.index.search(vector, {
        // Chunks, not notes: several chunks of one note can match, and they
        // collapse below. Over-fetched so the collapse still has N notes to
        // return.
        limit: limit * 4,
        filter: [{ key: "status", match: { value: "active" } }],
        withPayload: true,
        signal: controller.signal,
      })
      this.markUp()

      const chunks = new Map(
        this.store.chunksByIds(hits.map((hit) => hit.id)).map((chunk) => [chunk.id, chunk])
      )

      // A hit with no chunk row is stale — the note was rewritten or removed
      // since. Dropped AND deleted, the same invariant the episode path has:
      // nothing that is gone from the source can come back through a vector.
      const orphans = hits.filter((hit) => !chunks.has(hit.id)).map((hit) => hit.id)
      if (orphans.length > 0) {
        console.warn(`notebook: dropping ${orphans.length} vector(s) with no chunk row`)
        void this.index.deletePoints(orphans).catch(() => undefined)
      }

      const best = new Map<string, NoteHit>()
      for (const hit of hits) {
        const chunk = chunks.get(hit.id)
        if (!chunk) continue
        const note = this.store.byId(chunk.noteId)
        if (!note || note.status !== "active") continue
        // Score order from Qdrant, so the first chunk seen for a note is its
        // best one.
        if (!best.has(note.id)) {
          best.set(note.id, {
            note,
            score: hit.score,
            headingPath: chunk.headingPath,
            text: chunk.text,
          })
        }
        if (best.size >= limit) break
      }

      return { available: true, hits: [...best.values()] }
    } catch (err) {
      const reason = controller.signal.aborted
        ? `the ${this.limits.searchTimeoutMs}ms search budget`
        : err instanceof Error
          ? err.message
          : String(err)
      this.markDown(reason)
      return { available: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  // The no-query half: the most recent active notes, newest first.
  //
  // SQLite only — no embedding, no network — so "what have I written down
  // lately?" is answerable with Ollama and Qdrant both down. Same reasoning
  // as episode recency: a question with no subject in it embeds to a vector
  // near nothing, and ordering by date is something the table already does.
  recent(): NoteSearchResult {
    return {
      available: true,
      hits: this.store.recent(this.limits.searchLimit).map((note) => ({
        note,
        score: 0,
        headingPath: "",
        text: note.summary,
      })),
    }
  }

  byId(id: string): Note | null {
    return this.store.byId(id)
  }
}

let shared: Notebook | null = null

export function getNotebook(): Notebook | null {
  return shared
}

export function setNotebook(notebook: Notebook | null): void {
  shared = notebook
}
