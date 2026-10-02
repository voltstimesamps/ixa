import { randomUUID } from "crypto"
import type { Connection } from "../src/core/connection"
import type { ConfirmationOutcome, Confirmer } from "../src/core/confirmation"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse } from "../src/core/llm"
import type { WsMessage } from "../src/api/types"
import type { Tool } from "../src/tools/registry"

export const TEST_LIMITS = { maxMessages: 40, budgetChars: 24000 }

export interface FakeConnection extends Connection {
  sent: WsMessage[]
  close(): void
}

export function makeConnection(options: { confirmer?: Confirmer; id?: string } = {}): FakeConnection {
  let open = true
  const sent: WsMessage[] = []
  return {
    id: options.id ?? randomUUID(),
    confirmer: options.confirmer ?? (async (): Promise<ConfirmationOutcome> => "declined"),
    get isOpen() {
      return open
    },
    sent,
    send: (msg) => {
      sent.push(msg)
    },
    sendBinary: () => {},
    close: () => {
      open = false
    },
  }
}

// A scripted stand-in for the LLM: each call shifts the next reply off the
// queue, so a test states exactly what the model "says" at each step.
export function makeChat(replies: LLMResponse[], hooks: { onCall?: () => void | Promise<void> } = {}): {
  chat: ChatFn
  calls: number
} {
  const state = { calls: 0 }
  const chat: ChatFn = async () => {
    state.calls++
    await hooks.onCall?.()
    const next = replies.shift()
    if (!next) throw new Error("fake chat ran out of scripted replies")
    return next
  }
  return {
    chat,
    get calls() {
      return state.calls
    },
  }
}

export function textReply(content: string): LLMResponse {
  return { type: "text", content }
}

export function toolCallReply(id: string, name: string, args: Record<string, unknown> = {}): LLMResponse {
  return { type: "tool_calls", calls: [{ id, name, arguments: JSON.stringify(args) }] }
}

// A confirming tool that records whether it ever actually ran.
export function makeConfirmingTool(name: string): Tool & { executed: number } {
  const tool = {
    name,
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    requiresConfirmation: true,
    executed: 0,
    execute: async () => {
      tool.executed++
      return "EXECUTED"
    },
  }
  return tool
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
