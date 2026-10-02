// Voice-path smoke test: one text turn over WebSocket, confirming the reply
// comes back AND is spoken as streamed TTS chunks. Run with the dev server up.
import { WebSocket } from "ws"

const WS_URL = process.env.IXA_WS_URL ?? "ws://localhost:3001"

async function main(): Promise<void> {
  const ws = new WebSocket(WS_URL)
  const startedAt = Date.now()
  let audioStart = false
  let chunks = 0
  let bytes = 0
  let firstChunkMs = 0
  let reply = ""

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "user", content: "Say hello in one short sentence." }))
    })
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        chunks++
        bytes += (data as Buffer).length
        if (chunks === 1) firstChunkMs = Date.now() - startedAt
        return
      }
      const msg = JSON.parse(data.toString())
      if (msg.type === "assistant") reply = msg.content ?? ""
      if (msg.type === "audioStart") audioStart = true
      if (msg.type === "audioOutputEnd") resolve()
      if (msg.type === "error") reject(new Error(msg.content))
    })
    ws.on("error", reject)
    setTimeout(() => reject(new Error("timed out waiting for audioOutputEnd")), 90_000)
  })

  ws.close()

  console.log(`reply:        ${JSON.stringify(reply)}`)
  console.log(`audioStart:   ${audioStart}`)
  console.log(`audio chunks: ${chunks} (${bytes} bytes), first at ${firstChunkMs}ms`)
  console.log(chunks > 0 && reply.trim() ? "VOICE PATH OK" : "VOICE PATH FAILED")
  process.exit(chunks > 0 && reply.trim() ? 0 : 1)
}

main().catch((err) => {
  console.error("voice smoke failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
