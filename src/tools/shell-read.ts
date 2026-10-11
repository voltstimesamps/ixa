import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { basename } from "path"
import { homedir, platform } from "os"
import type { Tool } from "./registry"

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
// `command` may arrive as one string and is split on whitespace, so the model
// writes what it would type — find . -name '*architecture*' — and execFile
// passes the quotes through as literal characters. The pattern then contains
// two apostrophes and matches nothing, silently: no error, no output, no way
// to tell it apart from a directory with nothing in it. Measured live, twice
// in one turn.
//
// Stripping a matched surrounding pair is exactly what the shell would have
// done. The length check leaves a lone quote alone, which is a real argument
// ("'" is what you grep for when you want an apostrophe).
function stripQuotes(arg: string): string {
  if (arg.length < 2) return arg
  const first = arg[0]!
  if ((first === "'" || first === '"') && arg.endsWith(first)) {
    return arg.slice(1, -1)
  }
  return arg
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
    "Note that find's -name is case-sensitive: prefer -iname unless you know the exact case.",
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
  execute: async (input) => {
    const raw = input as ShellReadInput
    let command = raw.command
    let args = raw.args ?? []
    const { cwd } = raw

    if (command.includes(" ")) {
      const parts = command.trim().split(/\s+/)
      command = parts[0] ?? command
      args = [...parts.slice(1), ...args]
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
