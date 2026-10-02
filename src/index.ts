import "./tools/register"
import { config } from "./config"
import { runHarness } from "./core/harness"
import { createRestServer } from "./api/rest"
import { createWsServer } from "./api/websocket"
import { startSidecars } from "./core/sidecars"
import { startScheduler } from "./proactive/scheduler"
import { SessionManager } from "./core/session-manager"

async function main() {
  console.log(`Ixa — ${config.llm.model} @ ${config.llm.baseURL}`)

  // One manager owns every session. Sessions outlive the connections attached
  // to them, so a client can drop and reconnect without losing context.
  const sessions = new SessionManager({
    idleTimeoutMs: config.session.idleTimeoutMs,
    limits: {
      maxMessages: config.session.contextMaxMessages,
      budgetChars: config.session.contextBudgetChars,
    },
  })

  sessions.onSessionEnd((session, reason) => {
    // Phase 3c writes episodic summaries here: summarize session.history(),
    // embed it with nomic-embed-text, and upsert it to Qdrant.
  })

  if (!config.llm.apiKey) {
    console.error("ERROR: LLM_API_KEY is not set. Copy .env.example to .env and fill in your key.")
    process.exit(1)
  }

  // REST first, so /health and the /test page answer while the sidecar models
  // load. Sidecars next — a WebSocket client that connects before they are up
  // can neither transcribe nor speak, so WS only opens once they are ready.
  await createRestServer(config.server.port, sessions)
  await startSidecars()
  await createWsServer(config.server.wsPort, sessions)

  startScheduler()

  if (config.voice.enabled) {
    console.log("Voice mode: active. Awaiting WebSocket clients.")
  } else {
    console.log("Text mode: starting stdin REPL.")
    await runHarness(sessions)
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
