import { test } from "node:test"
import assert from "node:assert/strict"
import { joinThousandsSeparators, renderPriceRanges } from "../src/voice/prices"
import { sanitizeForSpeech } from "../src/voice/sanitize"

// What the two renderings put out, asserted exactly. Whether the result SOUNDS
// right is a separate question answered by ear from Ixa-Tests/tts — these fix
// the transform, not the judgment about it.
//
// Both of these exist because the price guard in src/core/prices.ts cannot see
// what they fix: it reads the draft, where the number is already correct, and
// nothing else in the project verifies what is actually spoken.

// --------------------------------------------- a Unicode thousands separator

test("a narrow no-break space inside a price is removed, not folded", () => {
  // The whole bug: folded to an ASCII space this is spoken "one two hundred
  // dollars", a different number from the one written. Joined, it is "one
  // thousand two hundred dollars".
  assert.equal(
    joinThousandsSeparators("Expect to pay $1 200 for a used one."),
    "Expect to pay $1200 for a used one."
  )
})

test("every Unicode space is accepted as the separator, and ASCII is not", () => {
  // The non-ASCII ones are exactly what the fold is about to destroy. A plain
  // space is something a person typed and is not evidence of a separator.
  for (const space of [" ", " ", " ", " "]) {
    assert.equal(joinThousandsSeparators(`It is $1${space}200.`), "It is $1200.")
  }
  assert.equal(joinThousandsSeparators("It is $1 200."), "It is $1 200.")
})

test("the separator is recognised on every currency symbol", () => {
  assert.equal(joinThousandsSeparators("£1 200"), "£1200")
  assert.equal(joinThousandsSeparators("€1 200"), "€1200")
  assert.equal(joinThousandsSeparators("¥1 200"), "¥1200")
  assert.equal(joinThousandsSeparators("₹1 200"), "₹1200")
})

test("both amounts of a separated range are joined", () => {
  // The live shape src/core/prices.ts records.
  assert.equal(
    joinThousandsSeparators("Expect to pay $1 200 to $1 500 for a used one."),
    "Expect to pay $1200 to $1500 for a used one."
  )
})

test("a two-digit leading group and a repeated group are joined", () => {
  assert.equal(joinThousandsSeparators("It cost $12 500."), "It cost $12500.")
  assert.equal(joinThousandsSeparators("It cost $1 250 000."), "It cost $1250000.")
})

test("a Unicode space before a UNIT is left for the fold", () => {
  // The common case by far — 127 occurrences in the recorded replies. Every
  // one of them has a letter or a one-, two- or four-digit group after the
  // space, never a bare three-digit one.
  for (const text of [
    "It has 16 GB of VRAM.",
    "A used RTX 3090 is $1,360.",
    "An RTX 3060 12 GB card.",
    "An AMD Ryzen 5 5600G chip.",
    "A low-end card like an RTX 3050 4 GB.",
    "Qwen 2.5 7B and Mistral 7B.",
    "An AMD Ryzen 9 7950X.",
  ]) {
    assert.equal(joinThousandsSeparators(text), text)
  }
})

test("a group that is not exactly three digits is not a separator", () => {
  for (const text of [
    "A $500 12 GB card.",      // two digits
    "A $500 4 GB card.",       // one digit
    "It is $1 2000 or so.",     // four digits
    "It is $1 20 or so.",       // two digits
  ]) {
    assert.equal(joinThousandsSeparators(text), text)
  }
})

test("a three-digit leading group is left alone, deliberately", () => {
  // THE AMBIGUOUS SHAPE. "$500 256 GB" is a three-digit price then a
  // three-digit quantity, and nothing in the text distinguishes it from
  // "$500 000" meaning half a million. Joining it would speak "five hundred
  // thousand two hundred fifty-six dollars" — a believable wrong price, which
  // is worse than the garble it is today. See src/voice/prices.ts.
  assert.equal(joinThousandsSeparators("A $500 256 GB drive."), "A $500 256 GB drive.")
  assert.equal(joinThousandsSeparators("It cost $500 000."), "It cost $500 000.")
})

test("digits with no currency symbol are not a price", () => {
  for (const text of [
    "The context window is 24 000 characters.",
    "It runs at 3 000 MHz.",
    "1 200 dollars, roughly.",
  ]) {
    assert.equal(joinThousandsSeparators(text), text)
  }
})

test("joining twice changes nothing the first pass did not", () => {
  for (const text of ["Pay $1 200.", "Pay $12 500 or $1 250 000."]) {
    const once = joinThousandsSeparators(text)
    assert.equal(joinThousandsSeparators(once), once)
  }
})

// ---------------------------------------------------- a dash between prices

test("a dash between two prices becomes the spoken word", () => {
  // Spaced, verbatim from a recorded reply. Both amounts were already correct;
  // the dash was silent, so the listener heard two prices and no relationship.
  assert.equal(
    renderPriceRanges("Roughly $1,300 – $1,400 today."),
    "Roughly $1,300 to $1,400 today."
  )
  // Tight, which is 10 of the 12 ranges in the corpus and the worse bug: the
  // dash is swallowed AND the second amount loses its currency word, so
  // "$180–$220" is spoken "one hundred eighty dollar two hundred twenty".
  assert.equal(renderPriceRanges("About $180–$220."), "About $180 to $220.")
  assert.equal(renderPriceRanges("Usually listed for $350–$400."), "Usually listed for $350 to $400.")
})

test("all three dash characters between two prices are rendered", () => {
  // Only the en dash occurs in the corpus; the other two are measurably just
  // as broken, and core/prices.ts records "$300-$400" as a live shape.
  assert.equal(renderPriceRanges("About $420–$450."), "About $420 to $450.")
  assert.equal(renderPriceRanges("About $420—$450."), "About $420 to $450.")
  assert.equal(renderPriceRanges("About $420-$450."), "About $420 to $450.")
})

test("a range inside parentheses and one with separators are rendered", () => {
  assert.equal(renderPriceRanges("Mid-range ($400–$800) is fine."), "Mid-range ($400 to $800) is fine.")
  assert.equal(renderPriceRanges("$1,300–$1,400"), "$1,300 to $1,400")
  assert.equal(renderPriceRanges("£250–£300"), "£250 to £300")
})

test("a dash used as punctuation is left alone", () => {
  // The dominant use in the corpus: 40 en dashes, only 12 of them between
  // prices. It already reads as the pause it is.
  for (const text of [
    "Used RTX 3060 12 GB – about $180 to $220.",
    "HP ZBook Fury 15 G8 – 10th-gen Intel Core i7.",
    "No worries—just let me know what you need next.",
    "The newer card—an RTX 4060—outperforms it.",
  ]) {
    assert.equal(renderPriceRanges(text), text)
  }
})

test("a bare numeric range is left alone, and is a stated gap", () => {
  // "eight twelve cores" is missing its connector too. It is not a price, and
  // widening the rule to every dash between two numbers would reach version
  // numbers and part numbers. Four occurrences in the corpus, all intelligible.
  assert.equal(renderPriceRanges("8–12 cores, 16–24 threads."), "8–12 cores, 16–24 threads.")
  assert.equal(renderPriceRanges("Around 40-50 tokens per second."), "Around 40-50 tokens per second.")
  assert.equal(renderPriceRanges("The RTX 3060/3070–3080 range."), "The RTX 3060/3070–3080 range.")
})

test("a one-sided range is left alone, and is a stated gap", () => {
  // Badly broken when it happens, and it does not: all 12 ranges in the corpus
  // carry a symbol on both sides. Guessing that a bare number after a dash is
  // money is a bigger inference than this layer should make.
  assert.equal(renderPriceRanges("Roughly $1,300–1,400 today."), "Roughly $1,300–1,400 today.")
  assert.equal(renderPriceRanges("Roughly 1,300–$1,400 today."), "Roughly 1,300–$1,400 today.")
})

test("a sentence boundary is not absorbed into a range", () => {
  // The amount has to begin and end with a digit, or the full stop here would
  // be rewritten into a connector.
  assert.equal(renderPriceRanges("It was $400. – $500 is too much."), "It was $400. – $500 is too much.")
})

test("rendering a range twice changes nothing the first pass did not", () => {
  for (const text of ["About $180–$220.", "Roughly $1,300 – $1,400 today."]) {
    const once = renderPriceRanges(text)
    assert.equal(renderPriceRanges(once), once)
  }
})

test("empty input produces nothing", () => {
  assert.equal(joinThousandsSeparators(""), "")
  assert.equal(renderPriceRanges(""), "")
})

// ------------------------------------------------- through the whole boundary

test("the separator is resolved before the fold, and the range after it", () => {
  // The ordering that matters. If the fold ran first the separator would be an
  // ASCII space and this would speak a different number; if the range rule ran
  // before the markdown was stripped there would be no price for it to match.
  assert.equal(
    sanitizeForSpeech("**Expect to pay $1 200 – $1 500.**"),
    "Expect to pay $1200 to $1500."
  )
})

test("a real reply's price range goes through the boundary", () => {
  // Verbatim from data/ixa.db, narrow spaces included.
  assert.equal(
    sanitizeForSpeech(
      "**Used RTX 4060 Ti 16 GB** – about $420–$450."
    ),
    "Used RTX 4060 T I 16 GB – about $420 to $450."
  )
  assert.equal(
    sanitizeForSpeech(
      "A used RTX 3090 is about $1,360 – $1,370 today."
    ),
    "A used RTX 3090 is about $1,360 to $1,370 today."
  )
})

test("a reply with no price is untouched by either stage", () => {
  const reply = "You asked what time it was. It's 6:25 PM."
  assert.equal(sanitizeForSpeech(reply), reply)
})
