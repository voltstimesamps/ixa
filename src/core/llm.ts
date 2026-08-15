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
  tools?: OpenAI.Chat.ChatCompletionTool[],
  options?: { silent?: boolean }
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

  // Groq/Llama sometimes outputs tool calls as raw text instead of via the API
  // mechanism. Detect and throw so the session can retry without tools.
  if (textContent.includes("<function")) {
    throw new Error("malformed tool call in text content")
  }

  if (!options?.silent) {
    process.stdout.write(`Ixa: ${textContent}\n\n`)
  }
  return { type: "text", content: textContent }
}
