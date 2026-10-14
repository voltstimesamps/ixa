import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { basename } from "path"
import { homedir, platform } from "os"
import type { Tool } from "./registry"
import { isShellFailure } from "./shell-result"
import {
  argOperators,
  chainingOperators,
  expandHome,
  READ_OPERATOR_ADVICE,
  shellOperatorRefusal,
  tokenize,
} from "./shell-command"

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
// Two narrowings were added later, after a live turn answered this message
// with a shell_write REDIRECT: told only to "ask a narrower question", the
// model reached for somewhere to put the output rather than a way to produce
// less of it. So the message now names the two flags that actually bound a
// tree on this machine — -maxdepth, and excluding venv / node_modules, which
// is where most of the volume is — and says outright that a redirect cannot
// help, because there is no shell and the output comes back directly anyway.
// The wording moved from "ask a narrower question" to "produce LESS output"
// for the same reason: the first can be satisfied by a file.
//
// The search_notes pointer is the last sentence, and it is here because the
// live turns kept reaching for this message when what they actually needed was
// a LOCATION. Three turns in a row started by listing a whole home directory
// to find a project whose path was written down: twice nothing in the notebook
// was consulted, and once the path was sitting in a saved preference. A
// narrower command does not help a model that does not know where to point it.
const OUTPUT_TOO_LARGE =
  "Output too large to return: the command produced more than 1 MB before it was stopped, " +
  "so none of it is available. Nothing is wrong with the command or the tool — it is the " +
  "SIZE. Produce LESS output: name a subdirectory rather than a whole tree, add -maxdepth 2, " +
  "exclude dependencies with -not -path '*/venv/*' -not -path '*/node_modules/*', use find " +
  "-iname with a name pattern to look for one thing, or read a bounded number of lines with " +
  "head -n. A redirect cannot help: there is no shell here, so > does nothing, and shell_read " +
  "hands you the output directly once it is small enough. If you are looking for where a " +
  "project or a file lives, search_notes may already say — look there before listing a " +
  "whole tree."

// What successful output of nothing says. An empty string is indistinguishable
// from a tool that broke, and live that ambiguity cost two calls: `find` with
// a pattern that could not match returned "" twice, and the model read it as
// the tool failing rather than as the answer being "nothing here".
const NO_OUTPUT = "(no output)"

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
  // The same command, in the same directory, fails the same way every time:
  // one live turn ran `ls -R` in $HOME four times for four identical
  // "output too large" results. See `dedupeFailures` in registry.ts.
  dedupeFailures: true,
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
      return shellOperatorRefusal(operators[0]!, "shell_read", READ_OPERATOR_ADVICE)
    }

    // Whitelist check on Unix command name before translation
    if (!WHITELIST.has(basename(command))) {
      return `Command '${command}' is not allowed in read-only mode.`
    }

    // Quotes come off first, so '~/Projects' expands the way the shell would.
    const expandedArgs = expandHome(args, homedir())

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
