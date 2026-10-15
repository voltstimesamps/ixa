import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RAN_NO_OUTPUT, shellWriteTool } from "../src/tools/shell-write"
// The real registry, because two of these tests drive a real turn and the
// session resolves a tool by name. Neither of those two ever executes
// anything — one is refused before the prompt and the other declines it — so
// nothing here can write outside the temp directory, which matters because
// the session injects its OWN cwd ($HOME) into a shell call's arguments.
import "../src/tools/register"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { confirmationText, type ChatFn } from "../src/core/session"
import { NO_OUTPUT } from "../src/tools/shell-read"
import { isShellFailure } from "../src/tools/shell-result"
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
  assert.equal(result, RAN_NO_OUTPUT, "a touch that worked says so")

  const entries = await readdir(dir)
  assert.deepEqual(entries, ["my file.txt"], `created instead: ${entries.join(", ")}`)
})

test("single quotes work too, and the quotes are not part of the name", async () => {
  const result = await run(`touch 'two words.txt'`, [], dir)
  assert.equal(result, RAN_NO_OUTPUT)

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
  assert.equal(result, RAN_NO_OUTPUT)

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

// ------------------------------------------- success that printed nothing

// A SUCCESSFUL WRITE HAS TO SAY SO.
//
// This returned "" until a live voice conversation showed what an empty
// result teaches. A confirmed `touch` and a confirmed `rm` both reported
// nothing and were both answered correctly, so the history the model carried
// was twice the pattern
//
//   shell_write touch MyFile.txt -> (nothing) -> "I created MyFile.txt."
//
// Three turns later a DECLINED touch, whose result said "Action declined by
// user." in so many words, was answered "I've created MyFile.txt." Replaying
// that history reproduced the false claim in 8 of 30 turns; replaying it with
// those two empty-result exchanges removed reproduced it in 0 of 10.
test("a command that worked and printed nothing says that it worked", async () => {
  const result = await run("mkdir", ["silent-success"], dir)
  assert.equal(result, RAN_NO_OUTPUT)
  // The two things the sentence has to carry, named rather than assumed: that
  // the command ran, and that the silence was its output and not an error.
  assert.match(result, /ran successfully/)
  assert.match(result, /no output/)

  const made = await stat(join(dir, "silent-success"))
  assert.ok(made.isDirectory(), "and it really ran")
})

test("the success sentence is not shell_read's, because they are different claims", () => {
  // shell_read's "(no output)" answers a question: the listing really was
  // empty and nothing happened. This reports an action that completed. A model
  // reading its own history has to be able to tell the two apart.
  assert.notEqual(RAN_NO_OUTPUT, NO_OUTPUT)
  // The difference that carries it: this one says the command RAN. shell_read's
  // says only that there was nothing, which is true of a write that never
  // happened as well as of one that did.
  assert.match(RAN_NO_OUTPUT, /\bran\b/)
  assert.ok(!/\bran\b/.test(NO_OUTPUT), `shell_read's result now claims a run: ${NO_OUTPUT}`)
})

test("the success sentence is not read as a failure", () => {
  // The prefix list is in shell-result.ts, a different file from the sentence,
  // so this is asserted rather than inspected: "Command ran successfully" sits
  // one word away from "Command failed:" and "Command blocked:", and a success
  // logged as a failure would also be remembered as one by dedupeFailures.
  assert.equal(isShellFailure(RAN_NO_OUTPUT), false, "a success read as a failure")
  assert.equal(shellWriteTool.isFailure!(RAN_NO_OUTPUT), false)
})

test("failure results are unchanged", async () => {
  // Nothing about the success wording moved these, and each is still
  // recognised as a failure by the tool's own predicate.
  const blocked = await run("rm", ["/etc/passwd"], dir)
  assert.match(blocked, /^Command blocked: access to system paths/)

  const missing = await run("cd", ["no-such-directory-here"], dir)
  assert.match(missing, /^Directory not found:/)

  const failed = await run("rm", ["definitely-not-a-file.txt"], dir)
  assert.match(failed, /^Command failed:/)

  const refused = await run("find", [">", join(dir, "out2.txt")], dir)
  assert.match(refused, /^Not run: ">" is a shell operator/)

  for (const result of [blocked, missing, failed, refused]) {
    assert.equal(isShellFailure(result), true, `not seen as a failure: ${result}`)
  }
})
