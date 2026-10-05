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
  return found
}

// The corrective instruction, injected for ONE retry.
//
// Never written to stored history: like the preference block and the voice
// constraint, it is a statement about this call and not something that was
// said. The draft it is correcting is never recorded either — the user never
// heard it, and history must not claim otherwise.
//
// It offers a search OR removal, and exempts a figure the user themselves
// supplied: repeating "your $500 budget" back is not an invented price, and a
// guard that forced it out would be a worse answer, not a safer one.
export function priceCorrectionPrompt(amounts: string[]): string {
  return (
    `STOP. Your draft reply stated ${amounts.length === 1 ? "a price" : "prices"} ` +
    `(${amounts.join(", ")}) and you did not search the web in this turn, so ` +
    `${amounts.length === 1 ? "that figure is" : "those figures are"} from memory and may be ` +
    "wrong. A wrong price costs the user money. Write the reply again, and either call " +
    "web_search first and use what it returns, or name the products without any prices and say " +
    "you would have to look up what they cost now. The one exception is a figure the USER stated " +
    "in this conversation — their own budget is theirs to repeat."
  )
}
