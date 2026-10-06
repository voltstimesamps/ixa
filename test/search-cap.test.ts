import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionManager } from "../src/core/session-manager"
import { registry } from "../src/tools/registry"
import { config } from "../src/config"
import type { ChatFn } from "../src/core/session"
import type { LLMResponse, Message } from "../src/core/llm"
import { makeConnection, TEST_LIMITS } from "./helpers"

// Nothing bounded the number of searches in a turn. The tool loop caps
// ITERATIONS at 10 and one iteration may carry any number of parallel calls,
// so a live price question fired EIGHT web_search calls with several queries
// repeated verbatim. At ~5300 chars per Tavily result that is ~42k of tool
// output, and the context budget starts evicting the turn that gathered it:
// measured, from the second round of searching on, the model can see only the
// two most recent results and no longer the question — so it searches again
// for what it can no longer see.

const LIMIT = config.tools.maxSearchesPerTurn

let searchesRun = 0
registry.register({
  name: "web_search",
  description: "Search the web.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  requiresConfirmation: false,
  execute: async (input) => {
    searchesRun++
    return `results for ${JSON.stringify(input)}`
  },
})

function parallelSearches(n: number, round = 0): LLMResponse {
  return {
    type: "tool_calls",
    calls: Array.from({ length: n }, (_, i) => ({
      id: `r${round}c${i}`,
      name: "web_search",
      arguments: JSON.stringify({ query: `used rtx 3090 price` }),
    })),
  }
}

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

// ------------------------------------------------------ the cap itself

test("the cap is three by default", () => {
  assert.equal(LIMIT, 3)
})

test("searches up to the cap all run", async () => {
  searchesRun = 0
  const { chat } = scripted([
    parallelSearches(LIMIT),
    { type: "text", content: "About eight hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  await sessions.submitTurn("how much is a used 3090", makeConnection({ id: "sc1" }), "text")

  assert.equal(searchesRun, LIMIT, "nothing under the cap is held back")

  sessions.shutdown()
})

test("a runaway parallel group is cut off at the cap", async () => {
  searchesRun = 0
  const { chat } = scripted([
    // The live shape: one iteration asking for eight at once.
    parallelSearches(8),
    { type: "text", content: "About eight hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  await sessions.submitTurn("how much is a used 3090", makeConnection({ id: "sc2" }), "text")

  assert.equal(searchesRun, LIMIT, `only ${LIMIT} of the eight actually ran`)

  // Every call in the group still has a result: an assistant tool_calls
  // message with a missing result is rejected outright by the API.
  const history = sessions.primarySession().history()
  const group = history.filter((m) => m.role === "tool")
  assert.equal(group.length, 8, "all eight calls were answered, run or not")

  sessions.shutdown()
})

test("searches accumulate across iterations, not just within one", async () => {
  searchesRun = 0
  const { chat } = scripted([
    parallelSearches(2, 0),
    parallelSearches(2, 1),
    { type: "text", content: "About eight hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  await sessions.submitTurn("how much is a used 3090", makeConnection({ id: "sc3" }), "text")

  assert.equal(searchesRun, LIMIT, "the fourth was capped even though it was a fresh iteration")

  sessions.shutdown()
})

test("the cap is per turn, so the next turn searches again", async () => {
  searchesRun = 0
  const { chat } = scripted([
    parallelSearches(LIMIT, 0),
    { type: "text", content: "About eight hundred dollars used." },
    parallelSearches(LIMIT, 1),
    { type: "text", content: "About seven hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })
  const connection = makeConnection({ id: "sc4" })

  await sessions.submitTurn("how much is a used 3090", connection, "text")
  await sessions.submitTurn("and a 3080?", connection, "text")

  assert.equal(searchesRun, LIMIT * 2, "a new turn gets a new allowance")

  sessions.shutdown()
})

// -------------------------------------- WHAT THE MODEL IS TOLD at the cap
//
// The whole risk of a cap is that the model reads it as a broken search and
// retries — which is the behaviour the cap exists to stop. So the result has
// to say that the search did not run, that this is a limit and not a fault,
// and what to do instead.

test("a capped call is told it is a limit, not a failure", async () => {
  searchesRun = 0
  const { chat } = scripted([
    parallelSearches(LIMIT + 1),
    { type: "text", content: "About eight hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  await sessions.submitTurn("how much is a used 3090", makeConnection({ id: "sc5" }), "text")

  const results = sessions
    .primarySession()
    .history()
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content))
  const capped = results.at(-1)!

  assert.equal(results.length, LIMIT + 1)
  assert.match(capped, /NOT run/, "it says plainly that the search did not happen")
  assert.match(capped, /nothing failed/, "and that this is not an outage")
  assert.match(capped, /working/, "and that the tool itself is fine")
  assert.match(capped, /do not try again/i, "and not to retry")
  assert.match(capped, /already have/, "and to use the results it does have")
  assert.match(capped, new RegExp(`all ${LIMIT} web_search calls`), "and names the limit")

  // It must not read like the error shape every other failure uses, or the
  // model will treat it as one. ("nothing failed" is a denial of failure, so
  // the check is for a failure CLAIM, not for the word.)
  assert.ok(!capped.includes('"error"'), "not dressed up as an error result")
  assert.ok(
    !/search failed|unavailable|timed out|try again later/i.test(capped),
    "nothing in it reads as an outage the model should wait out",
  )

  sessions.shutdown()
})

// The cap sits in front of the price guard, so the two must not fight: a turn
// that searched and then hit the cap has still searched, and its price goes
// through without a correction. (A capped call leaves `ran` false and so
// cannot license a price by itself — but with a positive cap it is only ever
// reachable after real searches have run, which is the case covered here.)
test("hitting the cap does not make the price guard reject the answer", async () => {
  searchesRun = 0
  const { chat } = scripted([
    parallelSearches(LIMIT + 2),
    { type: "text", content: "About eight hundred dollars used." },
  ])
  const sessions = new SessionManager({ idleTimeoutMs: 60_000, limits: TEST_LIMITS, chat })

  const reply = await sessions.submitTurn(
    "how much is a used 3090",
    makeConnection({ id: "sc6" }),
    "text",
  )

  // Real searches ran, so the price is allowed through without a correction.
  assert.equal(reply, "About eight hundred dollars used.")
  assert.equal(searchesRun, LIMIT)

  sessions.shutdown()
})
