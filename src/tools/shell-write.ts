import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import { resolve } from "path"
import { homedir, platform } from "os"
import type { Tool } from "./registry"

const execFile = promisify(execFileCb)

const MAX_OUTPUT = 8000

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  const omitted = s.length - MAX_OUTPUT
  return s.slice(0, MAX_OUTPUT) + `\n[output truncated — ${omitted} characters omitted]`
}

interface ExecSpec {
  exe: string
  args: string[]
}

function translateToWindows(command: string, args: string[]): ExecSpec {
  const ps = (cmdStr: string): ExecSpec => ({
    exe: "powershell.exe",
    args: ["-NoProfile", "-Command", cmdStr],
  })

  switch (command) {
    case "rm":    return { exe: "del",  args }
    case "cp":    return { exe: "copy", args }
    case "mv":    return { exe: "move", args }
    case "touch": {
      const files = args.filter(a => !a.startsWith("-"))
      const fileStr = files.map(f => `'${f}'`).join(", ")
      return ps(`New-Item -ItemType File -Force ${fileStr}`)
    }
    default:      return { exe: command, args }
  }
}

interface ShellWriteInput {
  command: string
  args?: string[]
  cwd?: string
}

export const shellWriteTool: Tool = {
  name: "shell_write",
  description:
    "Execute a shell command that modifies the filesystem, installs packages, runs " +
    "scripts, or changes the working directory. Use this ONLY when the operation " +
    "creates, deletes, or changes something — for example: mkdir, rm, cp, mv, touch, " +
    "write to files, npm install, git commit, git push, or cd. Requires confirmation " +
    "before execution. Do NOT use this for read-only commands like ls, cat, or ps — " +
    "use shell_read instead.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass.",
      },
    },
    required: ["command"],
  },
  requiresConfirmation: true,
  execute: async (input) => {
    const raw = input as ShellWriteInput
    let command = raw.command
    let args = raw.args ?? []
    const cwd = raw.cwd ?? homedir()

    if (command.includes(" ")) {
      const parts = command.trim().split(/\s+/)
      command = parts[0] ?? command
      args = [...parts.slice(1), ...args]
    }

    const home = homedir()
    args = args.map((arg) => {
      if (arg === "~" || arg === "$HOME") return home
      if (arg.startsWith("~/")) return home + arg.slice(1)
      return arg
    })

    // Hard blocks — applied on Unix command name before translation
    if (command === "sudo") {
      return "Command 'sudo' is not allowed."
    }

    for (const part of [command, ...args]) {
      if (part.includes("/etc") || part.includes("/sys") || part.includes("/boot")) {
        return "Command blocked: access to system paths (/etc, /sys, /boot) is not allowed."
      }
    }

    const fullInvocation = [command, ...args].join(" ")
    if (fullInvocation.includes("rm") && fullInvocation.includes("-rf") && fullInvocation.includes("/")) {
      return "Command blocked: recursive deletion of root paths is not allowed."
    }

    // cd is handled without spawning a subprocess
    if (command === "cd") {
      const target = args[0]
      const resolvedPath = !target || target === "~" ? homedir() : resolve(cwd, target)
      if (!existsSync(resolvedPath)) {
        return `Directory not found: ${resolvedPath}`
      }
      return JSON.stringify({ newCwd: resolvedPath, display: `Changed directory to ${resolvedPath}` })
    }

    const isWindows = platform() === "win32"
    const spec: ExecSpec = isWindows
      ? translateToWindows(command, args)
      : { exe: command, args }

    try {
      const { stdout, stderr } = await execFile(spec.exe, spec.args, { cwd, timeout: 30000, shell: false, env: { ...process.env } })
      if (stdout) return truncate(stdout)
      if (stderr) return truncate(stderr)
      return ""
    } catch (err: unknown) {
      const execErr = err as { killed?: boolean; stderr?: string; message?: string }
      if (execErr.killed) return "Command timed out after 30 seconds."
      const detail = execErr.stderr || execErr.message || String(err)
      return `Command failed: ${detail}`
    }
  },
}
