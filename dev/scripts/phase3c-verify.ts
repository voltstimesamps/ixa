// Phase 3c acceptance run. Requires a backend already started with
// `VOICE_MODE=true npm run dev`, pointed at the SAME IXA_DB_PATH and
// QDRANT_COLLECTION as this script. The runs use throwaway values for both so
// real memory is never touched.
//
//   npx tsx dev/scripts/phase3c-verify.ts converse   # a: a real conversation, then wait for the episode
//   npx tsx dev/scripts/phase3c-verify.ts trivial    # b: a one-turn session is skipped
//   npx tsx dev/scripts/phase3c-verify.ts recall     # c + d: related recalls, unrelated does not
//   npx tsx dev/scripts/phase3c-verify.ts search     # e: search_memory
//   npx tsx dev/scripts/phase3c-verify.ts down       # f: with Qdrant stopped
//   npx tsx dev/scripts/phase3c-verify.ts status     # print SQLite + Qdrant state
import { WebSocket } from "ws"
import Database from "better-sqlite3"
import { config } from "../../src/config"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"

let failures = 0

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

interface EpisodeRow {
  id: number
  session_id: string
  started_at: number
  ended_at: number
  summary: string
  tags: string
  embedding_model: string | null
  indexed_at: number | null
}

function episodes(): EpisodeRow[] {
  const db = new Database(config.data.dbPath, { readonly: true })
  try {
    return db.prepare("SELECT * FROM episodes ORDER BY id").all() as EpisodeRow[]
  } finally {
    db.close()
  }
}

function printEpisodes(): void {
  const rows = episodes()
  if (rows.length === 0) {
    console.log("    (no episodes)")
    return
  }
  for (const row of rows) {
    const when = new Date(row.ended_at).toLocaleString("en-GB")
    const state = row.indexed_at ? `indexed (${row.embedding_model})` : "NOT INDEXED"
    console.log(`    #${row.id} ${when} [${JSON.parse(row.tags).join(", ")}] ${state}`)
    console.log(`        ${row.summary}`)
  }
}

async function qdrantCount(): Promise<number | null> {
  try {
    const response = await fetch(`${config.qdrant.url}/collections/${config.qdrant.collection}`)
    if (!response.ok) return null
    const body = (await response.json()) as { result?: { points_count?: number } }
    return body.result?.points_count ?? 0
  } catch {
    return null
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
  const startedAt = Date.now()
  const reply = await client.ask(text)
  console.log(`  < ${reply}  (${Date.now() - startedAt}ms)`)
  return reply.replace(/[‐-―−]/g, "-")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForEpisodes(target: number, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (episodes().length >= target) return true
    await sleep(2000)
  }
  return false
}

// (a) A real conversation, left to time out, becomes an indexed episode.
async function converseRun(): Promise<void> {
  const before = episodes().length
  const client = await connect("converse")

  console.log("\n(a) A REAL CONVERSATION")
  await say(client, "The humidity sensor in my attic is reading 72 percent. Is that a problem?")
  await say(client, "What would you suggest I do about it?")
  await say(client, "Right, let's go with a dehumidifier then. A 30 pint one.")
  await client.close()

  console.log("\n  waiting for the session to idle out and be summarized…")
  const arrived = await waitForEpisodes(before + 1)
  check("an episode was written", arrived)
  printEpisodes()

  const latest = episodes().at(-1)
  check("it has a summary", !!latest && latest.summary.length > 20)
  check("it has tags", !!latest && (JSON.parse(latest.tags) as string[]).length > 0)
  check(
    "it mentions the subject of the conversation",
    !!latest && /humid|attic|dehumidifier/i.test(latest.summary),
    latest?.summary.slice(0, 80),
  )
  check("it is marked indexed", !!latest?.indexed_at, latest?.embedding_model ?? "not indexed")

  const points = await qdrantCount()
  check("Qdrant holds a point for it", points !== null && points >= before + 1, `points_count=${points}`)
}

// (b) A one-turn session is not worth remembering.
async function trivialRun(): Promise<void> {
  const before = episodes().length
  const client = await connect("trivial")

  console.log("\n(b) TRIVIAL SESSION")
  await say(client, "Thanks!")
  await client.close()

  console.log("  waiting past the idle timeout…")
  await sleep(45_000)

  check("no episode was written", episodes().length === before, `${episodes().length} episode(s)`)
  console.log("  (the backend log should carry a 'skipping episode' line)")
}

// (c) and (d).
async function recallRun(): Promise<void> {
  const client = await connect("recall")

  console.log("\n(c) RELATED QUESTION — expect the earlier conversation to be recalled")
  const related = await say(client, "Remind me what we decided about the attic humidity?")
  check(
    "the answer uses the recalled episode",
    /dehumidifier|30 ?pint|72/i.test(related),
    "looked for dehumidifier/30 pint/72",
  )
  // The date is in the injected block, but a model answering "what did we
  // decide" has no reason to repeat it. Ask for it directly instead: if it can
  // name the day, the date reached it.
  const when = await say(client, "When did we have that conversation about the attic?")
  const today = new Date()
  const dayName = today.toLocaleDateString("en-GB", { weekday: "long" })
  const monthName = today.toLocaleDateString("en-GB", { month: "long" })
  check(
    "the model knows when it happened, so the date reached it",
    new RegExp(`${dayName}|${monthName}|${today.getDate()}|today`, "i").test(when),
    `expected ${dayName} / ${monthName} ${today.getDate()}`,
  )

  console.log("\n(d) UNRELATED QUESTION — expect nothing recalled")
  const unrelated = await say(client, "How do I reverse a string in Python?")
  check(
    "the answer does not drag in the humidity episode",
    !/humid|attic|dehumidifier/i.test(unrelated),
  )
  console.log("  (the backend log should show 'no episode above' for this turn)")

  await client.close()
}

// (e)
async function searchRun(): Promise<void> {
  const client = await connect("search")
  console.log("\n(e) SEARCH_MEMORY")
  const reply = await say(client, "Search your memory: what did we talk about regarding the attic?")
  check(
    "it answers from a past conversation",
    /humid|attic|dehumidifier/i.test(reply),
    reply.slice(0, 80),
  )
  await client.close()
}

// (f) run this with the Qdrant container stopped.
async function downRun(): Promise<void> {
  const before = episodes().length
  const points = await qdrantCount()
  check("Qdrant is unreachable, as this test requires", points === null, `points=${points}`)

  const client = await connect("down")
  console.log("\n(f) QDRANT DOWN")
  const normal = await say(client, "What is the capital of France?")
  check("Ixa still answers normally", /paris/i.test(normal))

  const search = await say(client, "Search your memory for what we said about the attic.")
  check(
    "search_memory reports it cannot search",
    /unavailable|can't|cannot|not (be )?(able|reachable)/i.test(search),
    search.slice(0, 90),
  )

  await say(client, "Remember this for later: the spare key is in the blue tin.")
  await say(client, "And the tin is on the top shelf of the garage.")
  await client.close()

  console.log("\n  waiting for the session to idle out and be summarized…")
  const arrived = await waitForEpisodes(before + 1)
  check("the episode is still written with Qdrant down", arrived)
  const latest = episodes().at(-1)
  check("and is marked NOT indexed", !!latest && latest.indexed_at === null)
  printEpisodes()
}

async function statusRun(): Promise<void> {
  console.log(`\nDatabase:   ${config.data.dbPath}`)
  console.log(`Collection: ${config.qdrant.collection} @ ${config.qdrant.url}`)
  console.log(`Qdrant points: ${await qdrantCount()}`)
  console.log("Episodes:")
  printEpisodes()
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "status"
  console.log(`Phase 3c verification — mode: ${mode}`)

  if (mode === "converse") await converseRun()
  else if (mode === "trivial") await trivialRun()
  else if (mode === "recall") await recallRun()
  else if (mode === "search") await searchRun()
  else if (mode === "down") await downRun()
  else if (mode === "status") await statusRun()
  else throw new Error(`unknown mode: ${mode}`)

  if (mode !== "status") {
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("verification failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
