import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import type { ChatFn } from "../src/core/session"
import type { ConfirmationOutcome } from "../src/core/confirmation"
import { makeConfirmingTool, makeConnection, TEST_LIMITS } from "./helpers"

// WHAT THE MODEL IS TOLD when a confirming tool was not confirmed.
//
// There are three different things to have happened and there used to be two
// results for them: a prompt nobody answered inside the time limit was
// reported as "Action declined by user", which puts a refusal on the record
// that was never made. The model then has it in history, and a question about
// it later is answered from a decision the user did not take.
//
// All three block execution, which is why the tool's own counter is asserted
// every time: a result that is merely worded differently would be no fix.

const tool = makeConfirmingTool("outcome_probe")
registry.register(tool)

// The reply the model gives after the tool result comes back. Fixed, so what
// is under test is the RESULT and not the model's reaction to it.
function chatThatCallsTheTool(): { chat: ChatFn; results: () => string[] } {
  let calls = 0
  const results: string[] = []
  const chat: ChatFn = async (messages) => {
    calls++
    if (calls === 1) {
      return { type: "tool_calls", calls: [{ id: "c1", name: "outcome_probe", arguments: "{}" }] }
    }
    for (const message of messages) {
      if (message.role === "tool" && typeof message.content === "string") {
        results.push(message.content)
      }
    }
    return { type: "text", content: "Understood." }
  }
  return { chat, results: () => results }
}

async function runWith(outcome: ConfirmationOutcome): Promise<{ result: string; ran: number }> {
  const before = tool.executed
  const { chat, results } = chatThatCallsTheTool()
  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ confirmer: async () => outcome })

  await manager.submitTurn("do the thing", connection, "text")

  const all = results()
  assert.equal(all.length, 1, `expected one tool result, got ${all.length}`)
  return { result: all[0]!, ran: tool.executed - before }
}

test("a timeout, a decline and a cancel are three different results, and none of them runs the tool", async () => {
  const timedOut = await runWith("timeout")
  const declined = await runWith("declined")
  const cancelled = await runWith("cancelled")

  // Three distinct strings. Asserted as a set, because the point is that the
  // model can tell them apart at all.
  const distinct = new Set([timedOut.result, declined.result, cancelled.result])
  assert.equal(distinct.size, 3, `not distinct: ${JSON.stringify([...distinct])}`)

  // Nothing executed, in any of the three.
  assert.equal(timedOut.ran, 0, "a timeout does not run the tool")
  assert.equal(declined.ran, 0, "a decline does not run the tool")
  assert.equal(cancelled.ran, 0, "a cancel does not run the tool")

  // And each says the one thing only it can say.
  assert.match(declined.result, /declined by user/i)
  assert.match(cancelled.result, /disconnected/i)
  assert.match(timedOut.result, /did not answer the confirmation in time/i)

  // The timeout must not read as a refusal, which is the whole point.
  assert.ok(
    !/declined/i.test(timedOut.result),
    `a timeout must not claim a decline: ${timedOut.result}`
  )
  assert.match(timedOut.result, /NOT a refusal/)

  // And it must not invite a retry. A prompt the user walked away from is not
  // an offer to make the same attempt on the next turn.
  assert.match(timedOut.result, /Do not run it again or ask again/)

  // All three say plainly that nothing happened, because a result that leaves
  // that in doubt is one the model retries.
  for (const outcome of [timedOut, cancelled]) {
    assert.match(outcome.result, /[Nn]othing was executed/)
  }
})

test("a confirmed call still runs, which is the control", async () => {
  const before = tool.executed
  const { chat, results } = chatThatCallsTheTool()
  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ confirmer: async () => "confirmed" })

  const reply = await manager.submitTurn("do the thing", connection, "text")

  assert.equal(reply, "Understood.")
  assert.equal(tool.executed - before, 1, "a yes runs it exactly once")
  assert.equal(results()[0], "EXECUTED")
})
