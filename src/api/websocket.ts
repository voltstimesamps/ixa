import { WebSocketServer } from "ws"
import { Session } from "../core/session"
import { createWsConfirmer, resolveConfirmation } from "../core/confirmation"
import { speak } from "../voice/tts"
import { transcribe, pcmToWav } from "../voice/stt"
import type { WsMessage } from "./types"

export function createWsServer(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wss = new WebSocketServer({ port })

    wss.once("listening", () => {
      wss.off("error", reject)
      wss.on("error", (err) => console.error("WS server error:", err))
      console.log(`WS server listening on ws://localhost:${port}`)
      resolve()
    })

    wss.on("error", reject)

    wss.on("connection", (ws) => {
      const send = (msg: WsMessage) => ws.send(JSON.stringify(msg))
      const session = new Session(createWsConfirmer(send))

      send({ type: "sessionStart" })

      const handleUserMessage = async (text: string) => {
        try {
          const result = await session.send(text)
          send({ type: "assistant", content: result })

          if (result.trim()) {
            try {
              const audio = await speak(result)
              send({ type: "audioStart" })
              ws.send(audio)
              send({ type: "audioOutputEnd" })
            } catch (err) {
              console.error("TTS error:", err instanceof Error ? err.message : String(err))
            }
          }
        } catch (err) {
          const content = err instanceof Error ? err.message : String(err)
          send({ type: "error", content })
          ws.close()
        }
      }

      ws.on("message", async (data, isBinary) => {
        if (isBinary) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          session.appendAudioChunk(chunk)
          return
        }

        try {
          const msg: WsMessage = JSON.parse(data.toString()) as WsMessage

          if (msg.type === "user") {
            await handleUserMessage(msg.content ?? "")
          } else if (msg.type === "audioStart") {
            session.startAudioInput()
          } else if (msg.type === "audioInputEnd") {
            const pcm = session.endAudioInput()
            if (pcm && pcm.length > 0) {
              try {
                const { text } = await transcribe(pcmToWav(pcm))
                if (text.trim()) {
                  await handleUserMessage(text)
                } else {
                  console.log("STT: empty transcript, discarding")
                }
              } catch (err) {
                console.error("STT error:", err instanceof Error ? err.message : String(err))
                send({ type: "error", content: "Transcription failed" })
              }
            }
          } else if (msg.type === "confirmReply") {
            if (msg.requestId && msg.content) {
              resolveConfirmation(msg.requestId, msg.content)
            }
          } else {
            console.log(`WS: ignoring message type "${msg.type}"`)
          }
        } catch (err) {
          const content = err instanceof Error ? err.message : String(err)
          send({ type: "error", content })
          ws.close()
        }
      })

      ws.on("close", () => {
        console.log("WS: session ended")
      })

      ws.on("error", (err) => {
        console.error("WS error:", err.message)
      })
    })
  })
}
