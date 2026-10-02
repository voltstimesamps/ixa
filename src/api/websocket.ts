import { randomUUID } from "crypto"
import { WebSocket, WebSocketServer } from "ws"
import type { MessageOrigin } from "../core/session"
import type { SessionManager } from "../core/session-manager"
import type { Connection } from "../core/connection"
import { createWsConfirmer, resolveConfirmation } from "../core/confirmation"
import { speakStreaming } from "../voice/tts"
import { transcribe, pcmToWav } from "../voice/stt"
import { isDismissPhrase, DISMISS_ACKNOWLEDGMENT } from "../voice/dismiss"
import type { WsMessage } from "./types"

export function createWsServer(port: number, sessions: SessionManager): Promise<void> {
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
      const connectionId = randomUUID()
      const isOpen = () => ws.readyState === WebSocket.OPEN

      const send = (msg: WsMessage) => {
        if (isOpen()) ws.send(JSON.stringify(msg))
      }

      const connection: Connection = {
        id: connectionId,
        confirmer: createWsConfirmer(connectionId, send),
        get isOpen() {
          return isOpen()
        },
        send,
        sendBinary: (chunk: Buffer) => {
          if (isOpen()) ws.send(chunk)
        },
      }

      // Audio input buffering is per-socket, not per-session: a session can
      // have several connections attached, and two clients streaming at once
      // must not interleave PCM into one buffer.
      let audioChunks: Buffer[] | null = null

      // Aborts in-flight TTS when this socket goes away.
      let speechAbort: AbortController | null = null

      sessions.attach(connection)
      send({ type: "sessionStart" })

      const speak = async (text: string) => {
        const abort = new AbortController()
        speechAbort = abort
        try {
          let started = false
          await speakStreaming(
            text,
            (chunk) => {
              if (!connection.isOpen) return
              if (!started) {
                started = true
                send({ type: "audioStart" })
              }
              connection.sendBinary(chunk)
            },
            { signal: abort.signal },
          )
          if (started) {
            send({ type: "audioOutputEnd" })
          }
        } catch (err) {
          console.error("TTS error:", err instanceof Error ? err.message : String(err))
        } finally {
          if (speechAbort === abort) speechAbort = null
        }
      }

      const handleUserMessage = async (text: string, origin: MessageOrigin) => {
        try {
          // Resolved through the manager every turn — never a cached Session.
          const result = await sessions.submitTurn(text, connection, origin)
          send({ type: "assistant", content: result })
          // Audio for a turn goes only to the connection that originated it,
          // and nothing is replayed to a client that reconnects later.
          if (result.trim() && connection.isOpen) {
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
          audioChunks?.push(chunk)
          return
        }

        try {
          const msg: WsMessage = JSON.parse(data.toString()) as WsMessage

          if (msg.type === "user") {
            await handleUserMessage(msg.content ?? "", "text")
          } else if (msg.type === "audioStart") {
            audioChunks = []
          } else if (msg.type === "audioInputEnd") {
            const pcm = audioChunks ? Buffer.concat(audioChunks) : null
            audioChunks = null
            if (pcm && pcm.length > 0) {
              try {
                const { text } = await transcribe(pcmToWav(pcm))
                if (!text.trim()) {
                  console.log("STT: empty transcript, discarding")
                } else if (isDismissPhrase(text)) {
                  // A dismiss closes the CLIENT's listening window, like the
                  // client-side conversation timeout. It does not end the
                  // session: with one shared session, a dismiss on one device
                  // would otherwise wipe context for every device.
                  console.log("Dismiss phrase detected, ending listening window")
                  await speak(DISMISS_ACKNOWLEDGMENT)
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
              resolveConfirmation(msg.requestId, msg.content, connectionId)
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
        // The session survives. Only this connection goes: its pending
        // confirmations resolve as cancelled, and any TTS still synthesizing
        // for it is abandoned. A turn already in the tool loop runs to
        // completion and records its result in history.
        audioChunks = null
        speechAbort?.abort()
        speechAbort = null
        sessions.detach(connectionId)
        console.log(`WS: connection ${connectionId} closed (session preserved)`)
      })

      ws.on("error", (err) => {
        console.error("WS error:", err.message)
      })
    })
  })
}
