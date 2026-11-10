// One voice turn driven straight through chat() with the REAL tool registry,
// for the measurement scripts that need to replay a history or ask a question
// without a backend, a microphone or the sidecars.
//
// It is the same shape voice-behavior-verify.ts's `length` run drives, pulled
// out so a second script does not carry a second copy. What it does NOT
// exercise is Session: no price guard, no claim guard, no empty-reply retry, no
// call cap, no working-directory line. A result from here is the MODEL's
// behaviour given the real prompt, tools and request parameters, which is the
// thing a prompt or description change can move.
//
//   SYSTEM_PROMPT            REAL, leading
//   VOICE_RESPONSE_PROMPT    REAL, trailing — where a voice turn carries it
//   request parameters       REAL — turnCallOptions("voice"), what a turn sends
//   tools                    REAL registry, so the descriptions are the shipped
//                            ones; save_note / search_notes / remember_preference
//                            write to whatever db, vault and collection the
//                            caller's environment points at (assert they are
//                            throwaway before calling)
//   web_search               STUBBED by the caller's `searchStub`
import "../../../src/tools/register"
import { registry } from "../../../src/tools/registry"
import { chat, type Message } from "../../../src/core/llm"
import { runWithSessionControl } from "../../../src/core/session-context"
import { SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT, turnCallOptions } from "../../../src/core/session"

export interface ToolCallRecord {
  name: string
  args: string
  result: string
}

export interface DirectTurn {
  reply: string
  calls: ToolCallRecord[]
  llmCalls: number
  tokens: number
  finishReason: string | null
  error?: string
}

export interface DirectTurnOptions {
  // The conversation so far, WITHOUT any system messages and ending on the
  // user's turn. The caller owns what it contains.
  history: Message[]
  // Extra system messages that sit between SYSTEM_PROMPT and the history, the
  // way the preference and recall blocks do.
  injected?: Message[]
  searchStub: string
  maxIterations?: number
}

export async function directTurn(options: DirectTurnOptions): Promise<DirectTurn> {
  const tools = registry.toOpenAI()
  const callOptions = turnCallOptions("voice")
  const lastUser = [...options.history].reverse().find((m) => m.role === "user")
  const userText = typeof lastUser?.content === "string" ? lastUser.content : ""
  const maxIterations = options.maxIterations ?? 6

  const calls: ToolCallRecord[] = []
  const searchResults: string[] = []
  let reply = ""
  let llmCalls = 0
  let tokens = 0
  let finishReason: string | null = null
  let error: string | undefined

  try {
    await runWithSessionControl(
      {
        requestNewConversation: () => {},
        evidence: {
          userText,
          source: "voice",
          sessionId: `direct-${Date.now()}`,
          searchResults,
        },
      },
      async () => {
        const messages: Message[] = [
          { role: "system", content: SYSTEM_PROMPT },
          ...(options.injected ?? []),
          ...options.history,
        ]
        for (let i = 0; i < maxIterations; i++) {
          llmCalls++
          const response = await chat(
            [...messages, { role: "system", content: VOICE_RESPONSE_PROMPT }],
            tools,
            { silent: true, ...callOptions }
          )
          tokens += (response.cost?.promptTokens ?? 0) + (response.cost?.completionTokens ?? 0)

          if (response.type === "text") {
            reply = response.content
            finishReason = response.finishReason ?? null
            return
          }

          messages.push({
            role: "assistant",
            content: null,
            tool_calls: response.calls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          })
          for (const tc of response.calls) {
            const tool = registry.get(tc.name)
            let result: string
            if (!tool) {
              result = `Unknown tool: ${tc.name}`
            } else if (tool.name === "web_search") {
              result = options.searchStub
              searchResults.push(result)
            } else {
              try {
                const output = await tool.execute(JSON.parse(tc.arguments || "{}"))
                result = typeof output === "string" ? output : JSON.stringify(output)
              } catch (err) {
                result = `Tool error: ${err instanceof Error ? err.message : String(err)}`
              }
            }
            calls.push({ name: tc.name, args: tc.arguments, result })
            messages.push({ role: "tool", tool_call_id: tc.id, content: result })
          }
        }
        reply = "(no final reply: hit the iteration ceiling)"
      }
    )
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return { reply, calls, llmCalls, tokens, finishReason, ...(error ? { error } : {}) }
}
