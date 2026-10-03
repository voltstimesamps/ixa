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
  let working = text.replace(/\r\n/g, "\n").replace(/^[ \t]*```+[^\n]*$/gm, "")

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
  return blocks.join(" ").replace(/[ \t]{2,}/g, " ").trim()
}
