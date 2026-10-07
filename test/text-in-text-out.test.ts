import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { WebSocket } from "ws"
import type { WebSocketServer } from "ws"
import type { WsMessage } from "../src/api/types"
import type { ChatFn } from "../src/core/session"

// Text in, text out: a turn that arrived as TEXT is not spoken, a turn that
// arrived as VOICE is.
//
// The rule is about the origin of the turn, not the connection, so the tests
// that matter drive both kinds of input down ONE socket and check that the
// typed turn did not take the spoken one's voice away with it. A unit test on
// a fake connection could not show that: the behaviour under test is the
// transport's, and whether audio frames reached a client is only observable
// over a real one.
//
// config.ts reads the environment at import time, so the sidecar URLs are set
// in `before` and the modules imported after it.

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

// Stands in for the Kokoro sidecar: the length-prefixed WAV frames that
// speakStreaming expects. Counted, because "was this spoken?" is exactly the
// question these tests ask.
let ttsRequests = 0
const sockets = new Set<net.Socket>()
const ttsServer = http.createServer((_req, res) => {
  ttsRequests++
  res.writeHead(200, { "Content-Type": "application/octet-stream" })
  const audio = Buffer.from("fake-wav-bytes")
  const frame = Buffer.alloc(4 + audio.length)
  frame.writeUInt32BE(audio.length, 0)
  audio.copy(frame, 4)
  res.end(frame)
})

// Stands in for the Whisper sidecar. It ignores the audio and returns whatever
// the test wants "heard", which is all that is needed to make a turn arrive
// with origin "voice" by the real route rather than by a test shortcut.
let transcript = ""
const sttServer = http.createServer((req, res) => {
  req.resume()
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ text: transcript, language: "en", durationMs: 1000 }))
  })
})

for (const server of [ttsServer, sttServer]) {
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
}

let wss: WebSocketServer
let wsPort: number
let chatBehaviour: ChatFn

before(async () => {
  await new Promise<void>((resolve) => ttsServer.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => sttServer.listen(0, "127.0.0.1", resolve))
  process.env.TTS_URL = `http://127.0.0.1:${(ttsServer.address() as AddressInfo).port}`
  process.env.STT_URL = `http://127.0.0.1:${(sttServer.address() as AddressInfo).port}`
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
  for (const socket of sockets) socket.destroy()
  ttsServer.close()
  sttServer.close()
})

interface Turn {
  types: string[]
  messages: WsMessage[]
  binaryFrames: number
  ttsRequests: number
}

interface Client {
  socket: WebSocket
  type(text: string): Promise<Turn>
  say(text: string): Promise<Turn>
  close(): void
}

// Each turn resolves on "replyEnd" — the protocol's statement that the turn is
// over. A test that waited for audio instead would be testing a different
// thing, and under this rule would wait forever on a typed question.
async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`)
  socket.binaryType = "nodebuffer"

  let onTerminator: ((turn: Turn) => void) | null = null
  let messages: WsMessage[] = []
  let binaryFrames = 0
  let ttsBefore = 0

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      binaryFrames++
      return
    }
    const msg = JSON.parse(data.toString()) as WsMessage
    if (msg.type === "sessionStart") return
    messages.push(msg)
    if (msg.type === "replyEnd") {
      const settle = onTerminator
      const turn: Turn = {
        types: messages.map((m) => m.type),
        messages,
        binaryFrames,
        ttsRequests: ttsRequests - ttsBefore,
      }
      onTerminator = null
      messages = []
      settle?.(turn)
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  // Arms the terminator watcher, then lets the caller put the turn in however
  // it likes: typed as one JSON frame, or spoken as the real three-part
  // audioStart / PCM / audioInputEnd sequence.
  const turn = (submit: () => void): Promise<Turn> =>
    new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no replyEnd within 5s; got ${JSON.stringify(messages)}`)),
        5000
      )
      binaryFrames = 0
      ttsBefore = ttsRequests
      onTerminator = (result) => {
        clearTimeout(timer)
        resolve(result)
      }
      submit()
    })

  return {
    socket,
    type: (text: string) =>
      turn(() => socket.send(JSON.stringify({ type: "user", content: text }))),
    say: (text: string) =>
      turn(() => {
        transcript = text
        socket.send(JSON.stringify({ type: "audioStart" }))
        // Content is irrelevant — the fake sidecar returns `transcript` — but
        // it must be non-empty, or the harness discards the turn as a false
        // VAD trigger before any origin is assigned.
        socket.send(Buffer.alloc(640))
        socket.send(JSON.stringify({ type: "audioInputEnd" }))
      }),
    close: () => socket.close(),
  }
}

test("a spoken turn is still spoken", async () => {
  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })

  const client = await connect()
  const turn = await client.say("what is the weather")

  assert.deepEqual(
    turn.types,
    ["assistant", "audioStart", "audioOutputEnd", "replyEnd"],
    `unexpected turn: ${turn.types.join(",")}`
  )
  assert.equal(turn.messages.find((m) => m.type === "assistant")?.content, "It is sunny.")
  assert.equal(turn.ttsRequests, 1, "a voice turn must reach TTS")
  assert.ok(turn.binaryFrames > 0, "no audio reached the client")

  client.close()
})

test("a typed turn over the WebSocket is not spoken, and still terminates", async () => {
  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })

  const client = await connect()
  const turn = await client.type("what is the weather")

  // The whole turn: the text of the reply, then the terminator. Nothing else
  // is sent, so there is no audioStart for a client to wait on.
  assert.deepEqual(turn.types, ["assistant", "replyEnd"], `unexpected turn: ${turn.types.join(",")}`)
  assert.equal(turn.messages.find((m) => m.type === "assistant")?.content, "It is sunny.")
  assert.equal(turn.ttsRequests, 0, "a text turn must not reach TTS at all")
  assert.equal(turn.binaryFrames, 0, "no audio for a typed question")

  client.close()
})

// The reason the rule is keyed off the turn and not the connection. The /test
// page sends both kinds of input down one socket, and a connection-level rule
// would mean that typing one question silently stopped spoken questions being
// answered aloud for the rest of that connection's life.
test("typing on a socket does not stop later spoken turns on it being spoken", async () => {
  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })

  const client = await connect()

  const typed = await client.type("what is the weather")
  assert.equal(typed.ttsRequests, 0, "the typed turn was spoken")

  const spoken = await client.say("and tomorrow")
  assert.equal(spoken.ttsRequests, 1, "the spoken turn after a typed one was not spoken")
  assert.ok(spoken.binaryFrames > 0, "no audio for the spoken turn")
  assert.equal(spoken.types.at(-1), "replyEnd")

  // And back again, on the same socket and the same session: the decision is
  // made per turn, every turn, in both directions.
  const typedAgain = await client.type("and the day after")
  assert.equal(typedAgain.ttsRequests, 0, "the second typed turn was spoken")
  assert.deepEqual(typedAgain.types, ["assistant", "replyEnd"])

  client.close()
})

// A failed turn is still a finished turn, and a failed TEXT turn is still a
// text turn: no spoken apology, and the terminator still arrives. The `error`
// frame and the terminator are what tell the client.
test("a failed text turn terminates cleanly with no spoken apology", async () => {
  chatBehaviour = async () => {
    throw new Error("LLM call aborted: no chunk for 15000ms (stream inactivity)")
  }

  const client = await connect()
  const turn = await client.type("what is the weather")

  assert.deepEqual(turn.types, ["error", "replyEnd"], `unexpected turn: ${turn.types.join(",")}`)
  assert.match(String(turn.messages.find((m) => m.type === "error")?.content), /stream inactivity/)
  assert.equal(turn.ttsRequests, 0, "a failed text turn must not speak an apology")
  assert.equal(turn.binaryFrames, 0, "no audio for a failed text turn")
  assert.equal(client.socket.readyState, WebSocket.OPEN, "the socket must survive a failed turn")

  // The next turn works, on the same socket and the same session.
  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })
  const next = await client.type("try again")
  assert.equal(next.messages.find((m) => m.type === "assistant")?.content, "It is sunny.")

  client.close()
})

// The voice half of the same path, unchanged by this work: a failed spoken
// turn still gets something to hear.
test("a failed voice turn still speaks the apology", async () => {
  chatBehaviour = async () => {
    throw new Error("LLM call aborted: no chunk for 15000ms (stream inactivity)")
  }

  const client = await connect()
  const turn = await client.say("what is the weather")

  assert.equal(turn.types.at(-1), "replyEnd", `replyEnd must terminate: ${turn.types.join(",")}`)
  assert.ok(turn.types.includes("error"))
  assert.ok(turn.types.includes("audioStart") && turn.types.includes("audioOutputEnd"))
  assert.equal(turn.ttsRequests, 1, "the apology was not sent to TTS")
  assert.ok(turn.binaryFrames > 0, "no apology audio reached the client")

  client.close()
})

// Exactly one terminator per accepted turn, whichever way the turn arrived.
// A voice client stops its own conversation timeout for the duration of a
// turn, so a second replyEnd would open a turn the user had not started and a
// missing one would leave the microphone dropped.
test("each turn is terminated exactly once, typed or spoken", async () => {
  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })

  const client = await connect()
  const typed = await client.type("what is the weather")
  const spoken = await client.say("and tomorrow")

  for (const [name, turn] of [["typed", typed], ["spoken", spoken]] as const) {
    const terminators = turn.types.filter((t) => t === "replyEnd" || t === "sessionEnd")
    assert.deepEqual(terminators, ["replyEnd"], `${name}: ${turn.types.join(",")}`)
    assert.equal(turn.types.at(-1), "replyEnd", `${name}: terminator must come last`)
  }

  client.close()
})

// Last, because it takes the TTS sidecar away for good.
//
// The terminator must not depend on the speech succeeding. A voice turn is the
// case that matters: TTS is genuinely in its path, and a voice client stops
// its own conversation timeout for the duration of a turn, so a turn that
// died inside speak() and sent nothing afterwards would leave the microphone
// dropped until the client's safety net fired.
test("a voice turn still terminates when TTS is unavailable", async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => ttsServer.close(() => resolve()))

  chatBehaviour = async () => ({ type: "text", content: "It is sunny." })

  const client = await connect()
  const turn = await client.say("what is the weather")

  assert.equal(turn.types.at(-1), "replyEnd", `replyEnd must still terminate: ${turn.types.join(",")}`)
  assert.equal(turn.messages.find((m) => m.type === "assistant")?.content, "It is sunny.")
  // Nothing was spoken, and that is fine: the terminator is what the client is
  // actually waiting on, and it still arrives with no audioStart before it.
  assert.ok(!turn.types.includes("audioStart"))
  assert.equal(turn.binaryFrames, 0)
  assert.equal(client.socket.readyState, WebSocket.OPEN)

  client.close()
})
