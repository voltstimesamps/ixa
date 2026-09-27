import "./tools/register"
import { config } from "./config"
import { runHarness } from "./core/harness"
import { createRestServer } from "./api/rest"
import { createWsServer } from "./api/websocket"
import { startSidecars } from "./core/sidecars"
import { startScheduler } from "./proactive/scheduler"

async function main() {
  console.log(`Ixa — ${config.llm.model} @ ${config.llm.baseURL}`)

  if (!config.llm.apiKey) {
    console.error("ERROR: LLM_API_KEY is not set. Copy .env.example to .env and fill in your key.")
    process.exit(1)
  }

  // REST first, so /health and the /test page answer while the sidecar models
  // load. Sidecars next — a WebSocket client that connects before they are up
  // can neither transcribe nor speak, so WS only opens once they are ready.
  await createRestServer(config.server.port)
  await startSidecars()
  await createWsServer(config.server.wsPort)

  startScheduler()

  if (config.voice.enabled) {
    console.log("Voice mode: active. Awaiting WebSocket clients.")
  } else {
    console.log("Text mode: starting stdin REPL.")
    await runHarness()
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
