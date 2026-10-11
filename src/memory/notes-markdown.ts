import fs from "fs"
import path from "path"

// The markdown layer of Ixa's notebook: the file format, where a file goes,
// and how it gets there.
//
// THE FILE IS THE SOURCE OF TRUTH. This inverts the episodic rule rather than
// contradicting it — for episodes SQLite is truth and Qdrant is a rebuildable
// index; for notes the markdown is truth and BOTH SQLite and Qdrant are
// rebuildable from it. The reason is that the file is the artifact: it is what
// Obsidian renders, what Syncthing replicates, and what survives the database
// being deleted. So it is written first, and written atomically.
//
// THE MODEL NEVER SUPPLIES A PATH. buildPath derives one from the id, which is
// the date and the title, and nothing in the tool schema accepts a filename. That
// is the whole reason save_note can be ungated while shell_write confirms:
// not "we trust it with files" but "it cannot name one". assertInsideVault is
// the backstop in case a future caller forgets.

export type NoteType = "decision" | "project" | "reference"
export type NoteStatus = "active" | "superseded"

export const NOTE_TYPES: NoteType[] = ["decision", "project", "reference"]

export interface NoteSection {
  heading: string
  body: string
}

// The frontmatter, and the whole of what SQLite mirrors about a note.
export interface NoteMeta {
  id: string
  type: NoteType
  title: string
  summary: string
  // YYYY-MM-DD, local — the same convention search_memory's bounds use, and
  // the backend's own timezone, because the user means their own Tuesday.
  date: string
  status: NoteStatus
  supersededBy?: string
  // Provenance, stamped by the harness. Asked for provenance in the spike the
  // model invented a session id ("?"), so it is never a schema field.
  source: "voice" | "text"
  sessionId?: string
}

// A title is a sentence, so a slug from it needs a length cap: without one,
// "Notes are written by Ixa and the user never hand-edits them" becomes a
// 58-character filename for no benefit.
const SLUG_MAX = 60

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Drop combining marks, so "café" slugs as "cafe" rather than losing the e.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "")
  // Every note needs a path, including one titled "???" — a date-only id is
  // ugly but reachable, where an empty one would collide with every other
  // untitleable note.
  return slug || "note"
}

// "2026-10-10-tavily-replaced-brave". Dated so that two notes on one subject
// months apart cannot collide, and so the vault sorts chronologically — which
// is the whole sort order now that the vault is flat.
export function buildId(date: string, title: string): string {
  return `${date}-${slugify(title)}`
}

// THE VAULT IS FLAT: every note is `<id>.md` in the vault root, with no type
// subdirectories. The type lives in the frontmatter (and in the Qdrant
// payload, where it can be filtered on) and nowhere in the path.
//
// An earlier version wrote `decisions/`, `projects/` and `references/`. The
// directories are gone because they put the same fact in two places: a note
// whose type changed would have to move files to stay consistent, which is a
// rename Syncthing replicates as a delete plus a create and Obsidian sees as
// a broken link. One directory and one id means the path is a pure function
// of the id, so `search_notes` returning an id is enough to find the file.
//
// Relative to the vault root, always with forward slashes: it is stored in
// SQLite and read back on another machine later.
export function buildPath(id: string): string {
  return `${id}.md`
}

// ---------------------------------------------------------------- the format
//
// Frontmatter is written as flat scalars with every string JSON-quoted, which
// is valid YAML double-quoted scalar syntax and survives a colon, a hash, a
// quote or a newline in a title or summary. Deliberately NOT a YAML library:
// this is the only YAML in the project, the shape is fixed and flat, and the
// parser below rejects anything it does not recognise rather than guessing.

const FENCE = "---"

function renderValue(value: string): string {
  return JSON.stringify(value)
}

function parseValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === "string") return parsed
    } catch {
      // Fall through: a hand-written quoted value that is not valid JSON is
      // better read literally than dropped.
    }
  }
  return trimmed
}

export function renderNote(meta: NoteMeta, sections: NoteSection[]): string {
  const lines = [FENCE]
  lines.push(`id: ${renderValue(meta.id)}`)
  lines.push(`type: ${renderValue(meta.type)}`)
  lines.push(`title: ${renderValue(meta.title)}`)
  lines.push(`summary: ${renderValue(meta.summary)}`)
  lines.push(`date: ${renderValue(meta.date)}`)
  lines.push(`status: ${renderValue(meta.status)}`)
  if (meta.supersededBy) lines.push(`superseded_by: ${renderValue(meta.supersededBy)}`)
  lines.push(`source: ${renderValue(meta.source)}`)
  if (meta.sessionId) lines.push(`session: ${renderValue(meta.sessionId)}`)
  lines.push(FENCE)

  const body = sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}`).join("\n\n")
  return `${lines.join("\n")}\n\n# ${meta.title}\n\n${body}\n`
}

export interface ParsedNote {
  meta: NoteMeta
  sections: NoteSection[]
}

// Reads back what renderNote wrote. Used by the rebuild script and by the
// supersede stamp, which has to change two frontmatter fields and nothing
// else — so it parses, edits and re-renders rather than patching text.
//
// Returns null rather than throwing: a file in the vault that is not a note
// Ixa wrote is a thing to skip and log, not a crash.
export function parseNote(text: string): ParsedNote | null {
  if (!text.startsWith(`${FENCE}\n`)) return null
  const end = text.indexOf(`\n${FENCE}`, FENCE.length)
  if (end === -1) return null

  const front: Record<string, string> = {}
  for (const line of text.slice(FENCE.length + 1, end).split("\n")) {
    if (!line.trim()) continue
    const colon = line.indexOf(":")
    if (colon === -1) return null
    front[line.slice(0, colon).trim()] = parseValue(line.slice(colon + 1))
  }

  const type = front.type
  const status = front.status ?? "active"
  if (!type || !NOTE_TYPES.includes(type as NoteType)) return null
  if (status !== "active" && status !== "superseded") return null
  if (!front.id || !front.title || front.summary === undefined || !front.date) return null

  const meta: NoteMeta = {
    id: front.id,
    type: type as NoteType,
    title: front.title,
    summary: front.summary,
    date: front.date,
    status,
    source: front.source === "voice" ? "voice" : "text",
    ...(front.superseded_by ? { supersededBy: front.superseded_by } : {}),
    ...(front.session ? { sessionId: front.session } : {}),
  }

  return { meta, sections: parseSections(text.slice(end + FENCE.length + 1)) }
}

// Splits the body on H2 headings. The H1 title line and anything before the
// first H2 are dropped: renderNote puts nothing there, and a stray preamble
// belongs to no section, so attributing it to the first one would change what
// a chunk says.
export function parseSections(body: string): NoteSection[] {
  const sections: NoteSection[] = []
  let heading: string | null = null
  let buffer: string[] = []

  const flush = () => {
    if (heading !== null) sections.push({ heading, body: buffer.join("\n").trim() })
    buffer = []
  }

  for (const line of body.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      heading = match[1]!
    } else if (heading !== null) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

// The supersede stamp. Decision: the replaced note is changed ONLY by a status
// stamp and a pointer, both added here in code — never by rewriting its body.
// The spike is why that is spelled out: asked to supersede a note, the model
// replaced three sections of reasoning with a single line, which is
// overwriting under another name. The old text is the thing worth keeping.
//
// The pointer is a visible blockquote as well as frontmatter, because a reader
// in Obsidian sees the rendered note and not the metadata.
export function stampSuperseded(fileText: string, by: string, date: string): string | null {
  const parsed = parseNote(fileText)
  if (!parsed) return null

  const meta: NoteMeta = { ...parsed.meta, status: "superseded", supersededBy: by }
  const rendered = renderNote(meta, parsed.sections)
  const pointer = `> **Superseded on ${date}** by \`${by}\`. Kept for the record.`
  // After the H1, so the rendered note announces it before its first claim.
  return rendered.replace(`# ${meta.title}\n`, `# ${meta.title}\n\n${pointer}\n`)
}

// --------------------------------------------------------------- the vault
//
// Resolved, then checked. A path that escapes the vault is a bug here rather
// than a possibility the model has, but the whole ungating argument rests on
// notes staying inside one directory, so it is asserted rather than assumed.
export function assertInsideVault(vaultRoot: string, relativePath: string): string {
  const root = path.resolve(vaultRoot)
  const absolute = path.resolve(root, relativePath)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside the vault: ${relativePath}`)
  }
  return absolute
}

// Temp file in the same directory, then rename. The rename is atomic within a
// filesystem, so a reader (Obsidian, Syncthing, a later scan) sees either the
// old note or the new one and never a half-written file. Same directory
// deliberately: /tmp can be a different filesystem, where rename falls back to
// a copy and stops being atomic.
export function writeNoteFile(vaultRoot: string, relativePath: string, text: string): string {
  const absolute = assertInsideVault(vaultRoot, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temp = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.writeFileSync(temp, text, "utf8")
    fs.renameSync(temp, absolute)
  } catch (err) {
    // A failed write must not leave a .tmp- file in the vault for Syncthing to
    // replicate and Obsidian to show.
    fs.rmSync(temp, { force: true })
    throw err
  }
  return absolute
}

export function readNoteFile(vaultRoot: string, relativePath: string): string | null {
  const absolute = assertInsideVault(vaultRoot, relativePath)
  try {
    return fs.readFileSync(absolute, "utf8")
  } catch {
    return null
  }
}
