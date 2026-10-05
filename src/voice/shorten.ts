// The length backstop behind VOICE_RESPONSE_PROMPT: speak at most N spoken
// units and offer the rest.
//
// The prompt (and now its examples) is the mechanism. This is what happens
// when the model ignores it anyway — one live reply named four GPUs where the
// prompt asks for one or two. Unlike sanitizeForSpeech, which deliberately
// truncates nothing, this one does cut. Three rules make that safe:
//
//   1. IT ONLY EVER CUTS AT A BOUNDARY. If there is no boundary at or before
//      the limit, the whole reply is spoken. A reply that sounds verbose is
//      survivable; one that stops mid-sentence sounds broken.
//   2. IT CUTS THE ORIGINAL TEXT, by offset. The kept prefix keeps whatever
//      markdown it had and still goes through sanitizeForSpeech at the TTS
//      boundary, exactly as an untrimmed reply does. Nothing here duplicates
//      the sanitizer's job.
//   3. VOICE-ORIGIN TURNS ONLY. The caller enforces that; a text client asked
//      for text and gets all of it.
//
// "Spoken unit", not "sentence", because the thing being counted is how many
// times the listener hears a full stop — and the sanitizer already turns a
// heading or a list item into one of those. Counting sentence-ending
// punctuation alone would wave a six-item markdown list straight through,
// since a list has almost no periods in it. So a line break is a boundary
// here for the same reason it is one in the sanitizer.

// Spoken after a trimmed reply, in place of the items that were dropped. A
// fixed string, like TURN_FAILURE_APOLOGY: it is spoken on a path where the
// model is not consulted, so it cannot be generated.
export const CONTINUE_OFFER = "There's more if you want it."

// Words that end in a period without ending a sentence. The lowercase-follows
// guard below catches most of these on its own ("e.g. the 3060"); these are
// the ones a capital letter legitimately follows.
const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "mt",
  "inc", "ltd", "co", "vs", "etc", "approx", "est", "no", "fig",
  "eg", "ie", "am", "pm", "us", "uk",
])

export interface Shortened {
  // What to speak, send to the client and record. The original text when
  // nothing was trimmed.
  spoken: string
  trimmed: boolean
  // Units kept and units found. Equal when nothing was trimmed.
  kept: number
  total: number
}

// Where one spoken unit ends, as an offset into the original text.
function unitEnds(text: string): number[] {
  const ends: number[] = []

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    // A line break ends a unit: the sanitizer will turn whatever precedes it
    // into its own sentence, so that is what the listener hears.
    if (char === "\n") {
      const end = i
      if (text.slice(ends.at(-1) ?? 0, end).trim()) ends.push(end)
      continue
    }

    if (char !== "." && char !== "!" && char !== "?") continue

    // Run past "?!" and "..." so the whole cluster is one boundary, then past
    // any closing quote or bracket that belongs to the sentence.
    let cursor = i
    while (cursor + 1 < text.length && /[.!?]/.test(text[cursor + 1]!)) cursor++
    const ellipsis = cursor > i && text[i] === "." && text[cursor] === "."
    while (cursor + 1 < text.length && /["'”’)\]]/.test(text[cursor + 1]!)) cursor++

    // A boundary needs whitespace after it. This is what keeps "$30.90",
    // "1.2.1" and "3.5" from being read as sentence ends — in every one of
    // them the period is followed by a digit, not a space.
    const next = text[cursor + 1]
    if (next !== undefined && !/\s/.test(next)) {
      i = cursor
      continue
    }

    if (!ellipsis && !isRealBoundary(text, i, cursor, ends.at(-1) ?? 0)) {
      i = cursor
      continue
    }

    const end = cursor + 1
    if (text.slice(ends.at(-1) ?? 0, end).trim()) ends.push(end)
    i = cursor
  }

  // Whatever trails the last boundary is a unit too, even unpunctuated.
  const tail = ends.at(-1) ?? 0
  if (text.slice(tail).trim()) ends.push(text.length)

  return ends
}

// Rejects the punctuation at `start`..`cursor` as a sentence end. Biased
// towards "not a boundary": a missed boundary makes a reply longer than
// intended, while a false one spends a unit of the budget on a fragment.
function isRealBoundary(text: string, start: number, cursor: number, unitStart: number): boolean {
  const before = text.slice(unitStart, start)
  const word = /([A-Za-z]+)$/.exec(before)?.[1]
  if (word && ABBREVIATIONS.has(word.toLowerCase())) return false
  // A single initial, as in "R. Smith".
  if (word && word.length === 1 && word === word.toUpperCase()) return false

  // An ordered-list marker: "1. Buy the 3060". The digits are the marker, not
  // a sentence, and the item itself is the unit.
  if (/(^|\s)\d{1,3}$/.test(before) && !/[A-Za-z]/.test(before.trim())) return false

  // A real sentence end is followed by something that starts a sentence. A
  // lowercase letter means the period was doing something else.
  const after = /^\s+(\S)/.exec(text.slice(cursor + 1))?.[1]
  if (after && /[a-z]/.test(after)) return false

  return true
}

export function shortenForSpeech(text: string, maxUnits: number): Shortened {
  const whole = (count: number): Shortened => ({
    spoken: text,
    trimmed: false,
    kept: count,
    total: count,
  })

  if (!text.trim()) return whole(0)
  // Zero or less turns the backstop off, which is what the scoreboard uses to
  // measure the prompt change on its own.
  if (!Number.isFinite(maxUnits) || maxUnits < 1) return whole(unitEnds(text).length)

  const ends = unitEnds(text)
  if (ends.length <= maxUnits) return whole(ends.length)

  const kept = text.slice(0, ends[maxUnits - 1]!).trimEnd()

  // An offer after a question would be a second question in a row, and the
  // model's own closing question already invites the follow-up.
  const spoken = kept.endsWith("?") ? kept : `${kept} ${CONTINUE_OFFER}`

  return { spoken, trimmed: true, kept: maxUnits, total: ends.length }
}
