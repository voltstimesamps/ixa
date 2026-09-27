import { config } from "../config"

const SAMPLE_RATE = 16000
const CHANNELS = 1
const BIT_DEPTH = 16

export interface TranscriptionResult {
  text: string
  language: string
  durationMs: number
}

export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = CHANNELS, bitDepth = BIT_DEPTH): Buffer {
  const blockAlign = channels * (bitDepth / 8)
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)

  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

export async function transcribe(wav: Buffer): Promise<TranscriptionResult> {
  const res = await fetch(`${config.voice.sttUrl}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    // Copied into a plain view: fetch's BodyInit doesn't accept Node's Buffer.
    body: new Uint8Array(wav),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`STT sidecar returned ${res.status}: ${body}`)
  }

  return (await res.json()) as TranscriptionResult
}
