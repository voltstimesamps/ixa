import type OpenAI from "openai"

// What `preflight` can say. Both fields are optional: a tool may refuse
// without a command to show, or offer a command with nothing to refuse.
export interface ToolPreflight {
  refusal?: string
  command?: string
}

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresConfirmation: boolean
  execute: (input: unknown) => Promise<unknown>
  // Optional, and for the LOG WORD only. The model never sees the answer.
  //
  // A tool that catches its own errors and returns them as a result string is
  // doing the right thing by the model, which can act on "find: unknown
  // predicate" and cannot act on an exception. But `executeTool` logs "ok"
  // whenever `execute()` resolves, so a live turn of fifteen consecutive
  // failed `shell_read` calls logged fifteen "ok" lines. This lets a tool say
  // which of its own results are failures, without the session having to know
  // anything about what they look like. See src/tools/shell-result.ts.
  //
  // THIS USED TO SAY "nothing branches on it", and that went stale the moment
  // the repeated-failure refusal shipped: it gated on `isFailure` merely
  // EXISTING, so giving a tool an honest log word silently enrolled it in a
  // behaviour change too. `dedupeFailures` below is that behaviour, opted into
  // on its own.
  isFailure?: (result: string) => boolean
  // Settled BEFORE the user is asked anything, and before `execute` runs.
  //
  // Two different jobs, both of which have to happen ahead of the
  // confirmation prompt rather than inside `execute`:
  //
  //   `refusal`  this call cannot run, so do not ask about it and do not run
  //              it. The string becomes the tool result the model reads.
  //              Asking someone to approve an action that cannot work spends
  //              their attention on nothing and teaches them that saying yes
  //              is free.
  //   `command`  exactly what will be executed, built by code, to be shown in
  //              the confirmation beside the model's prose. The prose comes
  //              from `generateDescription`, which is an LLM call — so without
  //              this, a user approving a confirmation is approving a CLAIM
  //              about the command. Live, that claim described a shell
  //              redirect that could not run.
  //
  // Must be pure and synchronous: it runs on the path to a prompt the user is
  // waiting for, and a preflight with side effects would be a side effect
  // nobody confirmed.
  preflight?: (input: unknown) => ToolPreflight
  // Whether an identical call that already failed this turn should be refused
  // rather than run again. Requires `isFailure` — there is no way to know a
  // call failed without it — and is deliberately a SEPARATE flag.
  //
  // The two questions are not the same question. "Was this result a failure?"
  // is about one result and is always safe to ask. "Will running this again
  // give the same result?" is about the FUTURE, and it is only true for a tool
  // whose result depends on nothing but its arguments.
  //
  // The shell tools qualify: `ls -R` in the same directory returns the same
  // oversized output every time. `save_note` DOES NOT. Its price guard
  // compares the note against what `web_search` returned in this turn, and its
  // refusal says in as many words: "Either call web_search now and use what it
  // returns, or call save_note again with the figure left out." A model that
  // does exactly that — searches, confirms the figure, re-sends the identical
  // call — is making a call that is now legitimate, and refusing it on
  // signature alone would break the one recovery path the refusal asks for.
  dedupeFailures?: boolean
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

// ---------------------------------------------------------- optional arguments

// The JSON Schema type for an optional string argument: `["string", "null"]`,
// never bare `"string"`.
//
// MEASURED, not defensive. gpt-oss-20b writes an EXPLICIT null for an optional
// field it has decided not to use, and Groq validates the arguments against
// this schema before the call ever reaches Ixa. Asked "what did we talk about
// last time?" — the question the no-query path exists for — verification got a
// hard turn failure instead of an answer:
//
//   Tool call validation failed: parameters for tool search_memory did not
//   match schema: errors: [`/from`: expected string, but got null, `/query`:
//   expected string, but got null, `/to`: expected string, but got null]
//
// A null is how the model spells "absent", so the schema accepts it and
// `optionalString` below collapses it back to absent. Omitting the field is
// still what the descriptions ask for; this is about what happens when it
// does the other thing.
export const OPTIONAL_STRING: readonly ["string", "null"] = ["string", "null"]

// null, undefined, "" and "   " all mean the same thing: the argument was not
// given. Blank is in that list because the model sends `query: ""` too, and
// embedding an empty string returns the opposite of what it meant.
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
