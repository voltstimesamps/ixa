import { test } from "node:test"
import assert from "node:assert/strict"
import { config } from "../src/config"
import {
  createWsConfirmer,
  pendingConfirmationCount,
  resolveConfirmation,
} from "../src/core/confirmation"
import type { WsMessage } from "../src/api/types"
import { sleep } from "./helpers"

// THE DEADLINE IS CONFIGURABLE AND IT IS TOLD TO THE CLIENT.
//
// It used to be 30 seconds hard-coded in two places, against a desktop client
// whose prompt had no timeout at all: answer at 35s and the server had already
// declined, the answer was dropped with a log line, and the user was told
// nothing. The timeout is now IXA_CONFIRM_TIMEOUT_MS (60s), and the `confirm`
// message carries it so the client can show the time left and decline locally.
//
// The field is additive and advisory: this timer stays the authority, and a
// client that ignores it behaves exactly as before.

test("the default comes from config, not from a literal", () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-default", (msg) => prompts.push(msg))
  void confirmer("do something")

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]!.type, "confirm")
  assert.equal(prompts[0]!.timeoutMs, config.confirm.timeoutMs)
  assert.equal(config.confirm.timeoutMs, 60_000, "60s unless IXA_CONFIRM_TIMEOUT_MS says otherwise")

  resolveConfirmation(prompts[0]!.requestId!, "no", "conn-default")
})

test("the prompt carries a requestId and the deadline it was given", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-explicit", (msg) => prompts.push(msg), 1234)
  const outcome = confirmer("do something")

  assert.equal(prompts[0]!.timeoutMs, 1234)
  assert.ok(prompts[0]!.requestId, "the client needs it to answer")
  assert.ok(prompts[0]!.content, "and the description to show")

  resolveConfirmation(prompts[0]!.requestId!, "yes", "conn-explicit")
  assert.equal(await outcome, "confirmed")
})

// CHANGED BEHAVIOUR. This asserted "silence is a no", and silence is not a
// no: it blocks the action exactly as a no does, but it says nothing about
// whether the user wanted it. The outcome is now its own value, and the tool
// result the model reads says so — see test/confirm-outcomes.test.ts.
test("an unanswered prompt times out when the deadline passes, and stops pending", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-slow", (msg) => prompts.push(msg), 30)
  const before = pendingConfirmationCount()

  const outcome = await confirmer("do something slow")

  assert.equal(outcome, "timeout", "nobody answered, which is not a refusal")
  assert.notEqual(outcome, "declined", "and must not be reported as one")
  assert.equal(pendingConfirmationCount(), before, "and nothing is left pending")
})

// The desktop client expires its prompt a second before the backend does, so
// in practice the backend's own timer above almost never fires for it: what
// arrives is a "no" from the client. Without a reason beside it that lands as
// an explicit decline, which is the same inaccuracy one layer out.
test("a client's own expiry is a timeout, not a decline", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-expired", (msg) => prompts.push(msg), 10_000)
  const outcome = confirmer("do something")

  resolveConfirmation(prompts[0]!.requestId!, "no", "conn-expired", "expired")
  assert.equal(await outcome, "timeout")
})

test("a person's no is still a decline, with or without an unknown reason", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-no", (msg) => prompts.push(msg), 10_000)
  const outcome = confirmer("do something")

  resolveConfirmation(prompts[0]!.requestId!, "no", "conn-no")
  assert.equal(await outcome, "declined")

  // A reason the backend does not know means nothing: only "expired" moves
  // the outcome, so a future client cannot turn a refusal into a timeout by
  // sending a word this code has never heard of.
  const second = createWsConfirmer("conn-no2", (msg) => prompts.push(msg), 10_000)
  const secondOutcome = second("do something else")
  resolveConfirmation(prompts.at(-1)!.requestId!, "no", "conn-no2", "whatever")
  assert.equal(await secondOutcome, "declined")
})

test("an answer that arrives after the deadline changes nothing", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-late", (msg) => prompts.push(msg), 20)

  assert.equal(await confirmer("do something"), "timeout")

  // The client that was too slow answers anyway. This is the case the client
  // now prints "that request already expired" for, rather than appearing to
  // have sent an answer that did nothing.
  resolveConfirmation(prompts[0]!.requestId!, "yes", "conn-late")
  await sleep(5)
  assert.equal(pendingConfirmationCount(), 0, "a late yes cannot revive a closed prompt")
})
