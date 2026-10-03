import { getEpisodicMemory } from "../memory/episodic-memory"
import type { Episode } from "../memory/episodes"
import type { Tool } from "./registry"

// requiresConfirmation: false — this only reads Ixa's own memory of past
// conversations. Same reasoning as the preference tools: the gate is for
// actions with consequences outside the database.

const UNAVAILABLE =
  "Memory search is unavailable right now (the vector index or embedding service is not " +
  "reachable). Tell the user you cannot search your memory at the moment rather than guessing " +
  "at what was discussed."

interface SearchInput {
  query: string
  from?: string
  to?: string
}

function isSearchInput(value: unknown): value is SearchInput {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as Record<string, unknown>).query === "string"
}

// "YYYY-MM-DD" → epoch ms. `endOfDay` makes a `to` bound inclusive of the
// whole day, which is what a person means by "up to the 5th".
function parseDate(value: string | undefined, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  if (Number.isNaN(date.getTime())) return undefined
  if (endOfDay) date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function formatEpisode(episode: Episode): string {
  const date = new Date(episode.endedAt).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  const tags = episode.tags.length > 0 ? ` [${episode.tags.join(", ")}]` : ""
  return `- ${date}: ${episode.summary}${tags}`
}

export const searchMemoryTool: Tool = {
  name: "search_memory",
  description:
    "Search your memory of past conversations with the user. Use this when the user asks what " +
    "you talked about or decided before, or when you clearly need context from an earlier " +
    "conversation that is not already in the notes provided to you. Optionally restrict the " +
    "search to a date range with 'from' and 'to' (YYYY-MM-DD). Returns the date and summary of " +
    "each matching past conversation. If memory search is unavailable, say so plainly rather " +
    "than guessing at what was discussed.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for, in natural language — a topic, decision, or question.",
      },
      from: {
        type: "string",
        description: "Optional earliest date to search, as YYYY-MM-DD.",
      },
      to: {
        type: "string",
        description: "Optional latest date to search, as YYYY-MM-DD.",
      },
    },
    required: ["query"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isSearchInput(input)) {
      return "Could not search memory: 'query' is required."
    }

    const memory = getEpisodicMemory()
    if (!memory) return UNAVAILABLE

    const result = await memory.search(input.query, {
      from: parseDate(input.from, false),
      to: parseDate(input.to, true),
    })

    if (!result.available) return UNAVAILABLE

    if (result.episodes.length === 0) {
      const range = input.from || input.to ? " in that date range" : ""
      return `No past conversations match that${range}.`
    }

    return (
      `${result.episodes.length} past conversation${result.episodes.length === 1 ? "" : "s"}:\n` +
      result.episodes.map(formatEpisode).join("\n")
    )
  },
}
