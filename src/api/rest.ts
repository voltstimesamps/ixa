import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { config } from "../config"
import type { SessionManager } from "../core/session-manager"
import type { Connection } from "../core/connection"
import type { Confirmer } from "../core/confirmation"
import { listWakeFixtures, serveAsset, servedModels, servedOrt } from "./static-assets"
import { renderTestClient } from "./test-client"
import { renderWakeCheck } from "./wake-check"

const noopConfirmer: Confirmer = async () => {
  console.warn("Confirmation required but REST has no confirmation channel — action blocked.")
  return "declined"
}

// REST has no socket to go away, so one long-lived connection stands in for
// every request. Replies travel back in the HTTP response, not through send().
const restConnection: Connection = {
  id: "rest",
  confirmer: noopConfirmer,
  isOpen: true,
  send: () => {},
  sendBinary: () => {},
}

// Resolves with the server once it is listening — see createWsServer for why.
export function createRestServer(
  port: number,
  sessions: SessionManager
): Promise<ReturnType<typeof serve>> {
  const app = new Hono()

  app.post("/chat", async (c) => {
    try {
      const body = await c.req.json<{ message: string }>()
      // Same shared primary session the WebSocket clients and the REPL use.
      const response = await sessions.submitTurn(body.message, restConnection, "text")
      return c.json({ response })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  // Explicit reset: ends the shared primary session (firing onSessionEnd) and
  // starts a fresh one. Attached clients need do nothing — their next turn
  // resolves the new primary by itself.
  app.post("/reset", (c) => {
    const session = sessions.resetPrimary()
    return c.json({ ok: true, sessionId: session.id })
  })

  // Minimal push-to-talk page for testing the voice loop from a phone over
  // Tailscale. Self-contained; see src/api/test-client.ts.
  app.get("/test", (c) => {
    return c.html(renderTestClient(config.server.wsPort))
  })

  // The /test page's in-browser wake word pipeline: the three ONNX models
  // plus onnxruntime-web itself. See static-assets.ts.
  app.get("/models/:name", (c) => serveAsset(c, servedModels, c.req.param("name")))
  app.get("/vendor/ort/:name", (c) => serveAsset(c, servedOrt, c.req.param("name")))

  // Runs the browser wake word pipeline over tools/wakeword/fixtures and
  // compares it frame-by-frame against the Python baseline. Re-run after
  // retraining hey_ixa.onnx or touching wakePipelineJs. See wake-check.ts.
  app.get("/test/wake-check", (c) => c.html(renderWakeCheck()))
  app.get("/test/fixtures", async (c) => c.json((await listWakeFixtures()).fixtures))
  app.get("/test/fixtures/:name", async (c) => {
    return serveAsset(c, (await listWakeFixtures()).files, c.req.param("name"))
  })

  app.get("/health", (c) => {
    return c.json({ ok: true, model: config.llm.model })
  })

  return new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname: "0.0.0.0" },
      () => {
        server.off("error", reject)
        server.on("error", (err) => console.error("REST server error:", err))
        console.log(`REST server listening on http://localhost:${port}`)
        resolve(server)
      }
    )
    server.on("error", reject)
  })
}
