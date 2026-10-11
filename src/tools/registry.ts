import type OpenAI from "openai"

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresConfirmation: boolean
  execute: (input: unknown) => Promise<unknown>
}

class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return Array.from(this.tools.values())
  }

  toOpenAI(): OpenAI.Chat.ChatCompletionTool[] {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
  }
}

export const registry = new ToolRegistry()

// ---------------------------------------------------------- optional arguments

// The JSON Schema type for an optional string argument: `["string", "null"]`,
// never bare `"string"`.
//
// MEASURED, not defensive. gpt-oss-20b writes an EXPLICIT null for an optional
// field it has decided not to use, and Groq validates the arguments against
// this schema before the call ever reaches Ixa. Asked "what did we talk about
// last time?" — the question the no-query path exists for — verification got a
// hard turn failure instead of an answer:
//
//   Tool call validation failed: parameters for tool search_memory did not
//   match schema: errors: [`/from`: expected string, but got null, `/query`:
//   expected string, but got null, `/to`: expected string, but got null]
//
// A null is how the model spells "absent", so the schema accepts it and
// `optionalString` below collapses it back to absent. Omitting the field is
// still what the descriptions ask for; this is about what happens when it
// does the other thing.
export const OPTIONAL_STRING: readonly ["string", "null"] = ["string", "null"]

// null, undefined, "" and "   " all mean the same thing: the argument was not
// given. Blank is in that list because the model sends `query: ""` too, and
// embedding an empty string returns the opposite of what it meant.
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
