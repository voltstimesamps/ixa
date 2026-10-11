import { getEpisodicMemory } from "../memory/episodic-memory"
import { formatEpisodeWhen, type Episode } from "../memory/episodes"
import { OPTIONAL_STRING, optionalString, type Tool } from "./registry"

// requiresConfirmation: false — this only reads Ixa's own memory of past
// conversations. Same reasoning as the preference tools: the gate is for
// actions with consequences outside the database.

const UNAVAILABLE =
  "Memory search is unavailable right now (the vector index or embedding service is not " +
  "reachable). Tell the user you cannot search your memory at the moment rather than guessing " +
  "at what was discussed."

interface SearchInput {
  // Optional: with no query this returns the most recent conversations
  // instead of searching by meaning. See the tool description.
  //
  // `| null` is not decoration: the model sends an explicit null for a field
  // it is not using, so the schema below accepts one and every read of these
  // goes through optionalString, which treats null exactly as absent.
  query?: string | null
  from?: string | null
  to?: string | null
}

function isSearchInput(value: unknown): value is SearchInput {
  return typeof value === "object" && value !== null
}

// "YYYY-MM-DD" → epoch ms, in the BACKEND'S LOCAL TIMEZONE.
//
// `new Date(y, m, d)` is the local-time constructor, deliberately: the user
// means their own Tuesday, not UTC's. Episodes are stored as epoch ms, so the
// bound only has to be built in the same zone the dates are rendered back in
// (formatEpisode below, also local) for the two to agree. A UTC parse would
// put the boundary up to a day off for anyone west of Greenwich.
//
// Note the model has no clock of its own: it learns today's date from get_date
// (also local), which is why the description tells it to call that first
// before building a relative range like "yesterday".
//
// `endOfDay` makes a `to` bound cover the whole day, which is what a person
// means by "up to the 5th".
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

// Local time, matching parseDate — see formatEpisodeWhen for why.
function formatEpisode(episode: Episode): string {
  const tags = episode.tags.length > 0 ? ` [${episode.tags.join(", ")}]` : ""
  return `- ${formatEpisodeWhen(episode.endedAt)}: ${episode.summary}${tags}`
}

export const searchMemoryTool: Tool = {
  name: "search_memory",
  description:
    "Look up your memory of past conversations with the user. Two ways to call it:\n" +
    "- WITH 'query': finds past conversations by meaning. Use this when the user asks whether " +
    "you discussed a particular subject, or when you need context from an earlier conversation " +
    "that is not already in the notes provided to you.\n" +
    "- WITHOUT 'query': returns your most recent conversations, newest first. Use this for any " +
    "question about recency rather than subject — \"what did we talk about last time?\", " +
    "\"what have we been working on?\", \"what did I say yesterday?\". A search by meaning " +
    "cannot answer those, because there is no subject in the question to match on.\n" +
    "Either way you can narrow to a date range with 'from' and 'to' (YYYY-MM-DD, inclusive, in " +
    "the user's local timezone). You do not know today's date — call get_date first if you need " +
    "to work out a relative range such as yesterday or last week. Returns the date, time and " +
    "summary of each conversation. If memory is unavailable, say so plainly rather than guessing " +
    "at what was discussed.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: OPTIONAL_STRING,
        description:
          "Optional. What to look for, in natural language — a topic, decision, or question. " +
          "OMIT IT ENTIRELY to get the most recent conversations instead, which is what a " +
          "question about recency needs.",
      },
      from: {
        type: OPTIONAL_STRING,
        description: "Optional earliest date to search, as YYYY-MM-DD.",
      },
      to: {
        type: OPTIONAL_STRING,
        description: "Optional latest date to search, as YYYY-MM-DD.",
      },
    },
    // Nothing is required: no argument at all is the valid "what did we talk
    // about last time?" call.
    required: [],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isSearchInput(input)) {
      return "Could not search memory: the arguments were not understood."
    }

    const memory = getEpisodicMemory()
    if (!memory) return UNAVAILABLE

    // null, "" and absent all mean "not given" — see optionalString. The
    // model sends all three, and embedding an empty string would return
    // nothing at all, the opposite of what it meant.
    const from = optionalString(input.from)
    const to = optionalString(input.to)
    const range = { from: parseDate(from, false), to: parseDate(to, true) }
    const query = optionalString(input.query)

    const result = query ? await memory.search(query, range) : memory.recent(range)
    if (!result.available) return UNAVAILABLE

    const dated = from || to ? " in that date range" : ""
    if (result.episodes.length === 0) {
      return query
        ? `No past conversations match that${dated}.`
        : `There are no saved conversations${dated} yet.`
    }

    const count = result.episodes.length
    const header = query
      ? `${count} past conversation${count === 1 ? "" : "s"} matching that:`
      : `Your ${count} most recent conversation${count === 1 ? "" : "s"}, newest first:`
    return `${header}\n${result.episodes.map(formatEpisode).join("\n")}`
  },
}
