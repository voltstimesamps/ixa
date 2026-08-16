import { notify } from "../proactive/notifier"
import type { Tool } from "./registry"

type Priority = "min" | "low" | "default" | "high" | "urgent"

const VALID_PRIORITIES = new Set<string>(["min", "low", "default", "high", "urgent"])

interface NotifyInput {
  title: string
  message: string
  priority?: string
}

function isNotifyInput(value: unknown): value is NotifyInput {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.title === "string" && typeof v.message === "string"
}

export const notifyTool: Tool = {
  name: "notify",
  description:
    "Send a push notification to the user's phone via Ntfy. Use this to alert the user about important events, completed tasks, or anything that needs their attention when they may not be looking at the screen. Do not use for routine responses — only for genuine alerts.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Notification title, keep it short",
      },
      message: {
        type: "string",
        description: "Notification body",
      },
      priority: {
        type: "string",
        description: "Priority level: min, low, default, high, urgent",
      },
    },
    required: ["title", "message"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isNotifyInput(input)) {
      return "Notify failed: invalid input"
    }

    const priority =
      input.priority && VALID_PRIORITIES.has(input.priority)
        ? (input.priority as Priority)
        : "default"

    await notify(input.title, input.message, priority)
    return `Notification sent: ${input.title}`
  },
}
