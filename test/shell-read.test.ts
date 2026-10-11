import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellReadTool } from "../src/tools/shell-read"
import { SessionManager } from "../src/core/session-manager"
import type { ChatFn } from "../src/core/session"
import type { Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// File discovery, driven by the three commands that actually failed.
//
// Live, asked to read her own architecture document, Ixa made nine tool calls
// and found nothing. Not one of them was a bad idea; all three mechanisms that
// defeated them were in this file:
//
//   ls -R                      → "Command failed: stdout maxBuffer length exceeded"  (×3)
//   find . -name '*architecture*' → ""                                               (×2)
//   find Projects -name '*architecture*' → ""
//
// The file is ARCHITECTURE.md, in a directory she was never told she was
// standing in, and `find . -iname '*architecture*'` from $HOME finds it in
// seven lines and 700 characters.

const run = (command: string, args?: string[], cwd?: string): Promise<string> =>
  shellReadTool.execute({ command, args, cwd }) as Promise<string>

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ixa-shell-read-"))
  await mkdir(join(dir, "Projects", "ixa"), { recursive: true })
  await writeFile(join(dir, "Projects", "ixa", "ARCHITECTURE.md"), "# Ixa\n")
  await mkdir(join(dir, "empty"), { recursive: true })
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ------------------------------------------------------ output too large

// A tree whose `ls -R` overruns the 1MB buffer, built the cheap way: one
// directory of long names. The real one was a 1.8MB, 69234-line listing of a
// home directory with two Python venvs and a node_modules in it.
test("a listing too large for the buffer says what to do instead", async () => {
  const big = await mkdtemp(join(tmpdir(), "ixa-big-tree-"))
  try {
    const name = "f".repeat(240)
    await Promise.all(
      Array.from({ length: 4600 }, (_, i) =>
        writeFile(join(big, `${name}${String(i).padStart(5, "0")}`), ""),
      ),
    )

    const out = await run("ls", ["-R"], big)

    // The old message was "Command failed: stdout maxBuffer length exceeded",
    // which names no cause and suggests nothing. It was retried verbatim.
    assert.doesNotMatch(out, /maxBuffer/, "the model is never shown the Node error")
    assert.match(out, /Output too large/)
    assert.match(out, /Nothing is wrong with the command or the tool/)
    assert.match(out, /-iname/, "and it names a narrower command to try")
    assert.ok(out.length < 600, "the message is a message, not a dump")
  } finally {
    await rm(big, { recursive: true, force: true })
  }
})

// The narrower command the message points at has to actually work from here.
test("the suggested narrower command finds the file the large one could not", async () => {
  const out = await run("find", [".", "-iname", "*architecture*"], dir)
  assert.match(out, /ARCHITECTURE\.md/)
})

// ------------------------------------------------------ shell quoting

// The quotes never reached a shell, so they were part of the pattern.
test("quotes the model typed around a pattern do not become part of it", async () => {
  const quoted = await run("find . -name '*ARCHITECTURE*'", [], dir)
  assert.match(quoted, /ARCHITECTURE\.md/, "a single-quoted pattern matches what it would in a shell")

  const double = await run('find . -name "*ARCHITECTURE*"', [], dir)
  assert.match(double, /ARCHITECTURE\.md/)

  // Including the exact live call, which fails for the OTHER reason too: the
  // file is ARCHITECTURE.md and -name is case-sensitive. Unquoting it alone
  // does not find the file, and that is correct — the tool must not quietly
  // run -iname when it was asked for -name.
  const live = await run("find . -name '*architecture*'", [], dir)
  assert.equal(live, "(no output)", "case is still case; the tool does not rewrite the flag")
})

test("a lone quote is still an argument", async () => {
  // What you grep for when you want an apostrophe. Stripping it would leave
  // an empty pattern, which matches every line.
  await writeFile(join(dir, "quotes.txt"), "it's here\nnot here\n")
  const out = await run("grep", ["'", "quotes.txt"], dir)
  assert.match(out, /it's here/)
  assert.doesNotMatch(out, /not here/)
})

test("quoted paths expand like the shell would", async () => {
  const out = await run("ls", ["'Projects'"], dir)
  assert.match(out, /ixa/)
})

// ------------------------------------------------------ nothing found

test("a successful command with no output says so", async () => {
  const empty = await run("find", ["empty", "-name", "*.md"], dir)
  assert.equal(empty, "(no output)", "an empty string reads as a broken tool")

  const listing = await run("ls", ["empty"], dir)
  assert.equal(listing, "(no output)")
})

// ------------------------------------------------------ the description

test("the description warns that -name is case-sensitive", () => {
  assert.match(shellReadTool.description, /-name is case-sensitive/)
  assert.match(shellReadTool.description, /-iname/)
})

// ------------------------------------------------------ the working directory

// Three of the nine live calls were spent working out where the shell was
// standing. Nothing told her, and nothing could: the directory moves with
// `cd` through shell_write and is restored with the session, so a static tool
// description cannot name it.
test("every call is told the working directory", async () => {
  const sent: Message[][] = []
  const chat: ChatFn = async (messages) => {
    sent.push(messages)
    return { type: "text", content: "noted" }
  }

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat,
  })

  await sessions.submitTurn("where are you", makeConnection({ id: "conn-cwd" }), "text")

  const session = sessions.primarySession()
  const line = sent
    .at(-1)!
    .find((m) => m.role === "system" && String(m.content).includes("shell_read and shell_write"))
  assert.ok(line, "the working directory is named on the call")
  assert.match(String(line!.content), new RegExp(`run in ${session.workingDirectory}\\b`))
  assert.match(String(line!.content), /relative paths are resolved from there/)

  // A statement about this call, not something that was said: never stored.
  assert.equal(
    session.history().some((m) => String(m.content ?? "").includes("shell_read and shell_write run in")),
    false,
    "the line is injected per call and never written to history",
  )

  sessions.shutdown()
})
