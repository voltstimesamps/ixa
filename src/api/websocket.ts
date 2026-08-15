import { WebSocketServer } from "ws"
import { Session } from "../core/session"
import { createWsConfirmer, resolveConfirmation } from "../core/confirmation"
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

      ws.on("message", async (data, isBinary) => {
        if (isBinary) {
          console.log("binary frame received, ignoring (voice not yet implemented)")
          return
        }

        try {
          const msg: WsMessage = JSON.parse(data.toString()) as WsMessage

          if (msg.type === "user") {
            try {
              const result = await session.send(msg.content ?? "")
              send({ type: "assistant", content: result })
            } catch (err) {
              const content = err instanceof Error ? err.message : String(err)
              send({ type: "error", content })
              ws.close()
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
