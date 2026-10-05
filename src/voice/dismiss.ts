// Detected against the STT transcript of a voice turn to close a wake-word
// conversation without an LLM round trip — dismissing shouldn't cost a
// generated reply, just a fixed acknowledgment.
//
// Matching is deliberately narrow, because a false dismiss costs the user
// their answer. The phrase has to END the utterance: "What's the capital of
// Japan? Stop listening." used to match anywhere in the transcript and so was
// dismissed without ever being answered. And a negated phrase is not a
// dismiss at all — "don't stop listening" asks for the opposite.
//
// When real words precede the phrase, they are a turn: the user asked
// something and then said goodbye, and both halves should happen. The
// transport runs the remainder as a normal voice turn and closes the
// listening window once the reply is done. Filler does not count as words —
// "Okay, thanks. Stop listening." is just a dismiss with manners.
//
// This is the only place dismiss phrases are listed. Both clients merely
// react to the `sessionEnd` the transport sends; neither has a copy of the
// list to keep in step.
const DISMISS_PHRASES = [
  "goodbye ixa",
  "bye ixa",
  "stop listening",
  "go to sleep",
  "that's all ixa",
  "that's all for now",
]

export const DISMISS_ACKNOWLEDGMENT = "Goodbye."

// Anywhere before the phrase, each of these is reason enough not to treat it
// as a dismiss. Checked across the whole preceding span rather than just the
// adjacent word, because the negator is often further back: "I didn't say
// stop listening" has "say" in between. The costs are lopsided — a missed
// dismiss leaves the user waiting out a 20-second conversation timeout, while
// a false one throws their question away — so this leans towards not
// dismissing and accepts that "I can't hear you, stop listening" needs
// saying twice.
const NEGATORS = new Set([
  "not", "dont", "donot", "never", "didnt", "doesnt", "wont",
  "cant", "cannot", "wouldnt", "shouldnt", "couldnt", "isnt", "arent",
])

// A remainder made only of these is politeness, not a question. Kept tight on
// purpose: "yes" and "no" are answers, so they are words, and a remainder of
// "no" submits a turn rather than being swallowed.
const FILLER = new Set([
  "ok", "okay", "alright", "allright", "right", "thanks", "thank", "you",
  "cheers", "ta", "got", "it", "never", "mind", "anyway", "anyhow", "cool",
  "nice", "great", "perfect", "fine", "well", "so", "and", "then", "please",
  "um", "uh", "erm", "hmm", "ah", "oh",
])

// Trailing words that only joined the dismiss to the question before it.
// Left on the end, they make the remainder read as an unfinished sentence.
const TRAILING_CONNECTORS = new Set(["and", "then", "so", "now", "also", "plus", "but"])

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "")
}

// Each phrase as its normalized words, so matching happens word by word and
// never mid-word: "I told her to stop listening to him" has the words in it
// but not at the end, and "unstoppable" contains none of them.
const PHRASE_WORDS = DISMISS_PHRASES.map((phrase) =>
  phrase.split(/\s+/).map(normalizeWord).filter(Boolean)
)

interface Token {
  word: string
  start: number
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(/[^\s]+/g)) {
    const word = normalizeWord(match[0])
    if (word) tokens.push({ word, start: match.index })
  }
  return tokens
}

export interface DismissMatch {
  // True only for an utterance-final, un-negated dismiss phrase.
  dismissed: boolean
  // The user's words before the phrase, in the original spelling and
  // punctuation, or "" when there were none worth answering. Always "" when
  // `dismissed` is false — there is nothing to split off.
  remainder: string
}

const NO_DISMISS: DismissMatch = { dismissed: false, remainder: "" }

export function parseDismiss(text: string): DismissMatch {
  const tokens = tokenize(text)
  if (tokens.length === 0) return NO_DISMISS

  const phrase = PHRASE_WORDS.find(
    (words) =>
      words.length <= tokens.length &&
      words.every((word, i) => tokens[tokens.length - words.length + i]!.word === word)
  )
  if (!phrase) return NO_DISMISS

  const phraseStart = tokens.length - phrase.length
  const preceding = tokens.slice(0, phraseStart)

  // "never mind" is one word's worth of filler, not the negator "never": it
  // ends a request rather than reversing one, and "never mind, stop
  // listening" is as plain a dismiss as there is.
  const negated = preceding.some(
    (token, i) =>
      NEGATORS.has(token.word) && !(token.word === "never" && preceding[i + 1]?.word === "mind")
  )
  if (negated) return NO_DISMISS

  // Politeness in front of a goodbye is still just a goodbye.
  if (preceding.every((token) => FILLER.has(token.word))) {
    return { dismissed: true, remainder: "" }
  }

  // Cut the ORIGINAL text, so the turn the model sees keeps its own casing and
  // punctuation rather than the normalized form used for matching.
  let remainder = text.slice(0, tokens[phraseStart]!.start).trim()

  // Drop a trailing connector and the punctuation around it: "Tell me the
  // time and stop listening" should submit "Tell me the time".
  for (;;) {
    const trailing = /([^\s]+)$/.exec(remainder)?.[1]
    if (!trailing || !TRAILING_CONNECTORS.has(normalizeWord(trailing))) break
    remainder = remainder.slice(0, remainder.length - trailing.length).trim()
  }
  remainder = remainder.replace(/[,;:\-—–]+$/, "").trim()

  return { dismissed: true, remainder }
}
