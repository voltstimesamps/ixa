import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { findCurrencyAmounts } from "../src/core/prices"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse, Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// The backstop behind the freshness rule in SYSTEM_PROMPT. Asked "what CPU
// should I get for local AI?" in live testing, the model produced a tiered
// list with a price against each part and never called web_search.

// ------------------------------------------------------------- the detector
//
// Everything in this domain that looks like a number and is not a price is
// what makes this hard: model numbers, memory sizes, resolutions, token
// budgets.

test("a currency amount is found however it is written", () => {
  for (const [text, expected] of [
    ["About $1,360 used.", "$1,360"],
    ["Around £250.50.", "£250.50"],
    ["It is 500 dollars.", "500 dollars"],
    ["Roughly 250 quid.", "250 quid"],
    ["Budget USD 500 for it.", "USD 500"],
    ["Call it €1,200.", "€1,200"],
  ] as const) {
    assert.deepEqual(findCurrencyAmounts(text), [expected], text)
  }
})

test("numbers that are not prices are left alone", () => {
  for (const text of [
    "The RTX 3090 is the pick.",
    "It has 16 GB of VRAM.",
    "Good for 1440p gaming.",
    "A 7B model fits comfortably.",
    "The 4090 and the 5090 are faster.",
    "IXA_CONTEXT_BUDGET_CHARS is 24000.",
    "It draws 320 watts under load.",
    "That is 30 percent faster.",
  ]) {
    assert.deepEqual(findCurrencyAmounts(text), [], text)
  }
})

// What the model actually writes. Live replies contained "$1 200–$1 500" with
// a NARROW NO-BREAK SPACE for thousands; matching only commas pulled "$1" out
// of it and quoted that back as the price the model had stated.
test("thousands separated by a space, narrow or otherwise, is one amount", () => {
  assert.deepEqual(findCurrencyAmounts("Budget $1\u202F200 for it."), ["$1\u202F200"])
  assert.deepEqual(findCurrencyAmounts("Expect $1 200 to $1 500."), ["$1 200", "$1 500"])
  assert.deepEqual(findCurrencyAmounts("Around $4 000 all in."), ["$4 000"])
  // A separator must be followed by exactly three digits, so this does not run on.
  assert.deepEqual(findCurrencyAmounts("It is $5 and change."), ["$5"])
})

test("every figure in a range is reported, without duplicates", () => {
  assert.deepEqual(findCurrencyAmounts("Expect $300-$400, so about $300 used."), ["$300", "$400"])
})

test("an empty reply has no prices in it", () => {
  assert.deepEqual(findCurrencyAmounts(""), [])
})

// ------------------------------------------------- the same price, in words
//
// VOICE_RESPONSE_PROMPT tells the model to write numbers as words in a spoken
// reply, because Kokoro mis-renders digits. Without these the guard would have
// gone quiet on every voice turn: a reply with no digits in it matched none of
// the patterns above, and nothing would have said so.

test("a spelled-out amount is a price too", () => {
  for (const [text, expected] of [
    ["About three hundred fifty dollars.", "three hundred fifty dollars"],
    ["Around one thousand three hundred sixty dollars right now.", "one thousand three hundred sixty dollars"],
    ["Listings are near thirteen hundred sixty dollars.", "thirteen hundred sixty dollars"],
    ["That is fifty cents.", "fifty cents"],
    ["Roughly two hundred fifty quid.", "two hundred fifty quid"],
    ["Say eighty euros.", "eighty euros"],
    // "a" can lead a run, and "and" can sit inside one.
    ["About a thousand dollars all in.", "a thousand dollars"],
    ["Four hundred and twenty dollars.", "Four hundred and twenty dollars"],
    // Hyphens, including the compound-adjective form, which states a price.
    ["Twenty-five dollars, give or take.", "Twenty-five dollars"],
    ["It is a two-hundred-dollar card.", "a two-hundred-dollar"],
  ] as const) {
    assert.deepEqual(findCurrencyAmounts(text), [expected], text)
  }
})

// A vague figure is still a figure stated from memory, so the guard fires. The
// quantifier is absorbed only so the correction quotes back something a person
// would recognise, rather than a bare "hundred dollars".
test("a vague amount is quoted back with its quantifier", () => {
  for (const [text, expected] of [
    ["These setups keep costs under a few hundred dollars.", "a few hundred dollars"],
    ["It runs a couple of hundred dollars.", "a couple of hundred dollars"],
    ["Expect several thousand dollars.", "several thousand dollars"],
    // No number word at all: the quantifier carries it.
    ["It is only a few dollars.", "a few dollars"],
  ] as const) {
    assert.deepEqual(findCurrencyAmounts(text), [expected], text)
  }
})

// Adjacency is what makes the spelled-out net safe: a number word and a
// currency word in the same sentence are not a price unless they are touching.
// A spurious match costs a wasted corrective LLM call.
test("number words in ordinary prose are not prices", () => {
  for (const text of [
    "The dollar is strong this year.",
    "There is a dollar store on the corner.",
    "A thousand times better than the old one.",
    "Nine times out of ten it is bed adhesion.",
    "It has sixteen gigabytes of VRAM.",
    "The RTX thirty ninety is the pick.",
    "That is thirty percent faster.",
    "It draws three hundred twenty watts under load.",
    "Worth millions of dollars to the company.",
    "One of the dollars was counterfeit.",
    "The dollar fell two percent today.",
    "Two pounds of flour and a pinch of salt.",
    "I have one thousand reasons not to.",
    "Pick one: dollars or euros.",
    "It takes about fifteen seconds to say out loud.",
    // Hyphenated compounds that bridge a number word into a noun which is not
    // a currency. The hyphen is permitted before a currency word, so these are
    // the shape most likely to be caught by mistake.
    "A sixteen-gigabyte card is enough.",
    "Use a three-hundred-twenty-watt supply.",
    "That is a two-pound loaf.",
    "It gives thirty-ninety-class performance.",
    "A sixty-four-bit build runs fine.",
    "Try the twelve-hour format instead.",
  ]) {
    assert.deepEqual(findCurrencyAmounts(text), [], text)
  }
})

// Both forms at once: a voice turn writes words, a text turn writes digits, and
// one build has to detect either.
test("digit and spelled-out amounts are found in the same reply", () => {
  assert.deepEqual(findCurrencyAmounts("It was $350, so about three hundred fifty dollars."), [
    "$350",
    "three hundred fifty dollars",
  ])
})

// --------------------------------------------------------------- the guard

function scripted(replies: LLMResponse[]): { chat: ChatFn; sent: Message[][] } {
  const sent: Message[][] = []
  const chat: ChatFn = async (messages) => {
    sent.push(messages)
    const next = replies.shift()
    if (!next) throw new Error("ran out of scripted replies")
    return next
  }
  return { chat, sent }
}

const text = (content: string): LLMResponse => ({ type: "text", content })

test("a priced reply with no search is retried, and the corrected one is delivered", async () => {
  const { chat, sent } = scripted([
    text("The 3060 is about $250 used and the 4070 runs $500."),
    text("The 3060 or the 4070. I would have to look up what they cost now."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU should I get?", makeConnection({ id: "p1" }), "text")

  assert.equal(reply, "The 3060 or the 4070. I would have to look up what they cost now.")
  assert.equal(sent.length, 2, "exactly one retry")

  // The correction reached the model, and named the figures.
  const correction = String(sent[1]!.at(-1)!.content)
  assert.match(correction, /did not search the web/)
  assert.match(correction, /\$250/)
  assert.match(correction, /\$500/)

  // Neither the correction nor the rejected draft is in stored history.
  const history = sessions.primarySession().history()
  const contents = history.map((message) => String(message.content ?? ""))
  assert.ok(!contents.some((c) => c.includes("$250")), "the rejected draft was not recorded")
  assert.ok(!contents.some((c) => c.includes("did not search the web")), "the correction was not recorded")
  assert.equal(contents.at(-1), "The 3060 or the 4070. I would have to look up what they cost now.")

  sessions.shutdown()
})

test("a reply with no prices is delivered untouched", async () => {
  const { chat, sent } = scripted([text("The 3060 is the safe pick for a budget build.")])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU?", makeConnection({ id: "p2" }), "text")

  assert.equal(reply, "The 3060 is the safe pick for a budget build.")
  assert.equal(sent.length, 1, "no retry")

  sessions.shutdown()
})

test("the guard retries once and then delivers, rather than looping", async () => {
  const { chat, sent } = scripted([
    text("About $250 used."),
    text("Still about $250 used."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("how much?", makeConnection({ id: "p3" }), "text")

  assert.equal(reply, "Still about $250 used.", "the second draft is delivered as-is")
  assert.equal(sent.length, 2, "two calls, not a loop")
  assert.equal(String(sessions.primarySession().history().at(-1)!.content), "Still about $250 used.")

  sessions.shutdown()
})

// Registered for the whole file, not per test. The registry has no
// unregister, and it does not need one: node's test runner gives each file its
// own process, and the scripted chat below decides what is called, so a tool
// sitting in the registry unused costs nothing.
let searched = 0
registry.register({
  name: "web_search",
  description: "test search",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  execute: async () => {
    searched++
    return "RTX 3060 used: $250"
  },
})

test("a price is fine once web_search has run in this turn", async () => {
  searched = 0
  const { chat, sent } = scripted([
    { type: "tool_calls", calls: [{ id: "c1", name: "web_search", arguments: "{}" }] },
    text("The 3060 goes for about $250 used right now."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("how much is a 3060?", makeConnection({ id: "p4" }), "text")

  assert.equal(searched, 1)
  assert.equal(reply, "The 3060 goes for about $250 used right now.")
  assert.equal(sent.length, 2, "no corrective call")
  assert.ok(
    !sent.some((messages) => /did not search the web/.test(String(messages.at(-1)!.content))),
    "the guard never fired"
  )

  sessions.shutdown()
})

test("the guard applies to a voice turn too", async () => {
  const { chat, sent } = scripted([
    text("The 3060 is about $250 used."),
    text("The 3060 is the pick. I would need to check the price."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU?", makeConnection({ id: "p5" }), "voice")

  assert.equal(reply, "The 3060 is the pick. I would need to check the price.")
  assert.equal(sent.length, 2)

  // The voice constraint is still present on the corrective call, and the
  // correction comes after it.
  const roles = sent[1]!.map((message) => String(message.content ?? ""))
  assert.ok(roles.some((c) => /SPOKEN ALOUD/i.test(c)), "the voice constraint survived the retry")
  assert.match(String(sent[1]!.at(-1)!.content), /did not search the web/)

  sessions.shutdown()
})

// The corrective call is not a side call: it re-enters the normal tool loop,
// so a search it provokes is a real web_search with a real recorded result.
// Anything else would let the model claim it had searched when it had not,
// which is the failure SYSTEM_PROMPT's honesty rule exists to prevent.
test("a search triggered by the correction is a real, recorded web_search", async () => {
  searched = 0
  const { chat, sent } = scripted([
    text("The 3060 is about $250 and the 4070 about $500."),
    { type: "tool_calls", calls: [{ id: "c1", name: "web_search", arguments: '{"query":"rtx 3060 price"}' }] },
    text("The 3060 is around $250 used, going by what I just looked up."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU should I get?", makeConnection({ id: "p6" }), "text")

  assert.equal(searched, 1, "the tool actually ran")
  assert.equal(reply, "The 3060 is around $250 used, going by what I just looked up.")
  assert.equal(sent.length, 3, "draft, correction, then the reply after the search")

  const history = sessions.primarySession().history()
  // The call and its result are both in history, as a matched pair.
  const call = history.find(
    (message) =>
      message.role === "assistant" &&
      "tool_calls" in message &&
      message.tool_calls?.some((entry) => entry.function.name === "web_search")
  )
  assert.ok(call, "the web_search call was recorded")
  const result = history.find((message) => message.role === "tool")
  assert.ok(result, "its result was recorded")
  assert.match(String(result!.content), /\$250/)

  // The price in the delivered reply survived, because a search did happen.
  assert.match(String(history.at(-1)!.content), /\$250/)

  sessions.shutdown()
})

// Order matters: the guard runs first, so the backstop must shorten the reply
// that is actually delivered. Trimming the discarded draft would waste the
// work and leave the delivered one unbounded.
test("the voice backstop applies to the final reply, not the discarded one", async () => {
  const priced = "The 3060 is about $250 used. The 4070 is about $500. The 4090 is about $1,600."
  // Deliberately over the 40-word budget — 4 sentences, about 60 words — so the
  // backstop has something to do on the reply that is actually delivered.
  const final =
    "The 3060 is the safe pick at that budget and has plenty of memory. " +
    "The 6700 XT gives you rather more memory again for not very much extra money. " +
    "The 4070 is faster still but costs a good deal more than you wanted to spend. " +
    "The 4090 is far beyond the budget you gave me and I would leave it alone."
  const { chat } = scripted([text(priced), text(final)])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const spoken = await sessions.submitTurn("what GPU?", makeConnection({ id: "p7" }), "voice")

  // The delivered reply was shortened...
  assert.ok(spoken.length < final.length, "the final reply was shortened")
  assert.ok(!spoken.includes("4070"), "the third sentence was dropped from the FINAL reply")
  // ...and nothing from the discarded draft is in it or in history.
  assert.ok(!spoken.includes("$250"), "the discarded draft was not spoken")

  const recorded = String(sessions.primarySession().history().at(-1)!.content)
  assert.match(recorded, /\[reply shortened for speech: spoke \d+ of \d+ sentences\]$/)
  assert.ok(!recorded.includes("$250"), "the discarded draft was not recorded")

  sessions.shutdown()
})

// ------------------------------------- forcing the search, not asking for it
//
// Asking for the search in the correction worked about half the time: the
// other half the model wrote the reply again and restated the same prices from
// memory, which is the exact failure the guard exists to stop. So the
// corrective call REQUIRES web_search through tool_choice instead.
//
// Measured against api.groq.com with openai/gpt-oss-20b:
// - A forced tool is honoured, streaming and not, on a turn that has not
//   searched: finish_reason=tool_calls, no content, the named function called.
// - A forced tool the model will not call is a 400, not a reply:
//   "Tool choice is required, but model did not call a tool". That is why
//   there is a fallback below rather than a bare force.

// A chat stand-in that records the options each call was made with, so a test
// can assert on tool_choice rather than on the reply it produced.
function scriptedWithOptions(replies: (LLMResponse | Error)[]): {
  chat: ChatFn
  forced: (string | undefined)[]
} {
  const forced: (string | undefined)[] = []
  const chat: ChatFn = async (_messages, _tools, options) => {
    forced.push(options?.forceTool)
    const next = replies.shift()
    if (!next) throw new Error("ran out of scripted replies")
    if (next instanceof Error) throw next
    return next
  }
  return { chat, forced }
}

test("the corrective call requires web_search, and only that call does", async () => {
  const { chat, forced } = scriptedWithOptions([
    text("The 3060 is about $250 used."),
    { type: "tool_calls", calls: [{ id: "c1", name: "web_search", arguments: '{"query":"rtx 3060 price"}' }] },
    text("Listings have it at about $250 used."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU?", makeConnection({ id: "pf1" }), "text")

  assert.deepEqual(
    forced,
    [undefined, "web_search", undefined],
    "the first call is free to answer; the correction is not, and the call after it is free again",
  )
  // The forced search ran, so the price in the delivered reply is a searched one.
  assert.equal(reply, "Listings have it at about $250 used.")

  sessions.shutdown()
})

test("a model that refuses the forced search is asked again unforced", async () => {
  // Groq's 400 for a forced tool_choice the model declines to honour.
  const refusal = new Error("400 Tool choice is required, but model did not call a tool")
  const { chat, forced } = scriptedWithOptions([
    text("The 3060 is about $250 used."),
    refusal,
    text("The 3060 or the 4070. I would have to look up what they cost now."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU?", makeConnection({ id: "pf2" }), "text")

  assert.deepEqual(forced, [undefined, "web_search", undefined], "forced once, then not")
  assert.equal(
    reply,
    "The 3060 or the 4070. I would have to look up what they cost now.",
    "a refused force must not fail a turn the user is waiting on",
  )

  sessions.shutdown()
})

test("a refused force still spends the guard's one retry", async () => {
  const refusal = new Error("400 Tool choice is required, but model did not call a tool")
  const { chat, forced } = scriptedWithOptions([
    text("The 3060 is about $250 used."),
    refusal,
    // Still priced, and still no search. The guard is used up, so this is
    // delivered rather than argued with a third time.
    text("The 3060 is about $250 used."),
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn("what GPU?", makeConnection({ id: "pf3" }), "text")

  assert.equal(reply, "The 3060 is about $250 used.", "delivered rather than looped on")
  assert.equal(forced.length, 3, "no second correction")

  sessions.shutdown()
})

test("a turn with no price in it never forces a tool", async () => {
  const { chat, forced } = scriptedWithOptions([text("The 3060 is the safe pick.")])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  await sessions.submitTurn("what GPU?", makeConnection({ id: "pf4" }), "text")

  assert.deepEqual(forced, [undefined])

  sessions.shutdown()
})
