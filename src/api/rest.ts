import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { config } from "../config"
import { Session } from "../core/session"
import type { Confirmer } from "../core/confirmation"

const noopConfirmer: Confirmer = async () => {
  console.warn("Confirmation required but REST has no confirmation channel — action blocked.")
  return false
}

export function createRestServer(port: number): Promise<void> {
  const app = new Hono()
  let session = new Session(noopConfirmer)

  app.post("/chat", async (c) => {
    try {
      const body = await c.req.json<{ message: string }>()
      const response = await session.send(body.message)
      return c.json({ response })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  app.post("/reset", (c) => {
    session = new Session(noopConfirmer)
    return c.json({ ok: true })
  })

  app.get("/health", (c) => {
    return c.json({ ok: true, model: config.llm.model })
  })

  return new Promise<void>((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname: "0.0.0.0" },
      () => {
        server.off("error", reject)
        server.on("error", (err) => console.error("REST server error:", err))
        console.log(`REST server listening on http://localhost:${port}`)
        resolve()
      }
    )
    server.on("error", reject)
  })
}
