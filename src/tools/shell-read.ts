import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { basename } from "path"
import { homedir, platform } from "os"
import type { Tool } from "./registry"
import { isShellFailure } from "./shell-result"

const execFile = promisify(execFileCb)

const MAX_OUTPUT = 8000

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  const omitted = s.length - MAX_OUTPUT
  return s.slice(0, MAX_OUTPUT) + `\n[output truncated — ${omitted} characters omitted]`
}

// Pinned rather than raised, and pinned rather than left to the default so the
// message below can name a real number that cannot drift with a Node version.
//
// `ls -R` in a home directory is 1.8MB — measured, 69234 lines — and that is
// how this was found: the child was killed with ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
// `truncate` above never saw a byte of it, and the model was told only
// "Command failed: stdout maxBuffer length exceeded" three times in one turn.
// Raising the ceiling would buy a bigger buffer for output that is thrown away
// at 8000 characters anyway; what was missing was a message that says what to
// do instead.
const MAX_BUFFER = 1024 * 1024

// Output that overran the buffer. Written for the model: what happened, that
// nothing is wrong with the tool, and three narrower commands to reach for.
// Not phrased as a bare failure — an unexplained failure is retried verbatim,
// which is what happened live.
const OUTPUT_TOO_LARGE =
  "Output too large to return: the command produced more than 1 MB before it was stopped, " +
  "so none of it is available. Nothing is wrong with the command or the tool — it is the " +
  "SIZE. Ask a narrower question instead: name a subdirectory rather than a whole tree, " +
  "use find with -iname and a name pattern to look for one thing, or read a bounded number " +
  "of lines with head -n."

// What successful output of nothing says. An empty string is indistinguishable
// from a tool that broke, and live that ambiguity cost two calls: `find` with
// a pattern that could not match returned "" twice, and the model read it as
// the tool failing rather than as the answer being "nothing here".
const NO_OUTPUT = "(no output)"

// Shell quoting that never reached a shell.
//
// `command` may arrive as one string, so the model writes what it would type —
// find . -name '*architecture*' — and nothing between here and execFile knows
// what a quote means. A whitespace split leaves them in: the pattern contains
// two apostrophes, matches nothing, and says so SILENTLY. Measured live.
//
// So the command string is tokenized the way a shell would tokenize it, not
// split on whitespace. That is a bigger change than stripping quotes off a
// token, and it is the one that matters:
//
//   find . -name "*.py" -printf "%s %p\n"
//
// splits into `"%s` and `%p\n"`, which is TWO arguments and neither is a
// matched pair, so find reports `paths must precede expression: %p\n"` and the
// model — reading an error about find's syntax — rearranges the find
// expression and tries again. Seven of fifteen calls in one live turn were
// that, and no amount of per-token quote stripping reaches it.
//
// Semantics are bash's, deliberately narrow:
//   '…'   literal, no escapes inside
//   "…"   literal except \" \\ \$ \` — so "%s %p\n" keeps its backslash-n,
//         which is what find itself expands
//   \x    outside quotes, a literal x — so `-exec … {} \;` reaches find as `;`
//         rather than as `\;`, which it rejects with "missing argument"
// Operators are recorded only where they appear UNQUOTED, so `grep -E 'a|b'`
// is alternation and `find … | sort` is a pipe.
interface Tokenized {
  tokens: string[]
  operators: string[]
}

const OPERATOR_CHARS = new Set(["|", ";", "&", ">", "<", "`"])

function tokenize(command: string): Tokenized {
  const tokens: string[] = []
  const operators: string[] = []
  let current = ""
  let started = false
  const push = (): void => {
    if (started) tokens.push(current)
    current = ""
    started = false
  }
  const take = (text: string): void => {
    current += text
    started = true
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      started = true
      if (end === -1) {
        take(command.slice(i + 1))
        break
      }
      take(command.slice(i + 1, end))
      i = end
      continue
    }

    if (ch === '"') {
      started = true
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) {
          take(command[i + 1]!)
          i += 2
          continue
        }
        take(command[i]!)
        i++
      }
      continue
    }

    if (ch === "\\" && i + 1 < command.length) {
      take(command[i + 1]!)
      i++
      continue
    }

    if (/\s/.test(ch)) {
      push()
      continue
    }

    if (ch === "$" && command[i + 1] === "(") {
      operators.push("$(")
      take("$(")
      i++
      continue
    }

    if (OPERATOR_CHARS.has(ch)) {
      // Doubled forms are their own operators, and naming the one the model
      // actually wrote is the difference between a useful message and a riddle.
      const next = command[i + 1]
      const doubled = (ch === "|" || ch === "&" || ch === ">") && next === ch
      operators.push(doubled ? ch + ch : ch)
      push()
      tokens.push(doubled ? ch + ch : ch)
      if (doubled) i++
      continue
    }

    take(ch)
  }
  push()

  return { tokens, operators }
}

// `;` is the one operator that is also an ordinary argument: it terminates
// find's -exec. Unquoted it would be a shell operator, and `\;` or ';' is how
// a shell user writes the literal — but the model writes both, and refusing
// the bare one would refuse the single most useful form of `find -exec`.
// So a bare `;` counts as chaining only when there is no -exec to terminate.
const EXEC_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir"])

function chainingOperators(tokens: string[], operators: string[]): string[] {
  const hasExec = tokens.some((t) => EXEC_PREDICATES.has(t))
  return operators.filter((op) => !(op === ";" && hasExec))
}

// Refusal, not execution. Three things in order, the same shape as the
// over-budget and search-cap results: it did not run, the reason is the tool's
// design rather than a fault, and what to do instead — including the one
// command that answers the question the live turn was asking.
function shellOperatorRefusal(operator: string): string {
  return (
    `Not run: "${operator}" is a shell operator, and shell_read executes ONE program ` +
    `directly with no shell — pipes, redirects, chaining and $(…) are never available ` +
    `here and nothing is wrong with the tool. Run one command per call. For file sizes, ` +
    `find does it alone: -printf '%s %p\\n', or -exec wc -l {} + for line counts.`
  )
}

// Quotes a pre-split argument still carries. The command string goes through
// `tokenize` instead; this is for the `args` array, where the model has done
// its own splitting and sometimes leaves a matched pair on a token. The length
// check keeps a lone quote, which is a real argument ("'" is what you grep for
// when you want an apostrophe).
function stripQuotes(arg: string): string {
  if (arg.length < 2) return arg
  const first = arg[0]!
  if ((first === "'" || first === '"') && arg.endsWith(first)) {
    return arg.slice(1, -1)
  }
  return arg
}

// The same operators in the `args` array, where there is no quoting left to
// read. Only a WHOLE argument counts: a pipe survives the model's own split as
// its own token, which is the shape seen live, while `a|b` inside one argument
// is regex alternation and must go through untouched.
const OPERATOR_TOKENS = new Set(["|", "||", ";", "&", "&&", ">", ">>", "<", "<<"])

function argOperators(args: string[]): string[] {
  return args.filter((a) => OPERATOR_TOKENS.has(a) || a.includes("`") || a.includes("$("))
}

const WHITELIST = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "pwd", "echo", "wc",
  "stat", "df", "du", "ps", "git", "env", "which", "whoami", "uname", "uptime",
])

interface ExecSpec {
  exe: string
  args: string[]
}

function buildTailCmd(args: string[]): string {
  let tailCount = "10"
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if ((arg === "-n" || arg === "--lines") && i + 1 < args.length) {
      tailCount = args[++i]!
    } else if (/^-\d+$/.test(arg)) {
      tailCount = arg.slice(1)
    } else if (!arg.startsWith("-")) {
      files.push(arg)
    }
  }
  const fileStr = files.map(f => `'${f}'`).join(" ")
  return `Get-Content ${fileStr} -Tail ${tailCount}`
}

function buildWcCmd(args: string[]): string {
  const hasLineFlag = args.some(a => a === "-l" || a === "--lines")
  const files = args.filter(a => !a.startsWith("-"))
  const fileStr = files.map(f => `'${f}'`).join(" ")
  const measure = hasLineFlag ? "-Line" : "-Character"
  return `Get-Content ${fileStr} | Measure-Object ${measure}`
}

function translateToWindows(command: string, args: string[]): ExecSpec {
  const ps = (cmdStr: string): ExecSpec => ({
    exe: "powershell.exe",
    args: ["-NoProfile", "-Command", cmdStr],
  })

  switch (command) {
    case "ls":    return { exe: "dir",      args }
    case "cat":   return { exe: "type",     args }
    case "head":  return { exe: "more",     args }
    case "tail":  return ps(buildTailCmd(args))
    case "grep":  return { exe: "findstr",  args }
    case "find":  return { exe: "where",    args }
    case "pwd":   return { exe: "cd",       args: [] }
    case "wc":    return ps(buildWcCmd(args))
    case "stat": {
      const files = args.filter(a => !a.startsWith("-"))
      const fileStr = files.length > 0 ? files.map(f => `'${f}'`).join(" ") : "."
      return ps(`Get-Item ${fileStr}`)
    }
    case "df":    return ps("Get-PSDrive")
    case "du": {
      const dirs = args.filter(a => !a.startsWith("-"))
      const target = dirs[0] ? `'${dirs[0]}'` : "."
      return ps(`Get-ChildItem ${target} -Recurse | Measure-Object -Property Length -Sum`)
    }
    case "ps":     return { exe: "tasklist", args: [] }
    case "uname":  return { exe: "ver",      args: [] }
    case "uptime": return ps("(Get-Date) - (gcim Win32_OperatingSystem).LastBootUpTime")
    case "which":  return { exe: "where",    args }
    case "env":    return { exe: "set",      args: [] }
    default:       return { exe: command,    args }
  }
}

interface ShellReadInput {
  command: string
  args?: string[]
  cwd?: string
}

export const shellReadTool: Tool = {
  name: "shell_read",
  description:
    "Execute a read-only shell command. Use this for ANY command that only reads " +
    "or inspects — listing files (ls), reading file contents (cat, head, tail), " +
    "searching (grep, find), checking system state (ps, df, du, pwd, uname, uptime, " +
    "whoami), or inspecting git (git status, git log, git diff). These commands never " +
    "modify anything and never require confirmation. Always prefer this tool over " +
    "shell_write when the operation is read-only. " +
    // Added after a live turn spent two calls on `find -name` patterns that
    // could not match: the file was ARCHITECTURE.md. The flag is not rewritten
    // in code — a tool that silently runs a different command than it was asked
    // for is worse than one that needs this sentence.
    "Note that find's -name is case-sensitive: prefer -iname unless you know the exact case. " +
    // Added after a live turn spent twelve of fifteen calls on piped commands.
    // Short on purpose: this is on every LLM call, and the refusal result
    // carries the detail only the call that needs it has to read.
    "One program per call, with no shell: pipes, redirects and chaining (| ; && > <) do nothing.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the command.",
      },
    },
    required: ["command"],
  },
  requiresConfirmation: false,
  isFailure: isShellFailure,
  execute: async (input) => {
    const raw = input as ShellReadInput
    let command = raw.command
    let args = raw.args ?? []
    const { cwd } = raw

    // Tokenized like a shell rather than split on whitespace, so a quoted
    // argument survives whole — see `tokenize`. `args` is left as the model
    // sent it: it has already done its own splitting there.
    let found: string[] = []
    if (command.includes(" ") || /["'\\]/.test(command)) {
      const parsed = tokenize(command)
      command = parsed.tokens[0] ?? command
      args = [...parsed.tokens.slice(1), ...args]
      found = parsed.operators
    }
    // The -exec exemption is decided over EVERY token, because the predicate
    // and its terminator can arrive by different routes.
    const operators = chainingOperators([command, ...args], [...found, ...argOperators(args)])

    // Before the whitelist, which would otherwise report a piped command as a
    // disallowed one — `find … | sort` tokenizes to `find` plus a `|`
    // argument, and `find` IS allowed, which is how the live turn's twelve
    // piped calls sailed past this check into find's own argument parser.
    if (operators.length > 0) {
      return shellOperatorRefusal(operators[0]!)
    }

    // Whitelist check on Unix command name before translation
    if (!WHITELIST.has(basename(command))) {
      return `Command '${command}' is not allowed in read-only mode.`
    }

    const home = homedir()
    // Quotes come off first, so '~/Projects' expands the way the shell would.
    const expandedArgs = args.map(stripQuotes).map((arg) => {
      if (arg === "~" || arg === "$HOME") return home
      if (arg.startsWith("~/")) return home + arg.slice(1)
      return arg
    })

    const isWindows = platform() === "win32"
    const spec: ExecSpec = isWindows
      ? translateToWindows(command, expandedArgs)
      : { exe: command, args: expandedArgs }

    try {
      const { stdout, stderr } = await execFile(spec.exe, spec.args, {
        cwd,
        timeout: 10000,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env },
      })
      if (stdout) return truncate(stdout)
      if (stderr) return truncate(stderr)
      return NO_OUTPUT
    } catch (err: unknown) {
      const execErr = err as { code?: unknown; killed?: boolean; stderr?: string; message?: string }
      // Before the `killed` check, deliberately. A buffer overrun kills the
      // child too, and on Node 24 it arrives with `killed` undefined — so this
      // currently reaches the generic branch, but a future runtime that sets
      // the flag would report a 1.8MB listing as a timeout.
      if (
        execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        (execErr.message ?? "").includes("maxBuffer")
      ) {
        return OUTPUT_TOO_LARGE
      }
      if (execErr.killed) return "Command timed out after 10 seconds."
      const detail = execErr.stderr || execErr.message || String(err)
      return `Command failed: ${detail}`
    }
  },
}
