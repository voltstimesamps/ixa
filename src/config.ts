import os from "os"
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
    // Hard ceiling on ONE chat() call, the SDK's own retries included. The
    // SDK's request timeout only covers getting the response headers — it is
    // cleared the moment they arrive, so a stream that stops mid-reply would
    // otherwise hang the turn forever. Deliberately generous: a slower local
    // model later must not be cut off mid-thought. The inactivity deadline
    // below is what actually catches a stall.
    requestTimeoutMs: parseInt(process.env.LLM_REQUEST_TIMEOUT_MS ?? "120000"),
    // Abort if no chunk arrives for this long. Groq's time-to-first-token is
    // well under a second, so this is a stall, not slowness.
    streamIdleTimeoutMs: parseInt(process.env.LLM_STREAM_IDLE_TIMEOUT_MS ?? "15000"),
    // Explicit rather than inherited: the SDK's default is also 2, but a
    // silent default is a thing nobody knows is there. Retries happen inside
    // one request ceiling, so they cannot extend a turn without bound.
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES ?? "2"),
  },
  tools: {
    // A backstop above every tool's own limit, not a substitute for one: a
    // tool that owns a network call or a subprocess bounds it itself (see
    // httpTimeoutMs, and the execFile timeouts in the shell tools). This
    // catches the ones that forget — including MCP tools in Phase 4, whose
    // timeout behaviour is not ours to set. Time spent waiting for a
    // confirmation is NOT counted against it.
    timeoutMs: parseInt(process.env.IXA_TOOL_TIMEOUT_MS ?? "45000"),
    // Deadline for a tool's outbound HTTP call (web_search, ntfy). Well
    // inside timeoutMs so the tool returns its own error message rather than
    // being abandoned by the backstop.
    httpTimeoutMs: parseInt(process.env.IXA_TOOL_HTTP_TIMEOUT_MS ?? "15000"),
    // How many web_search calls one turn may run. Nothing bounded this
    // before: the tool loop caps ITERATIONS at 10, and a single iteration can
    // carry any number of parallel calls, so one live price question fired
    // eight searches with several queries repeated verbatim.
    //
    // 3 because that is what the context budget holds. An uncapped Tavily
    // result is ~5300 chars and the four results of one parallel group come
    // to ~21.4k against contextBudgetChars' 24000 — past three, results start
    // evicting the turn that gathered them, and the model searches again for
    // what it can no longer see. Set to 0 to turn the cap off.
    maxSearchesPerTurn: parseInt(process.env.IXA_MAX_SEARCHES_PER_TURN ?? "3"),
  },
  confirm: {
    // How long a confirmation prompt stays answerable before it is treated as
    // a no. 60s, not 30: the old 30 was a hard-coded default in two confirmers
    // and it is a person being asked a question, not a tool hanging — and the
    // desktop client used to block its whole event loop on a stdin read, so a
    // prompt that outlived the timeout was answered into a void. The deadline
    // is now sent to the client (an optional `timeoutMs` on the `confirm`
    // message) so it can show the time remaining and decline locally rather
    // than leave the user typing at an expired prompt.
    timeoutMs: parseInt(process.env.IXA_CONFIRM_TIMEOUT_MS ?? "60000"),
  },
  voice: {
    enabled: process.env.VOICE_MODE === "true",
    ttsUrl: process.env.TTS_URL ?? "http://localhost:5001",
    sttUrl: process.env.STT_URL ?? "http://localhost:5002",
    sttModel: process.env.STT_MODEL ?? "base.en",
    // Abort synthesis if the sidecar sends no audio frame for this long.
    // Without it, a TTS sidecar that accepts the request and then hangs holds
    // the turn open forever — including the turn-failure path, where the
    // whole point is that the client gets its terminator promptly. Generous,
    // because the first frame of a cold Kokoro waits on the model loading.
    ttsIdleTimeoutMs: parseInt(process.env.TTS_IDLE_TIMEOUT_MS ?? "20000"),
    // Hard ceiling on how many spoken units (sentences, and the list items the
    // sanitizer turns into sentences) a voice reply may contain. The backstop
    // behind VOICE_RESPONSE_PROMPT, for the replies where the prompt loses.
    // Set to 0 to turn it off, which is how the scoreboard measures the prompt
    // change on its own.
    maxSpokenSentences: parseInt(process.env.IXA_VOICE_MAX_SENTENCES ?? "3"),
    // The other half of the same backstop, and in practice the binding one.
    // Measured: the model keeps to three sentences and then writes sentences of
    // 5 to 12 seconds each, so counting full stops bounded the number of pauses
    // and not the length of the reply. 40 words is a little above the ~35 the
    // prompt asks for, so an answer that lands on budget is never cut.
    maxSpokenWords: parseInt(process.env.IXA_VOICE_MAX_WORDS ?? "40"),
    // Domain words faster-whisper is told to expect. base.en has never heard
    // of most of these, and the ones it mishears it mishears expensively:
    // "RTX 3090" came back as "$30.90" in a live price question.
    // The bare brand names survive on their own; the MODEL NUMBERS do not.
    // Live testing heard "RTX 3090" as "RTX 39D" — the decoder got "RTX" and
    // then guessed at four digits it had no reason to expect. Whole model
    // names are listed for that reason, not for completeness: the hint slot
    // competes with the audio, so a longer list makes every entry weaker.
    sttHotwords:
      process.env.IXA_STT_HOTWORDS ??
      "Ixa, RTX, GPU, VRAM, Groq, Kokoro, Qdrant, Ollama, Tailscale, " +
        "RTX 3090, RTX 4090, RTX 5090",
    // How the hint list reaches faster-whisper: "hotwords", "prompt", "both"
    // or "off". Both mechanisms land in the same decoder slot and compose —
    // see sidecars/stt/hints.py.
    //
    // Measured in dev/scripts/stt-vocab-check.py: with no hints base.en got 9
    // of 14 domain phrases, and "hotwords", "prompt" and "both" all got 14 of
    // 14. "prompt" wins the tie on transcript quality — "hotwords" alone comes
    // back as "is the RTX 3090 still worth buying." with no capital and no
    // question mark, where "prompt" returns a properly formed sentence.
    sttHintMode: process.env.IXA_STT_HINT_MODE ?? "prompt",
    // Segment filtering, applied to faster-whisper's own per-segment scores.
    // Whisper invents words over noise — a live session recorded "Please the
    // President." as a user turn — and these are what drop them. Both are
    // thresholds on the model's confidence, not on the text.
    //
    // 0.6 / -1.0 is the tightest pair that is SAFE: at 0.5 / -0.8 a
    // synthesized "yes" is filtered away, and confirmations are answered with
    // single words, so a threshold that drops one is wrong however many
    // hallucinations it removes. Its benefit is not yet proven — the only
    // noise sample on hand is digital silence, which transcribes to nothing
    // either way, while the hallucination seen live came from a room with
    // sound in it. Add a room-tone recording as Ixa-Tests/stt/noise-*.wav and
    // the check script will measure it.
    sttMaxNoSpeechProb: parseFloat(process.env.IXA_STT_MAX_NO_SPEECH_PROB ?? "0.6"),
    sttMinAvgLogprob: parseFloat(process.env.IXA_STT_MIN_AVG_LOGPROB ?? "-1.0"),
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
  notes: {
    // Ixa's notebook. SHE is the only writer: the markdown files are the
    // source of truth, and the note/chunk rows in SQLite plus the Qdrant
    // collection are both rebuildable from them.
    //
    // Default OUTSIDE the repo. `||` not `??`, so a bare OBSIDIAN_VAULT_PATH=
    // line copied from .env.example falls back rather than resolving to "" —
    // which would put the vault at the process CWD and write notes into
    // whatever directory Ixa happened to be started from. Kept under the old
    // variable name because that is what .env.example already documents.
    vaultPath: process.env.OBSIDIAN_VAULT_PATH || path.join(os.homedir(), "Ixa-Vault"),
    // A SECOND collection, never the episode one. Note vectors and episode
    // vectors answer different questions and are filtered differently.
    collection: process.env.IXA_NOTES_COLLECTION || "ixa_notes",
    // Chunking, in proxy tokens (chars / 4 — see note-chunks.ts for why there
    // is no tokenizer). A section under the floor merges into its neighbour; a
    // group over the ceiling splits on paragraph boundaries.
    minTokens: parseInt(process.env.IXA_NOTE_CHUNK_MIN_TOKENS ?? "150"),
    maxTokens: parseInt(process.env.IXA_NOTE_CHUNK_MAX_TOKENS ?? "400"),
    // How many notes a search returns. Three, and NO SCORE FLOOR: measured
    // over 19 questions against 24 notes, text that answered the question
    // scored as low as 0.586 while text from an unrelated note reached 0.755,
    // so the bands overlap completely and any threshold cuts real answers.
    // The tool result tells the model the hits may be unrelated instead.
    searchLimit: parseInt(process.env.IXA_NOTE_SEARCH_LIMIT ?? "3"),
    // Whole-budget cap on embed + search for one search_notes call. Looser
    // than recall's 300ms because this one is a tool the user asked for, not
    // an automatic step in front of every turn.
    searchTimeoutMs: parseInt(process.env.IXA_NOTE_SEARCH_TIMEOUT_MS ?? "3000"),
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
  dev: {
    // Tools that exist to exercise the harness, not to serve the user. Off by
    // default: `echo` is one LLM-visible tool with a description that reads
    // like a way to deliver a reply ("Echoes back the provided message"), and
    // in live use the model called it to say something conversational — which
    // tripped the confirmation gate for a plain sentence. It is also the only
    // safe way to exercise that gate by hand, so it is kept behind a flag
    // rather than deleted.
    tools: process.env.IXA_DEV_TOOLS === "1",
  },
  sidecars: {
    // The harness spawns sidecars/{stt,tts}/main.py itself. Set false to run
    // them by hand (or on a platform where they can't run at all).
    autostart: process.env.SIDECAR_AUTOSTART !== "false",
    // Generous by default: first run downloads the whisper/Kokoro weights.
    timeoutMs: parseInt(process.env.SIDECAR_TIMEOUT_MS ?? "300000"),
  },
} as const
