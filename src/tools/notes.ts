import { currentTurnEvidence } from "../core/session-context"
import {
  findCurrencyAmounts,
  priceAsOfLine,
  priceRefusal,
  unsupportedAmounts,
} from "../core/prices"
import { getNotebook } from "../memory/notebook"
import { NOTE_TYPES, type NoteSection, type NoteType } from "../memory/notes-markdown"
import type { NoteHit } from "../memory/notebook"
import type { Tool } from "./registry"

// save_note and search_notes: Ixa's notebook.
//
// requiresConfirmation IS FALSE FOR BOTH, and the argument is longer than the
// one for the preference tools, because it has to be.
//
// The easy half is the same: the notebook is Ixa's own directory, nothing
// leaves the machine, and a change supersedes rather than overwrites. The
// part that argument does NOT cover is that a wrong note PERSISTS. A
// preference stated wrongly is corrected the next time the user notices it
// being applied; a note stated wrongly is a file that a search hands back
// later as something Ixa recorded, long after the conversation that could
// have corrected it is gone.
//
// Four things carry that risk instead of a confirmation prompt:
//
//   1. THE MODEL CANNOT NAME A PATH. There is no path field in the schema;
//      the path is derived from type, title and date in notes-markdown.ts and
//      asserted to be inside the vault. That is the difference from
//      shell_write, which does confirm: not "we trust it with files" but "it
//      cannot choose one".
//   2. READ-BACK. The result returns the title and summary that were actually
//      written, so the reply says what is on disk rather than what was meant.
//   3. PROVENANCE IS STAMPED BY THE HARNESS. Source, session and date come
//      from the turn, never from the model — asked for them in the spike it
//      invented a session id ("?").
//   4. THE PRICE RULE. A currency amount must come from the user's own turn
//      or from a web_search that ran in this turn, or nothing is saved.
//
// This reasoning does not generalise, and it is written here rather than in
// ARCHITECTURE.md alone so that it is in front of whoever changes this file.

const SAVE_NOTE_DESCRIPTION =
  "Write a note in your notebook: a FACT, a DECISION and why it was made, or ongoing WORK. " +
  "Not how the user wants you to behave — that is remember_preference. " +
  "Call search_notes first, every time: if a note already covers this, set 'supersedes' to its " +
  "id rather than writing a second note that disagrees with the first. Write only what the user " +
  "said or what a tool returned; if a detail is missing, leave it out or ask for it. " +
  "A price must be one the user gave you or one web_search returned in this turn."

const SEARCH_NOTES_DESCRIPTION =
  "Search your notebook, which holds facts, decisions and ongoing work you wrote down earlier. " +
  "With a query it searches by meaning; with no query it returns the most recent notes. " +
  "Call it before save_note, and whenever the user asks about something written down. " +
  "For past CONVERSATIONS use search_memory instead."

// The type descriptions are EXAMPLES, not definitions. Measured: given
// definitions ("a durable fact that is not a choice and not a plan") the spike
// model typed five of six notes `reference`, including a decision it had just
// been told was a decision.
const TYPE_DESCRIPTION =
  'decision: "Tavily replaced Brave for search". ' +
  'project: "the homelab GPU budget is settled". ' +
  'reference: "the backend runs in WSL2 on the gaming PC".'

interface SaveNoteInput {
  type?: unknown
  title?: unknown
  summary?: unknown
  sections?: unknown
  supersedes?: unknown
}

function asSections(value: unknown): NoteSection[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const sections: NoteSection[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null
    const record = entry as Record<string, unknown>
    if (typeof record.heading !== "string" || typeof record.body !== "string") return null
    if (!record.heading.trim() || !record.body.trim()) return null
    sections.push({ heading: record.heading.trim(), body: record.body })
  }
  return sections
}

// Local, NOT toISOString(): the date a note carries is the user's own day, and
// a UTC slice puts it up to a day off for anyone west of Greenwich — the same
// reason search_memory parses its bounds with the local Date constructor.
export function localDateString(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

// Everything the note will say, for the price check. The title and summary are
// included because a figure in a summary is the one a search is most likely to
// surface.
function noteText(title: string, summary: string, sections: NoteSection[]): string {
  return [title, summary, ...sections.map((s) => `${s.heading}\n${s.body}`)].join("\n\n")
}

function renderHit(hit: NoteHit, index: number): string {
  const head =
    `${index + 1}. [${hit.note.type}] "${hit.note.title}" — id ${hit.note.id}, ${hit.note.date}`
  const where = hit.headingPath ? ` (${hit.headingPath})` : ""
  return `${head}${where}\n   ${hit.note.summary}\n   ---\n${hit.text}`
}

const UNAVAILABLE =
  "Your notebook cannot be searched right now (the vector index or embedding service is not " +
  "reachable). Tell the user you cannot search your notes at the moment rather than guessing at " +
  "what you wrote, and do not call save_note — you cannot check for an existing note first."

// Said on every search, including a good one. The spike measured why: with
// this embedder, text that genuinely answered a question scored as low as
// 0.586 while text from an entirely unrelated note reached 0.755. There is no
// threshold that separates them, so the results are ranked and the reader is
// told to judge them.
const MAY_BE_UNRELATED =
  "These are the closest matches by meaning, not necessarily answers — a note may be here only " +
  "because it is the nearest thing you have written. Use one only if it actually addresses the " +
  "question, and say you have nothing written down if none of them do."

export const saveNoteTool: Tool = {
  name: "save_note",
  description: SAVE_NOTE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: NOTE_TYPES, description: TYPE_DESCRIPTION },
      title: {
        type: "string",
        description:
          'A specific sentence, not a category: "Notes are written by Ixa, not hand-edited", not "Notes".',
      },
      summary: {
        type: "string",
        description:
          "One or two sentences of the actual facts. This is what a later search matches on.",
      },
      sections: {
        type: "array",
        description: "The body. One section is fine.",
        items: {
          type: "object",
          properties: { heading: { type: "string" }, body: { type: "string" } },
          required: ["heading", "body"],
        },
      },
      supersedes: {
        type: "string",
        description:
          "Id of the note this replaces, exactly as search_notes gave it. The new note must say what it replaces and why.",
      },
    },
    required: ["type", "title", "summary", "sections"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    const notebook = getNotebook()
    if (!notebook) return "The notebook is not available, so nothing was saved."

    const raw = (typeof input === "object" && input !== null ? input : {}) as SaveNoteInput
    const type = typeof raw.type === "string" ? raw.type : ""
    const title = typeof raw.title === "string" ? raw.title.trim() : ""
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : ""
    const sections = asSections(raw.sections)

    if (!NOTE_TYPES.includes(type as NoteType)) {
      return `Nothing was saved: 'type' must be one of ${NOTE_TYPES.join(", ")}.`
    }
    if (!title) return "Nothing was saved: 'title' is required."
    if (!summary) return "Nothing was saved: 'summary' is required."
    if (!sections) {
      return "Nothing was saved: 'sections' must be a non-empty list of {heading, body}, both non-empty."
    }

    // FAIL CLOSED. No turn context means the price rule cannot be checked, and
    // unverifiable is not the same as verified — a dev script or a test that
    // wants to write a note has to provide a turn.
    const evidence = currentTurnEvidence()
    if (!evidence) {
      return (
        "Nothing was saved: save_note can only be called inside a conversation turn, because a " +
        "note's provenance and any price in it come from the turn."
      )
    }

    const body = noteText(title, summary, sections)
    const unsupported = unsupportedAmounts(body, [evidence.userText, ...evidence.searchResults])
    if (unsupported.length > 0) return priceRefusal(unsupported, "save_note")

    const date = localDateString()

    // A note that states a price carries its own date, appended HERE and not
    // asked of the model: a figure in a file has no conversation around it to
    // say when it was true.
    const priced = findCurrencyAmounts(body).length > 0
    const stamped = priced
      ? sections.map((section, index) =>
          index === sections.length - 1
            ? { ...section, body: `${section.body.trimEnd()}\n\n${priceAsOfLine(date)}` }
            : section
        )
      : sections

    try {
      const result = await notebook.save({
        type: type as NoteType,
        title,
        summary,
        sections: stamped,
        ...(typeof raw.supersedes === "string" && raw.supersedes.trim()
          ? { supersedes: raw.supersedes.trim() }
          : {}),
        source: evidence.source,
        sessionId: evidence.sessionId,
        date,
      })

      // The read-back. Deliberately quotes the title and summary that were
      // WRITTEN, so the reply describes the file rather than the intention.
      const lines = [
        `Saved ${result.note.type} note "${result.note.title}" (id ${result.note.id}).`,
        `Summary on disk: ${result.note.summary}`,
      ]
      if (result.superseded) {
        lines.push(
          `Superseded "${result.superseded.title}" (id ${result.superseded.id}); its text is ` +
            `kept and marked superseded.`
        )
      }
      if (result.supersedeProblem) lines.push(result.supersedeProblem)
      // Suppressed when the clashing note is the one that was just superseded:
      // the model reused the title AND set supersedes, which is the case the
      // collision rule exists for, and telling it to supersede what it has
      // already superseded is noise contradicting the line above.
      if (result.titleClash && result.titleClash.id !== result.superseded?.id) {
        lines.push(
          `Note that "${result.titleClash.title}" (id ${result.titleClash.id}) already existed ` +
            `with different content, so this was saved as a separate note rather than written ` +
            `over it. If it was meant to replace that one, call save_note again with ` +
            `supersedes="${result.titleClash.id}".`
        )
      }
      if (priced) lines.push(`A dated price caveat was added to the note automatically.`)
      if (!result.indexed) {
        lines.push(
          "The file is written but could not be indexed yet, so it will not be findable by " +
            "search_notes until the index recovers. Say so if the user asks."
        )
      }
      lines.push("Tell the user in one short sentence what you saved, using the title above.")
      return lines.join("\n")
    } catch (err) {
      return `Nothing was saved: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export const searchNotesTool: Tool = {
  name: "search_notes",
  description: SEARCH_NOTES_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional. What to look for, in plain language. OMIT IT to get the most recent notes.",
      },
    },
    // Nothing required: no argument at all is the valid "what have I written
    // down lately?" call, answered from SQLite with no embedding.
    required: [],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    const notebook = getNotebook()
    if (!notebook) return UNAVAILABLE

    const raw = (typeof input === "object" && input !== null ? input : {}) as { query?: unknown }
    // A blank query is treated as no query, for the reason search_memory
    // documents: the model sends `query: ""` rather than omitting the field,
    // and embedding an empty string returns the opposite of what it meant.
    const query = typeof raw.query === "string" ? raw.query.trim() : ""

    const result = query ? await notebook.search(query) : notebook.recent()
    if (!result.available) return UNAVAILABLE

    if (result.hits.length === 0) {
      return query
        ? "Nothing in your notebook matches that. You have not written a note about it."
        : "Your notebook is empty — you have not written any notes yet."
    }

    const header = query
      ? `${result.hits.length} note(s) closest to that, best first:`
      : `Your ${result.hits.length} most recent note(s), newest first:`
    const body = result.hits.map(renderHit).join("\n\n")
    return query ? `${header}\n${body}\n\n${MAY_BE_UNRELATED}` : `${header}\n${body}`
  },
}
