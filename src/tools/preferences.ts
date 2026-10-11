import { getPreferenceStore, type Preference } from "../memory/preferences"
import { OPTIONAL_STRING, optionalString, type Tool } from "./registry"

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
  "Categories: general, food, communication, schedule, work, home, technical, personal."

interface RememberInput {
  topic: string
  value: string
  // Nullable because the model writes `category: null` rather than omitting
  // it, and a bare "string" schema makes that a hard turn failure — see
  // OPTIONAL_STRING in registry.ts for the measured error.
  category?: string | null
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
  // THIS DESCRIPTION AND save_note's ARE A PAIR. Changing one without the
  // other is what caused the bug this version fixes.
  //
  // The previous version said to call this when the user "directly asks you to
  // remember something" — which is how a request to note a FACT arrives, word
  // for word. Measured over ten spoken-style note requests, three of them were
  // routed here instead of to save_note; deleting that one clause flipped two
  // of the three. The clause is gone, and each description now names the
  // other's territory explicitly, because a boundary stated from one side only
  // is not a boundary.
  description:
    "Save or update a preference: something about the USER or how they want you to behave. " +
    "Call it only when they state one (\"I prefer…\", \"I like…\", \"always…\", \"from now on…\"). " +
    "A fact, a decision, or work in progress is NOT a preference — write those with save_note. " +
    // A WORKED EXAMPLE PAIR WAS TRIED HERE AND REMOVED. It read:
    //
    //   "remember that the backup runs at 3am" → save_note.
    //   "from now on skip the greeting" → this tool.
    //
    // +97 chars, and measured against the routing set it bought nothing: the
    // failing case ("remember that the stt sidecar uses base.en, not small")
    // still came here, and "make a note to always answer in metric" — which
    // had been passing — came here AND wrote a note. So the examples are not
    // in the shipped description. Kept as a comment because the next person to
    // reach for this lever should know it was pulled and measured.
    //
    // Note for whoever tries again: neither example may be one of the probes,
    // or the re-run measures recall of this sentence instead of routing.
    "Never infer a preference from what the user asks about. 'topic' is a short key such as " +
    "\"coffee\"; when updating, reuse the EXACT topic from the saved preferences block so the " +
    "update replaces it instead of forking a near-duplicate. " +
    CATEGORY_HINT +
    " Afterwards tell the user in one short sentence what you saved.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Short key, e.g. \"coffee\". Reuse the existing one exactly when updating.",
      },
      value: {
        type: "string",
        description: "The preference itself, in plain language.",
      },
      category: {
        type: OPTIONAL_STRING,
        description: `Optional grouping. ${CATEGORY_HINT}`,
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
        category: optionalString(input.category),
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
        type: OPTIONAL_STRING,
        description: `Optional filter. ${CATEGORY_HINT}`,
      },
    },
  },
  requiresConfirmation: false,
  execute: async (input: unknown): Promise<string> => {
    const category =
      typeof input === "object" && input !== null
        ? optionalString((input as Record<string, unknown>).category)
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
