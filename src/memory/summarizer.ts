import { config } from "../config"
import type { Message } from "../core/llm"
import type { ChatFn } from "../core/session"

// Turns a finished conversation into one episode: a few sentences plus topic
// tags, written for Ixa's future self rather than for the user.
//
// Nothing in here is allowed to throw. A session that ends is summarized on a
// best-effort basis; a parse failure costs the tags, never the episode.

export interface EpisodeSummary {
  summary: string
  tags: string[]
}

const SUMMARY_PROMPT =
  "You are writing a memory note about a conversation that just ended between the user and " +
  "their assistant, Ixa. Write it for your future self, so you can recall this conversation " +
  "weeks from now.\n\n" +
  "Reply with ONLY a JSON object of the form " +
  '{"summary": "...", "tags": ["...", "..."]}.\n\n' +
  "The summary is 2-4 plain sentences covering what was discussed, what was decided, and what " +
  "was left open or unresolved. Name specifics — files, tools, numbers, decisions — because a " +
  "vague summary is useless later. Do not write in the first person and do not address the " +
  "user. 'tags' is 3-6 short lowercase topic keywords. One conversation may cover several " +
  "topics; include them all."

const MAX_FALLBACK_SUMMARY_CHARS = 1500

// How many user messages the session holds. The trivial-session check reads
// this: a session where the user said one thing is not worth remembering.
export function countUserTurns(history: readonly Message[]): number {
  return history.filter((message) => message.role === "user").length
}

// Renders history as a transcript. Tool traffic is collapsed to a marker:
// what matters later is that a search happened, not the JSON it returned.
export function renderTranscript(history: readonly Message[], maxChars: number): string {
  const lines: string[] = []

  for (const message of history) {
    if (message.role === "system") continue

    if (message.role === "user") {
      lines.push(`User: ${String(message.content ?? "")}`)
      continue
    }

    if (message.role === "assistant") {
      const toolCalls = (message as { tool_calls?: Array<{ function?: { name?: string } }> })
        .tool_calls
      if (toolCalls?.length) {
        const names = toolCalls.map((call) => call.function?.name ?? "tool").join(", ")
        lines.push(`Ixa: [used ${names}]`)
      } else if (message.content) {
        lines.push(`Ixa: ${String(message.content)}`)
      }
      continue
    }

    if (message.role === "tool") {
      const text = String(message.content ?? "").replace(/\s+/g, " ")
      lines.push(`[tool result: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}]`)
    }
  }

  const transcript = lines.join("\n")
  // Keep the END of the conversation when trimming: how it concluded, and what
  // was left open, is the part worth remembering.
  return transcript.length <= maxChars ? transcript : `…\n${transcript.slice(-maxChars)}`
}

// Pulls the JSON object out of a reply that may be wrapped in prose or fences.
function parseSummary(raw: string): EpisodeSummary | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      summary?: unknown
      tags?: unknown
    }
    if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") return null

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => tag.length > 0)
          .slice(0, 8)
      : []

    return { summary: parsed.summary.trim(), tags }
  } catch {
    return null
  }
}

export async function summarizeSession(
  history: readonly Message[],
  chat: ChatFn,
  options: { inputChars?: number } = {}
): Promise<EpisodeSummary> {
  const transcript = renderTranscript(history, options.inputChars ?? config.memory.summaryInputChars)

  const messages: Message[] = [
    { role: "system", content: SUMMARY_PROMPT },
    { role: "user", content: `Conversation:\n\n${transcript}` },
  ]

  // No tools, and silent: this is background work, not a reply to anyone.
  const response = await chat(messages, [], { silent: true })
  const raw = response.type === "text" ? response.content : ""

  const parsed = parseSummary(raw)
  if (parsed) return parsed

  // The model ignored the format. A plain-text summary is still a useful
  // episode, so keep it rather than losing the conversation over punctuation.
  const fallback = raw.trim().slice(0, MAX_FALLBACK_SUMMARY_CHARS)
  if (fallback) {
    console.warn("memory: summary was not valid JSON, storing it as plain text")
    return { summary: fallback, tags: [] }
  }

  throw new Error("summarizer returned nothing usable")
}
