// Rendering part numbers that Kokoro reads wrong whatever separator they are
// written with. Runs as the last stage of sanitizeForSpeech, so it sees text
// with the markdown already gone and every Unicode space already folded.
//
// This layer is deliberately TINY, and the reason is worth stating because the
// obvious design was a table of cards and the measurements killed it.
//
// Folding U+202F to a plain space (src/voice/sanitize.ts) is what fixes model
// numbers, because the separator is what decides how misaki reads the digits.
// With a plain space, Kokoro is already right about 31 of 31 GPU strings and
// every AMD CPU probed — "RTX 3090" reads "thirty ninety", "RX 7800 XT" reads
// "seventy eight hundred ex-tee", "Ryzen 7 7800X3D" reads "seven seventy eight
// hundred ex three dee". A table of cards would have added nothing to any of
// them and would have gone stale on the next generation.
//
// Two things the space fold does not fix, and they are all that is here:
//
//   1. "Ti", which is spoken as the two LETTERS. Measured: with U+202F in
//      place, "RTX 4060 Ti" read as "tie"; with the space folded it reads
//      "tee", which is the one rendering the fold made worse. Rendering it
//      "T I" reads "tee eye", which is how the suffix is said aloud and what
//      the user asked for — "sixteen sixty tee eye".
//
//      Three renderings produce the two letters and the choice between them is
//      not arbitrary: "T I" -> "tˈi ˌI", "T i" and the spelled-out "tee eye"
//      both -> "tˈi ˈI". The difference is only which letter carries the main
//      stress, and the spaced-capitals form is what suffix() below already
//      does to "KF" and "KS", so "T I" is the existing rule rather than a
//      second convention for the same job.
//
//   2. Intel's iN part numbers, which are wrong in EVERY separator form, so
//      there is no separator to normalize towards:
//
//        "i5-12400"       -> "i five one two four zero zero"
//        "i5<U+2011>12400" -> "i five twelve thousand four hundred"
//        "i5 12400"       -> "i five twelve thousand four hundred"
//        "i512400"        -> "i five one two four zero zero"
//
//      The 4-digit generations happen to be right with an ASCII hyphen
//      ("i7-8700K" reads "eighty seven hundred kay") and wrong with U+2011,
//      which the sanitizer no longer folds. Rendering both widths explicitly
//      costs one branch and makes the separator stop mattering, which is
//      cheaper than depending on which one the model happened to type.
//
// NOT covered, stated here rather than discovered later:
//   - "Core Ultra 7 265K" reads "two hundred sixty five kay" instead of "two
//     sixty-five kay". Intelligible, and a 3-digit SKU is a different shape
//     from the ones above.
//   - A slash run, "RTX 3060/3070/3080", reads as "thirty sixty thirty
//     seventy thirty eighty" — every number right, and the slash now SILENT
//     where it used to be read out as the word "slash". Three cards with no
//     audible separator between them is not obviously better than three with
//     the wrong one, so this is listed as uncovered rather than fixed. The
//     answer is the model naming one or two cards, which is what the voice
//     prompt already asks for.
//   - A lowercase slug, "rtx-3090", still reads "three thousand ninety". All
//     44 occurrences in the recorded sessions are inside tool results, which
//     are never spoken, and none is in an assistant reply.
//
// This renders NAMES, it does not check them. "RTX 390" is not a card and
// still reads "three hundred ninety": inventing the card the model meant is a
// different job, and not one for the speech path.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

// 0-99 as a person says it. Hyphenated above twenty because that is how it is
// written; measured, the hyphen makes no difference to the phonemes.
function twoDigits(value: number): string {
  if (value < 20) return ONES[value]!
  const tens = TENS[Math.floor(value / 10)]!
  const ones = value % 10
  return ones === 0 ? tens : `${tens}-${ONES[ones]!}`
}

// A four-digit SKU as two pairs, which is how every one of these is said. A
// trailing "00" is spoken "hundred" rather than as a second pair, so 8700 is
// "eighty-seven hundred" and not "eighty-seven oh oh".
function fourDigits(digits: string): string {
  const lead = twoDigits(Number(digits.slice(0, 2)))
  const tail = digits.slice(2)
  return tail === "00" ? `${lead} hundred` : `${lead} ${twoDigits(Number(tail))}`
}

// A five-digit Intel SKU: two digits of generation, then three of model.
// 12400 is "twelve four hundred", 12450 is "twelve four fifty". The generation
// is a pair and the model number is never read as one number with it, which is
// exactly what both of the wrong readings above do.
function fiveDigits(digits: string): string {
  const generation = twoDigits(Number(digits.slice(0, 2)))
  const model = ONES[Number(digits[2]!)]!
  const tail = digits.slice(3)
  return tail === "00"
    ? `${generation} ${model} hundred`
    : `${generation} ${model} ${twoDigits(Number(tail))}`
}

// A trailing suffix as separate letters, with any digit spelled out: "KF"
// becomes "K F" and "G7" becomes "G seven".
//
// Spaced rather than left alone because of ONE suffix. "KF" and "HX" are read
// correctly when joined ("kay-ef", "aitch-ex"), but "KS" joined reads "kays" —
// a plural, not two letters. Spacing is right for all three, so this is one
// rule instead of a rule with an exception in it.
function suffix(raw: string): string {
  return raw
    .split("")
    .map((char) => (/\d/.test(char) ? ONES[Number(char)]! : char.toUpperCase()))
    .join(" ")
}

// Intel's consumer CPUs: i3, i5, i7, i9, then a four- or five-digit SKU with an
// optional letter suffix. Every separator the model has been seen to use is
// accepted, including none at all, because the whole point is that the
// separator stops deciding the reading.
//
// The SKU must not be part of a longer number, and the suffix is at most three
// characters: that is enough for "KF", "HX" and "G7" and short enough that it
// cannot swallow a following word.
// The tier letter is matched in either case, because a reply that opens with
// the part number has it capitalized. The output is lowercase either way: "i"
// is what reads as the letter "eye".
//
// The separator class is written as escapes on purpose. An invisible character
// sitting in a character class is the exact bug this file exists to undo, and
// it must not be possible to read this line wrong.
const INTEL =
  /\b[iI]([3579])[ \-\u2010\u2011\u2012\u2013\u2014\u2015]?(\d{4,5})(?!\d)([A-Za-z]{1,2}\d?)?\b/g

// "Ti" as a GPU suffix, which is what it is when a four-digit model number
// comes immediately before it. Anchored on that number so the chemical symbol
// and anything else spelled "Ti" are left alone — "Ti plasma" is not a card.
//
// The attached form is matched too: "4060Ti" reads "tee" exactly as the spaced
// form does.
//
// Measured in every position it occurs in: before a quantity ("4060 T I 16
// GB"), before "or" ("3070 T I or RTX 3080"), before a comma and at the end of
// a sentence. All read the two letters. The one cost, stated because it is
// real and small: at the very end of a sentence the trailing period is taken
// as an abbreviation's and drops out of the phonemes, so "the 4060 T I." ends
// without a falling intonation. Chunking is unaffected — the sidecar splits on
// the text, where the period is still there — so this is prosody, not a lost
// sentence boundary.
const GPU_TI = /(\d{4}) ?Ti\b/g

export function renderPartNumbers(text: string): string {
  if (!text) return ""

  return text
    .replace(GPU_TI, "$1 T I")
    .replace(INTEL, (_match, tier: string, digits: string, tail?: string) => {
      const number = digits.length === 4 ? fourDigits(digits) : fiveDigits(digits)
      const spoken = `i ${ONES[Number(tier)]!} ${number}`
      return tail ? `${spoken} ${suffix(tail)}` : spoken
    })
}
