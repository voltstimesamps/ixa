import { randomUUID } from "crypto"
import { config } from "../config"
import { WebSocket, WebSocketServer } from "ws"
import type { MessageOrigin } from "../core/session"
import type { SessionManager } from "../core/session-manager"
import type { Connection } from "../core/connection"
import { createWsConfirmer, resolveConfirmation } from "../core/confirmation"
import { speakStreaming } from "../voice/tts"
import { sanitizeForSpeech } from "../voice/sanitize"
import { transcribe, pcmToWav } from "../voice/stt"
import { isDismissPhrase, DISMISS_ACKNOWLEDGMENT } from "../voice/dismiss"
import type { WsMessage } from "./types"

// Spoken when a turn fails. Short, fixed, and free of any suggestion about
// what went wrong: the user is mid-conversation and wants to know they can
// try again, not to hear a stack trace read aloud. The real error still goes
// out as an "error" message and into the log.
export const TURN_FAILURE_APOLOGY =
  "Sorry, something went wrong on my end. Could you try that again?"

// Resolves with the server once it is listening. index.ts ignores the handle;
// tests use it to shut the server down, which is the only way a test file can
// stop holding the event loop open.
export function createWsServer(port: number, sessions: SessionManager): Promise<WebSocketServer> {
  return new Promise<WebSocketServer>((resolve, reject) => {
    // 20MB backstop against a single oversized frame; real scaling comes from
    // streaming TTS output as multiple smaller chunks (see speakStreaming).
    const wss = new WebSocketServer({ port, maxPayload: 20 * 1024 * 1024 })

    wss.once("listening", () => {
      wss.off("error", reject)
      wss.on("error", (err) => console.error("WS server error:", err))
      console.log(`WS server listening on ws://localhost:${port}`)
      resolve(wss)
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

      // The one place text becomes audio, which is why the markdown stripping
      // lives here: the "assistant" message and the stored history above keep
      // the model's original text, and only what is spoken is sanitized.
      // Nothing is truncated — see src/voice/sanitize.ts.
      const speak = async (text: string) => {
        const spoken = sanitizeForSpeech(text)
        if (!spoken) return

        const abort = new AbortController()
        speechAbort = abort

        // An inactivity deadline, not a total one: a long reply legitimately
        // takes a long time to synthesize, but a gap between frames means the
        // sidecar has stopped producing. speakStreaming treats an abort as a
        // clean stop, so a stall ends the speech instead of the turn.
        let stall: NodeJS.Timeout | undefined
        const armStall = () => {
          clearTimeout(stall)
          stall = setTimeout(() => {
            console.error(`TTS stalled: no audio for ${config.voice.ttsIdleTimeoutMs}ms, abandoning`)
            abort.abort()
          }, config.voice.ttsIdleTimeoutMs)
        }

        try {
          let started = false
          armStall()
          await speakStreaming(
            spoken,
            (chunk) => {
              armStall()
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
          clearTimeout(stall)
          if (speechAbort === abort) speechAbort = null
        }
      }

      // Exactly one terminator per accepted turn: "replyEnd" normally, or
      // "sessionEnd" on a dismiss. A voice client stops its own conversation
      // timeout for the duration of a turn, so without a terminator it has no
      // way to know a text-only, empty or failed reply is over and would sit
      // waiting until its own safety-net timeout.
      //
      // A failed turn is still a finished turn. It gets the same treatment as
      // a successful one — something to hear, then the terminator — and the
      // socket stays open, because the conversation and the session both
      // survive one bad turn and the user's next sentence must land on them
      // rather than on a reconnect.
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
          console.error(`Turn failed: ${content}`)
          send({ type: "error", content })
          // A fixed string, never an LLM call: the thing that just failed is
          // quite likely the LLM, and asking it to apologise would hang or
          // fail exactly as the turn did.
          if (connection.isOpen) await speak(TURN_FAILURE_APOLOGY)
        } finally {
          // In a finally, not at the end of each branch: if the TTS sidecar
          // is down, speaking the apology fails too, and a client left with
          // no terminator waits out its own safety-net timeout for a turn
          // that is already over.
          send({ type: "replyEnd" })
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
                  // Usually a false VAD trigger on noise. The client is
                  // waiting on this turn, so it still needs its terminator.
                  console.log("STT: empty transcript, discarding")
                  send({ type: "replyEnd" })
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
                send({ type: "replyEnd" })
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
          // A frame that is not valid JSON, or an audio path that threw. No
          // turn was accepted, so no replyEnd — and no close either: one bad
          // frame is not a reason to drop a working conversation.
          const content = err instanceof Error ? err.message : String(err)
          console.error(`WS: bad frame — ${content}`)
          send({ type: "error", content })
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
