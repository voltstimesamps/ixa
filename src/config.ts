import * as dotenv from "dotenv"
dotenv.config()

export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "llama-3.3-70b-versatile",
  },
  voice: {
    enabled: process.env.VOICE_MODE === "true",
  },
  qdrant: {
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? "http://localhost:11434",
  },
  obsidian: {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH ?? "",
  },
  homeAssistant: {
    url: process.env.HA_URL ?? "",
    token: process.env.HA_TOKEN ?? "",
  },
  octoprint: {
    url: process.env.OCTOPRINT_URL ?? "",
    apiKey: process.env.OCTOPRINT_KEY ?? "",
  },
  ntfy: {
    url: process.env.NTFY_URL ?? "http://localhost:2586",
    topic: process.env.NTFY_TOPIC ?? "jarvis",
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY ?? "",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  server: {
    port: parseInt(process.env.PORT ?? "3000"),
    wsPort: parseInt(process.env.WS_PORT ?? "3001"),
  },
} as const
