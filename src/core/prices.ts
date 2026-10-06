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
