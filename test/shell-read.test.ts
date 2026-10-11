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
    // All three live turns began by listing a whole home directory to find a
    // path that was already written down, and search_notes was never called
    // in any of them. A narrower command does not help a model that does not
    // know where to point it.
    assert.match(out, /search_notes may already say/)
    assert.ok(out.length < 700, "the message is a message, not a dump")
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
  // Same pointer as the oversized-output result, for the same reason: the
  // cheapest fix for a turn that starts by listing a whole home directory.
  assert.match(String(line!.content), /locations may be in search_notes/)

  // A statement about this call, not something that was said: never stored.
  assert.equal(
    session.history().some((m) => String(m.content ?? "").includes("shell_read and shell_write run in")),
    false,
    "the line is injected per call and never written to history",
  )

  sessions.shutdown()
})

// ------------------------------------------------------ shell operators

// There is no shell. `execFile` runs one program, so a pipe is handed to that
// program as an argument — and the program complains about ITS OWN syntax,
// which is the worst possible error to give a model that is trying to pipe.
//
// Live, "find every Python file in the TTS sidecar and tell me what the
// biggest one does" spent 15 shell_read calls, 12 of them piped, and got:
//
//   find: paths must precede expression: `%p\n"'    ×7
//   find: missing argument to `-exec'               ×3
//   find: paths must precede expression: `|'        ×2
//
// Every one of those reads as a find-syntax problem, so the model rearranged
// the find expression and tried again. Nine of the twelve were the SAME
// command re-sent verbatim.
test("a piped command is refused, not handed to find as an argument", async () => {
  const out = await run(
    `find ${dir} -type f -name "*.py" -printf "%s %p\\n" | sort -nr | head -n 1`,
  )

  assert.match(out, /^Not run:/)
  assert.match(out, /"\|" is a shell operator/)
  assert.match(out, /ONE program directly with no shell/)
  assert.match(out, /nothing is wrong with the tool/)
  // find's own parser never sees it, so its confusing error cannot appear.
  assert.doesNotMatch(out, /paths must precede expression/)
  // And it says what to do instead, including the command that answers the
  // question that was actually being asked.
  assert.match(out, /-printf '%s %p/)
  assert.match(out, /-exec wc -l \{\} \+/)
  assert.ok(out.length < 420, "the refusal stays short")
})

test("every operator form is refused and named", async () => {
  const cases: [string, string][] = [
    [`ls ${dir} | wc -l`, "|"],
    [`ls ${dir} || ls .`, "||"],
    [`ls ${dir} && ls .`, "&&"],
    [`ls ${dir} ; ls .`, ";"],
    [`ls ${dir} > out.txt`, ">"],
    [`ls ${dir} >> out.txt`, ">>"],
    [`wc -l < ${dir}/Projects/ixa/ARCHITECTURE.md`, "<"],
    ["ls `pwd`", "`"],
    ["ls $(pwd)", "$("],
  ]
  for (const [command, operator] of cases) {
    const out = await run(command)
    assert.match(out, /^Not run:/, `not refused: ${command}`)
    assert.ok(
      out.includes(`"${operator}" is a shell operator`),
      `${command} should name ${operator}, got: ${out.slice(0, 90)}`,
    )
  }
})

test("an operator the model pre-split into args is refused too", async () => {
  // The same pipe, arriving as its own token because the model split the
  // command itself. Nothing is left to read quoting from here, so only a
  // whole argument counts.
  const out = await run("ls", [dir, "|", "wc", "-l"])
  assert.match(out, /^Not run:/)
  assert.match(out, /"\|" is a shell operator/)
})

// The refusal must not swallow the legitimate uses of the same characters.
test("quoted operators are arguments, not operators", async () => {
  // Extended-regex alternation: a real pipe inside a real pattern.
  await writeFile(join(dir, "alt.txt"), "alpha\nbeta\ngamma\n")
  const grep = await run("grep -E 'alpha|gamma' alt.txt", [], dir)
  assert.doesNotMatch(grep, /^Not run:/, "a quoted pipe is part of the pattern")
  assert.match(grep, /alpha/)
  assert.match(grep, /gamma/)
  assert.doesNotMatch(grep, /beta/)
})

test("find -exec keeps its semicolon terminator", async () => {
  // `\;` and ';' are how a shell user writes the literal, and the model writes
  // both. Refusing a bare `;` would refuse the most useful form of -exec, so
  // it only counts as chaining when there is no -exec to terminate.
  const escaped = await run(`find . -maxdepth 3 -name "ARCHITECTURE.md" -exec wc -c {} \;`, [], dir)
  assert.doesNotMatch(escaped, /^Not run:/, "an escaped semicolon is -exec's terminator")
  assert.match(escaped, /ARCHITECTURE\.md/)

  const bare = await run(`find . -maxdepth 3 -name "ARCHITECTURE.md" -exec wc -c {} ;`, [], dir)
  assert.doesNotMatch(bare, /^Not run:/, "and so is a bare one, when there is an -exec")
  assert.match(bare, /ARCHITECTURE\.md/)

  // With no -exec, a bare semicolon is the model trying to chain.
  const chained = await run("ls . ; ls .", [], dir)
  assert.match(chained, /^Not run:/)
})

// ------------------------------------------------------ quoted arguments

// The OTHER half of the live failure, and the one no amount of per-token quote
// stripping reaches: seven of the fifteen calls failed on `-printf "%s %p\n"`
// alone, with or without a pipe, because a whitespace split turns one argument
// into two. The remedy the refusal above recommends would be a trap without
// this.
test("an argument with a space inside quotes survives as one argument", async () => {
  const out = await run(`find . -maxdepth 3 -name "ARCHITECTURE.md" -printf "%s %p\\n"`, [], dir)
  assert.doesNotMatch(out, /paths must precede expression/)
  assert.match(out, /^\d+ \.\/Projects\/ixa\/ARCHITECTURE\.md/)
})

test("double quotes keep a backslash that find itself expands", async () => {
  // In a shell, "\n" inside double quotes is a literal backslash-n; find is
  // what turns it into a newline. Converting it here would hand find a real
  // newline and break -printf.
  const out = await run(`find . -maxdepth 3 -name "ARCHITECTURE.md" -printf "%p\\n%s\\n"`, [], dir)
  assert.equal(out.trim().split("\n").length, 2, "find expanded two newlines of its own")
})

// ------------------------------------------------------ failure reporting

test("the tool declares which of its own results are failures", () => {
  const isFailure = shellReadTool.isFailure!
  // Every string the live turn actually received.
  assert.equal(isFailure("Command failed: find: paths must precede expression: `|'"), true)
  assert.equal(isFailure("Output too large to return: the command produced more than 1 MB"), true)
  assert.equal(isFailure("Not run: \"|\" is a shell operator"), true)
  assert.equal(isFailure("Command timed out after 10 seconds."), true)
  assert.equal(isFailure("Command 'curl' is not allowed in read-only mode."), true)

  // And the ones that are not failures, including the one that looks most
  // like one: a successful command whose answer is "nothing".
  assert.equal(isFailure("(no output)"), false)
  assert.equal(isFailure("6119 ./main.py"), false)
  assert.equal(isFailure("total 0\ndrwxr-xr-x 2 wyatt wyatt 4096 Oct 11 04:06 ."), false)
})
