import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "child_process"
import path from "path"
import { registry } from "../src/tools/registry"
import "../src/tools/register"

// `echo` IS NOT A PRODUCTION TOOL.
//
// It exists to exercise the harness, and in live use on the desktop client the
// model called it to deliver a plain conversational sentence — which tripped
// the confirmation gate for something that needed no confirming, and then the
// client's blocking stdin prompt froze its event loop. A tool described as
// "Echoes back the provided message" is a plausible-looking way to say
// something, so the fix is to stop offering it rather than to reword it.
//
// It is still registered behind IXA_DEV_TOOLS=1, because with it gone the only
// way to exercise the confirmation gate by hand is `shell_write`, which has
// real side effects.

const REPO = path.resolve(__dirname, "..")

// The flag is read by config.ts at module load, and `registry` is a module
// singleton, so the two states cannot both exist in one process. A child
// process is the honest way to assert the other one.
function toolNamesWith(env: Record<string, string>): string[] {
  const output = execFileSync(
    path.join(REPO, "node_modules", ".bin", "tsx"),
    [
      "-e",
      `import { registry } from "./src/tools/registry"
       import "./src/tools/register"
       console.log(JSON.stringify(registry.list().map((t) => t.name)))`,
    ],
    { cwd: REPO, env: { ...process.env, ...env }, encoding: "utf8" }
  )
  // tsx may print warnings; the JSON array is the last line.
  const lines = output.trim().split("\n")
  return JSON.parse(lines[lines.length - 1]!)
}

test("echo is not offered to the model by default", () => {
  assert.equal(registry.get("echo"), undefined, "a production turn must not see it")
  assert.ok(
    !registry.list().some((tool) => tool.name === "echo"),
    "and it is not in the list either, which is what toOpenAI() walks"
  )
})

test("shell_write is the only always-on tool that confirms", () => {
  assert.deepEqual(
    registry
      .list()
      .filter((tool) => tool.requiresConfirmation)
      .map((tool) => tool.name),
    ["shell_write"],
    "so a confirmation prompt in production means a real side effect"
  )
})

test("IXA_DEV_TOOLS=1 brings echo back", () => {
  const withFlag = toolNamesWith({ IXA_DEV_TOOLS: "1" })
  assert.ok(withFlag.includes("echo"), `expected echo with the flag, got ${withFlag.join(", ")}`)

  const without = toolNamesWith({ IXA_DEV_TOOLS: "" })
  assert.ok(!without.includes("echo"), `expected no echo without it, got ${without.join(", ")}`)

  assert.equal(
    withFlag.length,
    without.length + 1,
    "the flag adds exactly one tool and changes nothing else"
  )
})

test("only the literal 1 turns dev tools on", () => {
  // Deliberately not truthy-string parsing: IXA_SKIP_WAKE_WORD accepts
  // 1/true/yes because a human types it ad hoc, but this one decides what the
  // model can see, so a stray value must fail closed.
  assert.ok(!toolNamesWith({ IXA_DEV_TOOLS: "true" }).includes("echo"))
  assert.ok(!toolNamesWith({ IXA_DEV_TOOLS: "0" }).includes("echo"))
})
