import type { Tool } from "./registry"

export const echoTool: Tool = {
  name: "echo",
  description: "Echoes back the provided message. Useful for testing.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The text to echo back." },
    },
    required: ["message"],
  },
  requiresConfirmation: false,
  execute: async (input) => (input as { message: string }).message,
}
