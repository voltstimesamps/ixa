import { WebSocketServer } from "ws"
import { Session, type MessageOrigin } from "../core/session"
import { createWsConfirmer, resolveConfirmation } from "../core/confirmation"
import { speakStreaming } from "../voice/tts"
import { transcribe, pcmToWav } from "../voice/stt"
import { isDismissPhrase, DISMISS_ACKNOWLEDGMENT } from "../voice/dismiss"
import type { WsMessage } from "./types"

export function createWsServer(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 20MB backstop against a single oversized frame; real scaling comes from
    // streaming TTS output as multiple smaller chunks (see speakStreaming).
    const wss = new WebSocketServer({ port, maxPayload: 20 * 1024 * 1024 })

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

      const speak = async (text: string) => {
        try {
          let started = false
          await speakStreaming(text, (chunk) => {
            if (!started) {
              started = true
              send({ type: "audioStart" })
            }
            ws.send(chunk)
          })
          if (started) {
            send({ type: "audioOutputEnd" })
          }
        } catch (err) {
          console.error("TTS error:", err instanceof Error ? err.message : String(err))
        }
      }

      const handleUserMessage = async (text: string, origin: MessageOrigin) => {
        try {
          const result = await session.send(text, origin)
          send({ type: "assistant", content: result })
          if (result.trim()) {
            await speak(result)
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
            await handleUserMessage(msg.content ?? "", "text")
          } else if (msg.type === "audioStart") {
            session.startAudioInput()
          } else if (msg.type === "audioInputEnd") {
            const pcm = session.endAudioInput()
            if (pcm && pcm.length > 0) {
              try {
                const { text } = await transcribe(pcmToWav(pcm))
                if (!text.trim()) {
                  console.log("STT: empty transcript, discarding")
                } else if (isDismissPhrase(text)) {
                  console.log("Dismiss phrase detected, ending conversation")
                  await speak(DISMISS_ACKNOWLEDGMENT)
                  session.reset()
                  send({ type: "sessionEnd" })
                } else {
                  await handleUserMessage(text, "voice")
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
