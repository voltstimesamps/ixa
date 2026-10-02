import { config } from "../config"

// The sidecar streams the response as a sequence of length-prefixed frames
// (4-byte big-endian length + that many bytes of an independently-valid WAV
// blob) over a chunked HTTP body, one frame per Kokoro-synthesized chunk.
// This lets us forward audio to the client as it's synthesized instead of
// waiting for the full reply.
//
// `signal` aborts the sidecar request itself, not just the forwarding. Kokoro
// is CPU-bound, so synthesizing a reply nobody can hear would delay the next
// real reply — when the originating connection goes away, the work stops.
export interface SpeakOptions {
  voice?: string
  signal?: AbortSignal
}

export async function speakStreaming(
  text: string,
  onChunk: (chunk: Buffer) => void,
  options: SpeakOptions = {},
): Promise<void> {
  const { voice, signal } = options
  if (signal?.aborted) return

  let res: Response
  try {
    res = await fetch(`${config.voice.ttsUrl}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(voice ? { text, voice } : { text }),
      signal,
    })
  } catch (err) {
    if (isAbort(err, signal)) return
    throw err
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`TTS sidecar returned ${res.status}: ${body}`)
  }
  if (!res.body) {
    throw new Error("TTS sidecar returned no response body")
  }

  const reader = res.body.getReader()
  let pending = Buffer.alloc(0)

  try {
    while (true) {
      if (signal?.aborted) break

      const { done, value } = await reader.read()
      if (done) break

      pending = pending.length > 0 ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value)

      while (pending.length >= 4) {
        const frameLen = pending.readUInt32BE(0)
        if (pending.length < 4 + frameLen) break
        onChunk(Buffer.from(pending.subarray(4, 4 + frameLen)))
        pending = pending.subarray(4 + frameLen)
      }
    }
  } catch (err) {
    if (!isAbort(err, signal)) throw err
  } finally {
    // Closes the HTTP stream so the sidecar stops synthesizing.
    await reader.cancel().catch(() => {})
  }
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError")
}
