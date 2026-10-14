import { execFile as execFileCb } from "child_process"
import { promisify } from "util"
import { existsSync } from "fs"
import { resolve } from "path"
import { homedir, platform } from "os"
import type { Tool } from "./registry"
import { isShellFailure } from "./shell-result"
import {
  argOperators,
  chainingOperators,
  displayCommand,
  expandHome,
  shellOperatorRefusal,
  tokenize,
  WRITE_OPERATOR_ADVICE,
} from "./shell-command"

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

// The argv this call will actually run, and the operators that mean it cannot.
//
// ONE function, called twice: once in `preflight` — before the user is asked
// anything — and once in `execute`. Both have to agree, because the whole
// point is that what the user approved is what runs; working it out twice in
// two places is how they would stop agreeing.
function parseInvocation(raw: ShellWriteInput): {
  command: string
  args: string[]
  operators: string[]
} {
  let command = raw.command
  let args = raw.args ?? []

  // Tokenized like a shell rather than split on whitespace. shell_write used
  // to do `command.trim().split(/\s+/)`, so `touch "my file"` became two
  // arguments and created two files — and `args` was never examined for
  // operators at all, which is how `[">", "/tmp/out.txt"]` got through.
  let found: string[] = []
  if (command.includes(" ") || /["'\\]/.test(command)) {
    const parsed = tokenize(command)
    command = parsed.tokens[0] ?? command
    args = [...parsed.tokens.slice(1), ...args]
    found = parsed.operators
  }

  const operators = chainingOperators(
    [command, ...args],
    [...found, ...argOperators(args)]
  )

  return { command, args: expandHome(args, homedir()), operators }
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
  // Everything that must be settled BEFORE the user is asked.
  //
  // Two things, and they are the same thing from two sides. A command that
  // cannot run must be refused without a prompt, because asking someone to
  // approve an impossible action wastes their attention and teaches them that
  // approving is harmless. And the prompt that IS shown has to carry the real
  // argv, because the rest of it is written by a language model.
  //
  // Live: the model called shell_write with args [">", "/tmp/pyfiles.txt"] to
  // redirect find's output. The user was shown a confirmation describing a
  // redirect, approved it, and find reported `'>': No such file or directory`.
  // Both halves failed at once — the call was unrunnable and the description
  // was fiction — and the user's "yes" is what makes that worse than a bad
  // tool call: they were asked, and the question was wrong.
  preflight: (input: unknown) => {
    const { command, args, operators } = parseInvocation(input as ShellWriteInput)
    if (operators.length > 0) {
      return {
        refusal: shellOperatorRefusal(operators[0]!, "shell_write", WRITE_OPERATOR_ADVICE),
      }
    }
    return { command: displayCommand(command, args) }
  },
  isFailure: isShellFailure,
  // Same argument as shell_read: the result is a function of the command and
  // the directory, so a repeat is a repeat. See registry.ts.
  dedupeFailures: true,
  execute: async (input) => {
    const raw = input as ShellWriteInput
    const cwd = raw.cwd ?? homedir()
    const { command, args, operators } = parseInvocation(raw)

    // Normally unreachable: `preflight` refuses these before the user is even
    // asked. Kept because `execute` is reachable on its own — the tool is
    // called directly by scripts and tests — and a tool whose safety depends
    // on its caller having run a different method first is not safe.
    if (operators.length > 0) {
      return shellOperatorRefusal(operators[0]!, "shell_write", WRITE_OPERATOR_ADVICE)
    }

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
