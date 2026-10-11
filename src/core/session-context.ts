import { AsyncLocalStorage } from "async_hooks"

// The channel a tool uses to act on the session it is running inside.
//
// A Tool only ever receives its own input (see tools/registry.ts) — it has no
// handle on the Session or the SessionManager, deliberately, because a tool
// that could reach either would be able to do anything to the conversation at
// any point in the tool loop. `start_new_conversation` still needs to say
// "end this conversation", so it says it HERE and the manager acts on it at
// the turn boundary.
//
// AsyncLocalStorage rather than a module-level flag: the request belongs to
// one session's turn, and a bare flag would leak into whatever turn ran next
// if a Session were ever driven outside SessionManager.submitTurn. It also
// keeps working unchanged if the one-shared-primary-session policy ever ends.
export interface SessionControl {
  // Ends the current session once this turn has finished — never mid-turn,
  // which would cut the history out from under the tool loop still writing
  // into it. The next turn resolves a fresh session through the manager.
  requestNewConversation(): void
}

// What this turn has actually seen, for a tool that must not write down a
// fact nobody gave it.
//
// save_note needs two things it cannot get from its own input: what the user
// said, and what a web_search returned in THIS turn. Those are facts about
// the turn, so they arrive the same way `requestNewConversation` leaves — a
// tool still never touches the Session, and this direction is read-only,
// which is weaker than the channel already here.
//
// Why not read them out of history instead: history is the whole
// conversation, and "the user mentioned a price six turns ago" is exactly the
// staleness the price rule exists to catch. The window is one turn.
export interface TurnEvidence {
  // The user's message, verbatim, as it arrived this turn.
  userText: string
  // Provenance, for a tool that records something durable. Here rather than
  // in a tool schema because the model cannot know either one: asked for a
  // session id in the spike, it supplied "?". `source` is the turn's origin,
  // so a note says whether it came from speech or typing.
  source: "voice" | "text"
  sessionId: string
  // Results of web_search calls that ACTUALLY RAN this turn — not ones that
  // were declined, capped or abandoned. Appended as each result comes back,
  // so a tool called before the search in the same group correctly sees
  // nothing.
  searchResults: string[]
}

export interface TurnContext extends SessionControl {
  evidence: TurnEvidence
}

// ONE store for the whole turn context, not one per concern: both are bound
// at the same moment around the same turn, and a second AsyncLocalStorage
// would be a second thing to remember to bind.
const storage = new AsyncLocalStorage<TurnContext>()

export function runWithSessionControl<T>(context: TurnContext, run: () => T): T {
  return storage.run(context, run)
}

// Undefined when called outside a turn — a dev script, or a tool invoked
// directly in a test. Callers must handle that rather than assume a session.
export function currentSessionControl(): SessionControl | undefined {
  return storage.getStore()
}

// Undefined outside a turn, and a tool that needs it must FAIL CLOSED rather
// than treat "no evidence" as "nothing to check against": unverifiable is not
// the same as verified.
export function currentTurnEvidence(): TurnEvidence | undefined {
  return storage.getStore()?.evidence
}
