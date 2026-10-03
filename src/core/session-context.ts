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

const storage = new AsyncLocalStorage<SessionControl>()

export function runWithSessionControl<T>(control: SessionControl, run: () => T): T {
  return storage.run(control, run)
}

// Undefined when called outside a turn — a dev script, or a tool invoked
// directly in a test. Callers must handle that rather than assume a session.
export function currentSessionControl(): SessionControl | undefined {
  return storage.getStore()
}
