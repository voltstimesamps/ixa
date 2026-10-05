import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDismiss } from "../src/voice/dismiss"

// What a false dismiss costs is the user's answer, so the cases that must NOT
// match matter at least as much as the ones that must.

test("a bare dismiss phrase dismisses with nothing to answer", () => {
  for (const text of ["Stop listening.", "stop listening", "Goodbye, Ixa.", "Go to sleep!", "That's all for now."]) {
    const result = parseDismiss(text)
    assert.equal(result.dismissed, true, `${text} dismissed`)
    assert.equal(result.remainder, "", `${text} left nothing to answer`)
  }
})

test("a question before the phrase is answered, then the window closes", () => {
  const result = parseDismiss("What's the capital of Japan? Stop listening.")

  assert.equal(result.dismissed, true)
  assert.equal(result.remainder, "What's the capital of Japan?")
})

test("the remainder keeps its original casing and punctuation", () => {
  const result = parseDismiss("How much is an RTX 3090? Goodbye Ixa.")
  assert.equal(result.remainder, "How much is an RTX 3090?")
})

test("a trailing connector is dropped from the remainder", () => {
  assert.equal(parseDismiss("Tell me the time and stop listening.").remainder, "Tell me the time")
  assert.equal(parseDismiss("Tell me the time, then go to sleep.").remainder, "Tell me the time")
})

test("filler before the phrase is manners, not a turn", () => {
  for (const text of [
    "Okay, stop listening.",
    "Thanks. Stop listening.",
    "Alright, thank you, go to sleep.",
    "Got it. Goodbye Ixa.",
    "Never mind, stop listening.",
    "Cool, thanks — that's all for now.",
  ]) {
    const result = parseDismiss(text)
    assert.equal(result.dismissed, true, `${text} dismissed`)
    assert.equal(result.remainder, "", `${text} submitted no turn`)
  }
})

// "yes" and "no" are answers, not filler: swallowing one would lose a reply
// the user actually gave.
test("a one-word answer before the phrase is still a turn", () => {
  const result = parseDismiss("No. Stop listening.")
  assert.equal(result.dismissed, true)
  assert.equal(result.remainder, "No.")
})

test("a negated phrase is not a dismiss", () => {
  for (const text of [
    "Don't stop listening.",
    "Do not stop listening.",
    "Never go to sleep.",
    "I didn't say stop listening",
    "You can't go to sleep.",
  ]) {
    const result = parseDismiss(text)
    assert.equal(result.dismissed, false, `${text} did not dismiss`)
    assert.equal(result.remainder, "")
  }
})

test("the phrase must end the utterance", () => {
  for (const text of [
    "I told her to stop listening to him",
    "Stop listening is the phrase that dismisses you",
    "Go to sleep early tonight",
  ]) {
    assert.equal(parseDismiss(text).dismissed, false, `${text} did not dismiss`)
  }
})

test("a phrase inside a longer word does not match", () => {
  assert.equal(parseDismiss("That bug is unstoppable").dismissed, false)
})

test("an empty or wordless transcript does not dismiss", () => {
  for (const text of ["", "   ", "...", "?!"]) {
    assert.equal(parseDismiss(text).dismissed, false)
  }
})

test("trailing punctuation and casing do not prevent a match", () => {
  for (const text of ["STOP LISTENING", "Stop listening!!!", "stop listening...", "Stop, listening."]) {
    assert.equal(parseDismiss(text).dismissed, true, `${text} dismissed`)
  }
})
