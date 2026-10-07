import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { WebSocket } from "ws"
import type { WebSocketServer } from "ws"
import type { WsMessage } from "../src/api/types"
import type { ChatFn } from "../src/core/session"

// A turn that fails is still a turn that ENDED: the client must be told, must
// get its terminator, and must still be connected afterwards.
//
// Driven over a real WebSocket against a real server, because the behaviour
// under test is the transport's, and a fake connection cannot show whether a
// socket was closed. config.ts reads the environment at import time, so
// TTS_URL is set in `before` and the modules are imported after it.
//
// Every turn here arrives as TEXT — ask() sends a "user" frame — so under
// text-in-text-out none of them is spoken. That is asserted rather than
// assumed: a failure is the one case where a silent reply is easiest to get
// wrong. The spoken side of these same paths lives in
// test/text-in-text-out.test.ts, which has the STT sidecar needed to make a
// turn arrive with origin "voice".

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

// Stands in for the Kokoro sidecar: the length-prefixed WAV frames that
// speakStreaming expects, over a chunked body.
let ttsRequests = 0
const ttsSockets = new Set<net.Socket>()
const ttsServer = http.createServer((_req, res) => {
  ttsRequests++
  res.writeHead(200, { "Content-Type": "application/octet-stream" })
  const audio = Buffer.from("fake-wav-bytes")
  const frame = Buffer.alloc(4 + audio.length)
  frame.writeUInt32BE(audio.length, 0)
  audio.copy(frame, 4)
  res.end(frame)
})
ttsServer.on("connection", (socket) => {
  ttsSockets.add(socket)
  socket.on("close", () => ttsSockets.delete(socket))
})

let wss: WebSocketServer
let wsPort: number
let chatBehaviour: ChatFn

before(async () => {
  await new Promise<void>((resolve) => ttsServer.listen(0, "127.0.0.1", resolve))
  process.env.TTS_URL = `http://127.0.0.1:${(ttsServer.address() as AddressInfo).port}`
  process.env.LLM_API_KEY = "test-key"

  const { SessionManager } = await import("../src/core/session-manager.js")
  const { createWsServer } = await import("../src/api/websocket.js")
  const { TEST_LIMITS } = await import("./helpers.js")

  const sessions = new SessionManager({
    idleTimeoutMs: 60_000,
    limits: TEST_LIMITS,
    chat: (...args) => chatBehaviour(...args),
  })

  wsPort = await freePort()
  wss = await createWsServer(wsPort, sessions)
})

after(() => {
  wss?.close()
  for (const socket of ttsSockets) socket.destroy()
  ttsServer.close()
})

interface Client {
  socket: WebSocket
  received: WsMessage[]
  binaryFrames: number
  ask(text: string): Promise<WsMessage[]>
  close(): void
}

// Connects, and resolves each `ask` when the turn's terminator arrives —
// "replyEnd" is the protocol's statement that the turn is over, so a test
// that waits for anything else is testing a different thing.
async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`)
  const received: WsMessage[] = []
  const client: Client = {
    socket,
    received,
    binaryFrames: 0,
    ask: () => Promise.reject(new Error("not ready")),
    close: () => socket.close(),
  }

  let onTerminator: ((messages: WsMessage[]) => void) | null = null
  let turnMessages: WsMessage[] = []

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      client.binaryFrames++
      turnMessages.push({ type: "chunk" })
      return
    }
    const msg = JSON.parse(data.toString()) as WsMessage
    received.push(msg)
    if (msg.type === "sessionStart") return
    turnMessages.push(msg)
    if (msg.type === "replyEnd") {
      const settle = onTerminator
      const out = turnMessages
      onTerminator = null
      turnMessages = []
      settle?.(out)
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  client.ask = (text: string) =>
    new Promise<WsMessage[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no replyEnd within 5s; got ${JSON.stringify(turnMessages)}`)),
        5000
      )
      onTerminator = (messages) => {
        clearTimeout(timer)
        resolve(messages)
      }
      socket.send(JSON.stringify({ type: "user", content: text }))
    })

  return client
}

test("a failed text turn sends error AND replyEnd, speaks nothing, and keeps the socket open", async () => {
  chatBehaviour = async () => {
    throw new Error("LLM call aborted: no chunk for 15000ms (stream inactivity)")
  }

  const client = await connect()
  const before = ttsRequests
  const startedAt = Date.now()
  const turn = await client.ask("what is the weather")
  const elapsed = Date.now() - startedAt

  const types = turn.map((m) => m.type)
  assert.ok(types.includes("error"), `no error message: ${JSON.stringify(turn)}`)
  assert.equal(types.at(-1), "replyEnd", `replyEnd must terminate the turn: ${types.join(",")}`)
  assert.match(String(turn.find((m) => m.type === "error")?.content), /stream inactivity/)

  // Nothing was spoken. The apology is for a listener, and a typed question
  // has none: the `error` frame and the terminator are what end this turn.
  // (A failed VOICE turn still speaks it — see text-in-text-out.test.ts.)
  assert.equal(ttsRequests, before, "a failed text turn must not reach TTS")
  assert.equal(client.binaryFrames, 0, "no audio for a failed text turn")
  assert.ok(!types.includes("audioStart"))

  // Fast: this is a failure, not a wait.
  assert.ok(elapsed < 3000, `took ${elapsed}ms`)

  // Still connected.
  assert.equal(client.socket.readyState, WebSocket.OPEN)

  // And the next turn works, on the same socket and the same session.
  chatBehaviour = async () => ({ type: "text", content: "it is sunny" })
  const next = await client.ask("try again")
  assert.equal(next.find((m) => m.type === "assistant")?.content, "it is sunny")
  assert.equal(client.socket.readyState, WebSocket.OPEN)

  client.close()
})

test("a malformed frame does not close the socket", async () => {
  const client = await connect()

  const errorArrived = new Promise<WsMessage>((resolve) => {
    client.socket.on("message", (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(data.toString()) as WsMessage
      if (msg.type === "error") resolve(msg)
    })
  })

  client.socket.send("this is not json")
  await errorArrived

  assert.equal(client.socket.readyState, WebSocket.OPEN)

  chatBehaviour = async () => ({ type: "text", content: "still here" })
  const next = await client.ask("are you there")
  assert.equal(next.find((m) => m.type === "assistant")?.content, "still here")

  client.close()
})

// The empty reply, as the protocol sees it.
//
// A live voice session produced a turn with no text at all — "Ixa:" and
// nothing after it — after four web_search calls succeeded. The cause was the
// context budget handing the model a window with no conversation in it (see
// buildWindow and test/session-window.test.ts). This is the other half of the
// question: what the client is told when it happens. Nothing is spoken, and
// the turn still terminates — so a voice client, which stops its own
// conversation timer for the duration of a turn, gets the microphone back
// instead of waiting out its safety net.
test("an empty reply speaks nothing and still terminates the turn", async () => {
  chatBehaviour = async () => ({ type: "text", content: "" })

  const client = await connect()
  const before = ttsRequests
  const framesBefore = client.binaryFrames
  const turn = await client.ask("how much is a used 3090 going for")
  const types = turn.map((m) => m.type)

  assert.deepEqual(types, ["assistant", "replyEnd"], `unexpected turn: ${types.join(",")}`)
  assert.equal(turn.find((m) => m.type === "assistant")?.content, "")

  // speak() is never reached with an empty string: nothing was synthesized
  // and no audio frames were sent.
  assert.equal(ttsRequests, before, "an empty reply must not reach TTS")
  assert.equal(client.binaryFrames, framesBefore, "no audio for a reply with no words in it")
  assert.ok(!types.includes("audioStart"))

  // The session survives it, which is what the live log showed: the turn
  // after the empty one was normal.
  chatBehaviour = async () => ({ type: "text", content: "about eight hundred dollars" })
  const next = await client.ask("say that again")
  assert.equal(next.find((m) => m.type === "assistant")?.content, "about eight hundred dollars")
  assert.equal(client.socket.readyState, WebSocket.OPEN)

  client.close()
})

// Last, because it takes the TTS sidecar away for good.
//
// A text turn never contacts TTS, so an unavailable sidecar cannot reach it —
// which is the point: the terminator does not depend on a sidecar that is not
// in the path. The harder case, where the sidecar IS in the path and dies, is
// a voice turn, and lives at the end of text-in-text-out.test.ts.
test("replyEnd still arrives when TTS is unavailable", async () => {
  for (const socket of ttsSockets) socket.destroy()
  await new Promise<void>((resolve) => ttsServer.close(() => resolve()))

  chatBehaviour = async () => {
    throw new Error("LLM call aborted: call exceeded 120000ms")
  }

  const client = await connect()
  const turn = await client.ask("anything")
  const types = turn.map((m) => m.type)

  assert.ok(types.includes("error"))
  assert.equal(types.at(-1), "replyEnd", `replyEnd must still terminate: ${types.join(",")}`)
  // Nothing was spoken, and that is fine — the terminator is what the client
  // is actually waiting on.
  assert.ok(!types.includes("audioStart"))
  assert.equal(client.socket.readyState, WebSocket.OPEN)

  // A working turn after a TTS failure still replies in text.
  chatBehaviour = async () => ({ type: "text", content: "text only" })
  const next = await client.ask("and now")
  assert.equal(next.find((m) => m.type === "assistant")?.content, "text only")

  client.close()
})
