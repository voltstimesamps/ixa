// Whether a shell tool's RESULT reports a failure.
//
// Both shell tools catch their own errors and RETURN a string, which is
// deliberate — the model can act on "find: unknown predicate" and cannot act
// on an exception. The cost was in the log: `executeTool` logs "ok" whenever
// `execute()` resolves, so a live turn in which fifteen consecutive
// `shell_read` calls all failed logged fifteen lines of
//
//   tool shell_read ok 6ms {"command":"find … | sort -nr | head -n 1"}
//
// and the one place a human looks said the turn was going fine.
//
// The predicate lives with the tools that write these strings rather than in
// the session that logs them: the session has no business knowing what find's
// stderr looks like, and a prefix list maintained at a distance from the
// strings it matches goes stale. `isFailure` on the Tool interface is how it
// gets there. It changes the LOG ONLY — what the model sees is untouched, and
// nothing branches on it.
const FAILURE_PREFIXES = [
  "Command failed:",
  "Command timed out",
  "Command blocked:",
  "Output too large",
  "Not run:",
  "Directory not found:",
]

export function isShellFailure(result: string): boolean {
  // "Command '<x>' is not allowed" — the whitelist refusal, which both tools
  // word with the command name in the middle.
  if (/^Command '.*' is not allowed/.test(result)) return true
  return FAILURE_PREFIXES.some((prefix) => result.startsWith(prefix))
}
