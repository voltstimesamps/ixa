import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { makeNotebook, withTurn } from "./memory-helpers"
import { setNotebook } from "../src/memory/notebook"
import { saveNoteTool, localDateString } from "../src/tools/notes"
import { normalizeAmount, unsupportedAmounts } from "../src/core/prices"

// A price in a NOTE.
//
// The existing price guard inspects the draft reply, so it never sees a tool
// argument — and the spike proved what that costs: `$600` reached a note body
// with no web_search in that turn, written as "A used RTX 3090 is currently
// selling for about $600" with no attribution to the user who had actually
// said "like six hundred bucks". On disk, that is read back later as a
// measurement.
//
// The rule: a currency amount in a note must appear in the user's own turn or
// in a web_search result executed that turn.

const BASE = {
  type: "reference",
  title: "Used RTX 3090 price for the homelab",
  summary: "What a used 3090 is going for.",
  sections: [{ heading: "Price", body: "A used RTX 3090 is selling for about $600." }],
}

function harness(t: { after: (fn: () => void) => void }) {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)
  return h
}

function vaultFiles(vault: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(vault)
  return out
}

// ------------------------------------------------------ value, not text

test("the user's words and the model's digits are the same figure", () => {
  // THIS is why the comparison cannot be a substring match. These two share
  // not one character.
  const spoken = normalizeAmount("six hundred bucks")
  const written = normalizeAmount("$600")
  assert.ok(spoken && written)
  assert.equal(spoken.value, written.value)
  assert.equal(spoken.currency, written.currency)
})

test("a figure the user actually said is supported however it is written", () => {
  const said = "note down that a used 3090 is going for like six hundred bucks now"
  assert.deepEqual(unsupportedAmounts("selling for about $600", [said]), [])
  assert.deepEqual(unsupportedAmounts("about six hundred dollars", [said]), [])
})

test("a near miss is not a match, because rounding would be deciding how wrong is allowed", () => {
  const said = "about six hundred bucks"
  assert.deepEqual(unsupportedAmounts("it is $599", [said]), ["$599"])
  assert.deepEqual(unsupportedAmounts("it is £600", [said]), ["£600"], "a different currency")
})

test("a vague figure passes only if the user was equally vague", () => {
  assert.deepEqual(
    unsupportedAmounts("it costs a few hundred dollars", ["maybe a few hundred dollars"]),
    []
  )
  assert.deepEqual(unsupportedAmounts("it costs a few hundred dollars", ["it is cheap"]), [
    "a few hundred dollars",
  ])
})

test("numbers that are not money do not make a note unsavable", () => {
  const body = "The RTX 3090 has 24 GB of VRAM, good for 1440p, and runs a 7B model at 24000 chars."
  assert.deepEqual(unsupportedAmounts(body, []), [])
})

// -------------------------------------------------------------- the tool

test("a price nobody gave her is refused, and nothing reaches disk", async (t) => {
  const h = harness(t)

  const output = await withTurn(
    { userText: "note down what a used 3090 goes for" },
    () => saveNoteTool.execute(BASE)
  )

  assert.match(String(output), /Nothing was saved/)
  assert.match(String(output), /\$600/, "the figure is quoted back so the model knows which one")
  assert.match(String(output), /call web_search now|left out/)
  assert.deepEqual(vaultFiles(h.vault), [], "no file")
  assert.equal(h.store.count(), 0, "no row")
  assert.equal(h.index.points.size, 0, "no vector")
})

test("a price the user stated is saved, with a dated caveat added by code", async (t) => {
  const h = harness(t)

  const output = await withTurn(
    { userText: "note down that a used 3090 is going for like six hundred bucks now" },
    () => saveNoteTool.execute(BASE)
  )

  assert.match(String(output), /^Saved reference note/m)
  const files = vaultFiles(h.vault)
  assert.equal(files.length, 1)

  const text = fs.readFileSync(files[0]!, "utf8")
  assert.match(text, /\$600/)
  assert.match(
    text,
    new RegExp(`Prices as stated on ${localDateString()}`),
    "a figure in a file has no conversation around it to date it, so it carries its own date"
  )
  assert.match(String(output), /price caveat was added/)
})

test("a price from a web_search run in this turn is saved", async (t) => {
  const h = harness(t)

  const output = await withTurn(
    {
      userText: "how much is a used 3090, and write it down",
      searchResults: ["eBay listings for used RTX 3090 cluster around $1,360 shipped."],
    },
    () =>
      saveNoteTool.execute({
        ...BASE,
        sections: [{ heading: "Price", body: "Used 3090s are around $1,360." }],
      })
  )

  assert.match(String(output), /^Saved reference note/m)
  assert.equal(vaultFiles(h.vault).length, 1)
})

test("a figure in the SUMMARY is checked too", async (t) => {
  const h = harness(t)

  const output = await withTurn({ userText: "write down the 3090 plan" }, () =>
    saveNoteTool.execute({
      ...BASE,
      summary: "A used 3090 costs $600, so that is the homelab plan.",
      sections: [{ heading: "Plan", body: "Buy one for the homelab." }],
    })
  )

  assert.match(String(output), /Nothing was saved/)
  assert.deepEqual(vaultFiles(h.vault), [], "a summary is what a search surfaces first")
})

test("a search from an EARLIER turn does not license a price now", async (t) => {
  const h = harness(t)

  // The evidence window is one turn, deliberately. Reading prices out of
  // history is exactly the staleness the freshness rule exists to catch.
  const output = await withTurn({ userText: "now write that down", searchResults: [] }, () =>
    saveNoteTool.execute(BASE)
  )

  assert.match(String(output), /Nothing was saved/)
  assert.deepEqual(vaultFiles(h.vault), [])
})

test("save_note called outside a turn fails closed", async (t) => {
  const h = harness(t)

  // Unverifiable is not the same as verified: with no turn there is no user
  // text and no search result, so the price rule cannot be applied at all.
  const output = String(
    await saveNoteTool.execute({
      ...BASE,
      sections: [{ heading: "Plain", body: "No money mentioned anywhere." }],
    })
  )

  assert.match(output, /only be called inside a conversation turn/)
  assert.deepEqual(vaultFiles(h.vault), [])
})

test("a note with no prices in it is unaffected", async (t) => {
  const h = harness(t)

  const output = await withTurn({ userText: "write down that the backend runs in WSL2" }, () =>
    saveNoteTool.execute({
      type: "reference",
      title: "The backend runs in WSL2 on the gaming PC",
      summary: "Ixa's harness runs under WSL2 Ubuntu on the gaming PC.",
      sections: [{ heading: "Where it runs", body: "WSL2 Ubuntu, on the native filesystem." }],
    })
  )

  assert.match(String(output), /^Saved reference note/m)
  const text = fs.readFileSync(vaultFiles(h.vault)[0]!, "utf8")
  assert.ok(!text.includes("Prices as stated"), "no caveat where there is no price")
})

// ------------------------------------------------- the rest of the schema

test("the tool validates its own arguments and says what was wrong", async (t) => {
  harness(t)

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...BASE, type: "note" }, /'type' must be one of/],
    [{ ...BASE, title: "  " }, /'title' is required/],
    [{ ...BASE, summary: "" }, /'summary' is required/],
    [{ ...BASE, sections: [] }, /'sections' must be a non-empty list/],
    [{ ...BASE, sections: [{ heading: "x" }] }, /'sections' must be a non-empty list/],
  ]

  for (const [input, expected] of cases) {
    const output = await withTurn({ userText: "write it down" }, () =>
      saveNoteTool.execute(input)
    )
    assert.match(String(output), expected, JSON.stringify(input).slice(0, 80))
  }
})

test("the result reads back the title and summary that are on disk", async (t) => {
  const h = harness(t)

  const output = String(
    await withTurn({ userText: "write down that the backend runs in WSL2" }, () =>
      saveNoteTool.execute({
        type: "reference",
        title: "The backend runs in WSL2 on the gaming PC",
        summary: "Ixa's harness runs under WSL2 Ubuntu on the gaming PC.",
        sections: [{ heading: "Where", body: "WSL2 Ubuntu." }],
      })
    )
  )

  const onDisk = fs.readFileSync(vaultFiles(h.vault)[0]!, "utf8")
  assert.match(output, /The backend runs in WSL2 on the gaming PC/)
  assert.match(output, /Summary on disk: Ixa's harness runs under WSL2 Ubuntu/)
  assert.ok(onDisk.includes("Ixa's harness runs under WSL2 Ubuntu on the gaming PC."))
  assert.match(
    output,
    /Tell the user in one short sentence what you saved/,
    "read-back is the mitigation that replaces a confirmation prompt"
  )
})

test("provenance is the turn's, and no schema field can set it", async (t) => {
  const h = harness(t)

  await withTurn({ userText: "note that down", source: "voice", sessionId: "turn-session" }, () =>
    saveNoteTool.execute({
      ...BASE,
      sections: [{ heading: "Plain", body: "Nothing about money." }],
      // What the spike's model supplied when the schema asked it: an invented
      // session id. Ignored here, because the schema has no such field.
      provenance: { source: "text", session_id: "?", date: "1999-01-01" },
    })
  )

  const note = h.store.all()[0]!
  assert.equal(note.source, "voice")
  assert.equal(note.sessionId, "turn-session")
  assert.equal(note.date, localDateString(), "the harness clock, not a date the model chose")
})
