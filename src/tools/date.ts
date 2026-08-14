import type { Tool } from "./registry"

export const dateTool: Tool = {
  name: "get_date",
  description: "Returns today's date.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () =>
    new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
}
