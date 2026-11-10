import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { makeNotebook, withTurn } from "./memory-helpers"
import { setNotebook } from "../src/memory/notebook"
import { figuresRestoredLine, saveNoteTool } from "../src/tools/notes"
import { restoreUserDigits } from "../src/core/prices"

// A price the user SAID in digits is stored in digits.
//
// Live (2026-11-08): the user said "...below my price range of $300", and
// save_note was called with a body saying "three hundred dollars" and a
// summary saying "$300". VOICE_RESPONSE_PROMPT's spell-numbers-out rule is for
// what is spoken; it is the last thing read before a tool call is written, and
// it bled into a file that is never spoken. Replayed 30 times, 6 bodies leaked.
// Two prompt-side levers (a clause in the body's schema description, a scoped
// line in the voice prompt) measured 10 and 7 of 30, so the restoration is code.

const USER = "write a note: I want a Dell OptiPlex, but I don't think I'll find one below my price range of $300."

test("a spelled-out figure the user said in digits goes back to the user's digits", () => {
  const out = restoreUserDigits("I do not expect to find one below three hundred dollars.", USER)
  assert.equal(out.text, "I do not expect to find one below $300.")
  assert.deepEqual(out.restored, [{ from: "three hundred dollars", to: "$300" }])
})

test("it matches on value and currency, not on wording", () => {
  const said = "it was about 600 bucks"
  assert.equal(restoreUserDigits("six hundred dollars", said).text, "600 bucks")
  assert.equal(
    restoreUserDigits("six hundred pounds sterling", said).text,
    "six hundred pounds sterling",
    "a different currency is a different figure"
  )
  assert.equal(
    restoreUserDigits("five hundred ninety nine dollars", USER).text,
    "five hundred ninety nine dollars",
    "a near miss is not the user's figure, and rounding would be deciding how wrong is allowed"
  )
})

test("every occurrence is restored, and a digit figure already there is left alone", () => {
  const out = restoreUserDigits(
    "Under three hundred dollars is unlikely; three hundred dollars is the floor, or $300.",
    USER
  )
  assert.equal(out.text, "Under $300 is unlikely; $300 is the floor, or $300.")
})

test("nothing is converted when the user did not give digits", () => {
  const text = "about three hundred dollars"
  assert.equal(restoreUserDigits(text, "maybe three hundred bucks").text, text, "said in words")
  assert.equal(restoreUserDigits(text, "no figures here at all").text, text)
  assert.equal(restoreUserDigits(text, "").text, text)
  assert.deepEqual(restoreUserDigits(text, "").restored, [])
})

test("only currency is touched: other quantities are the same leak in another shape and are not handled", () => {
  const text = "it has sixteen gigabytes and costs three hundred dollars"
  assert.equal(
    restoreUserDigits(text, "16 GB for $300").text,
    "it has sixteen gigabytes and costs $300"
  )
})

test("the correction line names each distinct figure once", () => {
  assert.equal(
    figuresRestoredLine([
      { from: "three hundred dollars", to: "$300" },
      { from: "three hundred dollars", to: "$300" },
      { from: "six hundred bucks", to: "$600" },
    ]),
    'Written the way the user said it: "three hundred dollars" as "$300", "six hundred bucks" as "$600".'
  )
})

// -------------------------------------------------------------- the tool

function harness(t: { after: (fn: () => void) => void }) {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)
  return h
}

function onlyFile(vault: string): string {
  const files = fs.readdirSync(vault).filter((f) => f.endsWith(".md"))
  assert.equal(files.length, 1)
  return fs.readFileSync(path.join(vault, files[0]!), "utf8")
}

test("save_note writes the user's digits to disk and says it did", async (t) => {
  const h = harness(t)

  const output = await withTurn({ userText: USER, source: "voice" }, () =>
    saveNoteTool.execute({
      type: "reference",
      title: "Home lab PC options",
      summary: "Considering a Dell OptiPlex, none below three hundred dollars",
      sections: [
        {
          heading: "Home lab PC options",
          body: "I do not expect to find one below three hundred dollars.",
        },
      ],
    })
  )

  const file = onlyFile(h.vault)
  assert.match(file, /below \$300\./, "the body, which is what Obsidian shows")
  assert.match(file, /none below \$300"/, "the summary, in the front matter")
  assert.doesNotMatch(file, /three hundred/i, "no spelled-out copy survives anywhere in the file")

  const text = String(output)
  assert.match(text, /^Saved reference note/m)
  assert.match(text, /Written the way the user said it: "three hundred dollars" as "\$300"\./)
  assert.match(text, /Body on disk: I do not expect to find one below \$300\./)
})

test("an ordinary save reads exactly as it did before", async (t) => {
  harness(t)

  const output = await withTurn({ userText: "write a note that the stt sidecar uses base.en" }, () =>
    saveNoteTool.execute({
      type: "reference",
      title: "STT sidecar model",
      summary: "The STT sidecar uses base.en.",
      sections: [{ heading: "Model", body: "The STT sidecar uses base.en." }],
    })
  )

  assert.doesNotMatch(String(output), /Written the way the user said it/)
})

test("restoring a figure does not let an unsupported one through", async (t) => {
  const h = harness(t)

  const output = await withTurn({ userText: USER }, () =>
    saveNoteTool.execute({
      type: "reference",
      title: "Home lab PC options",
      summary: "A OptiPlex.",
      sections: [
        { heading: "Price", body: "Below three hundred dollars, or maybe nine hundred dollars." },
      ],
    })
  )

  assert.match(String(output), /^Nothing was saved/)
  assert.match(String(output), /nine hundred dollars/)
  assert.deepEqual(fs.readdirSync(h.vault).filter((f) => f.endsWith(".md")), [])
})
