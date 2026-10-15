import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import {
  CLAIM_GUARD_CANCELLED,
  CLAIM_GUARD_DECLINED,
  CLAIM_GUARD_FAILED,
  CLAIM_GUARD_UNANSWERED,
  claimGuardFallback,
  type ChatFn,
} from "../src/core/session"
import { findCompletionClaim } from "../src/core/claims"
import type { ConfirmationOutcome } from "../src/core/confirmation"
import type { Tool } from "../src/tools/registry"
import type { Message } from "../src/core/llm"
import { makeConfirmingTool, makeConnection, TEST_LIMITS } from "./helpers"

// IXA MAY NOT TELL THE USER SHE DID SOMETHING SHE DID NOT DO.
//
// Live, a voice turn at reasoning_effort low: `shell_write touch MyFile.txt`,
// the user typed "no", the tool result was "Action declined by user." in those
// four words, and the reply was "I've created MyFile.txt." The file did not
// exist — and asked about it six turns later Ixa ran `ls`, got "No such file
// or directory", and said the attempt had been declined. Nothing was wrong
// with her reading of the result; the lie was in the reply.
//
// The system prompt has carried "NEVER CLAIM AN ACTION YOU DID NOT TAKE" in
// capitals since before this happened, which is what makes a guard the right
// shape rather than another sentence.
//
// Replaying that history, 30 turns per arm: low claimed it 8 times, medium 0.
// Replacing the user's mis-transcribed "Done, yeah." with "Yes, go ahead."
// gave 0 of 10, and a fresh conversation gave 0 of 20 in both arms — so what
// is guarded here is one specific confusion, not a model that lies at random.

const confirming = makeConfirmingTool("claim_probe")
registry.register(confirming)

// A confirming tool that RUNS and reports its own failure, which is the fourth
// outcome. Its own `isFailure`, because that is how `executeTool` decides —
// the session never parses a result itself.
let failingRuns = 0
const failingTool: Tool = {
  name: "claim_probe_fails",
  description: "test tool that fails",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: true,
  isFailure: (result: string) => result.startsWith("Command failed:"),
  execute: async () => {
    failingRuns++
    return "Command failed: no such file"
  },
}
registry.register(failingTool)

// A non-confirming tool that runs and fails, for the turn the guard must not
// touch: the user was never asked anything, so this is not the failure being
// guarded. A failed `shell_read` arms nothing.
let readingRuns = 0
const readingTool: Tool = {
  name: "claim_probe_reads",
  description: "test read-only tool that fails",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  isFailure: (result: string) => result.startsWith("Command failed:"),
  execute: async () => {
    readingRuns++
    return "Command failed: no such file"
  },
}
registry.register(readingTool)

// A tool that confirms nothing and succeeds, for the two cases the guard must
// not touch.
let succeedingRuns = 0
const succeedingTool: Tool = {
  name: "claim_probe_saves",
  description: "test tool that works",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () => {
    succeedingRuns++
    return "SAVED note-1"
  },
}
registry.register(succeedingTool)

interface Run {
  reply: string
  history: readonly Message[]
  // Calls that were asked for a REPLY. Deliberately not every chat call:
  // `generateDescription` is an LLM call too — it writes the confirmation
  // prose — and it goes out with `silent: true`, so counting it here would
  // make "did the guard ask again?" unanswerable.
  drafts: string[]
}

// One turn. `drafts` are the replies the fake model produces in order, so a
// test states exactly what Ixa "tries to say" at each step.
async function runTurn(options: {
  tool: string
  outcome: ConfirmationOutcome
  drafts: string[]
  origin?: "voice" | "text"
}): Promise<Run> {
  let toolCallMade = false
  const seen: string[] = []
  const chat: ChatFn = async (_messages, _tools, chatOptions) => {
    // The confirmation prose. Not a draft reply, and not counted as one.
    if (chatOptions?.silent) return { type: "text", content: "This will create a file." }
    if (!toolCallMade) {
      toolCallMade = true
      return { type: "tool_calls", calls: [{ id: "c1", name: options.tool, arguments: "{}" }] }
    }
    const draft = options.drafts[seen.length] ?? "(ran out of drafts)"
    seen.push(draft)
    return { type: "text", content: draft }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ confirmer: async () => options.outcome })
  const reply = await manager.submitTurn("make that file", connection, options.origin ?? "voice")

  return { reply, history: manager.primarySession().history(), drafts: seen }
}

// ------------------------------------------------- the four outcomes, corrected

test("a claiming draft is corrected once, for each of the four outcomes", async () => {
  const cases: { outcome: ConfirmationOutcome; tool: string; sentence: string }[] = [
    { outcome: "declined", tool: "claim_probe", sentence: CLAIM_GUARD_DECLINED },
    { outcome: "timeout", tool: "claim_probe", sentence: CLAIM_GUARD_UNANSWERED },
    { outcome: "cancelled", tool: "claim_probe", sentence: CLAIM_GUARD_CANCELLED },
    // The fourth is not a confirmation outcome at all: the user says yes and
    // the tool then fails.
    { outcome: "confirmed", tool: "claim_probe_fails", sentence: CLAIM_GUARD_FAILED },
  ]

  for (const { outcome, tool, sentence } of cases) {
    const run = await runTurn({
      tool,
      outcome,
      // The lie, then the honest second draft the correction asks for.
      drafts: ["I've created MyFile.txt.", "I didn't create it, because that was not confirmed."],
    })

    // The honest draft is what the user gets: the guard asked again and the
    // answer was good, so the code-authored sentence is never reached.
    assert.equal(run.reply, "I didn't create it, because that was not confirmed.", outcome)
    assert.notEqual(run.reply, sentence, `${outcome} should not have needed the fixed sentence`)
    // Two drafts were asked for: the rejected one and the corrected one.
    assert.deepEqual(
      run.drafts,
      ["I've created MyFile.txt.", "I didn't create it, because that was not confirmed."],
      `${outcome} did not retry exactly once`
    )

    // THE REJECTED DRAFT IS NOWHERE IN HISTORY. The user never heard it, and
    // history saying Ixa said it is the drift the turn-failure record exists
    // to prevent.
    const assistantText = run.history
      .filter((m) => m.role === "assistant")
      .map((m) => m.content ?? "")
      .join("\n")
    assert.ok(
      !assistantText.includes("I've created"),
      `${outcome}: the rejected draft was recorded: ${assistantText}`
    )
    // Nor is the correction itself, which is a statement about a draft and not
    // a thing that was said.
    assert.ok(!assistantText.includes("STOP."), `${outcome}: the correction was recorded`)
  }
})

// ------------------------------------------- the second draft that still lies

test("a second claiming draft is replaced by the fixed sentence, and recorded with a note", async () => {
  const run = await runTurn({
    tool: "claim_probe",
    outcome: "declined",
    // Both drafts claim it. The second one says it differently, so what is
    // under test is the claim and not one exact string.
    drafts: ["I've created MyFile.txt.", "Done. MyFile.txt has been created."],
  })

  assert.equal(run.reply, CLAIM_GUARD_DECLINED)
  // The sentence says the one thing the drafts would not.
  assert.match(run.reply, /didn't do that/)
  assert.match(run.reply, /nothing happened/)
  // Corrected once and once only. No third ask of a model that has already
  // claimed it twice.
  assert.equal(run.drafts.length, 2)

  // Content-bearing assistant messages only: the turn's first assistant
  // message is the tool-call one, which carries calls and no words.
  const recorded = run.history
    .filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.length > 0)
    .map((m) => m.content as string)
  assert.equal(recorded.length, 1, `expected one spoken reply in history: ${JSON.stringify(recorded)}`)
  // What the user heard, verbatim, plus the bracketed note for the model —
  // the same contract as lengthCutRecord.
  assert.ok(recorded[0]!.startsWith(CLAIM_GUARD_DECLINED), recorded[0])
  assert.match(recorded[0]!, /\[this sentence was written by code/)
  assert.match(recorded[0]!, /claim_probe was not carried out/)
  assert.match(recorded[0]!, /the user declined the confirmation/)
  // Neither rejected draft survives anywhere.
  assert.ok(!recorded[0]!.includes("I've created"), recorded[0])
  assert.ok(!recorded[0]!.includes("has been created"), recorded[0])
})

test("each outcome has its own sentence, and they are distinct", () => {
  const all = (["declined", "unanswered", "cancelled", "failed"] as const).map(claimGuardFallback)
  assert.equal(new Set(all).size, 4, `not distinct: ${JSON.stringify(all)}`)
  // A decline and an unanswered prompt are different facts about the user, and
  // reporting the second as the first is the inaccuracy the timeout outcome
  // was separated out to fix in the first place.
  assert.match(CLAIM_GUARD_DECLINED, /You said no/)
  assert.match(CLAIM_GUARD_UNANSWERED, /Nobody answered/)
  assert.ok(!/said no/i.test(CLAIM_GUARD_UNANSWERED), CLAIM_GUARD_UNANSWERED)
  // The failed sentence must NOT say nothing happened: a tool that ran may
  // have done part of its work, and one abandoned on its deadline may still
  // finish.
  assert.ok(!/nothing happened/.test(CLAIM_GUARD_FAILED), CLAIM_GUARD_FAILED)
  assert.match(CLAIM_GUARD_FAILED, /can't tell you it went through/)
  // All four are spoken, so none of them carries anything TTS has to guess at.
  for (const sentence of all) {
    assert.ok(!/[[\]—`*_#]/.test(sentence), `not sayable as written: ${sentence}`)
  }
})

// -------------------------------------------------- what must NOT be touched

test("a truthful 'I saved that note' is untouched when the tool succeeded", async () => {
  // The expensive false positive, and the reason condition 2 exists. The turn
  // declines a confirming tool AND successfully calls another one — so
  // condition 1 is met and the draft claims an action, and the guard still
  // must not fire, because something really did happen.
  const before = succeedingRuns
  let toolCallMade = false
  let drafts = 0
  const chat: ChatFn = async (_messages, _tools, chatOptions) => {
    if (chatOptions?.silent) return { type: "text", content: "This will do two things." }
    if (!toolCallMade) {
      toolCallMade = true
      return {
        type: "tool_calls",
        calls: [
          { id: "c1", name: "claim_probe", arguments: "{}" },
          { id: "c2", name: "claim_probe_saves", arguments: "{}" },
        ],
      }
    }
    drafts++
    return { type: "text", content: "I saved that note. I didn't run the other thing." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ confirmer: async () => "declined" })
  const reply = await manager.submitTurn("save it and do the thing", connection, "voice")

  assert.equal(succeedingRuns - before, 1, "the second tool really ran")
  assert.equal(reply, "I saved that note. I didn't run the other thing.")
  // One draft, not two: nothing was asked again.
  assert.equal(drafts, 1, "the guard fired on a turn where a tool succeeded")
})

test("a turn with no confirming tool is untouched, even when the draft claims a lot", async () => {
  // Only a non-confirming tool, and it fails. The user was never asked a
  // question, so this is not the failure being guarded — a failed shell_read
  // arms nothing.
  let toolCallMade = false
  let drafts = 0
  const chat: ChatFn = async (_messages, _tools, chatOptions) => {
    if (chatOptions?.silent) return { type: "text", content: "This will read a file." }
    if (!toolCallMade) {
      toolCallMade = true
      return { type: "tool_calls", calls: [{ id: "c1", name: "claim_probe_reads", arguments: "{}" }] }
    }
    drafts++
    return { type: "text", content: "I've created MyFile.txt and I deleted the old one." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ confirmer: async () => "declined" })
  const reply = await manager.submitTurn("do it", connection, "voice")

  assert.equal(readingRuns, 1, "the read really ran and really failed")
  assert.equal(reply, "I've created MyFile.txt and I deleted the old one.")
  assert.equal(drafts, 1, "the guard fired with no confirming tool in the turn")
})

test("a text turn is guarded too", async () => {
  // The measured failure was a voice turn, but nothing about it is spoken: the
  // same history and the same ambiguous message arrive by text.
  const run = await runTurn({
    tool: "claim_probe",
    outcome: "declined",
    drafts: ["I've created MyFile.txt.", "I didn't create it."],
    origin: "text",
  })
  assert.equal(run.drafts.length, 2, "the guard did not fire on a text turn")
  assert.equal(run.reply, "I didn't create it.")
})

// ------------------------------------------------------- the pattern itself

test("the pattern catches the claims it was written for", () => {
  for (const reply of [
    // The live reply, verbatim, with both apostrophes seen in practice.
    "I've created MyFile.txt.",
    "I’ve created MyFile.txt.",
    "I created MyFile.txt.",
    "I have created the file.",
    "I just deleted it.",
    "I already saved that.",
    "I've created MyFile.txt and written the list of Python files into it.",
    "Done. The file is there.",
    "All done.",
    "That's done.",
    "MyFile.txt has been created.",
    "It's been deleted.",
    "All set.",
    // The two verbs that carry an idiom still work in their literal sense.
    "I ran the command for you.",
    "I made the directory.",
  ]) {
    assert.ok(findCompletionClaim(reply), `missed a claim: ${reply}`)
  }
})

test("the pattern leaves truthful replies alone", () => {
  // Every one of these was produced by the measured runs on a turn where
  // nothing happened, which is exactly when the guard is armed. Touching any
  // of them would replace an honest, useful reply with a fixed sentence.
  for (const reply of [
    "I didn't create the file. If you'd like me to try again, just let me know.",
    "I couldn't create the file because the action was declined.",
    "I haven't created it yet.",
    "I can't create the file without your confirmation.",
    "I won't create it until you confirm.",
    "I never created that file.",
    "I did not create the file.",
    "I'm ready to create MyFile.txt when you give the go-ahead.",
    "I'm not going to delete it until you confirm. Is that what you'd like?",
    "Sure, I'll create MyFile.txt now.",
    "Would you like me to create MyFile.txt now?",
    "The file was not created.",
    "Let me know when you're done.",
    "I'm done asking about it.",
    // The two idioms the verb list excludes by name, and the fallback sentence
    // this file's neighbour already speaks.
    "I ran into a problem creating it.",
    "I ran out of tool calls before I could finish that one. Want me to keep going?",
    "I made a mistake there.",
    "I made sure not to touch it.",
  ]) {
    assert.equal(findCompletionClaim(reply), null, `false positive: ${reply}`)
  }
})

test("the claim is returned, not just a boolean, because the correction quotes it", () => {
  // A correction that says "your draft claimed the action happened" argues
  // about what the model meant. One that quotes it does not.
  assert.equal(findCompletionClaim("I've created MyFile.txt."), "I've created")
  assert.equal(findCompletionClaim("Nothing to report here."), null)
})
