import path from "path"
import * as dotenv from "dotenv"
dotenv.config()

// Resolved against this module, not the process CWD: src/config.ts and the
// compiled dist/config.js both sit exactly one level under the repo root, so
// the default data directory is the same whether Ixa runs via tsx or node.
const repoRoot = path.resolve(__dirname, "..")

export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "openai/gpt-oss-20b",
  },
  voice: {
    enabled: process.env.VOICE_MODE === "true",
    ttsUrl: process.env.TTS_URL ?? "http://localhost:5001",
    sttUrl: process.env.STT_URL ?? "http://localhost:5002",
    sttModel: process.env.STT_MODEL ?? "base.en",
  },
  qdrant: {
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
    // Separate collection names let a verification run index throwaway
    // episodes without touching the real one.
    collection: process.env.QDRANT_COLLECTION || "ixa_episodes",
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? "http://localhost:11434",
    embedModel: process.env.IXA_EMBED_MODEL || "nomic-embed-text",
    // Ollama unloads a model after 5 minutes by default, and reloading
    // nomic-embed-text costs ~0.5s — enough to blow the recall budget on the
    // first turn after a quiet spell. Keeping it resident costs ~274MB.
    embedKeepAlive: process.env.IXA_EMBED_KEEP_ALIVE || "1h",
  },
  memory: {
    // Episodic memory. SQLite is the source of truth; Qdrant is a rebuildable
    // index over it, so every one of these can change without data loss.
    recallTopK: parseInt(process.env.IXA_RECALL_TOP_K ?? "3"),
    // Cosine similarity floor. Measured with nomic-embed-text and its
    // search_query/search_document prefixes: genuinely related questions score
    // 0.65-0.74, unrelated ones top out at 0.54.
    recallMinScore: parseFloat(process.env.IXA_RECALL_MIN_SCORE ?? "0.60"),
    // Whole-budget cap on embed + search for one turn. Warm embedding measures
    // ~40ms, so this is ~7x headroom; past it, the turn proceeds without
    // recall rather than making the user wait.
    recallTimeoutMs: parseInt(process.env.IXA_RECALL_TIMEOUT_MS ?? "300"),
    recallMaxChars: parseInt(process.env.IXA_RECALL_MAX_CHARS ?? "1500"),
    // A session with fewer than this many user turns is not worth a summary.
    minUserTurns: parseInt(process.env.IXA_EPISODE_MIN_USER_TURNS ?? "2"),
    summaryInputChars: parseInt(process.env.IXA_EPISODE_SUMMARY_INPUT_CHARS ?? "12000"),
    // How often to retry episodes that are saved but not yet indexed.
    indexRetryMs: parseInt(process.env.IXA_EPISODE_INDEX_RETRY_MS ?? "300000"),
    searchLimit: parseInt(process.env.IXA_MEMORY_SEARCH_LIMIT ?? "5"),
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
  session: {
    // Sessions outlive client connections; they end only on an idle timeout or
    // an explicit reset. The clock runs from the last completed turn, not from
    // the last connection, so an unattended session still expires.
    idleTimeoutMs: parseInt(process.env.IXA_SESSION_IDLE_TIMEOUT_MS ?? "1800000"),
    // Context window budget for what is SENT to the LLM. Stored history is
    // never trimmed. Both limits apply; whichever is hit first stops the walk.
    contextMaxMessages: parseInt(process.env.IXA_CONTEXT_MAX_MESSAGES ?? "40"),
    contextBudgetChars: parseInt(process.env.IXA_CONTEXT_BUDGET_CHARS ?? "24000"),
  },
  data: {
    // One SQLite file holds preferences and persisted sessions. The directory
    // is gitignored — it is runtime state, not source.
    // `||`, not `??`: a bare `IXA_DB_PATH=` line copied from .env.example is
    // an empty string, which must fall back to the default rather than open a
    // database at "".
    dbPath: process.env.IXA_DB_PATH || path.join(repoRoot, "data", "ixa.db"),
  },
  preferences: {
    // Active preferences are injected into every LLM call, so the block has to
    // be bounded or a drifting store would crowd out conversation history.
    // ~2000 chars is under a tenth of the default context budget.
    maxInjected: parseInt(process.env.IXA_PREFS_MAX_INJECTED ?? "40"),
    maxChars: parseInt(process.env.IXA_PREFS_MAX_CHARS ?? "2000"),
  },
  sidecars: {
    // The harness spawns sidecars/{stt,tts}/main.py itself. Set false to run
    // them by hand (or on a platform where they can't run at all).
    autostart: process.env.SIDECAR_AUTOSTART !== "false",
    // Generous by default: first run downloads the whisper/Kokoro weights.
    timeoutMs: parseInt(process.env.SIDECAR_TIMEOUT_MS ?? "300000"),
  },
} as const
