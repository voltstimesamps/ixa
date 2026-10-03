import { test } from "node:test"
import assert from "node:assert/strict"
import { LATEST_SCHEMA_VERSION, openDatabase, schemaVersion } from "../src/memory/db"
import { PreferenceStore } from "../src/memory/preferences"

const LIMITS = { maxInjected: 40, maxChars: 2000 }

function makeStore(limits = LIMITS): PreferenceStore {
  return new PreferenceStore(openDatabase(":memory:"), limits)
}

test("a fresh database is migrated to the current schema", () => {
  const db = openDatabase(":memory:")
  assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION)

  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
  ).map((row) => row.name)
  assert.ok(tables.includes("preferences"))
  assert.ok(tables.includes("sessions"))
  assert.ok(tables.includes("schema_version"))
  assert.ok(tables.includes("episodes"))
})

test("an update supersedes the old row instead of overwriting it", () => {
  const store = makeStore()

  const first = store.remember({ topic: "coffee", value: "oat milk, no sugar", category: "food" })
  assert.equal(first.superseded, null, "the first save supersedes nothing")

  const second = store.remember({ topic: "coffee", value: "black, no milk" })

  assert.notEqual(second.preference.id, first.preference.id, "a new row was inserted")
  assert.equal(second.superseded!.id, first.preference.id)
  assert.notEqual(second.superseded!.supersededAt, null, "the old row is stamped superseded")
  assert.equal(second.superseded!.supersededBy, second.preference.id, "and points at its replacement")
  assert.equal(second.superseded!.value, "oat milk, no sugar", "the old value is still readable")

  const active = store.listActive()
  assert.equal(active.length, 1, "only the new row is active")
  assert.equal(active[0]!.value, "black, no milk")
  assert.equal(active[0]!.category, "food", "an update with no category keeps the old one")
})

// Requested explicitly: the model may echo a topic back with different casing.
test("an update with the same topic in different case supersedes correctly", () => {
  const store = makeStore()

  const first = store.remember({ topic: "coffee", value: "oat milk" })
  const second = store.remember({ topic: "COFFEE", value: "black" })
  const third = store.remember({ topic: "Coffee", value: "flat white" })

  assert.equal(second.superseded!.id, first.preference.id, "COFFEE superseded coffee")
  assert.equal(third.superseded!.id, second.preference.id, "Coffee superseded COFFEE")

  const active = store.listActive()
  assert.equal(active.length, 1, "case variants are one preference, not three")
  assert.equal(active[0]!.value, "flat white")
  assert.equal(active[0]!.topic, "Coffee", "the most recent spelling is kept")

  const rows = store["db"].prepare("SELECT COUNT(*) AS n FROM preferences").get() as { n: number }
  assert.equal(rows.n, 3, "every version is still on disk")
})

test("forgetting is a soft delete and hides the preference everywhere", () => {
  const store = makeStore()
  store.remember({ topic: "coffee", value: "black" })
  store.remember({ topic: "tea", value: "green, no sugar" })

  const removed = store.forget("COFFEE")
  assert.ok(removed, "forget matches the topic case-insensitively")
  assert.notEqual(removed!.removedAt, null, "the row is stamped removed")

  assert.deepEqual(
    store.listActive().map((p) => p.topic),
    ["tea"],
    "a removed preference is not active",
  )
  assert.equal(store.activeByTopic("coffee"), null)
  assert.match(store.buildInjection().text!, /tea/)
  assert.doesNotMatch(store.buildInjection().text!, /coffee/i, "and is never injected")

  const row = store["db"].prepare("SELECT value FROM preferences WHERE id = ?").get(removed!.id) as {
    value: string
  }
  assert.equal(row.value, "black", "the row itself survives for history")
})

test("forgetting an unknown topic is a no-op, not an error", () => {
  const store = makeStore()
  assert.equal(store.forget("nothing saved under this"), null)
})

test("a forgotten preference can be saved again", () => {
  const store = makeStore()
  store.remember({ topic: "coffee", value: "black" })
  store.forget("coffee")

  const again = store.remember({ topic: "coffee", value: "oat milk" })
  assert.equal(again.superseded, null, "the removed row is not treated as the current one")
  assert.deepEqual(
    store.listActive().map((p) => p.value),
    ["oat milk"],
  )
})

test("active preferences can be listed by category", () => {
  const store = makeStore()
  store.remember({ topic: "coffee", value: "black", category: "food" })
  store.remember({ topic: "wake time", value: "6am on weekdays", category: "schedule" })
  store.remember({ topic: "units", value: "metric", category: "General" })

  assert.equal(store.listActive("food").length, 1)
  assert.equal(store.listActive("FOOD").length, 1, "the filter is case-insensitive")
  assert.equal(store.listActive("general").length, 1, "categories are stored lowercased")
  assert.equal(store.listActive("nonexistent").length, 0)
  assert.equal(store.listActive().length, 3)
})

test("the injected block is capped by row count, keeping the newest", () => {
  const store = makeStore({ maxInjected: 3, maxChars: 100_000 })
  for (let i = 0; i < 10; i++) {
    store.remember({ topic: `topic ${i}`, value: `value ${i}` })
  }

  const result = store.buildInjection()
  assert.equal(result.total, 10)
  assert.equal(result.included, 3)
  assert.equal(result.truncated, true)

  const lines = result.text!.split("\n").slice(1)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((line) => line.replace(/^- \[general\] /, "").split(":")[0]),
    ["topic 7", "topic 8", "topic 9"],
    "the newest three, rendered oldest-first",
  )
})

test("the injected block is capped by characters", () => {
  const store = makeStore({ maxInjected: 1000, maxChars: 260 })
  for (let i = 0; i < 20; i++) {
    store.remember({ topic: `topic ${i}`, value: "x".repeat(40) })
  }

  const result = store.buildInjection()
  assert.equal(result.truncated, true)
  assert.ok(result.included > 0 && result.included < 20)
  assert.ok(result.text!.length <= 260, `block is ${result.text!.length} chars, cap is 260`)
})

test("an uncapped block reports no truncation and holds every preference", () => {
  const store = makeStore()
  store.remember({ topic: "coffee", value: "black", category: "food" })
  store.remember({ topic: "units", value: "metric" })

  const result = store.buildInjection()
  assert.equal(result.truncated, false)
  assert.equal(result.included, 2)
  assert.equal(result.total, 2)
  assert.match(result.text!, /- \[food\] coffee: black/)
  assert.match(result.text!, /- \[general\] units: metric/)
})

test("an empty store injects nothing at all", () => {
  const store = makeStore()
  const result = store.buildInjection()
  assert.equal(result.text, null)
  assert.equal(result.included, 0)
  assert.equal(store.injectionBlock(), null)
})

test("truncation warns once, not on every call", () => {
  const store = makeStore({ maxInjected: 1, maxChars: 100_000 })
  store.remember({ topic: "a", value: "one" })
  store.remember({ topic: "b", value: "two" })

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "))
  }
  try {
    store.injectionBlock()
    store.injectionBlock()
    store.injectionBlock()
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 1, "the same truncation is not logged repeatedly")
  assert.match(warnings[0]!, /injected 1 of 2 active/)
  assert.match(warnings[0]!, /1 omitted/)
})

test("a preference needs both a topic and a value", () => {
  const store = makeStore()
  assert.throws(() => store.remember({ topic: "   ", value: "black" }), /topic/)
  assert.throws(() => store.remember({ topic: "coffee", value: "  " }), /value/)
})

test("multi-line values are flattened so one preference stays one line", () => {
  const store = makeStore()
  store.remember({ topic: "signature", value: "Cheers,\n\n  Wyatt" })

  const lines = store.buildInjection().text!.split("\n")
  assert.equal(lines.length, 2, "header plus exactly one preference line")
  assert.match(lines[1]!, /signature: Cheers, Wyatt/)
})
