import { test } from "node:test"
import assert from "node:assert/strict"
// The real registrations, so these turns go through the tools the harness
// ships rather than stand-ins. The web_search below deliberately replaces the
// real one: the registry is a map keyed by name, and this import runs first.
import "../src/tools/register"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { setNotebook } from "../src/memory/notebook"
import {
  NOTEBOOK_UNAVAILABLE,
  SEARCH_UNAVAILABLE,
  noteFailure,
  saveNoteTool,
  searchNotesTool,
} from "../src/tools/notes"
import { shellReadTool } from "../src/tools/shell-read"
import { shellWriteTool } from "../src/tools/shell-write"
import { captureLogs, makeNotebook } from "./memory-helpers"
import { makeConnection, TEST_LIMITS } from "./helpers"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse } from "../src/core/llm"

// The log said a turn was going fine while nothing was being saved.
//
// Live: a save_note call with a `type` outside the three valid values logged
//
//   tool save_note ok 0ms {"sections":[…],"type":"note"}
//
// The call returned "Nothing was saved: 'type' must be one of …" and wrote
// nothing. Both note tools catch their own problems and return them as result
// strings — right by the model, and a lie to the one place a human looks.
//
// That particular refusal no longer exists: the honest log word showed it
// firing on 20 of 20 saves, so an unrecognized type is now coerced to
// `reference` (tool-arguments.test.ts). The lesson outlived the case — the
// refusals BELOW are the ones that still write nothing, and the only reason
// anyone knows how often any of them fire is that the log says the word.

// ------------------------------------------------------------ the predicate

test("every refusal save_note writes is a failure", () => {
  for (const result of [
    "Nothing was saved: 'title' is required.",
    "Nothing was saved: 'summary' is required.",
    "Nothing was saved: 'sections' must be a non-empty list of {heading, body}, both non-empty.",
    "Nothing was saved: save_note can only be called inside a conversation turn, because a note's",
    "Nothing was saved: ENOSPC: no space left on device",
    // priceRefusal, which opens with a PERIOD rather than a colon — which is
    // why the prefix carries neither.
    "Nothing was saved. The figure $1,360 is not in anything the user said in this conversation",
    NOTEBOOK_UNAVAILABLE,
    SEARCH_UNAVAILABLE,
  ]) {
    assert.equal(noteFailure(result), true, result.slice(0, 48))
  }
})

// A search that found nothing is a search that WORKED. It is the result of
// every first search of a session, and logging it as a failure would bury the
// real ones.
test("an empty notebook and an empty search are not failures", () => {
  for (const result of [
    "Nothing in your notebook matches that. You have not written a note about it.",
    "Your notebook is empty — you have not written any notes yet.",
    'Saved reference note "Ixa repo location" (id 2026-10-13-ixa-repo-location).',
    "1 note(s) closest to that, best first:",
  ]) {
    assert.equal(noteFailure(result), false, result.slice(0, 48))
  }
})

test("both note tools carry the predicate", () => {
  assert.equal(saveNoteTool.isFailure, noteFailure)
  assert.equal(searchNotesTool.isFailure, noteFailure)
})

// ------------------------------------------------------------- the log word

function harness(t: { after: (fn: () => void) => void }) {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)
  return h
}

function saveCall(id: string, broken: Record<string, unknown> = {}): LLMResponse {
  return {
    type: "tool_calls",
    calls: [
      {
        id,
        name: "save_note",
        arguments: JSON.stringify({
          type: "reference",
          title: "Ixa repo location",
          summary: "Ixa repo location",
          sections: [{ heading: "Ixa repo location", body: "The Ixa repo is at /home/wyatt/ixa." }],
          ...broken,
        }),
      },
    ],
  }
}

// The live line, now with the right word in it.
test("a save_note refusal logs as failed, and the save that follows logs as ok", async (t) => {
  harness(t)

  let n = 0
  const chat: ChatFn = async () => {
    n++
    // The live sequence was an invalid type corrected on the next iteration,
    // and an invalid type is no longer a refusal. The shape is what matters:
    // a call that writes nothing, then the same call put right.
    if (n === 1) return saveCall("c1", { title: "   " })
    if (n === 2) return saveCall("c2", {})
    return { type: "text", content: "I saved it." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const { logs } = await captureLogs(() =>
    manager.submitTurn("write down where the repo is", makeConnection(), "text")
  )
  manager.shutdown()

  const calls = logs.filter((line) => line.startsWith("tool save_note"))
  assert.equal(calls.length, 2)
  assert.match(calls[0]!, /^tool save_note failed /)
  assert.match(calls[0]!, /'title' is required/, "and says which failure it was")
  assert.match(calls[1]!, /^tool save_note ok /)
})

test("a search that finds nothing still logs as ok", async (t) => {
  harness(t)

  let n = 0
  const chat: ChatFn = async () => {
    n++
    if (n === 1) {
      return {
        type: "tool_calls",
        calls: [{ id: "s1", name: "search_notes", arguments: '{"query":"Ixa repo"}' }],
      }
    }
    return { type: "text", content: "Nothing written down about that." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const { logs } = await captureLogs(() =>
    manager.submitTurn("where is the repo?", makeConnection(), "text")
  )
  manager.shutdown()

  const calls = logs.filter((line) => line.startsWith("tool search_notes"))
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /^tool search_notes ok /)
})

// ------------------------------------------------- the log is not the refusal
//
// THE CASE THAT DECIDED THE DESIGN. The repeated-failure refusal used to be
// gated on `isFailure` existing, so making the log honest would have enrolled
// save_note in a behaviour change — and save_note is the one tool that must
// not be in it.
//
// priceRefusal says, in as many words: "Either call web_search now and use
// what it returns, or call save_note again with the figure left out." The
// model does the first thing, the search confirms the figure, and the call it
// re-sends is byte for byte the one that just failed. A signature match knows
// nothing about the search that happened in between.

let searched = 0
registry.register({
  name: "web_search",
  description: "test search",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () => {
    searched++
    return "eBay listings for used RTX 3090s cluster around $1,360 shipped."
  },
})

function pricedSave(id: string): LLMResponse {
  return {
    type: "tool_calls",
    calls: [
      {
        id,
        name: "save_note",
        arguments: JSON.stringify({
          type: "reference",
          title: "Used 3090 price",
          summary: "What a used 3090 goes for.",
          sections: [{ heading: "Price", body: "A used RTX 3090 is about $1,360." }],
        }),
      },
    ],
  }
}

test("a price refusal, a web_search, then the identical save_note — and it saves", async (t) => {
  const h = harness(t)
  searched = 0

  let n = 0
  const chat: ChatFn = async () => {
    n++
    // 1: the price is from memory, so nothing is saved.
    if (n === 1) return pricedSave("p1")
    // 2: the model does what the refusal asked.
    if (n === 2) {
      return { type: "tool_calls", calls: [{ id: "s1", name: "web_search", arguments: "{}" }] }
    }
    // 3: the SAME call again, now with evidence behind it.
    if (n === 3) return pricedSave("p2")
    return { type: "text", content: "Saved the 3090 price." }
  }

  const manager = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const { logs, result: reply } = await captureLogs(() =>
    manager.submitTurn("how much is a used 3090? write it down", makeConnection(), "text")
  )

  const history = manager.primarySession().history()
  manager.shutdown()

  assert.equal(searched, 1)
  assert.equal(reply, "Saved the 3090 price.")

  const results = history
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content))
    .filter((c) => c.startsWith("Nothing was saved") || c.startsWith("Saved ") || c.startsWith("Not run:"))

  assert.equal(results.length, 2, "two save_note results")
  assert.match(results[0]!, /^Nothing was saved\./, "the first had no evidence")
  assert.match(
    results[1]!,
    /^Saved reference note/,
    "the second is the identical call and it SAVED — not refused as a repeat"
  )
  for (const line of results) {
    assert.doesNotMatch(line, /^Not run: this exact call already failed/)
  }

  // The log still told the truth about the first one.
  const saveLines = logs.filter((line) => line.startsWith("tool save_note"))
  assert.equal(saveLines.length, 2)
  assert.match(saveLines[0]!, /^tool save_note failed /)
  assert.match(saveLines[1]!, /^tool save_note ok /)

  // And the note is on disk, once.
  const notes = h.store.recent(10)
  assert.equal(notes.length, 1)
  assert.equal(notes[0]!.title, "Used 3090 price")
})

// ------------------------------------------------------------- the opt-in

test("only the shell tools are enrolled in the repeated-failure refusal", () => {
  assert.equal(shellReadTool.dedupeFailures, true)
  assert.equal(shellWriteTool.dedupeFailures, true)
  assert.equal(saveNoteTool.dedupeFailures, undefined)
  assert.equal(searchNotesTool.dedupeFailures, undefined)
})

// A tool may not claim the refusal without the predicate that feeds it: there
// is no way to know a call failed otherwise, and the flag would silently do
// nothing.
test("no registered tool sets dedupeFailures without isFailure", () => {
  for (const tool of registry.list()) {
    if (tool.dedupeFailures) {
      assert.ok(tool.isFailure, `${tool.name} is enrolled but cannot say what a failure is`)
    }
  }
})
