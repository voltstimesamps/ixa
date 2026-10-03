import { getDatabase, type Db } from "./db"

// Episodes: one summarized conversation each.
//
// SQLite is the source of truth. Qdrant holds vectors pointing back at these
// rows and can be thrown away and rebuilt from them at any time, which is why
// every operation here is safe to perform with Qdrant down or absent.

export interface Episode {
  id: number
  sessionId: string
  startedAt: number
  endedAt: number
  summary: string
  tags: string[]
  // The model that produced the stored vector, or null while unindexed. Lets a
  // model change be detected rather than silently mixing vector spaces.
  embeddingModel: string | null
  indexedAt: number | null
  createdAt: number
}

export interface NewEpisode {
  sessionId: string
  startedAt: number
  endedAt: number
  summary: string
  tags: string[]
}

interface EpisodeRow {
  id: number
  session_id: string
  started_at: number
  ended_at: number
  summary: string
  tags: string
  embedding_model: string | null
  indexed_at: number | null
  created_at: number
}

function toEpisode(row: EpisodeRow): Episode {
  let tags: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.tags)
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string")
  } catch {
    // A malformed tags column costs the tags, not the episode.
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    tags,
    embeddingModel: row.embedding_model,
    indexedAt: row.indexed_at,
    createdAt: row.created_at,
  }
}

export class EpisodeStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // Writes the episode and returns it. Keyed on session_id: a second write for
  // the same session replaces the first rather than adding a duplicate, and
  // resets the indexing state because the text has changed.
  save(episode: NewEpisode): Episode {
    this.db
      .prepare(
        `INSERT INTO episodes
           (session_id, started_at, ended_at, summary, tags, embedding_model, indexed_at, created_at)
         VALUES (@sessionId, @startedAt, @endedAt, @summary, @tags, NULL, NULL, @createdAt)
         ON CONFLICT(session_id) DO UPDATE SET
           started_at      = excluded.started_at,
           ended_at        = excluded.ended_at,
           summary         = excluded.summary,
           tags            = excluded.tags,
           embedding_model = NULL,
           indexed_at      = NULL`
      )
      .run({
        sessionId: episode.sessionId,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        summary: episode.summary,
        tags: JSON.stringify(episode.tags),
        createdAt: Date.now(),
      })

    return this.bySessionId(episode.sessionId)!
  }

  markIndexed(id: number, embeddingModel: string): void {
    this.db
      .prepare("UPDATE episodes SET indexed_at = ?, embedding_model = ? WHERE id = ?")
      .run(Date.now(), embeddingModel, id)
  }

  // Used by the rebuild script: every episode becomes backlog again.
  markAllNotIndexed(): void {
    this.db.prepare("UPDATE episodes SET indexed_at = NULL, embedding_model = NULL").run()
  }

  notIndexed(limit = 50): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE indexed_at IS NULL ORDER BY created_at ASC LIMIT ?")
      .all(limit) as EpisodeRow[]
    return rows.map(toEpisode)
  }

  countNotIndexed(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE indexed_at IS NULL")
      .get() as { n: number }
    return row.n
  }

  byId(id: number): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
      | EpisodeRow
      | undefined
    return row ? toEpisode(row) : null
  }

  bySessionId(sessionId: string): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE session_id = ?").get(sessionId) as
      | EpisodeRow
      | undefined
    return row ? toEpisode(row) : null
  }

  // Hydration for search hits. Returns only the ids that still exist — a
  // vector whose episode has been deleted resolves to nothing, which is what
  // stops a deleted episode coming back through a stale Qdrant point.
  byIds(ids: number[]): Episode[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`)
      .all(...ids) as EpisodeRow[]
    return rows.map(toEpisode)
  }

  all(): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes ORDER BY id ASC")
      .all() as EpisodeRow[]
    return rows.map(toEpisode)
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n
  }

  // Hard delete, for the user removing their own data. Unlike a preference,
  // there is no soft-delete tier here: the point of forgetting an episode is
  // that the text is gone.
  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id).changes > 0
  }
}

let shared: EpisodeStore | null = null

export function getEpisodeStore(): EpisodeStore {
  if (!shared) shared = new EpisodeStore(getDatabase())
  return shared
}

export function setEpisodeStore(store: EpisodeStore | null): void {
  shared = store
}
