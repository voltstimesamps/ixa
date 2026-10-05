import { config } from "../config"
import { getDatabase, type Db } from "./db"

// The preference store.
//
// Append-only by design. A preference is never UPDATEd in place and never
// DELETEd: an update supersedes the old row and inserts a new one, and a
// forget is a soft delete. The history is the point — Phase 3c's temporal
// facts ("drinks tea now, previously coffee") need the old rows to still be
// there, and a forget that turns out to be a mistake is recoverable in SQL.
//
// Invariant: at most one ACTIVE row per topic (compared case-insensitively).
// remember() on an existing topic supersedes it, which is what lets forget()
// and the injection block address a preference by topic alone, with no row ids
// ever shown to the model.

export type PreferenceSource = "stated"

export interface Preference {
  id: number
  topic: string
  value: string
  category: string
  source: PreferenceSource
  createdAt: number
  supersededAt: number | null
  supersededBy: number | null
  removedAt: number | null
}

export interface RememberInput {
  topic: string
  value: string
  category?: string
  source?: PreferenceSource
}

export interface RememberResult {
  preference: Preference
  // The row this one replaced, if it was an update rather than a first save.
  superseded: Preference | null
}

export interface InjectionResult {
  text: string | null
  included: number
  total: number
  truncated: boolean
}

export interface PreferenceLimits {
  maxInjected: number
  maxChars: number
}

const DEFAULT_CATEGORY = "general"

// The second sentence is there because of a live failure, not for tidiness:
// asked "what did we talk about last time?", Ixa answered from this list. It
// was the only memory-shaped text in the request — recall matches on meaning
// and a question with no subject matches nothing — so the model read standing
// instructions as a record of conversations. The recency line that now ships
// alongside this block is the other half of that fix.
const INJECTION_HEADER =
  "The user's saved preferences, from your long-term memory. Apply them without " +
  "being asked, unless the user overrides one in this conversation. These are standing " +
  "instructions, NOT a record of past conversations: never answer a question about what you " +
  "talked about, or when, from this list — that is what search_memory is for."

interface PreferenceRow {
  id: number
  topic: string
  value: string
  category: string
  source: string
  created_at: number
  superseded_at: number | null
  superseded_by: number | null
  removed_at: number | null
}

function toPreference(row: PreferenceRow): Preference {
  return {
    id: row.id,
    topic: row.topic,
    value: row.value,
    category: row.category,
    source: row.source as PreferenceSource,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    removedAt: row.removed_at,
  }
}

// One preference is one line in the injected block, so a value typed with
// newlines must not be able to break the block's shape.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const ACTIVE = "superseded_at IS NULL AND removed_at IS NULL"

export class PreferenceStore {
  private readonly db: Db
  private readonly limits: PreferenceLimits
  // The last truncation warning emitted, so a capped store logs once rather
  // than on every LLM call (several per turn) with an identical line.
  private lastTruncationWarning: string | null = null

  constructor(db: Db, limits: PreferenceLimits = config.preferences) {
    this.db = db
    this.limits = limits
  }

  // The active preference for a topic, matched case-insensitively so "Coffee"
  // and "coffee" are the same preference rather than two near-duplicates.
  activeByTopic(topic: string): Preference | null {
    const row = this.db
      .prepare(`SELECT * FROM preferences WHERE topic = ? COLLATE NOCASE AND ${ACTIVE}`)
      .get(oneLine(topic)) as PreferenceRow | undefined
    return row ? toPreference(row) : null
  }

  listActive(category?: string): Preference[] {
    const rows = category
      ? (this.db
          .prepare(
            `SELECT * FROM preferences WHERE ${ACTIVE} AND category = ? COLLATE NOCASE
             ORDER BY created_at ASC, id ASC`
          )
          .all(oneLine(category).toLowerCase()) as PreferenceRow[])
      : (this.db
          .prepare(`SELECT * FROM preferences WHERE ${ACTIVE} ORDER BY created_at ASC, id ASC`)
          .all() as PreferenceRow[])
    return rows.map(toPreference)
  }

  getById(id: number): Preference | null {
    const row = this.db.prepare("SELECT * FROM preferences WHERE id = ?").get(id) as
      | PreferenceRow
      | undefined
    return row ? toPreference(row) : null
  }

  // Saves a preference, superseding any active one on the same topic. Never
  // overwrites: the old row stays, stamped with when and by what it was
  // replaced.
  remember(input: RememberInput): RememberResult {
    const topic = oneLine(input.topic)
    const value = oneLine(input.value)
    if (!topic) throw new Error("A preference needs a topic.")
    if (!value) throw new Error("A preference needs a value.")

    const requestedCategory = oneLine(input.category ?? "").toLowerCase()
    const source = input.source ?? "stated"
    const now = Date.now()

    const apply = this.db.transaction((): RememberResult => {
      const previous = this.activeByTopic(topic)
      // An update that names no category keeps the one it had. Re-filing a
      // preference under "general" just because the model omitted the field
      // would be a silent, invisible change.
      const category = requestedCategory || previous?.category || DEFAULT_CATEGORY

      const inserted = this.db
        .prepare(
          `INSERT INTO preferences (topic, value, category, source, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(topic, value, category, source, now)
      const newId = Number(inserted.lastInsertRowid)

      if (previous) {
        this.db
          .prepare("UPDATE preferences SET superseded_at = ?, superseded_by = ? WHERE id = ?")
          .run(now, newId, previous.id)
      }

      return {
        preference: this.getById(newId)!,
        // Re-read so the caller sees the supersession stamps, not the
        // pre-update snapshot.
        superseded: previous ? this.getById(previous.id) : null,
      }
    })

    return apply()
  }

  // Soft delete. A removed preference is never injected and never listed as
  // active, but the row survives for history.
  forget(topic: string): Preference | null {
    const existing = this.activeByTopic(topic)
    if (!existing) return null

    this.db.prepare("UPDATE preferences SET removed_at = ? WHERE id = ?").run(Date.now(), existing.id)
    return this.getById(existing.id)
  }

  // Builds the block injected into the system context. Returns the counts too,
  // so callers (and tests) can see a truncation without parsing log output.
  //
  // Capped newest-first and then rendered oldest-first: a cap this size is only
  // ever hit by a store that has drifted, and the most recently stated
  // preferences are the ones most likely to still be true. Stable ordering in
  // the rendered block keeps the prompt prefix cacheable between calls.
  buildInjection(): InjectionResult {
    const active = this.listActive()
    if (active.length === 0) {
      return { text: null, included: 0, total: 0, truncated: false }
    }

    const newestFirst = [...active].reverse()
    const chosen: Preference[] = []
    let chars = INJECTION_HEADER.length

    for (const preference of newestFirst) {
      if (chosen.length >= this.limits.maxInjected) break
      const lineChars = this.renderLine(preference).length + 1
      if (chars + lineChars > this.limits.maxChars) break
      chosen.push(preference)
      chars += lineChars
    }

    chosen.reverse()
    const text = [INJECTION_HEADER, ...chosen.map((p) => this.renderLine(p))].join("\n")

    return {
      text: chosen.length > 0 ? text : null,
      included: chosen.length,
      total: active.length,
      truncated: chosen.length < active.length,
    }
  }

  // What the Session injects. Null when there is nothing active to say.
  injectionBlock(): string | null {
    const result = this.buildInjection()

    if (result.truncated) {
      const warning =
        `preferences: injected ${result.included} of ${result.total} active ` +
        `(cap ${this.limits.maxInjected} rows / ${this.limits.maxChars} chars) — ` +
        `${result.total - result.included} omitted`
      if (warning !== this.lastTruncationWarning) {
        console.warn(warning)
        this.lastTruncationWarning = warning
      }
    } else {
      this.lastTruncationWarning = null
    }

    return result.text
  }

  private renderLine(preference: Preference): string {
    return `- [${preference.category}] ${preference.topic}: ${preference.value}`
  }
}

// The process-wide store, resolved lazily so importing the preference tools
// does not open the database as a side effect of module loading.
let shared: PreferenceStore | null = null

export function getPreferenceStore(): PreferenceStore {
  if (!shared) shared = new PreferenceStore(getDatabase())
  return shared
}

// Lets a test or a dev script point the tools at a temp database.
export function setPreferenceStore(store: PreferenceStore | null): void {
  shared = store
}
