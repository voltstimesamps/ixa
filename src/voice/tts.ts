import { config } from "../config"

export async function speak(text: string, voice?: string): Promise<Buffer> {
  const res = await fetch(`${config.voice.ttsUrl}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(voice ? { text, voice } : { text }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`TTS sidecar returned ${res.status}: ${body}`)
  }

  return Buffer.from(await res.arrayBuffer())
}
