import { test } from "node:test"
import assert from "node:assert/strict"
import { shortenForSpeech, CONTINUE_OFFER } from "../src/voice/shorten"

// The backstop behind VOICE_RESPONSE_PROMPT. Two properties matter more than
// any individual case here: it never cuts mid-sentence, and the text it keeps
// is a prefix of the original (so the sanitizer still sees real markdown).

test("a reply within the limit is returned untouched", () => {
  const text = "The 3060 is the safe pick. The 6700 XT has more VRAM."
  const result = shortenForSpeech(text, 3)

  assert.equal(result.spoken, text)
  assert.equal(result.trimmed, false)
  assert.equal(result.total, 2)
  assert.equal(result.kept, 2)
})

test("a reply over the limit is cut at a sentence boundary and offered", () => {
  const text = "One. Two. Three. Four. Five."
  const result = shortenForSpeech(text, 3)

  assert.equal(result.spoken, `One. Two. Three. ${CONTINUE_OFFER}`)
  assert.equal(result.trimmed, true)
  assert.equal(result.kept, 3)
  assert.equal(result.total, 5)
})

test("what is kept is a prefix of the original, markdown included", () => {
  const text = "**Best value:** the 3060.\n- The 6700 XT has more VRAM.\n- The 4070 is faster."
  const result = shortenForSpeech(text, 2)

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
  const result = shortenForSpeech(text, 2)

  assert.equal(result.total, 5)
  assert.equal(result.trimmed, true)
  assert.ok(!result.spoken.includes("4070"), "the third item was dropped")
})

test("a single long sentence is spoken whole rather than cut", () => {
  const text =
    "The 3060 is the safe pick for a budget build because it has twelve gigabytes of VRAM " +
    "and sells used for about two hundred pounds, which is less than anything newer with " +
    "the same memory, and it draws little enough power to run on a small supply"
  const result = shortenForSpeech(text, 3)

  assert.equal(result.spoken, text)
  assert.equal(result.trimmed, false)
  assert.equal(result.total, 1)
})

test("nothing is ever cut mid-sentence", () => {
  const text = "One. Two. Three. Four. Five. Six."
  for (const limit of [1, 2, 3, 4, 5]) {
    const result = shortenForSpeech(text, limit)
    const spoken = result.spoken.replace(` ${CONTINUE_OFFER}`, "")
    assert.ok(/[.!?]$/.test(spoken.trim()), `limit ${limit} ended on a sentence boundary`)
  }
})

test("a price is not a sentence boundary", () => {
  const result = shortenForSpeech("A used 3090 is about $1,360.90 today. That is the going rate.", 1)

  assert.equal(result.total, 2)
  assert.equal(result.spoken, `A used 3090 is about $1,360.90 today. ${CONTINUE_OFFER}`)
})

test("version numbers and decimals are not sentence boundaries", () => {
  const result = shortenForSpeech("faster-whisper 1.2.1 is installed and 3.5 is not.", 1)
  assert.equal(result.total, 1)
  assert.equal(result.trimmed, false)
})

test("abbreviations are not sentence boundaries", () => {
  const abbreviated = shortenForSpeech("Ask Dr. Smith about it. Then tell me.", 1)
  assert.equal(abbreviated.total, 2)

  const eg = shortenForSpeech("Use a small model, e.g. a 3B one. That runs on a laptop.", 1)
  assert.equal(eg.total, 2)
})

test("an ellipsis is one boundary, not three", () => {
  const result = shortenForSpeech("Well... Maybe. Perhaps. Who knows.", 2)
  assert.equal(result.total, 4)
})

test("a kept reply ending in a question gets no second question after it", () => {
  const result = shortenForSpeech("Install it and run tailscale up. Want the exit-node version? More follows. And more.", 2)

  assert.equal(result.trimmed, true)
  assert.ok(result.spoken.endsWith("?"), "ends on the model's own question")
  assert.ok(!result.spoken.includes(CONTINUE_OFFER), "no offer appended after a question")
})

test("a limit below one turns the backstop off but still counts units", () => {
  const text = "One. Two. Three. Four."
  for (const limit of [0, -1]) {
    const result = shortenForSpeech(text, limit)
    assert.equal(result.spoken, text)
    assert.equal(result.trimmed, false)
    assert.equal(result.total, 4)
  }
})

test("empty and whitespace-only replies are left alone", () => {
  for (const text of ["", "   ", "\n\n"]) {
    const result = shortenForSpeech(text, 3)
    assert.equal(result.spoken, text)
    assert.equal(result.trimmed, false)
    assert.equal(result.total, 0)
  }
})

test("trailing text with no final punctuation still counts as a unit", () => {
  const result = shortenForSpeech("First. Second. Third without a full stop", 2)
  assert.equal(result.total, 3)
  assert.equal(result.trimmed, true)
  assert.ok(!result.spoken.includes("Third"))
})
