// Phase 3a acceptance run. Requires a backend already started with
// `VOICE_MODE=true npm run dev`.
//
//   npx tsx dev/scripts/phase3a-verify.ts            # tests a-d + reset
//   npx tsx dev/scripts/phase3a-verify.ts idle       # test e (short timeout)
//   npx tsx dev/scripts/phase3a-verify.ts window     # test f (small budget)
import { WebSocket } from "ws"
import { existsSync, rmSync } from "fs"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"
const REST_URL = process.env.IXA_REST_URL ?? "http://localhost:3000"

interface Client {
  ws: WebSocket
  ask(text: string, options?: { waitForConfirm?: boolean }): Promise<string>
  nextConfirm(): Promise<string>
  close(): Promise<void>
}

async function connect(label: string): Promise<Client> {
  const ws = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })
  console.log(`  [${label}] connected`)

  const replyWaiters: Array<(value: string) => void> = []
  const errorWaiters: Array<(err: Error) => void> = []
  const confirmWaiters: Array<(value: string) => void> = []
  let bufferedConfirm: string | null = null

  ws.on("message", (data, isBinary) => {
    if (isBinary) return
    const msg = JSON.parse(data.toString())
    if (msg.type === "assistant") replyWaiters.shift()?.(msg.content ?? "")
    if (msg.type === "confirm") {
      if (confirmWaiters.length) confirmWaiters.shift()!(msg.content ?? "")
      else bufferedConfirm = msg.content ?? ""
    }
    if (msg.type === "error") errorWaiters.shift()?.(new Error(msg.content))
  })

  return {
    ws,
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
    nextConfirm() {
      if (bufferedConfirm !== null) {
        const buffered = bufferedConfirm
        bufferedConfirm = null
        return Promise.resolve(buffered)
      }
      return new Promise<string>((resolve, reject) => {
        confirmWaiters.push(resolve)
        setTimeout(() => reject(new Error(`[${label}] no confirm prompt arrived`)), 120_000)
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        ws.once("close", () => {
          console.log(`  [${label}] closed`)
          resolve()
        })
        ws.close()
      })
    },
  }
}

async function rest(message: string): Promise<string> {
  const res = await fetch(`${REST_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
  const body = (await res.json()) as { response?: string; error?: string }
  if (body.error) throw new Error(body.error)
  return body.response ?? ""
}

const results: Array<{ name: string; pass: boolean; detail: string }> = []
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name} — ${detail}`)
}

const FACT = "chartreuse"
const SENTINEL = "/tmp/claude-1000/phase3a-should-not-exist.txt"

async function mainRun(): Promise<void> {
  console.log("\n(a) context survives a reconnect")
  const c1 = await connect("conn-1")
  console.log(`  > ${await c1.ask(`Remember this fact: my favorite color is ${FACT}. Just acknowledge briefly.`)}`)
  await c1.close()

  const c2 = await connect("conn-2")
  const recalled = await c2.ask("What is my favorite color? Answer with just the color.")
  console.log(`  > ${recalled}`)
  check("a. context survives reconnect", recalled.toLowerCase().includes(FACT), `new connection recalled "${FACT}"`)

  console.log("\n(b) the same session is shared with REST")
  const viaRest = await rest("What is my favorite color? Answer with just the color.")
  console.log(`  > ${viaRest}`)
  check("b. shared session across transports", viaRest.toLowerCase().includes(FACT), "REST recalled a fact given over WebSocket")

  console.log("\n(c) two connections submitting at the same moment")
  const c3 = await connect("conn-3")
  const c4 = await connect("conn-4")
  const [alpha, bravo] = await Promise.all([
    c3.ask("Reply with exactly one word: ALPHA"),
    c4.ask("Reply with exactly one word: BRAVO"),
  ])
  console.log(`  > conn-3: ${alpha}`)
  console.log(`  > conn-4: ${bravo}`)
  const routed = alpha.toUpperCase().includes("ALPHA") && bravo.toUpperCase().includes("BRAVO")
  const order = await rest(
    "List my last three messages to you in the order I sent them, as a comma-separated list, nothing else."
  )
  console.log(`  > order: ${order}`)
  const alphaAt = order.toUpperCase().indexOf("ALPHA")
  const bravoAt = order.toUpperCase().indexOf("BRAVO")
  check(
    "c. serialization + reply routing",
    routed && alphaAt !== -1 && bravoAt !== -1 && alphaAt < bravoAt,
    `each reply went to its own connection; history order ALPHA(${alphaAt}) before BRAVO(${bravoAt})`
  )
  await c3.close()
  await c4.close()

  console.log("\n(d) confirmation cancelled when the asking client disconnects")
  rmSync(SENTINEL, { force: true })
  const c5 = await connect("conn-5")
  const pending = c5.ask(`Use shell_write to run: touch ${SENTINEL}`)
  pending.catch(() => {})
  const prompt = await c5.nextConfirm()
  console.log(`  > confirm prompt: ${prompt}`)
  console.log("  closing conn-5 without answering…")
  await c5.close()

  await new Promise((r) => setTimeout(r, 3000))
  const c6 = await connect("conn-6")
  const account = await c6.ask(
    "Looking only at our conversation history: what happened with the last tool call you attempted, and did the file get created?"
  )
  console.log(`  > ${account}`)
  const fileAbsent = !existsSync(SENTINEL)
  const saysCancelled = /cancel|disconnect|did not|wasn't|was not|never/i.test(account)
  check("d. cancel on disconnect — nothing executed", fileAbsent, `${SENTINEL} does not exist`)
  check("d. cancel on disconnect — recorded in history", saysCancelled, "the model reports the cancellation from history")

  console.log("\n(reset) explicit REST reset ends the session")
  await fetch(`${REST_URL}/reset`, { method: "POST" })
  const afterReset = await c6.ask("What is my favorite color? If you do not know, say UNKNOWN.")
  console.log(`  > ${afterReset}`)
  check(
    "reset. /reset starts a fresh primary session",
    !afterReset.toLowerCase().includes(FACT),
    "the fact from before the reset is gone, on a connection that stayed open"
  )
  await c6.close()
}

async function idleRun(): Promise<void> {
  console.log("\n(e) idle timeout (backend must be running with a short IXA_SESSION_IDLE_TIMEOUT_MS)")
  const c1 = await connect("conn-idle")
  console.log(`  > ${await c1.ask(`Remember this fact: my favorite color is ${FACT}. Just acknowledge briefly.`)}`)
  console.log("  waiting 15s without sending a turn, connection stays open…")
  await new Promise((r) => setTimeout(r, 15_000))
  const after = await c1.ask("What is my favorite color? If you do not know, say UNKNOWN.")
  console.log(`  > ${after}`)
  check(
    "e. idle timeout ends the session",
    !after.toLowerCase().includes(FACT),
    "the still-open connection landed on a fresh session (check the server log for onSessionEnd)"
  )
  await c1.close()
}

async function windowRun(): Promise<void> {
  console.log("\n(f) context windowing (backend must be running with a small IXA_CONTEXT_MAX_MESSAGES)")
  const c1 = await connect("conn-window")
  console.log(`  > ${await c1.ask(`Remember this fact: my favorite color is ${FACT}. Just acknowledge briefly.`)}`)

  // Tool calls put assistant/tool pairs into history: if windowing ever split
  // a pair, the next request would be rejected by the API.
  for (const q of ["What time is it?", "What is today's date?", "What time is it now?"]) {
    console.log(`  > ${(await c1.ask(q)).slice(0, 90)}`)
  }
  for (const q of ["Say FILLER1", "Say FILLER2", "Say FILLER3"]) {
    console.log(`  > ${(await c1.ask(q)).slice(0, 60)}`)
  }

  const after = await c1.ask("What is my favorite color? If you do not know, say UNKNOWN.")
  console.log(`  > ${after}`)
  check(
    "f. a small budget clips old history",
    !after.toLowerCase().includes(FACT),
    "the fact fell outside the window, so it was not sent"
  )
  check(
    "f. no tool call/result pair was split",
    true,
    "six turns including three tool calls completed with no API error"
  )
  await c1.close()
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "main"
  if (mode === "idle") await idleRun()
  else if (mode === "window") await windowRun()
  else await mainRun()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("\nverification run failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
