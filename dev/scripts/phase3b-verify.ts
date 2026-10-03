// Phase 3b acceptance run. Requires a backend already started with
// `VOICE_MODE=true npm run dev`, pointed at the same IXA_DB_PATH as this
// script (the runs below use data/phase3b-verify.db).
//
//   npx tsx dev/scripts/phase3b-verify.ts prefs    # a-d + f (remember/apply/update/forget/reset)
//   npx tsx dev/scripts/phase3b-verify.ts fact     # e, part 1: state a fact, then restart the backend
//   npx tsx dev/scripts/phase3b-verify.ts recall   # e, part 2: ask for it after the restart
//   npx tsx dev/scripts/phase3b-verify.ts recall-expired   # e, variant: short idle timeout, expect a fresh session
//   npx tsx dev/scripts/phase3b-verify.ts window   # g: tiny context budget, preference still applies
import { WebSocket } from "ws"
import Database from "better-sqlite3"
import { config } from "../../src/config"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"
const REST_URL = process.env.IXA_REST_URL ?? "http://localhost:3000"

let failures = 0

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

interface PreferenceRow {
  id: number
  topic: string
  value: string
  category: string
  source: string
  created_at: number
  superseded_at: number | null
  superseded_by: number | null
  removed_at: number | null
}

function rows(): PreferenceRow[] {
  const db = new Database(config.data.dbPath, { readonly: true })
  try {
    return db.prepare("SELECT * FROM preferences ORDER BY id").all() as PreferenceRow[]
  } finally {
    db.close()
  }
}

function activeRows(): PreferenceRow[] {
  return rows().filter((r) => r.superseded_at === null && r.removed_at === null)
}

function printRows(): void {
  for (const r of rows()) {
    const state =
      r.removed_at !== null ? "removed" : r.superseded_at !== null ? `superseded by ${r.superseded_by}` : "ACTIVE"
    console.log(`    #${r.id} [${r.category}] ${r.topic}: ${r.value}  (${r.source}, ${state})`)
  }
}

interface Client {
  ask(text: string): Promise<string>
  close(): Promise<void>
}

async function connect(label: string): Promise<Client> {
  const ws = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })

  const replyWaiters: Array<(value: string) => void> = []
  const errorWaiters: Array<(err: Error) => void> = []

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const msg = JSON.parse(data.toString())
    if (msg.type === "assistant") replyWaiters.shift()?.(msg.content ?? "")
    if (msg.type === "error") errorWaiters.shift()?.(new Error(msg.content))
  })

  return {
    ask(text) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`[${label}] timed out`)), 120_000)
        replyWaiters.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
        errorWaiters.push((err) => {
          clearTimeout(timer)
          reject(err)
        })
        ws.send(JSON.stringify({ type: "user", content: text }))
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        ws.once("close", () => resolve())
        ws.close()
      })
    },
  }
}

async function say(client: Client, text: string): Promise<string> {
  console.log(`  > ${text}`)
  const reply = await client.ask(text)
  console.log(`  < ${reply}`)
  // The model writes "oat-milk" and "thirty-seven" with typographic dashes
  // (U+2010..U+2015, U+2212). Normalise them so assertions match what a reader
  // sees rather than the exact code point.
  return reply.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019]/g, "'")
}

// a-d plus f.
async function prefsRun(): Promise<void> {
  const client = await connect("prefs")

  console.log("\n(a) REMEMBER")
  await say(client, "I take my coffee black with no sugar. Please remember that.")
  let active = activeRows()
  printRows()
  check("one active preference stored", active.length === 1, `${active.length} active`)
  check(
    "it is about coffee, black and unsweetened",
    active.length === 1 && /coffee/i.test(active[0]!.topic + active[0]!.value) && /black/i.test(active[0]!.value),
    active[0] ? `${active[0].topic}: ${active[0].value}` : "nothing stored",
  )
  check("source is 'stated'", active[0]?.source === "stated")
  const firstId = active[0]?.id

  console.log("\n(b) APPLIED without being reminded")
  const applied = await say(client, "I'm at a cafe. What should I order?")
  check("the answer reflects the saved preference", /black|americano|espresso/i.test(applied), "looked for black/americano/espresso")

  console.log("\n(c) UPDATE")
  await say(client, "Actually I've switched — I drink oat milk lattes now. Remember that instead.")
  const all = rows()
  printRows()
  active = activeRows()
  const old = all.find((r) => r.id === firstId)
  check("the old row still exists", !!old)
  check("the old row is superseded, not deleted", old?.superseded_at !== null && old?.removed_at === null)
  check("it points at its replacement", typeof old?.superseded_by === "number")
  check("exactly one active preference remains", active.length === 1, `${active.length} active`)
  check(
    "the active one is the new value",
    active.length === 1 && /oat/i.test(active[0]!.value),
    active[0]?.value,
  )
  const afterUpdate = await say(client, "Remind me how I take my coffee these days?")
  check("answers with the new value", /oat/i.test(afterUpdate))

  console.log("\n(f) PREFERENCES SURVIVE A SESSION RESET")
  const reset = await fetch(`${REST_URL}/reset`, { method: "POST" })
  const resetBody = (await reset.json()) as { ok: boolean; sessionId: string }
  console.log(`  POST /reset -> new session ${resetBody.sessionId}`)
  const afterReset = await say(client, "How do I take my coffee?")
  check("the preference still applies after a reset", /oat/i.test(afterReset))
  check("the preference row is untouched by the reset", activeRows().length === 1)

  console.log("\n(d) FORGET")
  await say(client, "Forget what you know about how I take my coffee.")
  printRows()
  const removed = rows().filter((r) => r.removed_at !== null)
  check("a row is marked removed", removed.length === 1)
  check("no active preferences remain", activeRows().length === 0, `${activeRows().length} active`)
  // Two rows: the superseded original and the now-removed replacement.
  check("nothing was hard deleted", rows().length === 2, `${rows().length} rows total`)
  const listed = await say(client, "What preferences do you have saved for me?")
  check("it reports nothing saved", !/oat|black/i.test(listed))

  await client.close()
}

async function factRun(): Promise<void> {
  const client = await connect("fact")
  console.log("\n(e) part 1: state a fact, then restart the backend")
  await say(client, "My lucky number is thirty-seven. Just hold on to that for now.")
  await client.close()

  // "Hold on to that" can read as an explicit ask to remember, and the model
  // may save it as a preference. Preferences are injected on every call, so
  // leaving one here would let the recall below pass without the session ever
  // being restored. Hard-delete it: after this, only restored history can
  // produce the answer.
  const saved = activeRows().filter((r) => /lucky|37|thirty/i.test(`${r.topic} ${r.value}`))
  if (saved.length > 0) {
    const db = new Database(config.data.dbPath)
    try {
      for (const row of saved) {
        db.prepare("DELETE FROM preferences WHERE id = ?").run(row.id)
        console.log(`  (removed preference #${row.id} "${row.topic}" so the recall test only tests the session)`)
      }
    } finally {
      db.close()
    }
  }
}

async function recallRun(expectRecall: boolean): Promise<void> {
  const client = await connect("recall")
  console.log(`\n(e) part 2: ask after the restart (expecting ${expectRecall ? "recall" : "a fresh session"})`)
  const reply = await say(client, "What's my lucky number?")
  const recalled = /37|thirty[- ]seven/i.test(reply)
  if (expectRecall) {
    check("the fact survived the restart", recalled, recalled ? "" : "the session was not restored")
  } else {
    check("the expired session did not come back", !recalled, recalled ? "stale context was restored" : "")
  }
  await client.close()
}

async function windowRun(): Promise<void> {
  const client = await connect("window")
  console.log("\n(g) TINY CONTEXT BUDGET")
  await say(client, "I take my coffee black with no sugar. Please remember that.")
  check("preference stored", activeRows().length === 1)

  // Bury the statement under enough turns that the budget cannot reach it.
  for (let i = 1; i <= 4; i++) {
    await say(client, `Filler turn ${i}: name one colour and nothing else.`)
  }

  const reply = await say(client, "How do I take my coffee?")
  check("the preference still applies with history clipped away", /black/i.test(reply))
  await client.close()
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "prefs"
  console.log(`Phase 3b verification — mode: ${mode}`)
  console.log(`Database: ${config.data.dbPath}`)

  if (mode === "prefs") await prefsRun()
  else if (mode === "fact") await factRun()
  else if (mode === "recall") await recallRun(true)
  else if (mode === "recall-expired") await recallRun(false)
  else if (mode === "window") await windowRun()
  else throw new Error(`unknown mode: ${mode}`)

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("verification failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
