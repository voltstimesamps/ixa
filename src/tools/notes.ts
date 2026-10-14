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
import { OPTIONAL_STRING, optionalString, type Tool } from "./registry"

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
//   2. READ-BACK. The result returns the title, the summary AND — for a note
//      whose body fits a spoken reply — the body itself, all as they were
//      actually written, so the reply says what is on disk rather than what
//      was meant. The body is there because the title was not enough: a live
//      turn saved a misheard path and reported the title, which was right.
//      See READ_BACK_THE_BODY.
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
  // THIS CLAUSE CLAIMS THE VERB, and it is the only thing measured to fix the
  // reverse-routing failure. Measured: "remember that the stt sidecar uses
  // base.en, not small" was filed as a PREFERENCE in 4 runs of 4 without this
  // clause, and wrote a reference note in 2 of 2 with it. The cost seen once,
  // in a single run: "from now on keep your spoken answers really short" made
  // no tool call at all and replied "Got it" having stored nothing. Routing is
  // noisy enough that one run per state is suggestive, not conclusive — see
  // ARCHITECTURE.md, which carries the per-probe table and the condition for
  // reverting this.
  "\"Remember that ...\" is this tool when what follows is a fact or a decision. " +
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

// WHAT THE MODEL ACTUALLY SENDS. Measured over twenty spoken saves: the FIRST
// save_note call of every single one carried a type outside the set — "note"
// nineteen times, "FACT" once — was refused, and was corrected on the next
// iteration. Twenty of twenty. The refusal worked; it just cost an LLM round
// trip on every note the user has ever saved, and before the log word was
// honest (`noteFailure`) it was invisible, logged as `tool save_note ok 0ms`.
//
// So the value is coerced instead of refused. Case and surrounding whitespace
// are a typing slip, not a decision, and "FACT" is the model agreeing with the
// description and disagreeing with the vocabulary. Anything else becomes
// `reference`, which is where five of six notes land when the model DOES pick
// (see TYPE_DESCRIPTION above), so the coercion mostly agrees with the choice
// it would have made on the second attempt.
//
// The correction is reported in the result rather than swallowed: without it
// the model describes a note it has just saved as a `fact` note, because its
// own arguments are all it has to go on. The log needs no help — it already
// prints the arguments that were sent — but a coercion nobody is told about
// would make `reference` the behaviour and the description a decoration.
export function coerceNoteType(value: unknown): { type: NoteType; given: string | null } {
  const given = typeof value === "string" ? value.trim() : ""
  const match = NOTE_TYPES.find((valid) => valid === given.toLowerCase())
  if (match) return { type: match, given: null }
  return { type: "reference", given }
}

export function typeCoercedLine(given: string): string {
  const what = given
    ? `'type' was "${given}", which is not one of ${NOTE_TYPES.join(", ")}`
    : "'type' was missing"
  return `${what}, so this was saved as a reference note.`
}

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

// -------------------------------------------------------------- read-back
//
// WHAT THE REPLY MUST SAY. The result used to end "Tell the user in one short
// sentence what you saved, using the title above", and the model obeyed it to
// the letter on a note whose body was wrong — see the live turn quoted at the
// read-back itself. The title is the one part of a note that a mishearing is
// least likely to land in, because the model composes it; the body is where
// the user's own words go, mangled or not.
//
// 120 chars, which is about twenty spoken words: enough for a path, a name, a
// version or a price, and short enough that reading it back cannot push a
// spoken reply past the ~35-word budget VOICE_RESPONSE_PROMPT asks for.
// Measured against the real speech path, "I wrote it down: the Ixa repo is at
// /home/wyatt/Projects/ixa." is ten words and one spoken unit, because
// `countWords` charges a whole path as ONE word and shortenForSpeech only ever
// cuts at a unit boundary — so a one-sentence read-back cannot be truncated
// mid-path.
export const BODY_READBACK_MAX_CHARS = 120

const READ_BACK_THE_BODY =
  "Tell the user in one short sentence what you saved, and REPEAT THE BODY ABOVE WORD FOR WORD " +
  "— the value exactly as it is written, every character of it, not a paraphrase and not a " +
  "description of it. The user cannot see the file. If you heard them wrongly, reading it back " +
  "is the only way they find out, and a note nobody corrects is read back as fact months later."

const READ_BACK_THE_SUMMARY =
  "This note is too long to read back in a spoken reply. Tell the user in one short sentence " +
  "what you saved, using the title and the summary above, and say the note is long so they know " +
  "they can ask for any part of it."

// ------------------------------------------------------------ what failed
//
// Exported, and compared against rather than prefix-matched, for the reason
// shell-result.ts gives: a list of strings maintained at a distance from the
// strings it matches goes stale. These two are the whole of it that is not
// already covered by the shared prefix below.

export const SEARCH_UNAVAILABLE =
  "Your notebook cannot be searched right now (the vector index or embedding service is not " +
  "reachable). Tell the user you cannot search your notes at the moment rather than guessing at " +
  "what you wrote, and do not call save_note — you cannot check for an existing note first."

export const NOTEBOOK_UNAVAILABLE = "The notebook is not available, so nothing was saved."

// Every refusal save_note writes opens with this, including priceRefusal's
// "Nothing was saved. The figure ..." — hence no colon in the prefix.
const NOTHING_SAVED = "Nothing was saved"

// Whether a note tool's RESULT reports a failure. THE LOG WORD ONLY: neither
// note tool sets `dedupeFailures`, because save_note's outcome depends on what
// web_search returned in this turn and not on its arguments alone. See
// registry.ts.
//
// "Nothing in your notebook matches that" is deliberately NOT a failure. An
// empty search is a search that worked and found nothing, which is an answer;
// calling it a failure would log every first note of a session as a problem.
export function noteFailure(result: string): boolean {
  if (result === SEARCH_UNAVAILABLE || result === NOTEBOOK_UNAVAILABLE) return true
  return result.startsWith(NOTHING_SAVED)
}

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
      // NO `enum` HERE, deliberately, even though there are exactly three
      // valid values and the description names all three.
      //
      // Groq validates a tool call against this schema before Ixa ever sees
      // it, and a rejection is a DEAD TURN: measured, "find out what a used
      // 3090 costs right now and write it down" ran its web_search, then
      // chose a type outside the set, and the turn died with
      //   parameters for tool save_note did not match schema:
      //   [`/type`: value must be one of 'decision', 'project', 'reference']
      // — no note, no answer, and the search paid for nothing. With the enum
      // gone the same mistake reaches execute(), where it costs nothing at
      // all: coerceNoteType maps it to `reference` and the result says so.
      // A schema constraint costs the whole turn; the enum here would also be
      // enforcing a distinction the model has never once got right on the
      // first try.
      type: { type: "string", description: TYPE_DESCRIPTION },
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
        type: OPTIONAL_STRING,
        description:
          "Id of the note this replaces, exactly as search_notes gave it. The new note must say what it replaces and why.",
      },
    },
    required: ["type", "title", "summary", "sections"],
  },
  requiresConfirmation: false,
  // Log word only — no `dedupeFailures`. A price refusal tells the model to
  // search and call again, and the call it comes back with is byte-identical.
  isFailure: noteFailure,
  execute: async (input: unknown): Promise<string> => {
    const notebook = getNotebook()
    if (!notebook) return NOTEBOOK_UNAVAILABLE

    const raw = (typeof input === "object" && input !== null ? input : {}) as SaveNoteInput
    const { type, given: typeGiven } = coerceNoteType(raw.type)
    const title = typeof raw.title === "string" ? raw.title.trim() : ""
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : ""
    const sections = asSections(raw.sections)

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
    // optionalString: null, "" and absent are one case. The model sends all
    // three — see OPTIONAL_STRING in registry.ts.
    const supersedes = optionalString(raw.supersedes)

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
        type,
        title,
        summary,
        sections: stamped,
        ...(supersedes ? { supersedes } : {}),
        source: evidence.source,
        sessionId: evidence.sessionId,
        date,
      })

      // The read-back. Deliberately quotes the title and summary that were
      // WRITTEN, so the reply describes the file rather than the intention.
      //
      // The title and summary were not enough, and a live turn showed exactly
      // how. Asked to note the repo path, STT delivered "slash home slash
      // WALLET slash project slash Ixa", the note went to disk saying
      // `/home/wallet/project/Ixa`, and Ixa said: *"I saved a reference note
      // titled 'Ixa repo location.'"* — true, compliant with this instruction,
      // and useless. Both the title and the summary were "Ixa repo location",
      // identical whether the path was right or wrong, because the mishearing
      // was in the BODY and nothing read the body back.
      const lines = [
        `Saved ${result.note.type} note "${result.note.title}" (id ${result.note.id}).`,
        // Only when the model's own value was not used, so the ordinary save
        // reads exactly as it did before.
        ...(typeGiven === null ? [] : [typeCoercedLine(typeGiven)]),
        `Summary on disk: ${result.note.summary}`,
      ]
      // `sections`, not `stamped`: the price caveat is appended by code and
      // announced on its own line below, and it is not a value the user needs
      // to hear back to check.
      const writtenBody = sections.map((section) => section.body.trim()).join(" ")
      if (writtenBody.length <= BODY_READBACK_MAX_CHARS) {
        lines.push(`Body on disk: ${writtenBody}`)
      }
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
      // What the description asks for and does not get. Verification measured
      // search_notes being called before only three of eight writes, and the
      // write that skipped it duplicated a note that was already there. So the
      // search runs in code on every save and its result is reported here.
      if (result.duplicates.length > 0) {
        lines.push(
          `You already have ${result.duplicates.length} note(s) that may cover this subject:`
        )
        for (const hit of result.duplicates) {
          lines.push(`  - id ${hit.note.id} — "${hit.note.title}": ${hit.note.summary}`)
        }
        lines.push(
          "If one of them is about the same thing as what you just saved, the two will disagree " +
            "later. Call save_note again with the same content and supersedes set to that id, " +
            "which marks the old one superseded instead of leaving both active. If none of them " +
            "is about the same thing, ignore this."
        )
      }
      if (priced) lines.push(`A dated price caveat was added to the note automatically.`)
      if (!result.indexed) {
        lines.push(
          "The file is written but could not be indexed yet, so it will not be findable by " +
            "search_notes until the index recovers. Say so if the user asks."
        )
      }
      lines.push(
        writtenBody.length <= BODY_READBACK_MAX_CHARS
          ? READ_BACK_THE_BODY
          : READ_BACK_THE_SUMMARY
      )
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
        type: OPTIONAL_STRING,
        description:
          "Optional. What to look for, in plain language. OMIT IT to get the most recent notes.",
      },
    },
    // Nothing required: no argument at all is the valid "what have I written
    // down lately?" call, answered from SQLite with no embedding.
    required: [],
  },
  requiresConfirmation: false,
  isFailure: noteFailure,
  execute: async (input: unknown): Promise<string> => {
    const notebook = getNotebook()
    if (!notebook) return SEARCH_UNAVAILABLE

    const raw = (typeof input === "object" && input !== null ? input : {}) as { query?: unknown }
    // A blank or null query is treated as no query, for the reason
    // optionalString documents: the model sends `query: ""` and `query: null`
    // as well as omitting the field, and embedding an empty string returns the
    // opposite of what it meant.
    const query = optionalString(raw.query) ?? ""

    const result = query ? await notebook.search(query) : notebook.recent()
    if (!result.available) return SEARCH_UNAVAILABLE

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
