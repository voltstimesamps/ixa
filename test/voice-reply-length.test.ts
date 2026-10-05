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

// The default the backstop ships with. If this changes, the scoreboard numbers
// in ARCHITECTURE.md stop describing the thing that shipped.
test("the configured default is three spoken sentences", () => {
  assert.equal(config.voice.maxSpokenSentences, 3)
})
