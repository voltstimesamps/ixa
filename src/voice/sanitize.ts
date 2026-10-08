// Markdown stripping for text on its way to the TTS sidecar.
//
// VOICE_RESPONSE_PROMPT tells the model not to format a spoken reply. This is
// what happens when it does anyway: Kokoro phonemizes what it is given, so
// "**Best value:** the 3060" is read out with the asterisks, and "1." becomes
// the spoken word "one". One live reply produced 87 seconds of that.
//
// Two rules:
//   1. NOTHING IS TRUNCATED. A reply that is too long is a prompting problem
//      and cutting it mid-sentence would make Ixa sound broken instead of
//      verbose. Every word in goes out; only the markup is removed.
//   2. The ORIGINAL text is what gets stored and what text clients see. This
//      runs at the TTS boundary (speak() in src/api/websocket.ts) and nowhere
//      else, so session history keeps exactly what the model wrote.
//
// Output is punctuated prose joined by single spaces. That matters: the
// sidecar's split_pattern chunks on sentence endings and newlines, so turning
// an unpunctuated heading or list item into a sentence is what lets it stream
// one chunk per item instead of one chunk for the whole reply.
//
// Deliberately out of scope: markdown tables. A spoken table is unsalvageable
// whatever we do to the pipes, and the fix is the model not writing one.
//
// TWO STAGES, one entry point. The markdown stripping is here; the part-number
// rendering that follows it is in src/voice/partnumbers.ts, called from the
// bottom of sanitizeForSpeech. They are composed rather than called separately
// because there are two callers — speak() in src/api/websocket.ts and
// dev/scripts/tts-render-check.ts — and the harness's guarantee that what is
// measured is what runs would otherwise depend on remembering to update both.
//
// The order is not a preference. The rendering has to see text with the
// markup already gone: a leaked asterisk fuses into the token after it, which
// is measurable in the phonemes, and a part number with "**" against it is not
// a part number any pattern will match.

import { renderPartNumbers } from "./partnumbers"

// Every Unicode space separator (category Zs) folded to a plain ASCII space.
//
// This is the single highest-value line in the speech path, and it is here
// rather than in a part-number table because the SEPARATOR, not the digits, is
// what decides how Kokoro reads a model number. Measured through misaki's
// G2P — the one KPipeline calls — on the same card with four separators:
//
//   "RTX 3090"       (ASCII space)  -> "thirty ninety"          correct
//   "RTX\u202f3090"  (U+202F)       -> "three thousand ninety"  wrong
//   "RTX-3090"                      -> "thirty ninety"          correct
//   "RTX3090"                       -> "thirty ninety"          correct
//
// The model writes U+202F NARROW NO-BREAK SPACE between a name and the number
// that follows it constantly — 127 occurrences across the recorded replies in
// data/ixa.db — and it is invisible in every terminal and every log line. With
// it gone, Kokoro reads every current GPU and AMD CPU number correctly on its
// own: 31 of 31 GPU strings probed, 50/40/30/20/16/10 series, RX 9070 XT
// through RX 6600, and Ryzen 5600G through 9950X3D. No table of cards is
// needed for any of them, and none is needed for a generation not yet
// released: "RTX 6090" already reads "sixty ninety".
//
// What U+202F costs is not only model numbers. Over the 19 recorded replies
// that contain one, folding it fixes a price range read as a different number
// ("$1,300 – $1,400" was "one-three-hundred-dash-one"), "Ubuntu 24.04" read as
// "twenty four zero four", "$500 12 GB" fused into one number, "LM Studio" and
// "Raspberry". Sixteen of the nineteen change, and exactly one rendering got
// worse — "Ti", handled in src/voice/partnumbers.ts.
//
// Two things the fold does NOT do, measured over the same fixtures so that
// neither is mistaken for a fix:
//   - "$1<U+202F>200", where the model used U+202F as a THOUSANDS separator
//     rather than before a unit, still reads "one two hundred dollars". It
//     gains the missing "dollars" and keeps the wrong amount. See
//     src/core/prices.ts, which documents that live shape.
//   - "PCIe<U+202F>4.0" read "four dot zero" fused and now reads "PCIe four":
//     the natural spoken form, but the ".0" is silent rather than spoken.
//
// U+2011 NON-BREAKING HYPHEN is deliberately NOT normalized alongside it.
// Folding it to an ASCII hyphen makes an Intel part number worse, not better:
// "i5\u201112400" reads "twelve thousand four hundred", while "i5-12400"
// reads "one two four zero zero". Neither is right, and partnumbers.ts renders
// that family explicitly instead of choosing between two wrong readings.
const UNICODE_SPACES = /\p{Zs}/gu

// A block that already ends in punctuation is left alone; one that does not
// gets a period, so it reads as a sentence and chunks like one.
function asSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  return /[.!?:;,]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function stripInline(text: string): string {
  return (
    text
      // Images before links: ![alt](url) keeps the alt text, which is the only
      // part that can be spoken.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_match, label: string, url: string) =>
        // An empty label would leave nothing to say, so fall back to the URL.
        label.trim() ? label : url
      )
      // <https://example.com> — speak the address rather than the brackets.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      // Inline code: drop the backticks, keep the code. It is often the
      // answer ("run `npm test`").
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // Single-asterisk emphasis. Requires a non-space first character so a
      // literal "2 * 3" is not treated as an opening marker.
      .replace(/\*(?=\S)([^*]*[^*\s])\*/g, "$1")
      .replace(/\*(\S)\*/g, "$1")
      // Underscore emphasis only at word boundaries: snake_case identifiers
      // and file names must survive intact.
      .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2")
      .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2")
  )
}

export function sanitizeForSpeech(text: string): string {
  if (!text) return ""

  // Code fences first, before anything inspects line starts: the content of a
  // fenced block is kept but must not be read as markdown, and a "```" line
  // is itself never speakable.
  // Space folding comes first, so every rule below — the line-start markers,
  // the inline strippers and the final whitespace collapse, all of which are
  // written for an ASCII space — sees one.
  let working = text
    .replace(/\r\n/g, "\n")
    .replace(UNICODE_SPACES, " ")
    .replace(/^[ \t]*```+[^\n]*$/gm, "")

  const blocks: string[] = []

  for (const rawLine of working.split("\n")) {
    let line = rawLine.trim()
    if (!line) continue

    // Horizontal rules carry no speech.
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue

    // Blockquotes: possibly nested, e.g. "> > quoted".
    line = line.replace(/^(?:>\s*)+/, "")
    // Headings become their own sentence.
    line = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "")
    // List markers: "- ", "* ", "+ ", "1. ", "2) ", and task boxes.
    line = line.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "")
    // Definition-list style leading colon.
    line = line.replace(/^:\s+/, "")

    line = stripInline(line).trim()
    if (!line) continue

    blocks.push(asSentence(line))
  }

  // Single spaces throughout: the sidecar splits on sentence endings, and a
  // stray newline would split a chunk at a place with no pause in it.
  const stripped = blocks.join(" ").replace(/[ \t]{2,}/g, " ").trim()

  // Last, on the finished prose. See the note on the two stages above.
  return renderPartNumbers(stripped)
}
