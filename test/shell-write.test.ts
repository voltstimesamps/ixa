import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellWriteTool } from "../src/tools/shell-write"
// The real registry, because two of these tests drive a real turn and the
// session resolves a tool by name. Neither of those two ever executes
// anything — one is refused before the prompt and the other declines it — so
// nothing here can write outside the temp directory, which matters because
// the session injects its OWN cwd ($HOME) into a shell call's arguments.
import "../src/tools/register"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { confirmationText, type ChatFn } from "../src/core/session"
import type { ConfirmationOutcome } from "../src/core/confirmation"
import type { WsMessage } from "../src/api/types"
import { makeConnection, TEST_LIMITS } from "./helpers"

// WHAT THE USER APPROVES HAS TO BE WHAT RUNS.
//
// Live: after shell_read answered "Output too large", the model called
// shell_write with args [">", "/tmp/pyfiles.txt"] to redirect find's output.
// The user was shown a confirmation describing a redirect, said yes, and the
// command failed with `find: '>': No such file or directory`.
//
// Two separate failures in one call, and the "yes" is what makes them worse
// than an ordinary bad tool call:
//
//   1. shell_write never looked for shell operators, so a call that could not
//      work was asked about and then run.
//   2. The confirmation text comes from `generateDescription`, which is an LLM
//      call — so what the user approved was the model's prose, not the argv.
//
// shell_write also split its command string on whitespace, so a quoted
// filename became two arguments and `touch "my file"` created two files.

const run = (command: string, args?: string[], cwd?: string): Promise<string> =>
  shellWriteTool.execute({ command, args, cwd }) as Promise<string>

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ixa-shell-write-"))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ------------------------------------------------------- the tokenizer

test("a quoted filename with a space is ONE file", async () => {
  const result = await run(`touch "my file.txt"`, [], dir)
  assert.equal(result, "", "touch says nothing when it works")

  const entries = await readdir(dir)
  assert.deepEqual(entries, ["my file.txt"], `created instead: ${entries.join(", ")}`)
})

test("single quotes work too, and the quotes are not part of the name", async () => {
  const result = await run(`touch 'two words.txt'`, [], dir)
  assert.equal(result, "")

  const entries = await readdir(dir)
  assert.ok(entries.includes("two words.txt"), `created instead: ${entries.join(", ")}`)
  assert.ok(
    !entries.some((name) => name.includes("'")),
    `a quote survived into a filename: ${entries.join(", ")}`
  )
})

test("mkdir -p with a quoted path makes one directory, not three", async () => {
  await run(`mkdir -p "a b/c d"`, [], dir)
  const inner = await stat(join(dir, "a b", "c d"))
  assert.ok(inner.isDirectory(), "the quoted path is one path")
})

// ------------------------------------------------------- the operators

test("a redirect is refused, naming the operator", async () => {
  const result = await run("find", [">", join(dir, "out.txt")], dir)

  assert.match(result, /^Not run: ">" is a shell operator/)
  assert.match(result, /shell_write executes ONE program/)
  // The advice has to answer the question the redirect was for. The model
  // wanted find's output in a file and did not need a file at all.
  assert.match(result, /call shell_read and it is returned to you directly/)

  const entries = await readdir(dir)
  assert.ok(!entries.includes("out.txt"), "nothing was written")
})

test("a pipe in the command string is refused as well", async () => {
  const result = await run(`cp a.txt b.txt | tee log`, [], dir)
  assert.match(result, /^Not run: "\|" is a shell operator/)
})

test("find -exec with a bare semicolon still runs, because that is find's syntax", async () => {
  // The one operator that is also an ordinary argument: `;` terminates
  // -exec. Refusing it would refuse the most useful form of find -exec, and
  // the exemption is shared with shell_read rather than written twice.
  const result = await run(`find . -maxdepth 1 -name "nothing-here-*" -exec rm {} ;`, [], dir)
  assert.ok(
    !result.startsWith("Not run:"),
    `the -exec terminator was mistaken for chaining: ${result}`
  )
})

// --------------------------------------------- refused before the prompt

test("an operator is refused BEFORE any confirmation is asked", async () => {
  const prompts: string[] = []
  let confirmations = 0

  let calls = 0
  const chat: ChatFn = async (messages) => {
    calls++
    if (calls === 1) {
      return {
        type: "tool_calls",
        calls: [
          {
            id: "c1",
            name: "shell_write",
            arguments: JSON.stringify({ command: "find", args: [">", "/tmp/pyfiles.txt"] }),
          },
        ],
      }
    }
    // The result the model is handed, read off the history it was sent.
    for (const message of messages) {
      if (message.role === "tool" && typeof message.content === "string") {
        prompts.push(message.content)
      }
    }
    return { type: "text", content: "I cannot redirect output." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({
    confirmer: async (): Promise<ConfirmationOutcome> => {
      confirmations++
      return "confirmed"
    },
  })

  const reply = await manager.submitTurn("put the python files in a list", connection, "text")

  assert.equal(confirmations, 0, "the user must never be asked to approve a command that cannot run")
  assert.equal(reply, "I cannot redirect output.")
  assert.equal(prompts.length, 1)
  assert.match(prompts[0]!, /^Not run: ">" is a shell operator/)
})

// ------------------------------------- the displayed command is the real one

test("the confirmation carries the exact argv, and the model's prose cannot replace it", async () => {
  const sent: WsMessage[] = []
  let calls = 0
  const chat: ChatFn = async () => {
    calls++
    if (calls === 1) {
      return {
        type: "tool_calls",
        calls: [
          {
            id: "c1",
            name: "shell_write",
            arguments: JSON.stringify({ command: `touch "my file.txt"`, cwd: dir }),
          },
        ],
      }
    }
    // generateDescription's call. Deliberately a lie, which is the case this
    // exists for: the prose is a language model's claim about the command.
    if (calls === 2) return { type: "text", content: "This will send an email to your bank." }
    return { type: "text", content: "Done." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({
    confirmer: async (description: string): Promise<ConfirmationOutcome> => {
      sent.push({ type: "confirm", content: description })
      return "declined"
    },
  })

  await manager.submitTurn("make that file", connection, "text")

  assert.equal(sent.length, 1, "exactly one prompt")
  const shown = sent[0]!.content!

  // The prose is still there — it is allowed to accompany the command.
  assert.match(shown, /send an email to your bank/)
  // And the truth is there under it, as one line, with the quoted filename
  // shown as ONE filename.
  assert.match(shown, /Exactly this will run:\n {2}touch "my file\.txt"$/)
})

// The argv the user reads and the argv execFile receives come from the same
// function, called twice — once in preflight, once in execute. This asserts
// they agree, because the whole guarantee rests on it.
test("the displayed command matches what is executed", async () => {
  const input = { command: `touch "spaced name.txt"`, cwd: dir }

  const shown = shellWriteTool.preflight!(input).command
  assert.equal(shown, `touch "spaced name.txt"`)

  const result = await shellWriteTool.execute(input)
  assert.equal(result, "")

  const entries = await readdir(dir)
  assert.ok(
    entries.includes("spaced name.txt"),
    `the displayed name is not what was created: ${entries.join(", ")}`
  )
})

test("a tilde in the displayed command is already expanded, because that is what runs", async () => {
  const shown = shellWriteTool.preflight!({ command: "mkdir", args: ["~/nope-not-created"] }).command
  assert.ok(shown!.startsWith("mkdir /"), `the user would read a path that is not the one used: ${shown}`)
  assert.ok(!shown!.includes("~"), shown)
})

test("a refusal offers no command to display", () => {
  const out = shellWriteTool.preflight!({ command: "find", args: [">", "/tmp/x"] })
  assert.ok(out.refusal, "it refuses")
  assert.equal(out.command, undefined, "and there is nothing to show, because nothing will run")
})

// ----------------------------------------------------- the helper itself

test("confirmationText keeps the prose and appends the command", () => {
  assert.equal(
    confirmationText("Create a file.", `touch "a b"`),
    'Create a file.\n\nExactly this will run:\n  touch "a b"'
  )
  // A tool with no preflight command is unchanged — every other confirming
  // tool in the registry is in this case.
  assert.equal(confirmationText("Remember something."), "Remember something.")
})

test("shell_write is still the only tool with a preflight", () => {
  const withPreflight = registry
    .list()
    .filter((tool) => tool.preflight)
    .map((tool) => tool.name)
  assert.deepEqual(withPreflight, ["shell_write"])
})
