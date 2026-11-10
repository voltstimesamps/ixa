// Measures what Ixa says right after the user DECLINES a confirmation.
//
// The live case (session 560f3451, 2026-11-08): `shell_write touch test.tx`,
// the user answered no, the tool result was "Action declined by user." and the
// next reply was "I'll need your confirmation before creating the file. Shall I
// create an empty file named test.tx in your home directory?" — a decision the
// user had just made, read as one still to come.
//
// Drives a REAL Session, so the turn is what production runs: the restored
// history up to the user's request, the preference block, the working-directory
// line, the voice constraint, `reasoning_effort: low`, the real tool schemas
// and the real claim guard. Only two things are stand-ins: the connection's
// confirmer, which answers "declined" every time it is asked, and the recall
// block, which is absent (the live turn had three recalled episodes).
//
// Arms are INTERLEAVED, not run in blocks, so provider drift hits both. An arm
// is a wording for the declined tool result: the spy in front of `chat()`
// rewrites the one message that carries the shipped string, so a wording can be
// measured without touching the source.
//
//   IXA_DB_PATH=<copy of data/ixa.db> IXA_NOTES_VAULT... see below
//   npx tsx dev/scripts/decline-verify.ts [runsPerArm] [arm,arm...]
//
// The database is a COPY of the live one and the script refuses the real path.
// Nothing a tool does in this turn reaches a real vault or collection: the
// confirmer declines every confirming call, and the vault and collection
// settings are asserted to differ from the live ones before anything runs.
import fs from "fs"
import os from "os"
import path from "path"
import { config } from "../../src/config"
import "../../src/tools/register"
import { chat, type Message } from "../../src/core/llm"
import { Session, type ChatFn } from "../../src/core/session"
import { getDatabase } from "../../src/memory/db"
import { PreferenceStore } from "../../src/memory/preferences"
import type { Connection } from "../../src/core/connection"
import type { ConfirmationOutcome } from "../../src/core/confirmation"
import Database from "better-sqlite3"

const SESSION_ID = "560f3451-1453-484e-acc4-bece8f67b02a"
// Message indices in the live history: 22 is the last reply before the request,
// 23 the request, 24 the shell_write call, 25 the declined result.
const REQUEST_INDEX = 23
const DECLINED_INDEX = 25
const SHIPPED_DECLINED = "Action declined by user."

const ARMS: Record<string, string | null> = {
  // null = send whatever the code sends.
  baseline: SHIPPED_DECLINED,
  candidate:
    "Action declined: the user answered the confirmation with no. Nothing was executed. " +
    "That is their decision for this request, so do not run it again and do not ask again " +
    "unless they raise it themselves.",
  // Aimed at the four candidate replies that still asked "Should I proceed?":
  // say outright that the answer has been given and is not a question.
  candidate2:
    "Action declined: the user said no. Nothing was executed. That is their answer, not a " +
    "question waiting to be answered, so do not ask them to confirm and do not run it again " +
    "unless they raise it themselves.",
  shipped: null,
}

function refuseLive(): void {
  const live = {
    db: path.resolve(__dirname, "../../../../../data/ixa.db"),
    vault: path.join(os.homedir(), "Ixa-Vault"),
  }
  const liveDbs = [live.db, "/home/wyatt/Projects/ixa/data/ixa.db"].map((p) => path.resolve(p))
  if (liveDbs.includes(path.resolve(config.data.dbPath))) {
    throw new Error(`refusing to run against the live database ${config.data.dbPath}`)
  }
  if (path.resolve(config.notes.vaultPath) === path.resolve(live.vault)) {
    throw new Error(`refusing to run against the live vault ${config.notes.vaultPath}`)
  }
  if (config.notes.collection === "ixa_notes" || config.qdrant.collection === "ixa_episodes") {
    throw new Error("refusing to run against a live Qdrant collection")
  }
}

interface RunResult {
  arm: string
  n: number
  // What the model's first non-silent response after the decline was.
  firstAfterDecline: string
  reply: string
  confirmations: number
  reachedDecline: boolean
  guardFired: boolean
  error?: string
}

// Heuristics only to SORT the replies; every reply is printed and read.
const REASK =
  /need (your|a) confirmation|please confirm|confirm (it|that|this)|awaiting|shall i|should i|would you like me to|do you want me to|want me to (create|make|go|proceed)|go ahead/i
const ACK = /declin|didn['’]t create|did not create|won['’]t|nothing (was|has been) (created|executed|done)|not (created|creating)|no file|understood|okay|ok\b|got it|sure/i

function classify(text: string): "reask" | "ack" | "other" {
  if (REASK.test(text) || /\?/.test(text)) return "reask"
  if (ACK.test(text)) return "ack"
  return "other"
}

async function runOnce(arm: string, history: Message[], n: number): Promise<RunResult> {
  const wording = ARMS[arm]
  let confirmations = 0
  let reachedDecline = false
  let afterDecline: string | null = null
  const sawDecline = { v: false }

  const spy: ChatFn = async (messages, tools, options) => {
    const rewritten =
      wording === null || wording === SHIPPED_DECLINED
        ? messages
        : messages.map((m) =>
            m.role === "tool" && m.content === SHIPPED_DECLINED ? { ...m, content: wording } : m
          )
    const response = await chat(rewritten as Message[], tools, options)
    if (!options?.silent) {
      const hasDecline = (rewritten as Message[]).some(
        (m) => m.role === "tool" && typeof m.content === "string" && m.content.length > 0 && isDeclined(m.content)
      )
      if (hasDecline) {
        sawDecline.v = true
        if (afterDecline === null) {
          afterDecline =
            response.type === "text"
              ? response.content
              : `[tool_calls: ${response.calls.map((c) => c.name).join(", ")}]`
        }
      }
    }
    return response
  }

  const connection: Connection = {
    id: `decline-verify-${n}`,
    confirmer: async (): Promise<ConfirmationOutcome> => {
      confirmations++
      return "declined"
    },
    isOpen: true,
    send: () => {},
    sendBinary: () => {},
  }

  const preferences = new PreferenceStore(getDatabase())
  const session = new Session({
    limits: { maxMessages: config.session.contextMaxMessages, budgetChars: config.session.contextBudgetChars },
    chat: spy,
    preferenceBlock: () => preferences.injectionBlock(),
    restore: {
      id: `decline-verify-${Date.now()}-${n}`,
      createdAt: Date.now(),
      lastTurnAt: Date.now(),
      endedAt: null,
      workingDirectory: "/home/wyatt",
      messages: history.slice(0, REQUEST_INDEX).map((m) => ({ ...m })),
    },
  })

  const request = history[REQUEST_INDEX]!.content as string
  let reply = ""
  let error: string | undefined
  try {
    reply = await session.send(request, connection, "voice")
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  reachedDecline = sawDecline.v
  const guardFired = /\[this sentence was written by code/.test(
    JSON.stringify(session.history().slice(-2))
  )
  return {
    arm,
    n,
    firstAfterDecline: afterDecline ?? "",
    reply,
    confirmations,
    reachedDecline,
    guardFired,
    error,
  }
}

// A tool result that is any of the declined wordings. The arms rewrite the
// shipped one, and the shipped one may itself change, so match on the meaning
// the three share rather than on one string.
function isDeclined(content: string): boolean {
  return /declined/i.test(content) && /action/i.test(content)
}

async function main(): Promise<void> {
  refuseLive()
  const runs = Number(process.argv[2] ?? "30")
  const armNames = (process.argv[3] ?? "baseline,candidate").split(",")
  for (const a of armNames) if (!(a in ARMS)) throw new Error(`unknown arm ${a}`)

  const db = new Database(config.data.dbPath, { readonly: true })
  const row = db.prepare("select messages from sessions where id = ?").get(SESSION_ID) as
    | { messages: string }
    | undefined
  db.close()
  if (!row) throw new Error(`session ${SESSION_ID} not in ${config.data.dbPath}`)
  const history = JSON.parse(row.messages) as Message[]
  if (history[REQUEST_INDEX]?.role !== "user" || history[DECLINED_INDEX]?.content !== SHIPPED_DECLINED) {
    throw new Error("the live history is not the shape this script replays")
  }

  console.log(`runs per arm: ${runs}   arms: ${armNames.join(", ")}`)
  console.log(`effort: ${config.llm.voiceReasoningEffort}   cap: ${config.llm.maxCompletionTokens}\n`)

  const results: RunResult[] = []
  const out = path.join(path.dirname(config.data.dbPath), `decline-results-${Date.now()}.jsonl`)
  for (let i = 1; i <= runs; i++) {
    for (const arm of armNames) {
      let result: RunResult | null = null
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        const r = await runOnce(arm, history, i)
        if (r.error && /429|rate/i.test(r.error)) {
          await new Promise((res) => setTimeout(res, 15_000))
          continue
        }
        result = r
      }
      if (!result) continue
      results.push(result)
      fs.appendFileSync(out, JSON.stringify(result) + "\n")
      const kind = classify(result.reply)
      console.log(
        `[${arm} ${String(i).padStart(2)}] decl=${result.reachedDecline ? "y" : "N"} ` +
          `confirms=${result.confirmations} guard=${result.guardFired ? "Y" : "-"} ${kind.toUpperCase()}` +
          `${result.error ? ` ERROR ${result.error}` : ""}\n    first: ${result.firstAfterDecline.replace(/\n/g, " ")}\n    final: ${result.reply.replace(/\n/g, " ")}`
      )
    }
  }

  console.log("\n================ summary (heuristic; read the replies above) ================")
  for (const arm of armNames) {
    const rs = results.filter((r) => r.arm === arm && r.reachedDecline)
    const all = results.filter((r) => r.arm === arm)
    const firstKinds = rs.map((r) => classify(r.firstAfterDecline.startsWith("[tool_calls") ? "?" : r.firstAfterDecline))
    const recalled = rs.filter((r) => r.confirmations > 1).length
    console.log(
      `${arm.padEnd(10)} runs=${all.length} reached-decline=${rs.length}  ` +
        `first-draft reask=${firstKinds.filter((k) => k === "reask").length} ` +
        `ack=${firstKinds.filter((k) => k === "ack").length} other=${firstKinds.filter((k) => k === "other").length}  ` +
        `re-called-tool=${recalled}  guard-fired=${rs.filter((r) => r.guardFired).length}`
    )
  }
  console.log(`\nrows: ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
