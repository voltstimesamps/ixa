import { test } from "node:test"
import assert from "node:assert/strict"
import { captureLogs } from "./memory-helpers"
import { isArgumentRejection, withArgumentRetry, LLMDeadlineError } from "../src/core/llm"

// ONE RETRY, FOR THE MODEL'S OUTPUT ONLY.
//
// Two measured failures killed a turn outright because the provider rejected
// the tool call the model had produced — a 400 on arguments that did not fit
// the schema, and malformed JSON in the tool call. No tool call reaches the
// harness in either case, so nothing in the turn can correct it; the user gets
// an apology and has to ask again.
//
// This is a different category from the SDK's retries, which cover requests
// that were never answered (429, 5xx, a dropped connection) and are left
// entirely alone. Here the request was fine and the sampled tokens were not,
// so the same call is issued once more for another sample.

// Shaped like what the SDK throws: an Error carrying an HTTP status.
function rejection(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status })
}

const SCHEMA_ERROR =
  "Tool call validation failed: tool call validation failed: parameters for tool " +
  "search_memory did not match schema: errors: [`/from`: expected string, but got null, " +
  "`/query`: expected string, but got null, `/to`: expected string, but got null]"

const JSON_ERROR = "Failed to parse tool call arguments as JSON"

test("a rejected tool call is re-issued once and the second sample is used", async () => {
  for (const message of [SCHEMA_ERROR, JSON_ERROR]) {
    let attempts = 0
    const { result, logs } = await captureLogs(() =>
      withArgumentRetry(async () => {
        attempts++
        if (attempts === 1) throw rejection(message)
        return "the answer"
      })
    )

    assert.equal(result, "the answer", `recovered from: ${message.slice(0, 40)}…`)
    assert.equal(attempts, 2)
    assert.equal(logs.filter((line) => line.includes("retrying once")).length, 1, "one line, once")
  }
})

test("it gives up after one retry rather than looping on 400s", async () => {
  let attempts = 0
  await captureLogs(async () => {
    await assert.rejects(
      () =>
        withArgumentRetry(async () => {
          attempts++
          throw rejection(SCHEMA_ERROR)
        }),
      /did not match schema/,
      "the second rejection is the caller's problem, not a third attempt"
    )
  })

  assert.equal(attempts, 2, "the original plus exactly one retry")
})

test("transport and deadline failures are not re-sampled", async () => {
  const notOurs: Array<[string, unknown]> = [
    ["a dropped connection", new TypeError("fetch failed")],
    ["a refused connection", new Error("connect ECONNREFUSED 127.0.0.1:443")],
    // The SDK owns these, with retry-after and backoff. Re-sampling here would
    // be a second retry policy on top of one that already works.
    ["a rate limit", rejection("Rate limit reached for model", 429)],
    ["a server error", rejection("internal server error", 500)],
    // Ours, handled elsewhere: the session retries this one WITHOUT tools.
    ["a raw-text tool call", new Error("malformed tool call in text content")],
    ["one of our deadlines", new LLMDeadlineError("call exceeded 30000ms")],
    // The same words, from a status that says the request itself was wrong.
    ["a 404 that happens to mention a schema", rejection("did not match schema", 404)],
  ]

  for (const [what, err] of notOurs) {
    let attempts = 0
    await assert.rejects(
      () =>
        withArgumentRetry(async () => {
          attempts++
          throw err
        })
    )
    assert.equal(attempts, 1, `${what} must not be retried here`)
    assert.equal(isArgumentRejection(err), false, what)
  }
})

test("a rejection with no status at all is still re-sampled", async () => {
  // Mid-stream rejections do not always arrive as an APIError with a status,
  // and the message is the reliable part.
  assert.equal(isArgumentRejection(new Error(JSON_ERROR)), true)
  assert.equal(isArgumentRejection("not even an error"), false)
})

test("nothing is retried when nothing failed", async () => {
  let attempts = 0
  const { logs } = await captureLogs(async () => {
    const result = await withArgumentRetry(async () => {
      attempts++
      return "fine"
    })
    assert.equal(result, "fine")
  })

  assert.equal(attempts, 1)
  assert.deepEqual(logs, [], "a successful call says nothing")
})
