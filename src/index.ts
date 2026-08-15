import "./tools/register"
import { config } from "./config"
import { runHarness } from "./core/harness"
import { createRestServer } from "./api/rest"
import { createWsServer } from "./api/websocket"

async function main() {
  console.log(`Ixa — ${config.llm.model} @ ${config.llm.baseURL}`)

  if (!config.llm.apiKey) {
    console.error("ERROR: LLM_API_KEY is not set. Copy .env.example to .env and fill in your key.")
    process.exit(1)
  }

  await Promise.all([
    createRestServer(config.server.port),
    createWsServer(config.server.wsPort),
  ])

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
