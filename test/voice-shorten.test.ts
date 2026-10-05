import { test } from "node:test"
import assert from "node:assert/strict"
import { shortenForSpeech, CONTINUE_OFFER } from "../src/voice/shorten"

// Most cases here exercise one limit at a time. `units` disables the word
// budget and `words` disables the unit count, so a failure names the limit
// that produced it instead of leaving the two to interact.
const units = (maxUnits: number) => ({ maxUnits, maxWords: 0 })
const words = (maxWords: number) => ({ maxUnits: 0, maxWords })

// The backstop behind VOICE_RESPONSE_PROMPT. Two properties matter more than
// any individual case here: it never cuts mid-sentence, and the text it keeps
// is a prefix of the original (so the sanitizer still sees real markdown).

test("a reply within the limit is returned untouched", () => {
  const text = "The 3060 is the safe pick. The 6700 XT has more VRAM."
  const result = shortenForSpeech(text, units(3))

  assert.equal(result.spoken, text)
  assert.equal(result.trimmed, false)
  assert.equal(result.total, 2)
  assert.equal(result.kept, 2)
})

test("a reply over the limit is cut at a sentence boundary and offered", () => {
  const text = "One. Two. Three. Four. Five."
  const result = shortenForSpeech(text, units(3))

  assert.equal(result.spoken, `One. Two. Three. ${CONTINUE_OFFER}`)
  assert.equal(result.trimmed, true)
  assert.equal(result.kept, 3)
  assert.equal(result.total, 5)
})

test("what is kept is a prefix of the original, markdown included", () => {
  const text = "**Best value:** the 3060.\n- The 6700 XT has more VRAM.\n- The 4070 is faster."
  const result = shortenForSpeech(text, units(2))

  assert.equal(result.trimmed, true)
  assert.ok(
    text.startsWith(result.spoken.slice(0, result.spoken.length - CONTINUE_OFFER.length - 1)),
    "the spoken text is the original's prefix plus the offer"
  )
  assert.ok(result.spoken.includes("**Best value:**"), "markdown survives for the sanitizer to strip")
})

// The case that motivated counting units rather than sentences: a list has
// almost no sentence-ending punctuation in it.
test("list items count as spoken units, because the sanitizer makes them sentences", () => {
  const text = "- The 3060\n- The 6700 XT\n- The 4070\n- The 7800 XT\n- The 4060 Ti"
  const result = shortenForSpeech(text, units(2))

  assert.equal(result.total, 5)
  assert.equal(result.trimmed, true)
  assert.ok(!result.spoken.includes("4070"), "the third item was dropped")
})

test("a single long sentence is spoken whole rather than cut", () => {
  const text =
    "The 3060 is the safe pick for a budget build because it has twelve gigabytes of VRAM " +
    "and sells used for about two hundred pounds, which is less than anything newer with " +
    "the same memory, and it draws little enough power to run on a small supply"
  const result = shortenForSpeech(text, units(3))

  assert.equal(result.spoken, text)
  assert.equal(result.trimmed, false)
  assert.equal(result.total, 1)
})

test("nothing is ever cut mid-sentence", () => {
  const text = "One. Two. Three. Four. Five. Six."
  for (const limit of [1, 2, 3, 4, 5]) {
    const result = shortenForSpeech(text, units(limit))
    const spoken = result.spoken.replace(` ${CONTINUE_OFFER}`, "")
    assert.ok(/[.!?]$/.test(spoken.trim()), `limit ${limit} ended on a sentence boundary`)
  }
})

test("a price is not a sentence boundary", () => {
  const result = shortenForSpeech("A used 3090 is about $1,360.90 today. That is the going rate.", units(1))

  assert.equal(result.total, 2)
  assert.equal(result.spoken, `A used 3090 is about $1,360.90 today. ${CONTINUE_OFFER}`)
})

test("version numbers and decimals are not sentence boundaries", () => {
  const result = shortenForSpeech("faster-whisper 1.2.1 is installed and 3.5 is not.", units(1))
  assert.equal(result.total, 1)
  assert.equal(result.trimmed, false)
})

test("abbreviations are not sentence boundaries", () => {
  const abbreviated = shortenForSpeech("Ask Dr. Smith about it. Then tell me.", units(1))
  assert.equal(abbreviated.total, 2)

  const eg = shortenForSpeech("Use a small model, e.g. a 3B one. That runs on a laptop.", units(1))
  assert.equal(eg.total, 2)
})

test("an ellipsis is one boundary, not three", () => {
  const result = shortenForSpeech("Well... Maybe. Perhaps. Who knows.", units(2))
  assert.equal(result.total, 4)
})

test("a kept reply ending in a question gets no second question after it", () => {
  const result = shortenForSpeech("Install it and run tailscale up. Want the exit-node version? More follows. And more.", units(2))

  assert.equal(result.trimmed, true)
  assert.ok(result.spoken.endsWith("?"), "ends on the model's own question")
  assert.ok(!result.spoken.includes(CONTINUE_OFFER), "no offer appended after a question")
})

test("a limit below one turns the backstop off but still counts units", () => {
  const text = "One. Two. Three. Four."
  for (const limit of [0, -1]) {
    const result = shortenForSpeech(text, units(limit))
    assert.equal(result.spoken, text)
    assert.equal(result.trimmed, false)
    assert.equal(result.total, 4)
  }
})

test("empty and whitespace-only replies are left alone", () => {
  for (const text of ["", "   ", "\n\n"]) {
    const result = shortenForSpeech(text, units(3))
    assert.equal(result.spoken, text)
    assert.equal(result.trimmed, false)
    assert.equal(result.total, 0)
  }
})

test("trailing text with no final punctuation still counts as a unit", () => {
  const result = shortenForSpeech("First. Second. Third without a full stop", units(2))
  assert.equal(result.total, 3)
  assert.equal(result.trimmed, true)
  assert.ok(!result.spoken.includes("Third"))
})

// ------------------------------------------------------------ word budget
//
// The limit that actually binds. Over six list-tempting questions the model
// kept to three sentences and then wrote sentences of 5 to 12 seconds each, so
// a unit count bounded the number of pauses and not the length of the reply.

test("units are kept while the cumulative word count fits the budget", () => {
  // 10 words per sentence, so a 25-word budget fits two and not three.
  const text =
    "One two three four five six seven eight nine ten. " +
    "One two three four five six seven eight nine ten. " +
    "One two three four five six seven eight nine ten."
  const result = shortenForSpeech(text, words(25))

  assert.equal(result.trimmed, true)
  assert.equal(result.kept, 2)
  assert.equal(result.total, 3)
  assert.equal(result.words, 20)
  assert.equal(result.totalWords, 30)
  assert.ok(result.spoken.endsWith(CONTINUE_OFFER))
})

test("a reply inside the word budget is returned untouched", () => {
  const text = "The 3060 is the safe pick. I can go through a few others if you like."
  const result = shortenForSpeech(text, words(40))

  assert.equal(result.trimmed, false)
  assert.equal(result.spoken, text)
  assert.equal(result.words, result.totalWords)
})

// The case the budget must not break: one sentence over budget has no boundary
// inside it, and speaking a long sentence beats speaking nothing at all.
test("a single over-long first sentence is spoken whole", () => {
  const text =
    "The RTX 3060 is the safe pick for a budget build because it has twelve gigabytes of " +
    "video memory and sells used for about two hundred pounds, which is less than anything " +
    "newer carrying the same amount of memory on board today"
  const result = shortenForSpeech(text, words(10))

  assert.equal(result.spoken, text)
  assert.equal(result.trimmed, false)
  assert.equal(result.total, 1)
  assert.ok(result.totalWords > 10, `${result.totalWords} words, budget was 10`)
})

test("the first unit is always kept even when it alone blows the budget", () => {
  const text =
    "One two three four five six seven eight nine ten eleven twelve. Second sentence here."
  const result = shortenForSpeech(text, words(5))

  assert.equal(result.trimmed, true)
  assert.equal(result.kept, 1)
  assert.equal(result.total, 2)
  assert.equal(result.spoken, `One two three four five six seven eight nine ten eleven twelve. ${CONTINUE_OFFER}`)
})

test("whichever limit binds first applies", () => {
  // Six short sentences: 3 words each, 18 words in all.
  const text = "One two three. Four five six. Seven eight nine. Ten eleven twelve. Thirteen fourteen fifteen. Sixteen seventeen eighteen."

  // The unit count binds: 2 units is 6 words, well inside a 100-word budget.
  const byUnits = shortenForSpeech(text, { maxUnits: 2, maxWords: 100 })
  assert.equal(byUnits.kept, 2)

  // The word budget binds: 7 words allows two units, not a third.
  const byWords = shortenForSpeech(text, { maxUnits: 10, maxWords: 7 })
  assert.equal(byWords.kept, 2)
  assert.equal(byWords.words, 6)
})

test("both limits disabled means nothing is trimmed, but counts still come back", () => {
  const text = "One two three. Four five six. Seven eight nine."
  const result = shortenForSpeech(text, { maxUnits: 0, maxWords: 0 })

  assert.equal(result.trimmed, false)
  assert.equal(result.spoken, text)
  assert.equal(result.total, 3)
  assert.equal(result.totalWords, 9)
})

test("punctuation between clauses is not charged to the word budget", () => {
  const result = shortenForSpeech("Install it — then sign in.", words(40))
  assert.equal(result.totalWords, 5)
})
