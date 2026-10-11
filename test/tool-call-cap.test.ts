import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { config } from "../src/config"
import { TURN_FAILURE_APOLOGY, type ChatFn } from "../src/core/session"
import type { LLMResponse, Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// The per-turn TOOL CALL budget, which replaced a hard-coded bound on
// ITERATIONS.
//
// A live voice turn asked to read a file made nine single-call iterations —
// three `ls -R` that overflowed execFile's buffer, two `find` calls with
// literal quotes in the pattern, a notes search — and then returned no text.
// The old limit was 10 iterations, so that turn was one iteration from dying
// in the failure apology with nine calls of work thrown away, and nothing had
// told the model it was running out. Worse, the unit was wrong: one iteration
// can carry any number of parallel calls, so ten iterations bounded anything
// between 10 calls and no calls at all.
//
// What the budget has to do is end the turn in an ANSWER. A cap that produces
// "something went wrong on my end" is a cap that loses the work.

const LIMIT = config.tools.maxToolCallsPerTurn

let probesRun = 0
registry.register({
  name: "cap_probe",
  description: "A probe that counts its executions.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () => {
    probesRun++
    return "probe ran"
  },
})

function parallelProbes(n: number, round: number): LLMResponse {
  return {
    type: "tool_calls",
    calls: Array.from({ length: n }, (_, i) => ({
      id: `r${round}c${i}`,
      name: "cap_probe",
      arguments: "{}",
    })),
  }
}

function sessions(chat: ChatFn): SessionManager {
  return new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
}

test("the budget is fifteen calls by default", () => {
  assert.equal(LIMIT, 15)
})

// The shape of the live turn, run past the limit. The model keeps asking for
// one more call and never answers on its own; the budget has to stop it AND
// get an answer out of it.
test("a turn that spends its whole budget ends in an answer, not the apology", async () => {
  probesRun = 0
  let call = 0
  const sent: Message[][] = []
  const chat: ChatFn = async (messages, tools) => {
    sent.push(messages)
    call++
    // Asked with no tools, the model can only answer — which is the point of
    // passing none. Asserted on the real argument, not inferred.
    if (!tools || tools.length === 0) {
      return { type: "text", content: "I could not find that file." }
    }
    return parallelProbes(1, call)
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("read your architecture doc", makeConnection(), "text")

  assert.equal(reply, "I could not find that file.", "the turn ends in an answer")
  assert.notEqual(reply, TURN_FAILURE_APOLOGY, "a spent budget is not a failed turn")
  assert.equal(probesRun, LIMIT, "exactly the budget is spent, never more")

  // The notice reaches the model on the call that has no tools, and says what
  // is true: the budget is gone, so answer or say what you could not find.
  const lastSent = sent.at(-1)!
  const notice = lastSent.filter((m) => m.role === "system").at(-1)!
  assert.match(String(notice.content), new RegExp(`all ${LIMIT} tool calls`))
  assert.match(String(notice.content), /Answer with what you found/)

  manager.shutdown()
})

// The notice is a statement about one CALL, not something that was said, so it
// must never end up in stored history — the same rule the price correction and
// the voice constraint follow.
test("the budget notice is never written to history", async () => {
  probesRun = 0
  let call = 0
  const chat: ChatFn = async (_messages, tools) => {
    call++
    if (!tools || tools.length === 0) return { type: "text", content: "done looking" }
    return parallelProbes(1, call)
  }

  const manager = sessions(chat)
  await manager.submitTurn("go hunting", makeConnection(), "text")

  const history = manager.primarySession().history()
  assert.equal(
    history.some((m) => String(m.content ?? "").includes("tool calls for this turn")),
    false,
    "the notice is injected per call and never stored",
  )

  manager.shutdown()
})

// A budget checked only between iterations would let one parallel group walk
// straight past it. The group is still ANSWERED whole — an assistant
// tool_calls message with a missing result is rejected outright by the API —
// but only the affordable calls RUN.
test("a parallel group larger than the remaining budget runs only what it can pay for", async () => {
  probesRun = 0
  let call = 0
  const chat: ChatFn = async (_messages, tools) => {
    call++
    if (!tools || tools.length === 0) return { type: "text", content: "answered anyway" }
    // One group of LIMIT + 4: more than the whole budget in a single iteration.
    if (call === 1) return parallelProbes(LIMIT + 4, call)
    return { type: "text", content: "answered anyway" }
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("search everything at once", makeConnection(), "text")

  assert.equal(reply, "answered anyway")
  assert.equal(probesRun, LIMIT, "only the affordable calls ran")

  const history = manager.primarySession().history()
  const group = history.find((m) => m.role === "assistant" && "tool_calls" in m)!
  const calls = (group as { tool_calls: unknown[] }).tool_calls
  assert.equal(calls.length, LIMIT + 4, "the model's group is recorded as it was issued")

  // Every call answered: the group is complete, which is what keeps every
  // later turn in this session sendable.
  const results = history.filter((m) => m.role === "tool")
  assert.equal(results.length, LIMIT + 4, "a tool-call group is never persisted incomplete")

  const refused = results.filter((m) => String(m.content).startsWith("not executed"))
  assert.equal(refused.length, 4, "the calls past the budget are marked not executed")

  // And marked truthfully. "The turn failed" would be a lie here — the turn is
  // still running and about to answer — and a result that reads as a fault is
  // an invitation to retry, which is what the cap exists to stop.
  for (const m of refused) {
    assert.match(String(m.content), /tool-call limit was reached/)
    assert.match(String(m.content), /Nothing happened, nothing is wrong/)
    assert.doesNotMatch(String(m.content), /the turn failed/)
  }

  manager.shutdown()
})

// The budget is not a tripwire for an ordinary turn: one search and one note
// must not notice it exists.
test("a turn inside the budget is untouched", async () => {
  probesRun = 0
  let call = 0
  const sent: Message[][] = []
  const chat: ChatFn = async (messages, tools) => {
    sent.push(messages)
    call++
    if (call <= 2) {
      assert.ok(tools && tools.length > 0, "tools stay available while budget remains")
      return parallelProbes(1, call)
    }
    return { type: "text", content: "two calls was enough" }
  }

  const manager = sessions(chat)
  const reply = await manager.submitTurn("look two things up", makeConnection(), "text")

  assert.equal(reply, "two calls was enough")
  assert.equal(probesRun, 2)
  assert.equal(
    sent.flat().some((m) => String(m.content ?? "").includes("tool calls for this turn")),
    false,
    "no notice is injected while the budget holds",
  )

  manager.shutdown()
})

// The runaway guard behind the budget, and a different thing from the budget.
// Reaching it means the loop asked the model again and again and never got
// text — not even when it was handed no tools and told the budget was gone.
// No turn should do that, so it stays a failed turn, and the message says
// which limit it was.
test("a model that never answers is bounded, and that one IS a failed turn", async () => {
  probesRun = 0
  let call = 0
  // Tool calls forever, whether or not it was given any tools: once the budget
  // is spent every one is refused, so nothing is ever spent again and the
  // iteration bound is the only thing left to stop it.
  const chat: ChatFn = async () => {
    call++
    return parallelProbes(1, call)
  }

  const manager = sessions(chat)
  await assert.rejects(
    () => manager.submitTurn("never answer me", makeConnection(), "text"),
    /LLM call limit \(20 calls in one turn\) reached/,
  )

  assert.equal(probesRun, LIMIT, "the budget still held: nothing ran past it")

  const history = manager.primarySession().history()
  // Still sendable afterwards: every group complete, and the failure recorded
  // as the apology the user heard.
  const groups = history.filter((m) => m.role === "assistant" && "tool_calls" in m)
  assert.equal(groups.length, 20, "one group per iteration")
  assert.equal(
    history.filter((m) => m.role === "tool").length,
    20,
    "every call in every group is answered",
  )
  assert.ok(String(history.at(-1)!.content).startsWith(TURN_FAILURE_APOLOGY))

  manager.shutdown()
})
