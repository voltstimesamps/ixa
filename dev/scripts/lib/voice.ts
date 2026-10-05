// Driving a voice turn from a script: a WebSocket client that waits for the
// one terminator per turn, and the audio helpers that let a turn be spoken
// without a microphone.
//
// Extracted from behavior-verify.ts so voice-behavior-verify.ts drives turns
// the same way rather than with a second, subtly different copy. Both scripts
// assert on what the backend recorded, so the thing driving it has to be the
// same in both.
import { WebSocket } from "ws"
import { config } from "../../../src/config"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"

// ------------------------------------------------------------- WS client

export interface Reply {
  text: string
  audioChunks: Buffer[]
  elapsedMs: number
}

export interface Client {
  ask(text: string): Promise<Reply>
  askAudio(pcm16k: Buffer): Promise<Reply>
  close(): Promise<void>
}

export async function connect(): Promise<Client> {
  const ws = new WebSocket(WS_URL)
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })

  let pending: {
    resolve: (reply: Reply) => void
    reject: (err: Error) => void
    startedAt: number
    text: string
    chunks: Buffer[]
    // Set by an "error" message, acted on when the terminator arrives. See
    // the handler below for why it is not acted on immediately.
    failure: Error | null
  } | null = null

  ws.on("message", (data, isBinary) => {
    // Captured once: `pending` is cleared below, and narrowing a mutable
    // closure variable does not survive that.
    const turn = pending
    if (!turn) return

    if (isBinary) {
      turn.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      return
    }

    const msg = JSON.parse(data.toString()) as { type: string; content?: string }
    if (msg.type === "assistant") turn.text = msg.content ?? ""

    // An "error" is NOT a terminator. The backend follows it with the spoken
    // apology and then "replyEnd", so failing the turn here and clearing
    // `pending` leaves those frames to be picked up by whatever turn is
    // installed next — and a stale "replyEnd" resolves that turn the moment it
    // starts, with only the audio that happened to have arrived.
    //
    // That is not hypothetical: it is what produced a 5.5-second reading for a
    // reply that takes 15.7 seconds to speak, on the turn immediately after a
    // failed one. The turn is failed when ITS terminator arrives, so every
    // frame stays attributed to the turn that owns it.
    if (msg.type === "error") {
      turn.failure = new Error(msg.content ?? "ws error")
      return
    }

    // replyEnd is the one terminator per accepted turn: it arrives after the
    // last audio chunk, so waiting on it means no chunk is missed. A dismiss
    // that follows a question sends "replyEnd" and then "sessionEnd" — the
    // first one ends the turn and the second finds no pending turn, which is
    // exactly right.
    if (msg.type === "replyEnd" || msg.type === "sessionEnd") {
      pending = null
      if (turn.failure) {
        turn.reject(turn.failure)
        return
      }
      turn.resolve({ text: turn.text, audioChunks: turn.chunks, elapsedMs: Date.now() - turn.startedAt })
    }
  })

  function await_(send: () => void): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out after 180s")), 180_000)
      pending = {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        startedAt: Date.now(),
        text: "",
        chunks: [],
        failure: null,
      }
      send()
    })
  }

  return {
    ask: (text) => await_(() => ws.send(JSON.stringify({ type: "user", content: text }))),
    askAudio: (pcm) =>
      await_(() => {
        ws.send(JSON.stringify({ type: "audioStart" }))
        // 20ms of 16kHz mono 16-bit audio per frame, as the desktop client sends it.
        for (let offset = 0; offset < pcm.length; offset += 640) {
          ws.send(pcm.subarray(offset, Math.min(offset + 640, pcm.length)))
        }
        ws.send(JSON.stringify({ type: "audioInputEnd" }))
      }),
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve())
        ws.close()
      }),
  }
}

export async function say(client: Client, text: string): Promise<Reply> {
  console.log(`  > ${text}`)
  const reply = await client.ask(text)
  console.log(`  < ${reply.text}  (${reply.elapsedMs}ms)`)
  return reply
}

// --------------------------------------------------------------- audio

// Each TTS frame is a standalone WAV. Pull the PCM out of the data chunk
// rather than assuming a 44-byte header, since Python's wave module may emit
// extra chunks.
export function pcmFromWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  const sampleRate = wav.readUInt32LE(24)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === "data") {
      return { pcm: wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length)), sampleRate }
    }
    offset += 8 + size + (size % 2)
  }
  return { pcm: Buffer.alloc(0), sampleRate }
}

// Linear resample, 24kHz (Kokoro) → 16kHz (what the STT path assumes).
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm
  const inSamples = Math.floor(pcm.length / 2)
  const outSamples = Math.floor((inSamples * to) / from)
  const out = Buffer.alloc(outSamples * 2)
  for (let i = 0; i < outSamples; i++) {
    const position = (i * from) / to
    const base = Math.floor(position)
    const frac = position - base
    const a = pcm.readInt16LE(Math.min(base, inSamples - 1) * 2)
    const b = pcm.readInt16LE(Math.min(base + 1, inSamples - 1) * 2)
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return out
}

// Speaks `text` with the TTS sidecar and returns it as 16kHz PCM, so a voice
// turn can be driven end to end without a microphone.
export async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`${config.voice.ttsUrl}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`TTS returned ${response.status}`)

  const bytes = Buffer.from(await response.arrayBuffer())
  const pieces: Buffer[] = []
  let sampleRate = 24000
  let offset = 0
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const frame = bytes.subarray(offset + 4, offset + 4 + length)
    const { pcm, sampleRate: rate } = pcmFromWav(frame)
    sampleRate = rate
    pieces.push(pcm)
    offset += 4 + length
  }
  return resample(Buffer.concat(pieces), sampleRate, 16000)
}

export function audioSeconds(chunks: Buffer[]): number {
  let samples = 0
  let rate = 24000
  for (const chunk of chunks) {
    const { pcm, sampleRate } = pcmFromWav(chunk)
    rate = sampleRate
    samples += pcm.length / 2
  }
  return samples / rate
}

export const MARKDOWN_MARKERS = ["**", "__", "##", "```", "- ", "* ", "](", "~~"]

export function markdownIn(text: string): string[] {
  const found = MARKDOWN_MARKERS.filter((marker) => text.includes(marker))
  if (/^\s*\d+[.)]\s/m.test(text)) found.push("numbered list")
  return found
}

