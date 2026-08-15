import { config } from "../config"
import type { Tool } from "./registry"

interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
}

interface TavilySearchResponse {
  results: TavilyResult[]
}

interface SearchInput {
  query: string
  count?: number
}

function isSearchInput(value: unknown): value is SearchInput {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.query === "string"
}

export const searchTool: Tool = {
  name: "web_search",
  description:
    "Search the web using Brave Search. Use this when the user asks about current events, real-time information, specific facts you are uncertain about, or anything that may have changed recently. Returns a list of results with titles, URLs, and descriptions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      count: {
        type: "number",
        description: "Number of results to return (default 5, max 10)",
      },
    },
    required: ["query"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isSearchInput(input)) {
      return "Search failed: invalid input"
    }

    if (!config.tavily.apiKey) {
      return "Tavily Search is not configured. Set TAVILY_API_KEY in .env"
    }

    const count = Math.min(input.count ?? 5, 10)

    let response: Response
    try {
      response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.tavily.apiKey,
          query: input.query,
          max_results: count,
          search_depth: "basic",
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Search failed: ${msg}`
    }

    if (!response.ok) {
      return `Search failed: HTTP ${response.status} ${response.statusText}`
    }

    let data: TavilySearchResponse
    try {
      data = (await response.json()) as TavilySearchResponse
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Search failed: ${msg}`
    }

    const results = data.results
    if (!results || results.length === 0) {
      return `No results found for: ${input.query}`
    }

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
      .join("\n\n")
  },
}
