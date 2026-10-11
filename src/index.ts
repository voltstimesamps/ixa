import "./tools/register"
import { config } from "./config"
import { runHarness } from "./core/harness"
import { createRestServer } from "./api/rest"
import { createWsServer } from "./api/websocket"
import { startSidecars } from "./core/sidecars"
import { startScheduler } from "./proactive/scheduler"
import { SessionManager } from "./core/session-manager"
import { getPreferenceStore } from "./memory/preferences"
import { getDatabase } from "./memory/db"
import { getEpisodeStore } from "./memory/episodes"
import { OllamaEmbedder } from "./memory/embeddings"
import { QdrantIndex } from "./memory/qdrant"
import { EpisodicMemory, setEpisodicMemory } from "./memory/episodic-memory"
import { getNoteStore } from "./memory/notes"
import { Notebook, setNotebook } from "./memory/notebook"
import { SqliteSessionStore } from "./core/sqlite-session-store"

async function main() {
  console.log(`Ixa — ${config.llm.model} @ ${config.llm.baseURL}`)

  // Opens (and migrates) the database before anything serves traffic, so a
  // schema problem is a startup failure rather than a failed turn later.
  const db = getDatabase()
  const preferences = getPreferenceStore()
  console.log(`Preferences: ${preferences.listActive().length} active`)

  // One embedder, two consumers: episodes and notes embed into the same
  // vector space with the same model, and a second instance would only mean a
  // second warm-up.
  const embedder = new OllamaEmbedder()

  // Episodic memory. Qdrant and Ollama are optional at runtime: if either is
  // missing, Ixa logs one warning and runs without recall.
  const memory = new EpisodicMemory({
    store: getEpisodeStore(),
    embedder,
    index: new QdrantIndex(),
  })
  setEpisodicMemory(memory)

  // Ixa's notebook, in a SECOND Qdrant collection. Its payload indexes differ
  // from the episode collection's: notes filter on `status` so a superseded
  // note cannot outrank its replacement, which measurement showed it does.
  const notebook = new Notebook({
    store: getNoteStore(),
    embedder,
    index: new QdrantIndex({
      collection: config.notes.collection,
      payloadIndexes: [{ field: "status", schema: "keyword" }],
    }),
  })
  setNotebook(notebook)

  // One manager owns every session. Sessions outlive the connections attached
  // to them, so a client can drop and reconnect without losing context.
  const sessions = new SessionManager({
    idleTimeoutMs: config.session.idleTimeoutMs,
    limits: {
      maxMessages: config.session.contextMaxMessages,
      budgetChars: config.session.contextBudgetChars,
    },
    preferenceBlock: () => preferences.injectionBlock(),
    lastEpisode: () => memory.lastEpisodeLine(),
    recall: (userInput) => memory.recall(userInput),
    // Sessions now survive a backend restart. InMemorySessionStore stays the
    // default inside the manager, which is what the tests use.
    store: new SqliteSessionStore(db),
  })

  sessions.onSessionEnd((session, reason) => {
    console.log(
      `Session ${session.id} ended (${reason}): ${session.history().length} messages`
    )
    // Summarize, store and index. Returns immediately; the work is detached.
    memory.handleSessionEnd(session, reason)
  })

  // Probe Qdrant/Ollama, warm the embedding model and drain any episodes that
  // were saved while they were down. Never fatal.
  await memory.start()
  // Same for the notebook: the collection is created if missing, and any note
  // whose chunks were written while Qdrant was down is indexed now. A note on
  // disk with no vector is unsearchable, never lost.
  await notebook.start()

  // After the handlers are registered, so a session that expired while the
  // backend was down still fires onSessionEnd (and gets summarized).
  if (!sessions.restorePrimary()) {
    console.log("No live session to restore; starting fresh.")
  }

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
