// Finding currency amounts in a reply, for the price guard in Session.
//
// The freshness rule in SYSTEM_PROMPT tells the model to search before stating
// a price. It mostly obeys, and when it does not it fails expensively: asked
// "what CPU should I get for local AI?" in live testing it produced a tiered
// list of parts with a price against each one and never called web_search. A
// wrong price stated confidently costs the user money, so the prompt gets a
// backstop in the same shape as the spoken-length one.
//
// What counts is a number tied to MONEY. The hard part is everything in this
// domain that looks like a number and is not a price: "RTX 3090", "16 GB",
// "4090", "1440p", "7B", "24000 chars". So a match needs a currency symbol or
// an explicit currency word next to the digits — never digits alone.

// Symbol first ("$1,360", "£250.50", "$1.5k"), or digits then a currency word
// ("500 dollars", "250 quid"), or the word then digits ("USD 500").
//
// `(?<![\w.])` keeps "$" inside a larger token from matching and stops a
// decimal tail being read as a fresh amount. Word boundaries on the currency
// words keep "pound cake" and "centre" out.
// Two shapes, grouped first so the grouped form wins: a thousands-separated
// number, then a plain one.
//
// The separator is not just a comma. The model writes thousands with a NARROW
// NO-BREAK SPACE (U+202F) at least as often — live replies contained
// "$1 200–$1 500" — and matching only commas took "$1" out of "$1 200" and
// quoted that back to the model as the price it had stated. A grouped match
// needs the separator followed by exactly three digits, so "$5 and change"
// still yields "$5" rather than running on.
//
// Neither shape can end on a separator, so the sentence comma in
// "$300-$400, so about" stays out of the match.
const SEPARATOR = String.raw`[,\u202F\u00A0\u2009 ]`
const NUMBER =
  String.raw`(?:\d{1,3}(?:${SEPARATOR}\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?[kKmM]?)`
const CURRENCY_WORDS =
  String.raw`dollars?|usd|bucks|quid|pounds? sterling|gbp|euros?|eur|yen|rupees?|cents?`

const PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?<![\w.])[$£€¥₹]\s?${NUMBER}`, "g"),
  new RegExp(String.raw`(?<![\w.])${NUMBER}\s?(?:${CURRENCY_WORDS})\b`, "gi"),
  new RegExp(String.raw`\b(?:usd|gbp|eur)\s?${NUMBER}`, "gi"),
]

// ------------------------------------------------- the same price, in words
//
// VOICE_RESPONSE_PROMPT now tells the model to write numbers as words in a
// spoken reply, because Kokoro mis-renders digits. That would have taken the
// guard above out silently: "three hundred fifty dollars" contains no digit,
// so all three patterns return nothing and the freshness backstop stops
// existing on voice turns without an error or a log line to say so.
//
// Both forms are detected, not one. A text turn gets no voice prompt and will
// keep writing digits.
//
// The vocabulary is closed and small. Plural scales are deliberately absent:
// "worth millions of dollars" is vague, not a figure that was stated.
const ONES =
  String.raw`zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|` +
  String.raw`fourteen|fifteen|sixteen|seventeen|eighteen|nineteen`
const TENS = String.raw`twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety`
const SCALES = String.raw`hundred|thousand|million|billion|trillion`
const NUMBER_WORD = String.raw`(?:${ONES}|${TENS}|${SCALES})`

// A run of number words, joined by whitespace, a hyphen, or "and":
// "twenty-five", "four hundred and twenty", "one thousand three hundred sixty".
const WORD_RUN = String.raw`${NUMBER_WORD}(?:[\s\-]+(?:and[\s\-]+)?${NUMBER_WORD})*`

// "under a few hundred dollars" is a price stated from memory, so the guard
// should fire on it. The quantifier is absorbed into the match only so that
// priceCorrectionPrompt quotes back something a person would recognise — "a
// few hundred dollars" rather than a bare "hundred dollars".
const VAGUE = String.raw`a few|a couple of|a couple|several`

// Only the unambiguous currency words. Bare "pounds" stays out for the same
// reason it is absent above: "two pounds of flour" is a weight.
const SPOKEN_CURRENCY = String.raw`dollars?|bucks|quid|cents?|pence|euros?|yen|rupees?|pounds? sterling`

// ADJACENCY IS THE WHOLE GUARD AGAINST FALSE POSITIVES. The currency word has
// to come straight after the number run, with nothing between but whitespace
// or a hyphen — which is what keeps the number words and the currency word of
// "one of the dollars was counterfeit" and "the dollar fell two percent" from
// being read together. A hyphen is allowed so "a two-hundred-dollar card",
// which states a price, is caught.
//
// "a" may lead a run but is never itself a number, so "a thousand dollars"
// matches and "a dollar store" cannot. A vague quantifier may stand alone
// ("a few dollars"); a bare number run may not be empty.
const SPOKEN_PATTERN = new RegExp(
  String.raw`\b(?:(?:${VAGUE})(?:[\s\-]+${WORD_RUN})?|(?:a[\s\-]+)?${WORD_RUN})[\s\-]+(?:${SPOKEN_CURRENCY})\b`,
  "gi"
)

// A price range written as "$300-$400" matches twice, which is right: both
// figures were stated. Duplicates are collapsed so the log line stays short.
export function findCurrencyAmounts(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const amount = match[0].trim()
      if (!found.includes(amount)) found.push(amount)
    }
  }
  // Digit amounts keep their exact text — the separator inside "$1 200" is part
  // of what was written. A spelled-out amount can span a line break in a draft,
  // so its whitespace is collapsed to keep the quoted-back figure readable.
  for (const match of text.matchAll(SPOKEN_PATTERN)) {
    const amount = match[0].trim().replace(/\s+/g, " ")
    if (!found.includes(amount)) found.push(amount)
  }
  return found
}

// The corrective instruction, injected for ONE retry.
//
// Never written to stored history: like the preference block and the voice
// constraint, it is a statement about this call and not something that was
// said. The draft it is correcting is never recorded either — the user never
// heard it, and history must not claim otherwise.
//
// IT ASKS FOR THE SEARCH AND NOTHING ELSE.
//
// It used to offer a choice: search, or name the products without any prices.
// The model overwhelmingly took the second option, which is SAFE — it never
// restated a price in 34 measured runs — but it is also the less useful
// answer, and the user asked a price question. Searches per shape, before
// and after removing the choice:
//
//   direct "how much is X"     8/8  -> 8/8
//   a price in an aside        1/8  -> 5/8
//   a budget the user gave     3/8  -> 3/8    (unmoved)
//   a priced list of parts     2/10 -> 9/10
//
// Still zero restated prices after the change, so the safe outcome was not
// traded away for the useful one. Small samples: the aside measured 4/8 on a
// second run of the same wording, so treat these as a direction, not a rate.
//
// Forcing the tool with tool_choice was tried first and reverted: Groq
// answers a forced tool the model declines with a 400 rather than a reply, so
// it refused 6 to 8 times out of 8 on the two shapes that most needed help
// and cost a wasted round trip every time. The prompt is the lever here, not
// the API.
//
// The USER'S OWN figure stays exempt: repeating "your $500 budget" back is
// not an invented price, and a guard that forced it out would be a worse
// answer, not a safer one.
export function priceCorrectionPrompt(amounts: string[]): string {
  return (
    `STOP. Your draft reply stated ${amounts.length === 1 ? "a price" : "prices"} ` +
    `(${amounts.join(", ")}) and you did not search the web in this turn, so ` +
    `${amounts.length === 1 ? "that figure is" : "those figures are"} from memory and may be ` +
    "wrong. A wrong price costs the user money. Call web_search NOW, before you write anything, " +
    "and use what it returns. Do not answer from memory, and do not answer without searching. " +
    "The one exception is a figure the USER stated in this conversation — their own budget is " +
    "theirs to repeat."
  )
}

// ---------------------------------------------- the same price, as a NUMBER
//
// Phase 3d needs a different question answered. The guard above asks "did the
// model state a price without searching", over a draft reply. A note asks
// "is this figure one the user gave me, or one a search returned" — and that
// comparison cannot be made on text.
//
// The spike is the proof. The user said "like six hundred bucks"; the model
// wrote "A used RTX 3090 is currently selling for about $600". Those are the
// same figure and share not one character, so a substring check waves a
// fabricated price through exactly as readily as a faithful one. What is
// compared is therefore a value and a currency.
//
// WHY THIS MATTERS MORE FOR A NOTE THAN FOR A REPLY. The guard above inspects
// the draft reply, so a price inside a save_note ARGUMENT never reaches it: a
// tool call is not a reply. An unguarded note would put the figure on disk,
// where a later search hands it back as something Ixa recorded, long after
// the conversation that could have corrected it is gone.

export interface NormalizedAmount {
  // The text as it was written, for quoting back.
  text: string
  value: number
  // A coarse bucket, not a currency code with FX: "$5" and "5 dollars" are
  // the same figure, "$5" and "5 cents" are not. Nothing here converts
  // between currencies, because two figures in different currencies are never
  // the same stated price.
  currency: string
}

const SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
}

const WORD_CURRENCY: Array<[RegExp, string]> = [
  [/\b(?:dollars?|usd|bucks)\b/i, "USD"],
  [/\b(?:pounds? sterling|gbp|quid)\b/i, "GBP"],
  [/\b(?:euros?|eur)\b/i, "EUR"],
  [/\byen\b/i, "JPY"],
  [/\brupees?\b/i, "INR"],
  [/\bcents?\b/i, "USD-cent"],
  [/\bpence\b/i, "GBP-pence"],
]

// Every currency word in one pattern, for stripping it out of a spoken amount
// before the number run is parsed. Longest first, so "pounds sterling" is
// removed whole rather than leaving "sterling" behind.
const CURRENCY_WORD_TOKENS =
  /\b(?:pounds? sterling|dollars?|bucks|quid|euros?|rupees?|cents?|pence|yen|usd|gbp|eur)\b/gi

const WORD_VALUES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

const WORD_SCALES: Record<string, number> = {
  hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, trillion: 1e12,
}

// "one thousand three hundred sixty" -> 1360. Returns null for a run with no
// number in it at all, which is how a vague quantifier ("a few hundred") is
// rejected: it names a scale but never a figure.
function wordsToNumber(words: string[]): number | null {
  let total = 0
  let current = 0
  let sawNumber = false

  for (const word of words) {
    if (word === "and" || word === "a" || word === "an") continue
    const value = WORD_VALUES[word]
    if (value !== undefined) {
      current += value
      sawNumber = true
      continue
    }
    const scale = WORD_SCALES[word]
    if (scale === undefined) return null
    // A bare scale counts: "a thousand dollars" is a figure, and only the
    // leading "a" stands between it and one. What still returns null is an
    // UNKNOWN word, which is what "a few hundred dollars" trips on.
    sawNumber = true
    if (scale === 100) {
      current = (current || 1) * 100
    } else {
      total += (current || 1) * scale
      current = 0
    }
  }

  if (!sawNumber) return null
  return total + current
}

// Thousands separators are not just commas — the model writes a NARROW
// NO-BREAK SPACE at least as often (see SEPARATOR above), and a plain space
// too. Stripped before parsing; a trailing k or m is a multiplier.
function digitsToNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,    ]/g, "")
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(cleaned)
  if (!match) return null
  const value = parseFloat(match[1]!)
  if (Number.isNaN(value)) return null
  const suffix = match[2]!.toLowerCase()
  return suffix === "k" ? value * 1000 : suffix === "m" ? value * 1e6 : value
}

// One amount, as findCurrencyAmounts returned it, to {value, currency}.
// Null when it is not a determinate figure — a vague quantifier, or a shape
// this does not understand. Null NEVER means "allowed": the caller falls back
// to comparing the text.
export function normalizeAmount(amount: string): NormalizedAmount | null {
  const text = amount.trim()

  let currency: string | null = null
  const symbol = Object.keys(SYMBOL_CURRENCY).find((s) => text.includes(s))
  if (symbol) currency = SYMBOL_CURRENCY[symbol]!
  if (!currency) {
    for (const [pattern, code] of WORD_CURRENCY) {
      if (pattern.test(text)) {
        currency = code
        break
      }
    }
  }
  if (!currency) return null

  // Digits win when both are present: "$600" is the figure, not a stray word.
  const digits = /\d[\d,.    ]*[kKmM]?/.exec(text)
  if (digits) {
    const value = digitsToNumber(digits[0]!.trim())
    return value === null ? null : { text, value, currency }
  }

  // The currency word has to come out before the number run is parsed, or
  // "six hundred bucks" dies on "bucks". A vague quantifier is deliberately
  // left in, because an unknown word is what makes wordsToNumber reject
  // "a few hundred dollars" as the non-figure it is.
  const words = text
    .toLowerCase()
    .replace(CURRENCY_WORD_TOKENS, " ")
    .split(/[\s\-]+/)
    .filter(Boolean)
  const value = wordsToNumber(words)
  return value === null ? null : { text, value, currency }
}

// Which amounts in `text` are NOT backed by anything in `evidence`.
//
// Evidence is the user's own words this turn plus the results of any
// web_search that actually ran in it. Two ways for an amount to pass:
//
//   1. Its normalised value and currency appear in the evidence. This is the
//      one that matters: it is what lets the user say "six hundred bucks" and
//      the model write "$600".
//   2. Its text appears verbatim, case-insensitively. This covers the figures
//      that have no determinate value — "a few hundred dollars" — where
//      repeating the user's own hedge is faithful and inventing one is not.
//
// Deliberately an EXACT value match, with no tolerance. "Six hundred" written
// back as $599 is a different figure, and a guard that rounded would be
// deciding how wrong a price is allowed to be.
export function unsupportedAmounts(text: string, evidence: string[]): string[] {
  const stated = findCurrencyAmounts(text)
  if (stated.length === 0) return []

  const haystack = evidence.join("\n")
  const lowerHaystack = haystack.toLowerCase()
  const supported = new Set(
    findCurrencyAmounts(haystack)
      .map(normalizeAmount)
      .filter((a): a is NormalizedAmount => a !== null)
      .map((a) => `${a.currency} ${a.value}`)
  )

  const unsupported: string[] = []
  for (const amount of stated) {
    const normalized = normalizeAmount(amount)
    if (normalized && supported.has(`${normalized.currency} ${normalized.value}`)) continue
    if (lowerHaystack.includes(amount.toLowerCase())) continue
    if (!unsupported.includes(amount)) unsupported.push(amount)
  }
  return unsupported
}

// What a tool says when it refuses to write a figure nobody gave it.
//
// It names the amounts and offers both ways out, unlike priceCorrectionPrompt
// above, which deliberately asks for the search and nothing else. The
// difference is what the model is in the middle of: a reply has to say
// something about the price, so offering "or omit it" got the vaguer answer
// almost every time. A note does not — a note with the price left out is a
// perfectly good note, and the sentence that mentions the search result can
// come later.
export function priceRefusal(amounts: string[], toolName: string): string {
  const plural = amounts.length !== 1
  return (
    `Nothing was saved. The ${plural ? "figures" : "figure"} ${amounts.join(", ")} ` +
    `${plural ? "are" : "is"} not in anything the user said in this conversation and did not ` +
    `come from a web_search in this turn, so ${plural ? "they are" : "it is"} from memory and ` +
    `may be wrong — and a wrong price written into a note is read back later as a measurement. ` +
    `Either call web_search now and use what it returns, or call ${toolName} again with the ` +
    `${plural ? "figures" : "figure"} left out. Do not guess.`
  )
}

// Appended by CODE to a note that states a price, never asked of the model.
// A figure in a note has no conversation around it to date it, so it carries
// its own date: a reader a year later sees a price AND when it was true.
export function priceAsOfLine(date: string): string {
  return `_Prices as stated on ${date}; they may be out of date._`
}
