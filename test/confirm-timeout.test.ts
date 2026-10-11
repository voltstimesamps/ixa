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

test("an unanswered prompt declines when the deadline passes, and stops pending", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-slow", (msg) => prompts.push(msg), 30)
  const before = pendingConfirmationCount()

  const outcome = await confirmer("do something slow")

  assert.equal(outcome, "declined", "silence is a no")
  assert.equal(pendingConfirmationCount(), before, "and nothing is left pending")
})

test("an answer that arrives after the deadline changes nothing", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("conn-late", (msg) => prompts.push(msg), 20)

  assert.equal(await confirmer("do something"), "declined")

  // The client that was too slow answers anyway. This is the case the client
  // now prints "that request already expired" for, rather than appearing to
  // have sent an answer that did nothing.
  resolveConfirmation(prompts[0]!.requestId!, "yes", "conn-late")
  await sleep(5)
  assert.equal(pendingConfirmationCount(), 0, "a late yes cannot revive a declined prompt")
})
