import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import type { Tool } from "./registry"

const execFile = promisify(execFileCb)

const WHITELIST = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "pwd", "echo", "wc",
  "stat", "df", "du", "ps", "git", "env", "which", "whoami", "uname", "uptime",
])

interface ShellReadInput {
  command: string
  args?: string[]
  cwd?: string
}

export const shellReadTool: Tool = {
  name: "shell_read",
  description:
    "Execute a read-only shell command. Use for exploring the filesystem, " +
    "reading files, checking git status, inspecting processes, and other " +
    "non-destructive operations. Cannot change the working directory.",
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
    const { command, args = [], cwd } = input as ShellReadInput

    if (!WHITELIST.has(command)) {
      return `Command '${command}' is not allowed in read-only mode.`
    }

    try {
      const { stdout, stderr } = await execFile(command, args, { cwd, timeout: 10000 })
      if (stdout) return stdout
      if (stderr) return stderr
      return ""
    } catch (err: unknown) {
      const execErr = err as { killed?: boolean; stderr?: string; message?: string }
      if (execErr.killed) return "Command timed out after 10 seconds."
      const detail = execErr.stderr || execErr.message || String(err)
      return `Command failed: ${detail}`
    }
  },
}
