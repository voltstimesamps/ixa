import type { Tool } from "./registry"

export const dateTool: Tool = {
  name: "get_date",
  // Same treatment as get_time, for the same reason: a date in the window is a
  // record of the day a call was made, and reusing one across midnight is the
  // same failure a day wide. See src/tools/time.ts.
  description:
    "Returns today's date, on the machine you are running on. Call it whenever the date matters " +
    "rather than reusing a date from earlier in this conversation. Never use a web search for " +
    "today's date.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () =>
    `today's date: ${new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })} (a snapshot — call get_date again on a later turn rather than reusing this)`,
}
