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
    "shell_write when the operation is read-only.",
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
    const expandedArgs = args.map((arg) => {
      if (arg === "~" || arg === "$HOME") return home
      if (arg.startsWith("~/")) return home + arg.slice(1)
      return arg
    })

    const isWindows = platform() === "win32"
    const spec: ExecSpec = isWindows
      ? translateToWindows(command, expandedArgs)
      : { exe: command, args: expandedArgs }

    try {
      const { stdout, stderr } = await execFile(spec.exe, spec.args, { cwd, timeout: 10000, env: { ...process.env } })
      if (stdout) return truncate(stdout)
      if (stderr) return truncate(stderr)
      return ""
    } catch (err: unknown) {
      const execErr = err as { killed?: boolean; stderr?: string; message?: string }
      if (execErr.killed) return "Command timed out after 10 seconds."
      const detail = execErr.stderr || execErr.message || String(err)
      return `Command failed: ${detail}`
    }
  },
}
