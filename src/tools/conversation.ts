import { currentSessionControl } from "../core/session-context"
import type { Tool } from "./registry"

// requiresConfirmation: false — deliberately, and on a narrower argument than
// "the session is summarized first".
//
// What ending a conversation actually costs was traced through the code before
// ungating this:
//   - The session row is NEVER deleted. endSession() stamps ended_at and
//     writes the full message history back to SQLite; nothing in Ixa removes a
//     session row. The raw conversation is still there afterwards, verbatim,
//     whatever happens next.
//   - The EPISODE (the summary that makes it searchable) is best effort. It is
//     skipped outright below IXA_EPISODE_MIN_USER_TURNS, and a summarizer LLM
//     failure — a Groq 413 or a rate limit — is caught, logged and dropped
//     with no retry, because the backlog sweep retries indexing of rows that
//     exist, not summarization.
// So the honest claim is: the conversation itself is never lost, but its
// summary may be. That is a recoverable loss (the history is on disk and can
// be re-summarized) and not the kind of consequence the confirmation gate
// exists for — unlike sending mail or writing a file, nothing leaves the
// machine and nothing is destroyed.
//
// The friction argument matters too: a spoken yes/no in front of "let's start
// over" is exactly the overhead that makes voice feel worse than a keyboard.
//
// This reasoning does not generalise. Anything with consequences outside the
// database still confirms, and it is still set here at definition time.

export const startNewConversationTool: Tool = {
  name: "start_new_conversation",
  description:
    "End the current conversation and start a fresh one with no memory of what was just said. " +
    "Call this ONLY when the user explicitly asks to start over, start a new conversation, " +
    "reset, or clear the context. NEVER call it because the subject changed — moving from one " +
    "topic to another within a conversation is normal and the user expects the earlier context " +
    "to still be there. The reset takes effect the moment your reply finishes, so tell the user " +
    "in one short sentence that you are starting fresh.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async (): Promise<string> => {
    const control = currentSessionControl()
    if (!control) {
      // No turn in progress to end. Reported rather than thrown so the model
      // says something true instead of claiming a reset that did not happen.
      return "Could not start a new conversation: there is no active conversation to end."
    }
    control.requestNewConversation()
    return (
      "A new conversation will start as soon as this reply is finished. Tell the user you are " +
      "starting fresh."
    )
  },
}
