import fs from "fs"
import path from "path"
import Database from "better-sqlite3"
import { config } from "../config"

export type Db = Database.Database

// Schema migrations.
//
// Versioned and append-only: a new phase adds an entry to this array and never
// edits an existing one, so a database created months ago reaches the same
// shape as a fresh one. The runner bootstraps `schema_version` itself (it has
// to exist before the current version can be read), writes one row per applied
// migration for the audit trail, and takes MAX(version) as the current level.
interface Migration {
  version: number
  up: (db: Db) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE preferences (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          topic         TEXT    NOT NULL,
          value         TEXT    NOT NULL,
          category      TEXT    NOT NULL DEFAULT 'general',
          source        TEXT    NOT NULL DEFAULT 'stated',
          created_at    INTEGER NOT NULL,
          superseded_at INTEGER,
          superseded_by INTEGER REFERENCES preferences(id),
          removed_at    INTEGER
        );

        -- "which preferences are active" is the only hot query, so it is the
        -- only thing indexed. Active means never superseded and never removed.
        CREATE INDEX idx_preferences_active ON preferences(topic)
          WHERE superseded_at IS NULL AND removed_at IS NULL;

        CREATE TABLE sessions (
          id                TEXT    PRIMARY KEY,
          created_at        INTEGER NOT NULL,
          last_turn_at      INTEGER NOT NULL,
          ended_at          INTEGER,
          working_directory TEXT    NOT NULL,
          messages          TEXT    NOT NULL
        );

        CREATE INDEX idx_sessions_live ON sessions(last_turn_at)
          WHERE ended_at IS NULL;
      `)
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE episodes (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT    NOT NULL,
          started_at      INTEGER NOT NULL,
          ended_at        INTEGER NOT NULL,
          summary         TEXT    NOT NULL,
          tags            TEXT    NOT NULL DEFAULT '[]',
          embedding_model TEXT,
          indexed_at      INTEGER,
          created_at      INTEGER NOT NULL
        );

        -- The backlog sweep runs on a timer and is almost always empty, so the
        -- index that serves it is partial.
        CREATE INDEX idx_episodes_backlog ON episodes(created_at)
          WHERE indexed_at IS NULL;

        CREATE INDEX idx_episodes_ended ON episodes(ended_at);

        -- One episode per session. Makes the writer idempotent: a retry after a
        -- crash mid-write replaces the row instead of adding a second one.
        CREATE UNIQUE INDEX idx_episodes_session ON episodes(session_id);
      `)
    },
  },
  {
    version: 3,
    up: (db) => {
      // Ixa's notebook (Phase 3d).
      //
      // BOTH OF THESE TABLES ARE REBUILDABLE. The markdown file is the source
      // of truth for a note — it is what Obsidian renders and what Syncthing
      // replicates — so these rows are a derived index over the vault, in the
      // same relationship Qdrant has to SQLite for episodes. Dropping them
      // costs a re-scan, never a note.
      db.exec(`
        CREATE TABLE notes (
          id            TEXT    PRIMARY KEY,
          type          TEXT    NOT NULL,
          title         TEXT    NOT NULL,
          summary       TEXT    NOT NULL,
          -- YYYY-MM-DD, local, as the frontmatter carries it.
          date          TEXT    NOT NULL,
          status        TEXT    NOT NULL DEFAULT 'active',
          -- Relative to the vault root, so moving the vault is a config change.
          path          TEXT    NOT NULL,
          superseded_by TEXT    REFERENCES notes(id),
          superseded_at INTEGER,
          -- Provenance, stamped by the harness. The model is never asked for
          -- any of it: asked for a session id in the spike, it invented "?".
          source        TEXT    NOT NULL DEFAULT 'text',
          session_id    TEXT,
          created_at    INTEGER NOT NULL
        );

        -- The no-query half of search_notes: the most recent ACTIVE notes.
        -- Partial for the same reason the preference index is: "active" is
        -- the only state anything reads in the hot path.
        CREATE INDEX idx_notes_recent ON notes(created_at) WHERE status = 'active';

        CREATE TABLE note_chunks (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id         TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          ordinal         INTEGER NOT NULL,
          heading_path    TEXT    NOT NULL,
          text            TEXT    NOT NULL,
          -- Content hash. Re-saving a note re-embeds only the chunks whose
          -- hash is new; an unchanged chunk keeps its row, its id (which IS
          -- its Qdrant point id) and its indexed_at.
          hash            TEXT    NOT NULL,
          embedding_model TEXT,
          indexed_at      INTEGER,
          created_at      INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX idx_note_chunks_ordinal ON note_chunks(note_id, ordinal);

        -- Matched on when a note is re-saved, to tell a changed chunk from a
        -- moved one.
        CREATE INDEX idx_note_chunks_hash ON note_chunks(note_id, hash);

        -- Same shape as the episode backlog: almost always empty, so partial.
        CREATE INDEX idx_note_chunks_backlog ON note_chunks(created_at)
          WHERE indexed_at IS NULL;
      `)
    },
  },
]

// The version a freshly opened database ends up at.
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
    version: number | null
  }
  const current = row.version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    // Each migration lands whole or not at all: a half-applied schema is far
    // worse to recover from than a failed startup.
    db.transaction(() => {
      migration.up(db)
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now()
      )
    })()
    console.log(`db: applied migration ${migration.version}`)
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
    version: number | null
  }
  return row.version ?? 0
}

// Opens (creating if needed) a database and brings it up to the current schema.
// Tests pass their own temp path; production uses the configured default.
export function openDatabase(filePath: string = config.data.dbPath): Db {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }

  const db = new Database(filePath)
  // WAL so a read (preference injection, on every LLM call) never blocks on a
  // write (a turn being persisted). NORMAL sync is the usual WAL companion:
  // durable across a process crash, which is the failure this guards against.
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")

  migrate(db)
  return db
}

// The process-wide handle. One database file, opened once.
let shared: Db | null = null

export function getDatabase(): Db {
  if (!shared) shared = openDatabase()
  return shared
}

export function closeDatabase(): void {
  shared?.close()
  shared = null
}
