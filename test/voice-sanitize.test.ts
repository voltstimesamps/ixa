import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeForSpeech } from "../src/voice/sanitize"

// The sanitizer is the backstop behind VOICE_RESPONSE_PROMPT: these are the
// shapes a model actually produced when told not to format a spoken reply.

test("plain prose is returned untouched", () => {
  const text = "A used 3060 runs about two hundred dollars. Want me to check listings?"
  assert.equal(sanitizeForSpeech(text), text)
})

test("bold, italics and strikethrough markers are removed, text kept", () => {
  assert.equal(sanitizeForSpeech("The **RTX 3060** is the *best* value."), "The RTX 3060 is the best value.")
  assert.equal(sanitizeForSpeech("__Important:__ check the VRAM."), "Important: check the VRAM.")
  assert.equal(sanitizeForSpeech("It is _probably_ fine."), "It is probably fine.")
  assert.equal(sanitizeForSpeech("That was ~~cheap~~ expensive."), "That was cheap expensive.")
  assert.equal(sanitizeForSpeech("***Never*** do that."), "Never do that.")
})

test("underscores inside identifiers and filenames survive", () => {
  assert.equal(
    sanitizeForSpeech("Check search_memory in episodic_memory.ts first."),
    "Check search_memory in episodic_memory.ts first."
  )
})

test("a literal asterisk between numbers is not treated as emphasis", () => {
  assert.equal(sanitizeForSpeech("That is 2 * 3 * 4 watts."), "That is 2 * 3 * 4 watts.")
})

test("headings become sentences", () => {
  assert.equal(sanitizeForSpeech("## Best value\nThe 3060."), "Best value. The 3060.")
  assert.equal(sanitizeForSpeech("# Already punctuated?\nYes."), "Already punctuated? Yes.")
})

test("bulleted list items become plain sentences", () => {
  const reply = "Here are options:\n- The RTX 3060\n- The RX 6600\n* The Arc A750"
  assert.equal(
    sanitizeForSpeech(reply),
    "Here are options: The RTX 3060. The RX 6600. The Arc A750."
  )
})

test("numbered list markers are removed without becoming spoken digits", () => {
  const reply = "1. Check the price.\n2) Check the VRAM.\n10. Then decide."
  const spoken = sanitizeForSpeech(reply)
  assert.equal(spoken, "Check the price. Check the VRAM. Then decide.")
  assert.ok(!/^\d/.test(spoken), "no list number survives at the start")
})

test("task list boxes are removed", () => {
  assert.equal(sanitizeForSpeech("- [ ] Buy it\n- [x] Benchmark it"), "Buy it. Benchmark it.")
})

test("code fences are dropped but the code inside is kept", () => {
  const reply = "Run this:\n```bash\nnpm test\n```\nThen look at the output."
  assert.equal(sanitizeForSpeech(reply), "Run this: npm test. Then look at the output.")
})

test("inline code keeps its content", () => {
  assert.equal(sanitizeForSpeech("Run `npm run dev` first."), "Run npm run dev first.")
})

test("links are reduced to their link text", () => {
  assert.equal(
    sanitizeForSpeech("See [the Kokoro repo](https://github.com/hexgrad/kokoro) for details."),
    "See the Kokoro repo for details."
  )
})

test("a link with no text falls back to the URL, and an image to its alt text", () => {
  assert.equal(sanitizeForSpeech("Here: [](https://example.com)"), "Here: https://example.com.")
  assert.equal(sanitizeForSpeech("![a benchmark chart](chart.png)"), "a benchmark chart.")
})

test("autolinks lose their angle brackets", () => {
  assert.equal(sanitizeForSpeech("Try <https://example.com> now."), "Try https://example.com now.")
})

test("blockquote markers are removed, including nested ones", () => {
  assert.equal(sanitizeForSpeech("> > It depends on the card."), "It depends on the card.")
})

test("horizontal rules produce no speech", () => {
  assert.equal(sanitizeForSpeech("First part.\n---\nSecond part."), "First part. Second part.")
  assert.equal(sanitizeForSpeech("***"), "")
})

test("blank lines and stray whitespace collapse to single spaces", () => {
  assert.equal(sanitizeForSpeech("One.\n\n\nTwo.   Three."), "One. Two. Three.")
})

test("nothing is truncated, however long the reply", () => {
  const long = Array.from({ length: 200 }, (_, i) => `- Item number ${i} is worth mentioning`).join("\n")
  const spoken = sanitizeForSpeech(long)
  assert.ok(spoken.includes("Item number 0"), "the first item survives")
  assert.ok(spoken.includes("Item number 199"), "the last item survives")
  assert.equal(spoken.split(". ").length, 200, "every item is its own sentence")
})

test("a heavily formatted reply reaches TTS with no markdown left in it", () => {
  const reply = [
    "## GPU recommendations",
    "",
    "Here are the **top picks** for a budget build:",
    "",
    "1. **RTX 3060 12GB** — about `$200` used. [Listings](https://example.com/3060)",
    "2. *RX 6600* — cheaper, but no CUDA",
    "",
    "> Note: check the _seller's_ return policy.",
    "",
    "```",
    "nvidia-smi",
    "```",
  ].join("\n")

  const spoken = sanitizeForSpeech(reply)
  for (const marker of ["**", "##", "```", "`", "](", "> ", "~~"]) {
    assert.ok(!spoken.includes(marker), `"${marker}" must not reach TTS — got: ${spoken}`)
  }
  assert.ok(spoken.startsWith("GPU recommendations."))
  assert.ok(spoken.includes("RTX 3060 12GB"))
  assert.ok(spoken.includes("$200"))
  assert.ok(spoken.includes("Listings"))
  assert.ok(spoken.includes("nvidia-smi"))
})

test("empty and whitespace-only input produce nothing to speak", () => {
  assert.equal(sanitizeForSpeech(""), "")
  assert.equal(sanitizeForSpeech("   \n\n  "), "")
  assert.equal(sanitizeForSpeech("```\n```"), "")
})

// ------------------------------------------------- Unicode space separators
//
// The model writes U+202F NARROW NO-BREAK SPACE between a name and the number
// after it — 127 occurrences in the recorded replies. It is invisible, and it
// was deciding whether Kokoro read "RTX 3090" as "thirty ninety" or as "three
// thousand ninety". These assert the fold, not the rendering: what the
// synthesizer does with the result is measured in Ixa-Tests/tts.

test("a narrow no-break space between a name and its number becomes a plain space", () => {
  assert.equal(sanitizeForSpeech("A used RTX\u202F3090 is fine."), "A used RTX 3090 is fine.")
  assert.equal(sanitizeForSpeech("It has 16\u202FGB of VRAM."), "It has 16 GB of VRAM.")
})

test("every Unicode space separator is folded, not just the narrow one", () => {
  // U+00A0 no-break, U+2009 thin, U+202F narrow no-break, U+205F medium
  // mathematical, U+3000 ideographic. All of them are spaces to a reader and
  // none of them is a space to the G2P.
  assert.equal(
    sanitizeForSpeech("RTX\u00A03060 RTX\u20093070 RTX\u202F3080 RTX\u205F3090 RTX\u30004090."),
    "RTX 3060 RTX 3070 RTX 3080 RTX 3090 RTX 4090."
  )
})

test("folded spaces collapse like ASCII ones rather than stacking up", () => {
  assert.equal(sanitizeForSpeech("The\u202F \u202FRTX 3060 is fine."), "The RTX 3060 is fine.")
})

test("a non-breaking hyphen is left alone", () => {
  // Folding it to an ASCII hyphen makes "i5-12400" read as "one two four zero
  // zero", which is worse than what it does now. Instead of choosing between
  // two wrong readings, src/voice/partnumbers.ts renders that family
  // explicitly \u2014 so the hyphen's survival is asserted on compounds here, and
  // the Intel case is asserted in test/voice-partnumbers.test.ts.
  assert.equal(sanitizeForSpeech("A 12\u2011GB card."), "A 12\u2011GB card.")
  assert.equal(sanitizeForSpeech("A pre\u2011built with a 7\u2011B model."), "A pre\u2011built with a 7\u2011B model.")
})

test("a price range separated by narrow spaces keeps its two amounts apart", () => {
  // Verbatim from a recorded reply. With the narrow spaces in place Kokoro read
  // the whole range as one fused number — "one-three-hundred-dash-one".
  //
  // The dash itself is now the spoken word "to" rather than a silent character
  // between the two amounts: see src/voice/prices.ts. What this asserts is
  // still the fold — that the two amounts survive as two amounts — which is
  // the precondition for the range rule having anything to match.
  assert.equal(
    sanitizeForSpeech("Roughly $1,300\u202F–\u202F$1,400 today."),
    "Roughly $1,300 to $1,400 today."
  )
})

test("a narrow space does not hide a list marker from the stripper", () => {
  assert.equal(sanitizeForSpeech("-\u202FThe RTX 3060\n-\u202FThe RX 6600"), "The RTX 3060. The RX 6600.")
})
