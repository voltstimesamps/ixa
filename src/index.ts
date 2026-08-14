import { config } from "./config"

async function main() {
  console.log("Ixa starting...")
  console.log(`LLM backend: ${config.llm.baseURL}`)
  console.log(`LLM model:   ${config.llm.model}`)
  console.log(`Voice mode:  ${config.voice.enabled ? "enabled" : "disabled (text mode)"}`)

  if (!config.llm.apiKey) {
    console.error("ERROR: LLM_API_KEY is not set. Copy .env.example to .env and fill in your Groq key.")
    process.exit(1)
  }

  // Phase 1: voice loop + basic chat
  // Claude Code will build out from here.
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
