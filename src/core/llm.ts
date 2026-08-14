import OpenAI from "openai"
import { config } from "../config"

const client = new OpenAI({
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
})

export type Message = OpenAI.Chat.ChatCompletionMessageParam

export type ToolCall = {
  id: string
  name: string
  arguments: string
}

export type LLMResponse =
  | { type: "text"; content: string }
  | { type: "tool_calls"; calls: ToolCall[] }

export async function chat(
  messages: Message[],
  tools?: OpenAI.Chat.ChatCompletionTool[]
): Promise<LLMResponse> {
  const stream = await client.chat.completions.create({
    model: config.llm.model,
    messages,
    tools: tools?.length ? tools : undefined,
    stream: true,
  })

  let textContent = ""
  const toolCallMap = new Map<number, ToolCall>()

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (!delta) continue

    if (delta.content) {
      if (!textContent) process.stdout.write("Ixa: ")
      process.stdout.write(delta.content)
      textContent += delta.content
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCallMap.get(tc.index) ?? { id: "", name: "", arguments: "" }
        toolCallMap.set(tc.index, {
          id: existing.id || tc.id || "",
          name: existing.name || tc.function?.name || "",
          arguments: existing.arguments + (tc.function?.arguments ?? ""),
        })
      }
    }
  }

  if (toolCallMap.size > 0) {
    return {
      type: "tool_calls",
      calls: Array.from(toolCallMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc),
    }
  }

  process.stdout.write("\n\n")
  return { type: "text", content: textContent }
}
