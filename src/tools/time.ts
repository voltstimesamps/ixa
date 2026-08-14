import type { Tool } from "./registry"

export const timeTool: Tool = {
  name: "get_time",
  description: "Returns the current local time.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () => new Date().toLocaleTimeString(),
}
