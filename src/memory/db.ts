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
]

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
