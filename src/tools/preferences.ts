import { getPreferenceStore, type Preference } from "../memory/preferences"
import type { Tool } from "./registry"

// requiresConfirmation is false for all three of these, deliberately.
//
// The confirmation gate exists for actions with real-world consequences:
// sending mail, writing files, moving physical things. Writing to Ixa's own
// preference memory is none of those. Nothing leaves the machine, and nothing
// is destroyed — an update supersedes (the old row stays), a forget is a soft
// delete, and both are recoverable in SQL. Gating them would also put a spoken
// yes/no in front of every "I prefer X", which is precisely the friction this
// feature exists to remove. The tools are instead told to state what they did,
// so the user always hears about the change.
//
// This reasoning does not generalise. Anything with consequences outside the
// database still confirms, and it is still set here at definition time, never
// decided at runtime.

const CATEGORY_HINT =
  "Suggested categories: general, food, communication, schedule, work, home, technical, personal."

interface RememberInput {
  topic: string
  value: string
  category?: string
}

interface ForgetInput {
  topic: string
}

function isRememberInput(value: unknown): value is RememberInput {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.topic === "string" && typeof v.value === "string"
}

function isForgetInput(value: unknown): value is ForgetInput {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as Record<string, unknown>).topic === "string"
}

function describe(preference: Preference): string {
  return `[${preference.category}] ${preference.topic}: ${preference.value}`
}

export const rememberPreferenceTool: Tool = {
  name: "remember_preference",
  description:
    "Save or update one of the user's stated preferences in long-term memory. " +
    "Call this ONLY when the user explicitly states a preference (\"I prefer…\", \"I like…\", " +
    "\"always…\", \"from now on…\") or directly asks you to remember something. NEVER infer a " +
    "preference from what the user does, asks about, or seems to want — if they did not say it, " +
    "do not save it. 'topic' is a short key such as \"coffee\" or \"wake time\"; 'value' is the " +
    "preference in plain language. When you are updating a preference that already exists, reuse " +
    "the EXACT topic name shown for it in the saved preferences block, so the update replaces the " +
    "old value instead of creating a second, near-duplicate topic. " +
    CATEGORY_HINT +
    " After calling this, always tell the user in one short sentence what you saved or updated.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Short key for the preference, e.g. \"coffee\". Reuse the existing topic name exactly when updating.",
      },
      value: {
        type: "string",
        description: "The preference itself, in plain language.",
      },
      category: {
        type: "string",
        description: `Optional grouping. ${CATEGORY_HINT} Defaults to the existing category when updating, otherwise general.`,
      },
    },
    required: ["topic", "value"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isRememberInput(input)) {
      return "Could not save the preference: both 'topic' and 'value' are required."
    }

    try {
      const { preference, superseded } = getPreferenceStore().remember({
        topic: input.topic,
        value: input.value,
        category: input.category,
      })

      if (superseded) {
        return (
          `Updated preference ${describe(preference)}. ` +
          `The previous value ("${superseded.value}") is superseded and kept as history.`
        )
      }
      return `Saved new preference ${describe(preference)}.`
    } catch (err) {
      return `Could not save the preference: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export const forgetPreferenceTool: Tool = {
  name: "forget_preference",
  description:
    "Remove one of the user's saved preferences, by its topic. Call this ONLY when the user asks " +
    "you to forget, drop, or stop applying something — never on your own initiative. Use the exact " +
    "topic name shown for it in the saved preferences block. The preference stops being applied " +
    "immediately. After calling this, always tell the user in one short sentence what you forgot.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The topic of the preference to forget, exactly as it is listed.",
      },
    },
    required: ["topic"],
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    if (!isForgetInput(input)) {
      return "Could not forget the preference: 'topic' is required."
    }

    const removed = getPreferenceStore().forget(input.topic)
    if (!removed) {
      return `No active preference saved under the topic "${input.topic}", so nothing was forgotten.`
    }
    return `Forgot preference ${describe(removed)}. It will no longer be applied.`
  },
}

export const listPreferencesTool: Tool = {
  name: "list_preferences",
  description:
    "List the user's currently active saved preferences, optionally filtered to one category. Use " +
    "this when the user asks what you remember about their preferences. Active preferences are " +
    "already applied to your answers automatically, so you do not need to call this before " +
    "answering an ordinary question.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: `Optional filter. ${CATEGORY_HINT}`,
      },
    },
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    const category =
      typeof input === "object" && input !== null
        ? ((input as Record<string, unknown>).category as string | undefined)
        : undefined

    const active = getPreferenceStore().listActive(category)
    if (active.length === 0) {
      return category
        ? `No active preferences saved in the category "${category}".`
        : "No preferences saved yet."
    }

    return (
      `${active.length} active preference${active.length === 1 ? "" : "s"}:\n` +
      active.map((preference) => `- ${describe(preference)}`).join("\n")
    )
  },
}
