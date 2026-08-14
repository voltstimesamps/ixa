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
