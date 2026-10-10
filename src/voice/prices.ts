// Rendering currency amounts for speech.
//
// The companion to src/core/prices.ts, and the division between them is why
// this file has to exist at all. core/prices.ts READS a draft to decide
// whether the model stated a price without searching for it, and it never
// rewrites a character. So it cannot see any of the bugs below: in every one
// of them the number in the draft is CORRECT and the number Kokoro says is
// not. The guard inspects the text; this renders it. Nothing else in the
// project checks what is actually spoken.
//
// TWO FUNCTIONS, not one, because they run at different points in
// sanitizeForSpeech and the Unicode space fold is what separates them. One has
// to see the model's invisible characters still in place; the other is easier
// once they are gone. The ordering is stated at each one and enforced by
// src/voice/sanitize.ts calling them where it does.
//
// Everything here is measured through misaki's G2P — the one KPipeline calls —
// on the strings in Ixa-Tests/tts/fixtures.json and on the shapes recorded in
// data/ixa.db. The phoneme transcripts quoted below are abbreviated to the
// part under discussion; Ixa-Tests/tts/phonemes.md has them in full.

// ------------------------------------------- a Unicode space between digits
//
// The model writes a thousands separator as a NARROW NO-BREAK SPACE, and that
// amount is spoken as a DIFFERENT NUMBER. Measured on "Expect to pay $1<U+202F>200
// for a used one":
//
//   "$1<U+202F>200"   as written      -> "one twohundred"   — and no "dollars" at all
//   "$1 200"          folded, TODAY   -> "one two hundred dollars"
//   "$1200"           separator gone  -> "one thousand two hundred dollars"
//   "$1,200"          comma           -> identical phonemes to "$1200"
//
// So deleting the separator is the fix, and a comma would do equally well —
// the two produce the same phonemes, so the shorter edit wins.
//
// IT HAS TO RUN BEFORE THE FOLD. Afterwards the separator is an ASCII space,
// which is also what the model types between two numbers that have nothing to
// do with each other, and the one piece of evidence that told them apart is
// gone. This is the conflict the fold creates: folding U+202F is right
// everywhere else in the speech path and wrong inside a number.
//
// HOW A SEPARATOR IS TOLD FROM A SPACE BEFORE A WORD — three conditions, all
// required:
//
//   1. THE SPACE IS A UNICODE SPACE, never an ASCII one. A plain space between
//      a price and a three-digit number is something a person typed, and it is
//      not evidence of anything; U+202F in this corpus is only ever the model's
//      own, and condition 2 says which of its two uses this is. data/ixa.db has
//      no occurrence of an ASCII space used as a thousands separator in any of
//      67 assistant replies.
//
//   2. EXACTLY THREE DIGITS FOLLOW IT, and no fourth. This is what excludes
//      the ordinary case. All 10 occurrences of digit<U+202F>digit in the
//      recorded replies are a number followed by a quantity — "RTX<U+202F>3060<U+202F>12<U+202F>GB",
//      "Ryzen<U+202F>5<U+202F>5600G", "RTX<U+202F>3050<U+202F>4<U+202F>GB", "Qwen<U+202F>2.5<U+202F>7B",
//      "Ryzen<U+202F>9<U+202F>7950X" — and not one of them has a bare three-digit group
//      on the right: they have one digit, two, or four-with-a-letter. The far
//      more common "16<U+202F>GB" has a letter there and never comes close.
//
//   3. A CURRENCY SYMBOL IMMEDIATELY BEFORE THE FIRST GROUP. Without it there
//      is nothing to say the digits are one quantity rather than two, and the
//      shape this exists for is a price.
//
// THE LEFT GROUP IS ONE OR TWO DIGITS, which is the one deliberate narrowing
// here and the reason is the ambiguous case:
//
//   "$500<U+202F>256<U+202F>GB"  — a three-digit price, then a three-digit quantity
//
// Nothing in the text distinguishes that from "$500<U+202F>000" meaning half a
// million. It satisfies conditions 1-3, and with a three-digit left group
// allowed it would be joined into "$500256" and spoken "five hundred thousand
// two hundred fifty-six dollars" — a confident, plausible, wrong price, which
// is the exact failure this layer exists to remove. Left as it is, it is
// spoken "five hundred two hundred fifty-six dollars" — already wrong today,
// and audibly broken rather than plausible, so a listener knows not to trust
// it. Trading a garbled price for a believable wrong one is a bad trade, so
// the left group is capped at two digits and the collision cannot arise.
//
// WHAT THAT COSTS, stated rather than discovered later: an amount of $100,000
// or more written with a Unicode separator is left alone. "$500<U+202F>000" is
// spoken "five hundred zero dollars" and stays that way. No reply in the
// corpus contains an amount above $1,400, and the domain is consumer PC parts,
// so the shape that is given up does not occur and the shape that is kept safe
// does. core/prices.ts allows a three-digit leading group because it is only
// quoting an amount back to the model, where being wide is harmless; speaking
// a number is where the width has to be paid for.
//
// ALSO NOT COVERED: a separated amount with no currency symbol ("1<U+202F>200
// dollars") and one written with a space after the symbol ("$<U+202F>1<U+202F>200",
// where which space is the separator is genuinely undecidable). Neither occurs
// in the corpus, and the voice prompt now asks the model for number words
// anyway, which is what keeps digits out of a spoken reply in the first place.

// A Zs that is not the ASCII space: exactly the characters UNICODE_SPACES in
// src/voice/sanitize.ts is about to destroy, and no others. Written as a
// negative lookahead on the space rather than as a list of code points so that
// it cannot drift out of step with the fold it is guarding against.
const THOUSANDS = /([$£€¥₹]\d{1,2})((?:(?! )\p{Zs}\d{3})+)(?!\d)/gu

export function joinThousandsSeparators(text: string): string {
  if (!text) return ""
  return text.replace(THOUSANDS, (_match, amount: string, groups: string) =>
    // Every separator in the run, so "$1<U+202F>250<U+202F>000" joins in one pass.
    amount + groups.replace(/\p{Zs}/gu, "")
  )
}

// ------------------------------------------------- a dash between two prices
//
// A range loses the relationship between its two amounts, and in the common
// form it loses more than that. Measured, with the two shapes the corpus
// actually contains:
//
//   spaced, "$1,300 – $1,400"
//     today -> "one thousand three hundred dollars — one thousand four
//               hundred dollars"      both amounts right, the dash SILENT
//     with "to" -> "... dollars to one thousand four hundred dollars"
//
//   tight, "$180–$220"   (10 of the 12 ranges in data/ixa.db)
//     today -> "one hundred eighty dollar two hundred twenty"
//               the dash is swallowed, "dollars" goes SINGULAR, the second
//               amount loses its currency word entirely, and the number words
//               fuse into one token
//     with "to" -> "one hundred eighty dollars to two hundred twenty dollars"
//
// The tight form is the one that matters and it is the one the brief for this
// change did not know about: it is not only a missing connector, it is a price
// with no currency on it. "$420–$450" says "four hundred twenty dollar four
// hundred fifty". Replacing the dash with the word fixes all of it at once,
// because once the two amounts are separate tokens each is phonemized as a
// whole amount.
//
// WHAT IS MATCHED: a dash with a complete currency amount on its left and a
// currency symbol followed by a digit on its right. Nothing else. That is
// narrow on purpose, because a dash is right far more often than it is wrong.
//
// DELIBERATELY LEFT ALONE:
//   - A dash used as punctuation. "Used RTX 3060 12 GB – about $180 to $220"
//     has a dash with a letter on one side, no currency symbol after it, and
//     it already reads as the pause it is. This is the dominant use in the
//     corpus — 40 en dashes, only 12 of them between prices.
//   - A BARE numeric range: "8–12 cores, 16–24 threads" reads "eight twelve
//     cores", so the connector is missing there too. It is a real gap and it
//     is not a price, and widening the rule to every dash between two numbers
//     would reach version numbers, scores and part numbers. Four occurrences
//     in the corpus, all of them cores and threads, all intelligible.
//   - A ONE-SIDED range, "$1,300–1,400", where only the first amount carries
//     a symbol. It is badly broken ("dollarsone four zero zero"), and it does
//     not occur: all 12 ranges in the corpus have a symbol on both sides.
//     Guessing that a bare number after a dash is money is a bigger inference
//     than this layer should make on its own.
//   - "Between $300 and $400" needs nothing; it is already correct.
//
// EM DASH AND ASCII HYPHEN are matched alongside the en dash. Neither occurs
// in the corpus — all 12 ranges use U+2013 — but both are measurably just as
// broken ("$420-$450" is read exactly like the en-dash form, "$420—$450" keeps
// a literal dash AND loses the currency word), and core/prices.ts records
// "$300-$400" as a live shape. One rule for the three characters is cheaper
// than finding out later which one the model typed.
//
// RUNS AFTER THE FOLD, on the finished prose: the spaced form is written
// "$1,300<U+202F>–<U+202F>$1,400" with narrow spaces hugging the dash, and by this point
// those are ASCII spaces. Running here also means the markdown is already
// gone, which matters for the same reason it does for part numbers — "**about
// $180–$220**" has no price in it that any pattern can see.
//
// The amount must begin and end with a digit so that a sentence-ending period
// cannot be absorbed into it: without that, "it was $400. – $500 is too much"
// would have its full stop rewritten into a range.
const RANGE = /([$£€¥₹]\d(?:[\d,.]*\d)?) *[-–—] *(?=[$£€¥₹]\d)/g

export function renderPriceRanges(text: string): string {
  if (!text) return ""
  return text.replace(RANGE, "$1 to ")
}
