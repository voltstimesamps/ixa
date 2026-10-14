import { test } from "node:test"
import assert from "node:assert/strict"
import { setNotebook } from "../src/memory/notebook"
import { BODY_READBACK_MAX_CHARS, saveNoteTool } from "../src/tools/notes"
import { sanitizeForSpeech } from "../src/voice/sanitize"
import { shortenForSpeech } from "../src/voice/shorten"
import { makeNotebook, withTurn } from "./memory-helpers"

// Reading the written VALUE back, not the title.
//
// The live turn this exists for: asked to note the repo path, STT delivered
// "slash home slash WALLET slash project slash Ixa", the note went to disk
// saying `/home/wallet/project/Ixa`, and Ixa said
//
//   "I saved a reference note titled 'Ixa repo location.'"
//
// — true, obedient to the instruction the result carried, and useless. The
// title and the summary were both "Ixa repo location", identical whether the
// path was right or wrong. The mishearing was in the body, and nothing read
// the body back.

function harness(t: { after: (fn: () => void) => void }) {
  const h = makeNotebook()
  t.after(() => {
    setNotebook(null)
    h.cleanup()
  })
  setNotebook(h.notebook)
  return h
}

const PATH_NOTE = {
  type: "reference",
  title: "Ixa repo location",
  summary: "Ixa repo location",
  sections: [{ heading: "Ixa repo location", body: "The Ixa repo is at /home/wyatt/Projects/ixa." }],
}

async function save(input: Record<string, unknown>, userText = "write that down"): Promise<string> {
  return String(await withTurn({ userText }, () => saveNoteTool.execute(input)))
}

test("the body is quoted back verbatim, and the reply is told to repeat it", async (t) => {
  harness(t)
  const out = await save(PATH_NOTE)

  assert.match(out, /^Body on disk: The Ixa repo is at \/home\/wyatt\/Projects\/ixa\.$/m)
  assert.match(out, /REPEAT THE BODY ABOVE WORD FOR WORD/)
  assert.doesNotMatch(out, /using the title above/, "the old instruction is gone")
})

// The specific failure, reproduced: the misheard value is in the result, so a
// reply built from the result can be heard to be wrong.
test("a misheard value is in the read-back, character for character", async (t) => {
  harness(t)
  const out = await save({
    ...PATH_NOTE,
    sections: [{ heading: "Ixa repo location", body: "The Ixa repo is at /home/wallet/project/Ixa." }],
  })

  assert.match(out, /Body on disk: The Ixa repo is at \/home\/wallet\/project\/Ixa\./)
})

test("several sections read back as one line", async (t) => {
  harness(t)
  const out = await save({
    ...PATH_NOTE,
    sections: [
      { heading: "Where", body: "The repo is at /home/wyatt/Projects/ixa." },
      { heading: "Branch", body: "Work is on tool-loop-fix." },
    ],
  })

  assert.match(
    out,
    /^Body on disk: The repo is at \/home\/wyatt\/Projects\/ixa\. Work is on tool-loop-fix\.$/m
  )
})

test("a long note reads back the summary and says it is long", async (t) => {
  harness(t)
  const body =
    "The backend runs in WSL2 on the gaming PC, with the STT, TTS and wake sidecars spawned by " +
    "the harness, Qdrant and Ollama in Docker, and the desktop client connecting over the LAN " +
    "WebSocket rather than loopback."
  assert.ok(body.length > BODY_READBACK_MAX_CHARS)

  const out = await save({
    type: "reference",
    title: "Where the backend runs",
    summary: "The backend runs in WSL2 on the gaming PC.",
    sections: [{ heading: "Topology", body }],
  })

  assert.doesNotMatch(out, /Body on disk:/, "nothing to recite in a spoken reply")
  assert.match(out, /^Summary on disk: The backend runs in WSL2 on the gaming PC\.$/m)
  assert.match(out, /too long to read back/)
  assert.match(out, /say the note is long/)
})

test("the threshold is on the body alone, not on the whole result", async (t) => {
  harness(t)
  // 120 chars exactly is read back; 121 is not.
  const at = "x".repeat(BODY_READBACK_MAX_CHARS)
  const over = "x".repeat(BODY_READBACK_MAX_CHARS + 1)

  const inside = await save({ ...PATH_NOTE, sections: [{ heading: "H", body: at }] })
  assert.match(inside, new RegExp(`Body on disk: ${at}`))

  const outside = await save({
    ...PATH_NOTE,
    title: "A longer one",
    sections: [{ heading: "H", body: over }],
  })
  assert.doesNotMatch(outside, /Body on disk:/)
})

// The price caveat is appended by CODE and announced on its own line. It is
// not a value the user needs to hear back to check, and including it would
// push a short priced note over the threshold for no gain.
test("the code-appended price caveat is not part of the read-back", async (t) => {
  harness(t)
  const out = await save(
    {
      type: "reference",
      title: "Used 3090 price",
      summary: "What a used 3090 goes for.",
      sections: [{ heading: "Price", body: "A used RTX 3090 is about $600." }],
    },
    "note that a used 3090 is going for like six hundred bucks"
  )

  assert.match(out, /^Body on disk: A used RTX 3090 is about \$600\.$/m)
  assert.doesNotMatch(out, /Body on disk:.*Prices as stated on/)
  assert.match(out, /price caveat was added/, "still announced, separately")
})

// ------------------------------------------------- it survives being spoken
//
// The read-back is worthless if the speech path eats it. Both stages are
// exercised here against the real functions rather than argued about.

test("a read-back reply survives sanitizeForSpeech and the spoken-length backstop", () => {
  for (const reply of [
    "I wrote it down: the Ixa repo is at /home/wyatt/Projects/ixa.",
    "I wrote it down: the Ixa repo is at `/home/wyatt/Projects/ixa`.",
    "Saved as Ixa repo location. It reads: the Ixa repo is at /home/wyatt/Projects/ixa.",
  ]) {
    const spoken = sanitizeForSpeech(reply)
    assert.match(spoken, /\/home\/wyatt\/Projects\/ixa/, `path intact: ${reply}`)

    const short = shortenForSpeech(reply, { maxUnits: 3, maxWords: 40 })
    assert.equal(short.trimmed, false, `inside the budget: ${reply}`)
    assert.match(short.spoken, /\/home\/wyatt\/Projects\/ixa/)
  }
})

// A whole path costs ONE word, which is why a read-back fits a 40-word budget
// at all. Worth pinning: if countWords ever split on slashes, every path
// read-back would blow the budget and be cut.
test("a path is charged to the word budget as one word", () => {
  const counted = shortenForSpeech("The repo is at /home/wyatt/Projects/ixa.", {
    maxUnits: 0,
    maxWords: 0,
  })
  assert.equal(counted.totalWords, 5)
})
