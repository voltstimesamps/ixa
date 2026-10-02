import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import {
  createWsConfirmer,
  pendingConfirmationCount,
  resolveConfirmation,
} from "../src/core/confirmation"
import type { ChatFn } from "../src/core/session"
import type { WsMessage } from "../src/api/types"
import { makeConnection, makeConfirmingTool, TEST_LIMITS, textReply, toolCallReply, sleep } from "./helpers"

test("a pending confirmation is cancelled when its connection closes, and nothing executes", async () => {
  const tool = makeConfirmingTool("test_confirm_disconnect")
  registry.register(tool)

  const prompts: WsMessage[] = []
  const connectionId = "conn-disconnecting"
  const confirmer = createWsConfirmer(connectionId, (msg) => prompts.push(msg), 60_000)
  const connection = makeConnection({ id: connectionId, confirmer })

  // 1st call: the tool call. 2nd: the one-line action description. 3rd: the
  // reply after the cancellation is recorded.
  const replies = [
    toolCallReply("call_1", tool.name),
    textReply("I am about to run the test tool."),
    textReply("That did not run."),
  ]
  const chat: ChatFn = async () => {
    const next = replies.shift()
    if (!next) throw new Error("fake chat ran out of scripted replies")
    return next
  }

  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const turn = sessions.submitTurn("do the thing", connection, "text")

  // Wait for the confirmation prompt to actually be outstanding.
  for (let i = 0; i < 100 && prompts.length === 0; i++) await sleep(5)
  assert.equal(prompts.length, 1, "a confirm prompt was sent")
  assert.equal(pendingConfirmationCount(), 1)

  // The client vanishes without answering.
  connection.close()
  sessions.detach(connectionId)

  // The in-flight turn finishes rather than hanging on the 60s timeout.
  const reply = await turn
  assert.equal(reply, "That did not run.")

  assert.equal(tool.executed, 0, "the action must not have executed")
  assert.equal(pendingConfirmationCount(), 0, "no confirmation outlives its connection")

  const history = sessions.primarySession().history()
  const toolResult = history.find((m) => m.role === "tool")
  assert.ok(toolResult, "the cancellation is recorded in history")
  assert.match(
    String(toolResult!.content),
    /cancelled/i,
    "history must tell the LLM the action did not happen",
  )
  assert.match(String(toolResult!.content), /disconnected/i)

  sessions.shutdown()
})

test("one connection cannot answer another connection's confirmation", async () => {
  const prompts: WsMessage[] = []
  const confirmer = createWsConfirmer("owner", (msg) => prompts.push(msg), 60_000)

  const outcome = confirmer("do something dangerous")
  const requestId = prompts[0]!.requestId!

  // An unrelated connection tries to say yes.
  resolveConfirmation(requestId, "yes", "impostor")
  assert.equal(pendingConfirmationCount(), 1, "the prompt is still outstanding")

  // The owner answers.
  resolveConfirmation(requestId, "yes", "owner")
  assert.equal(await outcome, "confirmed")
  assert.equal(pendingConfirmationCount(), 0)
})
