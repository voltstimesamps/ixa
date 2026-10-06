import type { Message } from "./llm"

// Context windowing.
//
// Stored history grows without bound and is never trimmed — it is the record,
// and Phase 3c summarizes from it. What each LLM request CARRIES is capped
// here instead.
//
// The budget is deliberately a character count, not a token count: a tokenizer
// would be a dependency and a per-turn cost for an approximation that is good
// enough to bound a request. Roughly 4 characters per token, so the 24000
// default is on the order of 6k tokens.
//
// The one hard rule is grouping. An assistant message carrying tool_calls and
// the tool messages answering them are a single indivisible unit: sending a
// tool result without its call (or a call without its results) is rejected
// outright by OpenAI-compatible APIs, so a group is taken whole or not at all.

function isAssistantWithToolCalls(msg: Message): boolean {
  return (
    msg.role === "assistant" &&
    Array.isArray((msg as { tool_calls?: unknown[] }).tool_calls) &&
    ((msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0
  )
}

function charCost(msg: Message): number {
  try {
    return JSON.stringify(msg).length
  } catch {
    return 0
  }
}

// Splits the non-system tail into atomic groups: a tool-call assistant message
// plus the tool results that follow it, or a single standalone message.
function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (isAssistantWithToolCalls(msg)) {
      const group: Message[] = [msg]
      while (i + 1 < messages.length && messages[i + 1]!.role === "tool") {
        group.push(messages[++i]!)
      }
      groups.push(group)
      continue
    }

    // An orphan tool message — a result whose call is not in this array — can
    // only come from history that was already sliced somewhere else. It is
    // unsendable on its own, so it is dropped rather than grouped.
    if (msg.role === "tool") continue

    groups.push([msg])
  }

  return groups
}

export interface ContextWindowLimits {
  maxMessages: number
  budgetChars: number
}

// Returns a NEW array: leading system prompts, then as many of the most recent
// whole groups as fit. Never mutates `messages`.
//
// Leading system messages are always kept regardless of budget — they are the
// instructions, and dropping them changes who Ixa is.
export function buildWindow(messages: Message[], limits: ContextWindowLimits): Message[] {
  let systemCount = 0
  while (systemCount < messages.length && messages[systemCount]!.role === "system") {
    systemCount++
  }

  const leadingSystem = messages.slice(0, systemCount)
  const groups = groupMessages(messages.slice(systemCount))

  let usedChars = leadingSystem.reduce((sum, msg) => sum + charCost(msg), 0)
  let usedMessages = leadingSystem.length
  const kept: Message[][] = []

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!
    const groupChars = group.reduce((sum, msg) => sum + charCost(msg), 0)
    const overMessages = usedMessages + group.length > limits.maxMessages
    const overChars = usedChars + groupChars > limits.budgetChars

    // THE WINDOW IS NEVER EMPTY OF CONVERSATION.
    //
    // Every group used to be dropped the same way, and because the walk
    // BREAKS at the first group that does not fit, dropping the newest one
    // dropped everything behind it too: the window came back holding nothing
    // but the leading system prompts. A single group can exceed the whole
    // budget on its own — four parallel web_search calls are ~21.5k
    // characters of tool results against the 24000 default — so one ordinary
    // turn could reach it. Asked to answer a conversation it could not see,
    // the model returned an empty reply.
    //
    // So the newest group is taken whatever it costs, and the budget binds
    // normally from the second group on. The exception is deliberately this
    // narrow: a tighter cap that drops older turns is the budget working as
    // intended, and only a window with NOTHING in it is broken.
    //
    // Sending an over-budget group is a more expensive request than the
    // budget asked for. Sending no conversation at all is not a request. The
    // budget is a cost control, not a limit of the model's context, so the
    // group goes out and the overrun is logged.
    if (overMessages || overChars) {
      if (kept.length > 0) break
      console.log(
        `context window: newest group is over budget, sending it anyway — ` +
          `${group.length} messages, ${groupChars} chars ` +
          `(limits: ${limits.maxMessages} messages, ${limits.budgetChars} chars)`
      )
    }

    kept.unshift(group)
    usedMessages += group.length
    usedChars += groupChars
  }

  return [...leadingSystem, ...kept.flat()]
}
