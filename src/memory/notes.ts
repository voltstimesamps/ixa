import { getDatabase, type Db } from "./db"
import type { NoteChunk } from "./note-chunks"
import type { NoteMeta, NoteStatus, NoteType } from "./notes-markdown"

// The SQLite mirror of the notebook.
//
// REBUILDABLE, BOTH TABLES. The markdown file is the source of truth for a
// note; these rows exist so that a search hit resolves to a title and summary
// without reading 24 files, and so that a chunk's hash is known without
// re-chunking. Dropping them costs a re-scan of the vault, never a note. That
// is the opposite direction from episodes, where SQLite is truth and Qdrant is
// the index — and the reason is that a note's artifact is the file: it is what
// Obsidian renders and what Syncthing replicates.
//
// Chunk ids ARE Qdrant point ids, the same invariant the episode path has, so
// there is no mapping table to keep in sync.

export interface Note extends NoteMeta {
  // Relative to the vault root.
  path: string
  createdAt: number
  supersededAt?: number
}

export interface StoredChunk {
  id: number
  noteId: string
  ordinal: number
  headingPath: string
  text: string
  hash: string
  embeddingModel: string | null
  indexedAt: number | null
}

interface NoteRow {
  id: string
  type: string
  title: string
  summary: string
  date: string
  status: string
  path: string
  superseded_by: string | null
  superseded_at: number | null
  source: string
  session_id: string | null
  created_at: number
}

interface ChunkRow {
  id: number
  note_id: string
  ordinal: number
  heading_path: string
  text: string
  hash: string
  embedding_model: string | null
  indexed_at: number | null
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    type: row.type as NoteType,
    title: row.title,
    summary: row.summary,
    date: row.date,
    status: row.status as NoteStatus,
    path: row.path,
    source: row.source === "voice" ? "voice" : "text",
    createdAt: row.created_at,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  }
}

function toChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    noteId: row.note_id,
    ordinal: row.ordinal,
    headingPath: row.heading_path,
    text: row.text,
    hash: row.hash,
    embeddingModel: row.embedding_model,
    indexedAt: row.indexed_at,
  }
}

// What replaceChunks did, so the caller knows exactly what to embed and which
// stale vectors to delete.
export interface ChunkDiff {
  kept: StoredChunk[]
  added: StoredChunk[]
  // Point ids whose text no longer exists in the note. The vectors have to go
  // or a search would return text that is not in the file any more.
  removedIds: number[]
}

export class NoteStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // Insert or replace the row for one note. Keyed on id, so re-saving the same
  // note (a correction, a re-scan) updates it instead of forking a second row.
  save(note: Note): Note {
    this.db
      .prepare(
        `INSERT INTO notes
           (id, type, title, summary, date, status, path,
            superseded_by, superseded_at, source, session_id, created_at)
         VALUES (@id, @type, @title, @summary, @date, @status, @path,
                 @supersededBy, @supersededAt, @source, @sessionId, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           type    = excluded.type,
           title   = excluded.title,
           summary = excluded.summary,
           date    = excluded.date,
           status  = excluded.status,
           path    = excluded.path`
      )
      .run({
        id: note.id,
        type: note.type,
        title: note.title,
        summary: note.summary,
        date: note.date,
        status: note.status,
        path: note.path,
        supersededBy: note.supersededBy ?? null,
        supersededAt: note.supersededAt ?? null,
        source: note.source,
        sessionId: note.sessionId ?? null,
        createdAt: note.createdAt,
      })
    return this.byId(note.id)!
  }

  // The supersede stamp, in SQL. Mirrors what stampSuperseded does to the
  // file: a status and a pointer, and nothing else touched.
  markSuperseded(id: string, by: string, at = Date.now()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE notes SET status = 'superseded', superseded_by = ?, superseded_at = ?
           WHERE id = ? AND status = 'active'`
        )
        .run(by, at, id).changes > 0
    )
  }

  byId(id: string): Note | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined
    return row ? toNote(row) : null
  }

  // Hydration for search hits, in the order the ids were given — which is
  // score order, and the order the model should read them in.
  byIds(ids: string[]): Note[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .all(...ids) as NoteRow[]
    const found = new Map(rows.map((row) => [row.id, toNote(row)]))
    return ids.map((id) => found.get(id)).filter((note): note is Note => note !== undefined)
  }

  // The no-query half of search_notes: the most recent ACTIVE notes, newest
  // first. SQLite only — no embedding, no network — for the same reason
  // episode recency is: "what have I written down lately?" has no subject in
  // it to match on, and an ordering this table already has does not need a
  // vector search to produce.
  recent(limit: number): Note[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notes WHERE status = 'active'
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(limit) as NoteRow[]
    return rows.map(toNote)
  }

  // Title match, case-insensitive, active only. Not a search feature: it is
  // how save_note notices it is about to write a note that already exists
  // under the same title, the way remember_preference matches a topic.
  byTitle(title: string): Note | null {
    const row = this.db
      .prepare(
        `SELECT * FROM notes WHERE status = 'active' AND lower(title) = lower(?) LIMIT 1`
      )
      .get(title) as NoteRow | undefined
    return row ? toNote(row) : null
  }

  all(): Note[] {
    const rows = this.db.prepare("SELECT * FROM notes ORDER BY id ASC").all() as NoteRow[]
    return rows.map(toNote)
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n
  }

  countActive(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'active'").get() as {
        n: number
      }
    ).n
  }

  // ------------------------------------------------------------------ chunks

  // Replaces a note's chunks with a new set, MATCHED ON HASH.
  //
  // This is what makes re-saving a note cheap: a chunk whose text is unchanged
  // keeps its row, its id (and therefore its Qdrant point) and its indexed_at,
  // even if it moved to a different ordinal. Only genuinely new text is
  // embedded, and only genuinely gone text has its vector deleted.
  //
  // One transaction, and existing ordinals are parked negative first: the
  // (note_id, ordinal) index is UNIQUE, so re-numbering in place would collide
  // with a row that has not been moved yet.
  replaceChunks(noteId: string, chunks: NoteChunk[]): ChunkDiff {
    const run = this.db.transaction((): ChunkDiff => {
      const existing = this.chunksFor(noteId)
      this.db
        .prepare("UPDATE note_chunks SET ordinal = -1 - ordinal WHERE note_id = ?")
        .run(noteId)

      // Several chunks of one note can share a hash (two identical one-line
      // sections), so each existing row is claimed at most once.
      const unclaimed = new Map<string, StoredChunk[]>()
      for (const chunk of existing) {
        const list = unclaimed.get(chunk.hash) ?? []
        list.push(chunk)
        unclaimed.set(chunk.hash, list)
      }

      const kept: StoredChunk[] = []
      const added: StoredChunk[] = []
      const now = Date.now()

      for (const chunk of chunks) {
        const claim = unclaimed.get(chunk.hash)?.shift()
        if (claim) {
          this.db
            .prepare("UPDATE note_chunks SET ordinal = ?, heading_path = ? WHERE id = ?")
            .run(chunk.ordinal, chunk.headingPath, claim.id)
          kept.push({ ...claim, ordinal: chunk.ordinal, headingPath: chunk.headingPath })
          continue
        }
        const result = this.db
          .prepare(
            `INSERT INTO note_chunks
               (note_id, ordinal, heading_path, text, hash, embedding_model, indexed_at, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
          )
          .run(noteId, chunk.ordinal, chunk.headingPath, chunk.text, chunk.hash, now)
        added.push({
          id: Number(result.lastInsertRowid),
          noteId,
          ordinal: chunk.ordinal,
          headingPath: chunk.headingPath,
          text: chunk.text,
          hash: chunk.hash,
          embeddingModel: null,
          indexedAt: null,
        })
      }

      const removedIds = [...unclaimed.values()].flat().map((chunk) => chunk.id)
      if (removedIds.length > 0) {
        const placeholders = removedIds.map(() => "?").join(", ")
        this.db
          .prepare(`DELETE FROM note_chunks WHERE id IN (${placeholders})`)
          .run(...removedIds)
      }

      return { kept, added, removedIds }
    })

    return run()
  }

  chunksFor(noteId: string): StoredChunk[] {
    const rows = this.db
      .prepare("SELECT * FROM note_chunks WHERE note_id = ? ORDER BY ordinal ASC")
      .all(noteId) as ChunkRow[]
    return rows.map(toChunk)
  }

  chunksByIds(ids: number[]): StoredChunk[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM note_chunks WHERE id IN (${placeholders})`)
      .all(...ids) as ChunkRow[]
    const found = new Map(rows.map((row) => [row.id, toChunk(row)]))
    return ids
      .map((id) => found.get(id))
      .filter((chunk): chunk is StoredChunk => chunk !== undefined)
  }

  markChunkIndexed(id: number, embeddingModel: string): void {
    this.db
      .prepare("UPDATE note_chunks SET indexed_at = ?, embedding_model = ? WHERE id = ?")
      .run(Date.now(), embeddingModel, id)
  }

  // Used by the rebuild script: every chunk becomes backlog again.
  markAllNotIndexed(): void {
    this.db.prepare("UPDATE note_chunks SET indexed_at = NULL, embedding_model = NULL").run()
  }

  notIndexedChunks(limit = 100): StoredChunk[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM note_chunks WHERE indexed_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?"
      )
      .all(limit) as ChunkRow[]
    return rows.map(toChunk)
  }

  countNotIndexedChunks(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM note_chunks WHERE indexed_at IS NULL")
        .get() as { n: number }
    ).n
  }

  countChunks(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM note_chunks").get() as { n: number }).n
  }
}

let shared: NoteStore | null = null

export function getNoteStore(): NoteStore {
  if (!shared) shared = new NoteStore(getDatabase())
  return shared
}

export function setNoteStore(store: NoteStore | null): void {
  shared = store
}
