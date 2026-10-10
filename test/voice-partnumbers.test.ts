import { test } from "node:test"
import assert from "node:assert/strict"
import { renderPartNumbers } from "../src/voice/partnumbers"
import { sanitizeForSpeech } from "../src/voice/sanitize"

// What the renderer puts out, asserted exactly. Whether that output SOUNDS
// right is a separate question answered by ear from Ixa-Tests/tts — these
// tests fix the transform, not the judgment about it.
//
// The cases that are NOT here matter as much as the ones that are: every
// current GPU and AMD CPU number is already read correctly once the Unicode
// spaces are folded (src/voice/sanitize.ts), so this layer leaves them alone
// and the tests below assert that it does.

// ------------------------------------------------------------------ Intel

test("a five-digit Intel part number is rendered whatever separates it", () => {
  // All four forms are wrong as written, in three different ways, which is why
  // this family is rendered instead of normalized towards one separator.
  const expected = "An Intel i five twelve four hundred build."
  assert.equal(renderPartNumbers("An Intel i5-12400 build."), expected)
  assert.equal(renderPartNumbers("An Intel i5\u201112400 build."), expected)
  assert.equal(renderPartNumbers("An Intel i5 12400 build."), expected)
  assert.equal(renderPartNumbers("An Intel i512400 build."), expected)
})

test("the generation is a pair and the model number is not read with it", () => {
  assert.equal(renderPartNumbers("i5-12400"), "i five twelve four hundred")
  assert.equal(renderPartNumbers("i7-13700"), "i seven thirteen seven hundred")
  assert.equal(renderPartNumbers("i9-14900"), "i nine fourteen nine hundred")
  assert.equal(renderPartNumbers("i5-10400"), "i five ten four hundred")
  assert.equal(renderPartNumbers("i3-13100"), "i three thirteen one hundred")
})

test("a model number that does not end in double zero keeps its last pair", () => {
  assert.equal(renderPartNumbers("i5-12450H"), "i five twelve four fifty H")
  assert.equal(renderPartNumbers("i7-12650H"), "i seven twelve six fifty H")
})

test("a four-digit Intel part number is rendered as two pairs", () => {
  // Right already with an ASCII hyphen, wrong with U+2011 — which the
  // sanitizer no longer folds. Rendered so the separator stops mattering.
  assert.equal(renderPartNumbers("i7-8700K"), "i seven eighty-seven hundred K")
  assert.equal(renderPartNumbers("i7\u20118700K"), "i seven eighty-seven hundred K")
  assert.equal(renderPartNumbers("i5-8400"), "i five eighty-four hundred")
  assert.equal(renderPartNumbers("i3-9100F"), "i three ninety-one hundred F")
  assert.equal(renderPartNumbers("i7-1165G7"), "i seven eleven sixty-five G seven")
})

test("a suffix is spoken as separate letters, with digits spelled out", () => {
  // Spaced because of one suffix: "KS" joined reads as the plural "kays".
  // Spacing is correct for all of them, so there is no exception list.
  assert.equal(renderPartNumbers("i9-14900KS"), "i nine fourteen nine hundred K S")
  assert.equal(renderPartNumbers("i5-12400KF"), "i five twelve four hundred K F")
  assert.equal(renderPartNumbers("i7-13600HX"), "i seven thirteen six hundred H X")
  assert.equal(renderPartNumbers("i5-11400F"), "i five eleven four hundred F")
})

test("the tier letter and a lowercase suffix are normalized", () => {
  assert.equal(renderPartNumbers("I5-12400k"), "i five twelve four hundred K")
})

test("an Intel part number inside a sentence does not swallow the next word", () => {
  assert.equal(
    renderPartNumbers("The i5-12400 beats the i7-8700K for the money."),
    "The i five twelve four hundred beats the i seven eighty-seven hundred K for the money."
  )
})

test("a tier with no part number after it is left alone", () => {
  // Verbatim shape from a recorded reply: "10th-gen Intel Core i7/i9 or Xeon".
  assert.equal(renderPartNumbers("Intel Core i7/i9 or Xeon"), "Intel Core i7/i9 or Xeon")
  assert.equal(renderPartNumbers("An i5 is enough."), "An i5 is enough.")
})

// --------------------------------------------------------------------- Ti

test("Ti after a model number is spoken as its two letters", () => {
  // The one rendering the space fold made worse: with U+202F in place it read
  // "tie", with a plain space it reads "tee". Spaced capitals read "tee eye",
  // which is how the suffix is said, and it is the same shape suffix() gives
  // "KF" and "KS" rather than a second convention for the same job.
  assert.equal(renderPartNumbers("The RTX 4060 Ti is fine."), "The RTX 4060 T I is fine.")
  assert.equal(renderPartNumbers("The RTX 4070 Ti Super is fine."), "The RTX 4070 T I Super is fine.")
  assert.equal(renderPartNumbers("The GTX 1050 Ti is fine."), "The GTX 1050 T I is fine.")
  assert.equal(renderPartNumbers("A 3090 Ti, used."), "A 3090 T I, used.")
})

test("Ti attached to the number is matched too", () => {
  assert.equal(renderPartNumbers("The RTX 4060Ti is fine."), "The RTX 4060 T I is fine.")
})

test("the rendered Ti does not become an Intel tier", () => {
  // The letter the suffix leaves behind sits next to a number, which is the
  // shape the Intel rule matches on. It must not: the tier letter has to be
  // followed IMMEDIATELY by 3, 5, 7 or 9, and a quantity after the suffix is
  // separated from it by a space. Verbatim corpus shape, which pairs Ti with a
  // VRAM figure.
  assert.equal(
    renderPartNumbers("Used RTX 4060 Ti 16 GB, about $420."),
    "Used RTX 4060 T I 16 GB, about $420."
  )
  assert.equal(renderPartNumbers("RTX 3070 Ti or RTX 3080."), "RTX 3070 T I or RTX 3080.")
})

test("Ti that is not a model suffix is left alone", () => {
  assert.equal(renderPartNumbers("Ti plasma etching."), "Ti plasma etching.")
  assert.equal(renderPartNumbers("A titanium Ti frame."), "A titanium Ti frame.")
  assert.equal(renderPartNumbers("Tiny but fast."), "Tiny but fast.")
  // A three-digit number is not a model number this rule knows about.
  assert.equal(renderPartNumbers("Part 390 Ti."), "Part 390 Ti.")
})

// ------------------------------------------------------- left strictly alone

test("every GPU family is passed through untouched", () => {
  // Already correct once the spaces are folded — 31 of 31 strings probed. A
  // table of cards here would have been churn with a chance of invention.
  for (const name of [
    "RTX 5090", "RTX 5080", "RTX 4090", "RTX 4080 Super", "RTX 4060", "RTX 3090",
    "RTX 3060", "RTX 2060 Super", "GTX 1660 Super", "GTX 1650", "GTX 1060",
    "RX 9070 XT", "RX 7900 XTX", "RX 7800 XT", "RX 7600", "RX 6950 XT", "RX 6600",
    "Ryzen 5 5600G", "Ryzen 7 7800X3D", "Ryzen 9 9950X", "Ryzen 5 9600X",
  ]) {
    assert.equal(renderPartNumbers(`The ${name} is fine.`), `The ${name} is fine.`)
  }
})

test("quantities, versions, standards and prices are untouched", () => {
  for (const text of [
    "It runs at 1080p on a 2025 build with 3000 MHz RAM.",
    "DDR4, GDDR6, PCIe 4.0 and Ubuntu 24.04.",
    "It costs $1,360 and has 16 GB.",
    "A 7B model at 4-bit quantization.",
    "Around 40-50 tokens per second.",
    "The RTX 3000 series and the RTX 50 series.",
  ]) {
    assert.equal(renderPartNumbers(text), text)
  }
})

test("a part number the renderer does not cover is unchanged", () => {
  // Stated as a test because "no worse than today" is the promise this layer
  // makes about everything outside it.
  for (const text of [
    "The Core Ultra 7 265K is fine.",
    "Gaming PCs with RTX 3060/3070/3080.",
    "See rtx-3090 listings.",
    "The Arc A770 is fine.",
    "The RTX 390 is fine.",
    "A Threadripper 7980X.",
  ]) {
    assert.equal(renderPartNumbers(text), text)
  }
})

test("rendering twice changes nothing the first pass did not", () => {
  // "T I" contains no "Ti" for the GPU rule to find on a second pass, and no
  // "i" followed by a tier digit for the Intel rule.
  for (const text of [
    "An Intel i5-12400 and an RTX 4060 Ti.",
    "The i9-14900KS is fine.",
    "A used RTX 3090.",
  ]) {
    const once = renderPartNumbers(text)
    assert.equal(renderPartNumbers(once), once)
  }
})

test("empty input produces nothing", () => {
  assert.equal(renderPartNumbers(""), "")
})

// ------------------------------------------------- through the whole boundary

test("the sanitizer applies the rendering last, after the markdown is gone", () => {
  // The ordering that matters: with the asterisks still attached there is no
  // part number for the pattern to match.
  assert.equal(
    sanitizeForSpeech("**Best value:** the *i5-12400* with an RTX\u202F4060 Ti."),
    "Best value: the i five twelve four hundred with an RTX 4060 T I."
  )
})

test("a real reply goes through both stages", () => {
  // Verbatim from data/ixa.db, narrow spaces and non-breaking hyphen included.
  const reply =
    "A single\u2011board CPU like an AMD Ryzen 5 5600G or an Intel i5\u201112400, " +
    "16\u202FGB of DDR4 RAM, and a 12\u2011GB or 16\u2011GB GPU will do."
  assert.equal(
    sanitizeForSpeech(reply),
    "A single\u2011board CPU like an AMD Ryzen 5 5600G or an Intel i five twelve four hundred, " +
      "16 GB of DDR4 RAM, and a 12\u2011GB or 16\u2011GB GPU will do."
  )
})
