import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import type { Tool } from "./registry"

const execFile = promisify(execFileCb)

interface ShellWriteInput {
  command: string
  args?: string[]
  cwd?: string
}

export const shellWriteTool: Tool = {
  name: "shell_write",
  description:
    "Execute a shell command that may modify the filesystem, run scripts, " +
    "install packages, or change the working directory. Requires confirmation " +
    "before execution. Use cd to navigate directories — this updates the session " +
    "working directory for all subsequent commands.",
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
    const { command, args = [], cwd = homedir() } = input as ShellWriteInput

    // Hard blocks
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

    try {
      const { stdout, stderr } = await execFile(command, args, { cwd, timeout: 30000, shell: false })
      if (stdout) return stdout
      if (stderr) return stderr
      return ""
    } catch (err: unknown) {
      const execErr = err as { killed?: boolean; stderr?: string; message?: string }
      if (execErr.killed) return "Command timed out after 30 seconds."
      const detail = execErr.stderr || execErr.message || String(err)
      return `Command failed: ${detail}`
    }
  },
}
