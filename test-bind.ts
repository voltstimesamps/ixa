// Temporary diagnostic — delete after debugging
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import http from "node:http"

async function* stdinLines(): AsyncGenerator<string> {
  let buf = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    buf += chunk as string
    let nl: number
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl).replace(/\r$/, "")
      buf = buf.slice(nl + 1)
    }
  }
  if (buf) yield buf.replace(/\r$/, "")
}

const app = new Hono()
app.get("/health", (c) => c.json({ ok: true }))

const restServer = serve({ fetch: app.fetch, port: 9994, hostname: "0.0.0.0" }, (info) => {
  console.log("REST LISTENING CALLBACK:", JSON.stringify(info))
})
restServer.on("error", (e: Error) => console.error("REST ERROR:", e.message))

const wss = new WebSocketServer({ port: 9993 })
wss.on("listening", () => console.log("WS LISTENING:", wss.address()))
wss.on("error", (e: Error) => console.error("WS ERROR:", e.message))

setTimeout(() => {
  console.log("500ms: rest.address()=", restServer.address(), "wss.address()=", wss.address())
  http.get("http://127.0.0.1:9994/health", (res) => {
    let d = ""
    res.on("data", (c) => (d += c))
    res.on("end", () => { console.log("GET /health:", d); done() })
  }).on("error", (e) => { console.log("GET /health failed:", e.message); done() })
}, 500)

let doneFired = false
function done() {
  if (doneFired) return
  doneFired = true
  restServer.close()
  wss.close()
  process.exit(0)
}

setTimeout(done, 3000)

;(async () => {
  for await (const line of stdinLines()) {
    console.log("stdin line:", line)
  }
  console.log("stdin closed")
  done()
})()
