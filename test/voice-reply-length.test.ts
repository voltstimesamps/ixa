import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { config } from "../src/config"
import { CONTINUE_OFFER } from "../src/voice/shorten"
import { makeChat, makeConnection, textReply, TEST_LIMITS } from "./helpers"

// The spoken-length backstop, where it is wired in rather than in isolation
// (test/voice-shorten.test.ts covers the splitter). What matters here is the
// split between what the user HEARS and what history RECORDS, and that a text
// client is unaffected.

const LONG = "One sentence. Two sentences. Three sentences. Four sentences. Five sentences."

function manager(reply: string) {
  const { chat } = makeChat([textReply(reply)])
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

test("a voice reply over the limit is shortened and offered", async () => {
  const sessions = manager(LONG)

  const spoken = await sessions.submitTurn("recommend some GPUs", makeConnection({ id: "v1" }), "voice")

  assert.equal(spoken, `One sentence. Two sentences. Three sentences. ${CONTINUE_OFFER}`)
  assert.ok(!spoken.includes("Four"), "the fourth sentence was never spoken")
  assert.ok(!spoken.includes("["), "the history note is not spoken")

  sessions.shutdown()
})

test("history records what was spoken, plus a note that it was shortened", async () => {
  const sessions = manager(LONG)

  await sessions.submitTurn("recommend some GPUs", makeConnection({ id: "v2" }), "voice")

  const recorded = String(sessions.primarySession().history().at(-1)!.content)
  assert.match(recorded, /^One sentence\. Two sentences\. Three sentences\./)
  assert.match(recorded, /\[reply shortened for speech: spoke 3 of 5 sentences\]$/)
  assert.ok(!recorded.includes("Four sentences"), "the dropped sentences are not kept")

  sessions.shutdown()
})

test("a text turn is never shortened", async () => {
  const sessions = manager(LONG)

  const reply = await sessions.submitTurn("recommend some GPUs", makeConnection({ id: "v3" }), "text")

  assert.equal(reply, LONG)
  assert.equal(String(sessions.primarySession().history().at(-1)!.content), LONG)

  sessions.shutdown()
})

test("a voice reply within the limit is recorded with no note", async () => {
  const short = "The 3060 is the safe pick. I can go through a few others if you like."
  const sessions = manager(short)

  const spoken = await sessions.submitTurn("recommend a GPU", makeConnection({ id: "v4" }), "voice")

  assert.equal(spoken, short)
  assert.equal(String(sessions.primarySession().history().at(-1)!.content), short)

  sessions.shutdown()
})

// The defaults the backstop ships with. If these change, the scoreboard numbers
// in ARCHITECTURE.md stop describing the thing that shipped.
test("the configured defaults are three sentences and forty words", () => {
  assert.equal(config.voice.maxSpokenSentences, 3)
  assert.equal(config.voice.maxSpokenWords, 40)
})

// The word budget is the limit that usually binds, so it needs its own wiring
// test: three sentences can be well over forty words.
test("a voice reply over the word budget is shortened even within three sentences", async () => {
  const wordy =
    "The RTX 3060 is the safe pick at that budget because it has twelve gigabytes of memory. " +
    "The 6700 XT costs a little more but gives you more memory for the money if you can stretch. " +
    "The 4070 is faster again but runs well past what you said you wanted to spend."
  const sessions = manager(wordy)

  const spoken = await sessions.submitTurn("recommend some GPUs", makeConnection({ id: "v5" }), "voice")

  assert.ok(spoken.length < wordy.length, "the reply was shortened")
  assert.ok(spoken.endsWith(CONTINUE_OFFER), "the offer was appended")
  assert.ok(!spoken.includes("4070"), "the third sentence was dropped")

  const recorded = String(sessions.primarySession().history().at(-1)!.content)
  assert.match(recorded, /\[reply shortened for speech: spoke \d+ of 3 sentences\]$/)

  sessions.shutdown()
})
