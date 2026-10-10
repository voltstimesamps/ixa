# Ixa — Architecture Document

> Source of truth for **decisions and their rationale**. Every Claude Code session should read this before touching code.
>
> **What this doc is authoritative for:** vision, principles, design decisions, status, and what was evaluated and rejected.
> **What it is NOT authoritative for:** exact file paths, env var names, function signatures. The code, `.env.example`, and `package.json` win on specifics. Where this doc says **(verify)**, reconcile it against the repo and update the doc.
>
> **Status markers:** ✅ built and verified · 🔜 planned / designed, not built. If you find a 🔜 item described as if it exists, the doc is wrong. Report it.
>
> Project name: **Ixa** (pronounced "eh-chs-uh"), wake phrase **"Hey Ixa"**. Internal code name: `jarvis` (appears in older notes and some identifiers).
> Repo: `voltstimesamps/ixa`. Canonical checkout: `/home/wyatt/Projects/ixa` (native WSL2 filesystem on the gaming PC).

---

## Vision

Ixa is a personal AI operating system: a persistent, voice-native agent deeply integrated with the tools and environment of daily life. It is not a chatbot with plugins. It is a coordinator with tool access, memory, and modality switching. It runs continuously in the background and can be invoked from any device.

North star: it should feel like a capable person who is always available, knows your context, remembers your history, acts on your behalf with appropriate confirmation, and is reachable at the desk, on the move, or at home.

---

## Core Philosophy

- **Backend-first intelligence.** All reasoning, tool execution, memory, and speech synthesis/recognition live on the backend. Clients stay thin and hold no conversation state.
  - **Deliberate exception:** wake-word detection and voice activity detection run **on the client**. This keeps the mic stream local until the user actually addresses Ixa, avoids streaming continuous room audio over the network, and removes a network round-trip from the latency-critical "is someone talking?" decision.
- **Always-on (target).** The harness is designed to run as a daemon that fires scheduled tasks, receives webhooks, and sends alerts with no client connected. During development it runs via `npm run dev`.
- **Swappable backends.** The LLM is reached through `LLM_BASE_URL` + `LLM_API_KEY` (+ `LLM_MODEL`) using the `openai` npm package. Moving from Groq to a homelab Ollama/llama.cpp instance is a `.env` change, not a code change.
- **Confirmation gate.** Read operations run freely. Write or act operations with real-world consequences require explicit confirmation. This is **encoded per tool at definition time, never reasoned at runtime**, and the rule applies equally to tools imported over MCP (see below).
- **Open source and self-hosted wherever practical.** Self-hosted beats SaaS, and open-weight models beat proprietary ones where quality allows. Cloud services are interim choices with a planned exit.
- **No unreviewed third-party code.** Ixa does not install tools, skills, or plugins from marketplaces without reading them. Every integration is chosen deliberately. (See *OpenClaw* under Evaluated and Not Adopted for why this matters.)

---

## Hardware Topology

### Current

```
Cloud
├── Groq API              — LLM inference (openai/gpt-oss-20b)
├── Tavily API            — Web search
└── ntfy.sh (public)      — Push notifications (dev only; self-host later)

Tailscale mesh
├── Gaming PC (Windows 11 + WSL2 Ubuntu) — BACKEND + dev environment
│   ├── Ryzen 5 5600G (6C/12T), RX 6600 XT (AMD — no CUDA; TTS runs on CPU)
│   └── Harness (Node/TS), STT + TTS Python sidecars
├── Framework 13 (AMD 7040, Fedora 44, 32GB) — primary voice client (Python desktop client)
├── iPhone (Safari)       — browser test client at /test over Tailscale HTTPS
└── Surface Pro 7s (×3)   — thin client terminals (optional)
```

**Networking gotcha:** Tailscale inside WSL2 is a **separate node** from any Windows-side Tailscale, with its own IP (shown as e.g. `desktop-1 (wsl)`). Always confirm the backend address with `tailscale status` **inside WSL2** after any networking change. Never reuse an IP from earlier in a session.

**Compute gotcha (resolved, not yet re-measured):** WSL2 now exposes **8 vCPUs** (`nproc` = 8); it previously exposed 4 because of a `processors=` limit in Windows-side `%UserProfile%\.wslconfig`. Torch defaults to one thread per visible physical core. **The TTS benchmark has not been re-run since the limit was raised** — the last measurements are still the 4-vCPU ones below (real-time factor ≈ 0.54 at 2 torch threads, 0.38 at 4; 4 threads ~29% faster than 2). Re-benchmark and replace those numbers.

### Future (homelab online)

```
Tailscale mesh
├── Homelab (24GB-class NVIDIA GPU, e.g. RTX 3090) — local LLM inference (Ollama/llama.cpp),
│     embeddings, GPU TTS, possibly Qdrant
├── SFF desktop (Optiplex / EliteDesk / ThinkCentre, 8th–10th gen) — always-on services node:
│     harness daemon, sidecars, self-hosted Ntfy, webhooks, cron
├── Framework 13 — primary client
└── Phone / Surfaces / other clients
```

Migration is configuration only: `LLM_BASE_URL` and the service URLs change, with no client code changes. Target local models once 24GB of VRAM is available: gpt-oss-20b or Qwen3-Coder-30B-A3B fully in VRAM. The RX 6600 XT limits local inference to roughly 7B models, which is why Groq is the interim backend. **Do not attempt GPU acceleration on the RX 6600 XT under WSL2.** CUDA cannot work on AMD, and ROCm-on-WSL support for this card is not expected.

---

## Capabilities (target scope)

### Interaction
- **Voice I/O.** "Hey Ixa" opens a conversation; it ends on the dismiss phrase or a 20s conversation timeout.
- **Computer use.** Sandboxed shell, plus browser control via a persistent Playwright-based session. Alongside mode (user watches) is preferred; away mode is the fallback.
- **Coding assistance.** Voice-driven pair programming transcribed into a running chat log. Text is the source of truth; voice is the input method.

### Management
- **Email.** Gmail: read and search freely; drafting allowed; sending requires confirmation.
- **Calendar / planner.** Google Sheets planner, read and write.
- **Home Assistant.** State queries, automations, presence. Physical actions require confirmation. Planned via HA's native MCP server.
- **3D printer.** OctoPrint status and webhook alerts.
- **Shopping / logistics.** Research and comparison freely; ordering requires confirmation.

### Memory and Knowledge
- **Episodic memory.** ✅ Each ended session is summarized and embedded; related episodes are recalled automatically on the turn that needs them, and `search_memory` answers direct questions about past conversations — by meaning with a query, or by recency without one.
- **Preference learning.** ✅ Structured store of preferences the user has stated, applied to every reply without being asked.
- **Notes.** 🔜 **Ixa's own notebook.** She writes the markdown; the files are the source of truth and are chunked and embedded for semantic search. Obsidian is a viewer, not the write interface.

### Proactive Behavior
- **Morning debrief.** Scheduled alarm or "good morning" phrase triggers weather, calendar, tasks, and context.
- **Arrival home.** HA presence triggers music, automations, and a context switch.
- **Reminders and interrupts.** Delivered via voice (if a session is active), Ntfy (phone), or desktop notification.
- **Monitoring and alerting.** OctoPrint, homelab health, and HA anomalies. A DND window is enforced (no alerts 11pm–7am unless critical).

### Hardware (long-term)
- Smart glasses with HUD; native earbuds.

---

## Autonomy Policy

- **Read freely:** email, calendar, HA state, files, web search, read-only shell.
- **Confirm first:** send email, push code, trigger physical automations, place orders, write/delete outside the sandbox, modify system state.
- Encoded as `requiresConfirmation: boolean` on every tool. The gate is **transport-agnostic**: a `Confirmer` is injected, so the same gate works over voice (TTS readback + spoken yes/no) and text clients. ✅ (`shell_write` confirms today.)
- **Memory tools are deliberately ungated** (`remember_preference`, `forget_preference`, `list_preferences`, `search_memory`). They touch only Ixa's own database: nothing leaves the machine, a preference update supersedes rather than overwrites, and forgetting is a soft delete. Gating them would put a spoken yes/no in front of every "I prefer X", which is the friction the feature exists to remove. The reasoning is recorded in a comment at the top of each tool file so it is not quietly generalised to tools with outside consequences.
- **`save_note` and `search_notes` are ungated on the same argument, plus one difference that argument does not cover.** 🔜 The notebook is Ixa's own directory, nothing leaves the machine, and a supersede never overwrites — so far this is the memory-tools case. What is new is that **a wrong note persists**: it is a file on disk that a later search will hand back as something Ixa recorded, long after the conversation that produced it is gone. A preference stated wrongly is corrected the next time the user notices it being applied; a note stated wrongly is read back as a measurement. Three things carry that risk instead of a confirmation prompt: the tool returns the title and summary it wrote so **the reply reads back exactly what was saved**, provenance (source, session, date) is **stamped by the harness and never asked of the model**, and a change to an existing note **supersedes rather than overwrites**, so the superseded text survives for comparison. The path is built in code from type, slug and date — the model never supplies one — which is what keeps this distinct from `shell_write`, the tool that does confirm, because `save_note` cannot write outside the vault at all.
- **`start_new_conversation` is ungated too**, on a narrower argument than "the session is summarized first, so nothing is lost". What was traced through the code: **session rows are never deleted** — ending one stamps `ended_at` and writes the full history back to SQLite, and nothing in Ixa removes a session row, so the raw conversation survives verbatim. The **episode** (the searchable summary) is best effort: skipped outright below `IXA_EPISODE_MIN_USER_TURNS`, and on a summarizer LLM failure logged and dropped **with no retry**, because the backlog sweep retries *indexing* of rows that exist, not summarization. So the honest claim is that the conversation is never lost but its summary may be — a recoverable loss, since the history is on disk and can be re-summarized. That is not what the confirmation gate is for.
- **A cancelled confirmation is recorded differently from a refused one.** If the client that asked disconnects mid-prompt, the tool result says so explicitly, so the model knows the action did not happen because the asker vanished — not because the user said no. ✅
- **Imported (MCP) tools follow the same rule** via an Ixa-side policy table. **Unknown tools default to confirm.** 🔜

---

## Tech Stack

### Languages
- **TypeScript** for the harness, API, tools, memory, and proactive layer. Naming: PascalCase for classes/types/interfaces, camelCase for variables/functions.
- **Python** only where the ecosystem requires it: speech sidecars and the desktop voice client. Each sidecar has its own venv (TTS uses Python 3.11).

### Built ✅

| Layer | Choice | Notes |
|---|---|---|
| LLM | Groq, `openai/gpt-oss-20b` | Via `openai` npm package; swappable by env |
| API | Hono (REST) + WebSocket | `WsMessage` protocol including audio message types |
| STT | faster-whisper (Python sidecar) | `vad_filter=True` |
| TTS | Kokoro 0.9.4, voice `af_nova` (Python sidecar) | Streaming: chunked HTTP transfer encoding, per-chunk WAV blobs (mono, 16-bit, 24kHz), 20MB frame ceiling. **Sentence-level chunking** (see Voice pipeline). CPU-only. |
| Wake word | openWakeWord, custom `hey_ixa.onnx` (~772KB) | Client-side. See Voice pipeline decisions |
| VAD | Silero VAD as pure `onnxruntime` + `numpy` reimplementation | Desktop client; no torch (avoids ~5GB dependency); bit-identical to official wrapper |
| Browser-side inference | onnxruntime-web | Wake word ported and validated in browser |
| Web search | Tavily | Requires `TAVILY_API_KEY`. `SEARXNG_URL` exists in `.env.example`; see Open items |
| Shell | `shell_read` (free) / `shell_write` (confirm) | Cross-platform command translation; session-scoped working directory |
| Sessions | Long-lived `SessionManager` + `SqliteSessionStore` | Sessions outlive connections and survive a backend restart |
| Preferences | SQLite via better-sqlite3 | Append-only: updates supersede, forgetting soft-deletes. Injected on every LLM call |
| Episodic memory | SQLite (source of truth) + Qdrant (index) | Session summaries, embedded and recalled per turn |
| Embeddings | nomic-embed-text via Ollama (768-dim) | Local. `search_query:` / `search_document:` prefixes |
| Notifications | Ntfy (`notify` tool) | ntfy.sh public server in dev; self-host planned |
| Scheduling | node-cron | Morning debrief skeleton only: fires at 08:00 on weekdays and sends an Ntfy nudge |
| Networking | Tailscale | All clients reach the backend over the tailnet |

**Registered tools today** (`src/tools/register.ts`): `get_time`, `get_date`, `echo`, `web_search`, `shell_read`, `shell_write`, `notify`, `remember_preference`, `forget_preference`, `list_preferences`, `search_memory`, `start_new_conversation`. All twelve are passed to the LLM for both voice and text turns. Only `echo` and `shell_write` require confirmation; the memory tools and `start_new_conversation` deliberately do not (see Autonomy Policy). **Phase 3d adds `save_note` and `search_notes`** (🔜), also ungated, for a net **+1759 chars / ~440 tok** on every call — `remember_preference` shrinks by 319 of those chars as part of the same change, because the two descriptions only work as a pair.

**The tool schemas are the single largest fixed cost in a request:** **8533 characters, ~2133 tokens**, on *every* LLM call — measured with `JSON.stringify(registry.toOpenAI())`, which is what actually goes on the wire. That is roughly four times the system prompt. Trimming a verbose description is the cheapest way to buy headroom (see Current open items). Two earlier figures in this doc were wrong and are corrected here: the total was recorded as 8015 chars / ~1400 tok, and `remember_preference`'s *description* was said to be ~1470 chars when 1470 is its whole schema entry and the description is 852.

### Planned 🔜

| Component | Choice | Why |
|---|---|---|
| Notes | Markdown written by Ixa + Syncthing | Her own notebook: `save_note` / `search_notes`, chunk → nomic-embed → Qdrant (Phase 3d). No chokidar: she is the only writer, so there is nothing to watch for |
| Turn detection | **Smart Turn v3** (Pipecat), ONNX | Decides end-of-turn from intonation, not a fixed silence timer. ~8M params, 8MB int8 ONNX, Whisper-Tiny encoder + linear head. BSD 2-Clause (not tied to Pipecat). Layers **on top of** Silero, which must use a ~0.2s stop threshold to match training. |
| Integration protocol | **MCP client in the harness** | One generic adapter instead of a bespoke wrapper per service. First consumer: Home Assistant's native MCP server (Streamable HTTP). |
| Browser layer | **Stagehand** (TS, MIT) | Playwright-compatible; deterministic Playwright calls and AI actions can be mixed in one script. Use deterministic paths for routine flows; AI actions are less reliable than plain selectors. |
| OAuth tokens | keytar | **Open question:** keytar needs a running Secret Service (libsecret), which headless WSL2/server installs usually lack. Decide before Gmail work. |

---

## Architecture

### System Layers

```
Cloud APIs (Groq, Tavily, ntfy.sh)          🔜 MCP servers (HA first)
        │ HTTPS                                      │ Streamable HTTP over tailnet
        ▼                                            ▼
┌───────────────────────────────────────────────────────────┐
│                    Backend (gaming PC, WSL2)              │
│                                                           │
│  Core Harness                                             │
│    SessionManager (owns sessions) · Session · tool loop ·  │
│    context windowing · confirmation gate · LLM            │
│                                                           │
│  Tool layer                    Memory                     │
│    time, date, echo, search,     SQLite: preferences,     │
│    shell_read/write, notify,       episodes, sessions     │
│    remember/forget/list_         Qdrant: episode vectors  │
│    preference, search_memory     Ollama: embeddings       │
│    🔜 MCP client + policy table  🔜 notebook (markdown     │
│    🔜 save_note, search_notes       files + note chunks)   │
│                                                           │
│  Proactive                     API layer                  │
│    node-cron · Ntfy              WebSocket (voice)        │
│    🔜 webhooks                   Hono REST (text, /test)  │
│                                                           │
│  Python sidecars (own venvs, spawned by npm run dev)      │
│    STT: faster-whisper    TTS: Kokoro (sentence streaming)│
└───────────────────────────────────────────────────────────┘
        │ localhost only
        ▼
  Qdrant (Docker, 127.0.0.1:6333, storage on a host volume)
  Ollama (systemd service, nomic-embed-text)
        │ Tailscale
        ▼
Clients (no conversation state; wake word + VAD run locally)
  Framework 13 desktop client (Python) · iPhone /test (browser) · Surfaces
```

### Key Data Flows

**Voice turn ✅:**
```
[client] mic → wake word ("Hey Ixa", 2-frame rule) → conversation opens
[client] end of utterance:
         desktop: Silero VAD (SPEECH_PROB_THRESHOLD=0.5 / TRAILING_SILENCE_MS=600, validated live)
         browser: tap-to-end-turn (VAD deferred)
         🔜 Silero + Smart Turn v3 on both
→ audio over WebSocket → [backend] STT sidecar → LLM + tool loop
→ confirmation gate (if tool requires it) → tool execute → LLM response
→ TTS sidecar splits reply into sentences → streams one WAV chunk per sentence
→ [client] plays first chunk while later chunks synthesize
→ loop until dismiss phrase or 20s conversation timeout
→ [client] reset wake model (Model.reset()) before listening again
```

**Tool execution with confirmation ✅ (MCP part 🔜):**
```
LLM calls a tool
→ harness looks up requiresConfirmation
    native tool: from its definition
    🔜 MCP tool: from the Ixa policy table (unknown → confirm)
→ if true: Confirmer prompts via the active transport
    voice: TTS readback "I'm about to … Confirm?" → spoken yes/no
→ yes: execute, append result, resume loop
→ no:  append cancellation, ask what to do instead
```

**Session ownership ✅:**
```
SessionManager owns sessions independent of client connections
→ every WebSocket connection, REST request and the REPL attaches to one shared
  primary session; no session id crosses the wire
→ a turn resolves the session through the manager EVERY time, never from a cache
→ history is persisted to SQLite after each completed turn
→ a session ends on idle timeout or explicit reset, firing onSessionEnd
→ on startup the last live session is restored if it is still inside the idle
  timeout (measured from its last turn), otherwise expired and summarized
```

**Writing an episode ✅:**
```
session ends (timeout | reset | expired-on-restart)
→ fewer than IXA_EPISODE_MIN_USER_TURNS user turns? skip, and log it
→ otherwise, detached from the session-end path:
  summarize with the configured LLM (summary + topic tags)
→ INSERT into SQLite            ← source of truth, happens first
→ embed (search_document:) → upsert to Qdrant with {episodeId, timestamps, tags}
→ mark indexed; on failure the row stays unindexed and the sweep retries it
```

**Recalling episodes ✅ (once per user turn, before the first LLM call):**
```
user turn arrives → embed the message (search_query:)
→ Qdrant top-K above the score threshold
→ resolve hits to SQLite rows (a hit with no row is dropped and its vector deleted)
→ render a dated block, capped by characters, injected fresh into the system context
→ the whole step runs under one timeout; over budget, the turn proceeds without it
```

**Writing a note 🔜** (replaces the retired Obsidian→chokidar flow — see *Ixa's notebook*):
```
the user asks Ixa to write something down
→ search_notes first: is there already a note on this?
→ save_note: path built IN CODE from type + slug + date (the model never supplies one)
→ write the markdown atomically (temp file + rename)   ← source of truth, happens first
→ chunk on headings → rows in SQLite (rebuildable)
→ embed (search_document:) → upsert to Qdrant with {title, headingPath, type, status, date}
→ index failure leaves the FILE as truth and an unindexed backlog, exactly like episodes
→ the tool returns title + summary + what it superseded, so the reply reads back what was saved
```

**Proactive interrupt 🔜:**
```
cron fires OR webhook received (HA / OctoPrint)
→ check HA presence
→ if home and a session is active: speak via client
→ always: Ntfy push
→ desktop: notification popup
→ DND 11pm–7am: queue unless critical
```

---

## Key Design Decisions

### Voice pipeline
1. **Wake word runs client-side** (desktop: Python `openwakeword`; browser: onnxruntime-web port validated to within 3e-6 of the Python pipeline, ~4.3ms mean per 80ms chunk on iPhone).
2. **Trigger rule: 2 consecutive frames ≥ 0.5.** `hey_ixa.onnx` can spike on room tone for a single frame (observed up to 0.84). openWakeWord's own `patience` parameter is broken in v0.6.0 (it suppresses real triggers too), so the custom rule is implemented **identically** on desktop and browser. Validated live on Framework 13.
3. **Always reset the wake model on sleep** (`Model.reset()`) after timeout or dismiss. Without it, residual state causes an immediate false re-wake.
4. **Frame buffer is separate from the VAD state machine** (`audio_framing.py`), so wake word, VAD, and future turn detection attach to the same frames without rework.
5. **TTS chunking never depends on LLM output formatting.** Kokoro's pipeline splits only on newlines by default (or past 510 phonemes). Voice replies are plain sentences with no newlines, so without intervention every reply became one chunk and first audio waited for the whole reply (~14s for ~480 chars). The sidecar passes an explicit `split_pattern` that splits at sentence boundaries (`. ! ?`, optionally followed by one closing quote or bracket) **and** at newlines. Result: first audio at ~1.7s warm. Known, accepted quirks: "Dr." and "e.g." split early; a sentence ending in two closers (e.g. `.")`) joins the next one; per-piece padding makes total audio ~17% longer. The pattern uses only non-capturing groups, because Kokoro applies it with `re.split`.
6. **Turn detection direction:** Silero decides "is there speech"; Smart Turn v3 (🔜) decides "is the speaker finished." Port it with the same pattern as the wake word: baseline script → fixture comparison against the reference implementation → wire in only once validated.
7. **Voice-origin responses are shaped differently.** A `MessageOrigin` type threads through `send()` / `runToolLoop()`. Voice turns get a short plain-sentence system prompt addition. `messagesForCall()` builds a fresh message array per call and never mutates session state.
8. **Sidecar readiness** is currently a TCP port probe (`src/core/sidecars.ts`); models load before the port opens. Measured cold-start cost is small (~0.4s), but on the first request after a restart chunk 2 can arrive ~0.17s after chunk 1 finishes playing. A warmup synthesis before reporting ready (🔜) removes that gap.
9. **TTS throughput is CPU-bound.** Real-time factor ≈ 0.54 at 2 torch threads, 0.38 at 4 (seconds of synthesis per second of speech). Warm steady-state margin between chunks is thin (~0.16s) at 2 threads, so raising the WSL vCPU limit matters.
10. **Push-to-talk** exists as a toggle (`:rec`) for debugging and noisy environments.
11. **The client is an explicit four-state machine** (`clients/desktop/conversation.py`): `SLEEPING` (only the wake model sees audio, no timer), `LISTENING` (conversation open, the user's move, conversation timer runs), `WAITING` (utterance sent, reply not started, response timer runs), `SPEAKING` (reply audio playing, no timer, mic dropped). **The conversation timeout runs in LISTENING and nowhere else** — that is the point of the split: a turn that takes 30s to think and 20s to speak must not burn down the window the user has to reply. `WAITING` has its own long safety-net timer for a reply that never comes. The backend sends exactly one terminator per accepted turn (`replyEnd`, or `sessionEnd` on a dismiss) so the client always knows a turn is over, including for empty or failed replies.

### Conversation lifecycle ✅ (behaviour fixes)
Live voice testing found there was **no real way to end a conversation**. Typing `/reset` at the REPL was sent to the LLM as a message, and the model answered "Conversation reset. All previous context cleared" with nothing having happened — a believable lie, which is worse than an error.

Three entry points now reach **one** reset, `SessionManager.resetPrimary()`:
1. **`start_new_conversation`**, a tool, so voice can ask for it.
2. **The REPL's `/reset`**, handled locally in `handleLocalCommand` and never sent on. Anything that is not a known command is left alone and reaches the LLM as typed, so this cannot silently swallow a real message.
3. **`POST /reset`**, unchanged.

- **The end is deferred to the turn boundary, never applied mid-turn.** Ending the session inside the tool loop would pull the history out from under the loop still appending to it, and would leave the reply that announced the reset out of the episode. The manager honours the request in `submitTurn`'s `finally`, after history is persisted.
- **It waits for queued turns.** Turns already chained behind the resetting one were submitted *before* the request, so they belong to the old conversation: the request is honoured once `pendingTurns` reaches zero, not at the first opportunity.
- **A tool cannot reach the session directly, by design.** `Tool.execute` receives only its own input; a tool able to reach the `Session` or the `SessionManager` could do anything to the conversation at any point in the loop. So the tool records a *request* through `SessionControl` (`src/core/session-context.ts`), an `AsyncLocalStorage` bound around each turn, and the manager decides what to do with it. AsyncLocalStorage rather than a module-level flag: the request belongs to one session's turn, a bare flag would leak into whatever turn ran next if a `Session` were ever driven outside `submitTurn`, and this keeps working unchanged if the one-shared-primary-session policy ends.
- **No `WsMessage` change.** A session ending is not the same as the client's listening window closing, so there is nothing new to tell the client: the window stays open and the next thing the user says lands in the fresh session.
- **The model is told never to claim an action it did not take.** `SYSTEM_PROMPT` now forbids saying anything was reset, cleared, saved, remembered, updated or forgotten unless the tool that does it was actually called and reported success. The tool itself, called outside a turn, returns a failure string rather than throwing, so the model says something true instead of inventing a reset.

### Voice response shaping ✅ (behaviour fixes)
One live voice reply produced **87 seconds of speech**, with numbered lists and bold. Kokoro phonemizes whatever it is handed, so `**Best value:**` is read out with the asterisks and `1.` becomes the spoken word "one".

- **Text in, text out.** A turn that arrived as text is never spoken; a turn that arrived as voice is. Typed questions get no `VOICE_RESPONSE_PROMPT` and no spoken-length backstop, so one of them produced a 3,937-char reply and **149 seconds of TTS** — and a typed question is often typed precisely because the user cannot make noise. The decision keys off the turn's `MessageOrigin`, not the connection and not a client setting: the `/test` page sends typed and spoken input over one socket, so a connection-level rule would mean that typing once silently stopped spoken questions being answered aloud for the rest of that connection's life. One rule, in `handleUserMessage` in `src/api/websocket.ts`, where the origin is already in scope — `speak()` itself stays origin-agnostic for the dismiss acknowledgment, which is voice by construction. A failed text turn gets no spoken apology either; the `error` frame and `replyEnd` are what end it. Everything else about a text turn is unchanged, including that its replies stay long: nobody has to listen to them.
- **The prompt is the mechanism; the sanitizer is the backstop.** `VOICE_RESPONSE_PROMPT` asks for one to three short sentences, forbids formatting outright, and for a multi-item answer wants the best one or two plus an offer of the rest. Its previous version had an escape hatch — "unless the user is explicitly asking for something that requires more detail" — which the model took constantly, because almost any question reads as inviting detail.
- **`sanitizeForSpeech` (`src/voice/sanitize.ts`) runs only at the TTS boundary**, in `speak()` in `src/api/websocket.ts`. It is downstream of the `assistant` message, so **stored history and text clients keep the model's original text** and only what is spoken is stripped. `src/voice/tts.ts` stays a dumb transport.
- **Nothing is ever truncated.** A reply that is too long is a prompting problem; a sentence cut mid-word makes Ixa sound broken rather than verbose.
- **Its output is punctuated prose joined by single spaces**, which is not cosmetic: the sidecar's `split_pattern` chunks on sentence endings and newlines, so turning an unpunctuated heading or list item into a sentence is what lets a list stream one chunk per item instead of one chunk for the whole reply.
- **It works on the complete reply, which Phase 4 will change.** Overlapping LLM token streaming with TTS (listed under Phase 4) means handing TTS each sentence while the model is still generating. A sanitizer that sees only a partial sentence cannot tell an unclosed `**` from a literal asterisk, and cannot know whether a line is a list item before its marker arrives. It will need to become incremental — buffering until a block is provably complete — or run behind whatever boundary detector the streaming path uses. Do not assume the current whole-string version drops into that path.
- Underscores inside identifiers (`search_memory`, `episodic_memory.ts`) and a literal `2 * 3` survive. **Markdown tables are deliberately out of scope**: a spoken table is unsalvageable whatever is done to the pipes, and the fix is the model not writing one.

### What Ixa knows about her own memory ✅ (behaviour fixes)
Asked to "pull your memory", Ixa said she had no stored memories — while `search_memory` and the three preference tools were registered and working. Nothing in the system prompt told her the memory existed; the injected preference and recall blocks describe *contents*, so with an empty recall she had no reason to think there was a capability at all.

`SYSTEM_PROMPT` now describes it in three parts, matching what is actually built: saved preferences (always applied), summaries of past conversations (some recalled automatically, the rest searchable), and the current conversation persisting across reconnects and restarts. It also states the limits — no record of a conversation that never ended, no recall of a file she has not read — because an overstated memory produces a different lie from the one this fixed.

**The hand-listed tool descriptions are gone** from `SYSTEM_PROMPT` (the open item flagged through 3b/3c). The registry descriptions are the contract the model reads when choosing a tool, and a duplicate list goes stale. What stays in the prompt is only what a tool description cannot carry: identity, memory, the honesty rule, the freshness rule, and guidance spanning every tool.

**Anything that changes over time must be searched for.** Ixa stated prices and specific products from memory. The prompt now requires `web_search` before answering about prices, availability, versions, release dates or current events, and requires saying plainly that she is not sure when she cannot search. This **increases `web_search` traffic**, which matters under the free tier — see Current open items for the measured cost of a search turn.

### Turn resilience ✅ (built, verified)

How a turn fails. Found by diagnosing a live hang: there was no LLM timeout at all, and the SDK's own request timeout is **cleared the moment response headers arrive**, so a stream that stopped mid-reply hung forever. A hung turn also kept the idle timer disarmed, so the session could never expire either.

- **Two deadlines on every LLM call**, both on one `AbortController`. A **stream-inactivity deadline** (`LLM_STREAM_IDLE_TIMEOUT_MS`, 15s) aborts if no chunk arrives for that long — this is the one that actually catches a stall. A **request ceiling** (`LLM_REQUEST_TIMEOUT_MS`, 120s) bounds the whole call, retries included. The ceiling is deliberately generous: it is a backstop, and a slower local model later must not be cut off mid-thought.
- The chunk loop is driven by hand rather than with `for await`, because the inactivity deadline has to sit on each individual `next()`.
- **Retries stay the SDK's.** `maxRetries` is explicit in config (2) rather than inherited silently, but the retry *policy* — which statuses, what backoff, how `retry-after` is honoured — is not reimplemented. Instead a **custom `fetch` wrapper** is passed to the client: every attempt, retries included, goes through it, and the SDK stamps `x-stainless-retry-count` on each one so an attempt can name itself. Rejected alternative: a hand-rolled retry loop, which buys the same log line at the cost of a second retry policy that would drift from the SDK's.
- **A generic per-tool ceiling** (`IXA_TOOL_TIMEOUT_MS`, 45s) sits in the tool loop, above each tool's own limit. It exists for the tools that forget one — and for MCP tools in Phase 4, whose timeout behaviour is not Ixa's to set. **Time spent waiting on a confirmation is excluded**, because a user thinking is not a tool hanging.
  - A tool's promise cannot be cancelled from outside, so the ceiling stops the *turn* waiting, not the work. Both the log line and the result handed to the model say exactly that: *abandoned, may still complete* — never "it did not run". A tool that is still running is not a tool that did nothing.
  - Tools that own a network call bound it themselves (`IXA_TOOL_HTTP_TIMEOUT_MS`, 15s): `web_search` and the ntfy notifier had unbounded `fetch` calls and now do not. `shell_read` / `shell_write` were already bounded (10s / 30s `execFile`), and the preference tools are synchronous SQLite. **`search_memory` is not bounded from the inside** — `EpisodicMemory.search()` takes no signal, unlike `recall()`, which has `IXA_RECALL_TIMEOUT_MS`. It relies on the generic ceiling.
- **TTS has an inactivity deadline too** (`TTS_IDLE_TIMEOUT_MS`, 20s). `speak()` already swallowed TTS *errors*, but a sidecar that accepted the request and then hung would hold a turn open forever — including the failure path, whose whole point is a prompt terminator.

**Failing well.** A failed turn is still a *finished* turn, and each transport says so in its own idiom:

- **WebSocket:** the error goes out as an `error` message, a short **fixed** apology is spoken (never an LLM call — the thing that just failed is quite likely the LLM), and `replyEnd` is sent **from a `finally`**, so the client gets its terminator even if speaking the apology fails too. **The socket stays open.** The conversation and the session both survive one bad turn, and the user's next sentence must land on them rather than on a reconnect. A malformed frame no longer closes the socket either.
- **REST:** a 500 with the message. **REPL:** prints it and keeps taking input.

**What is persisted, and when.**

- **The user's message is written before the turn runs**, not in `submitTurn`'s `finally`. Everything that can fail happens after that point, so a turn that times out, throws or is killed still leaves the question on the record. Losing what the user said is worse than losing the answer, because only one of the two can be asked for again. The hook fires *inside* the turn chain — called from outside it would race the serialization.
- **A failed turn is recorded as the apology the user actually heard**, not left as a question with no answer. Found in live testing: two turns failed against a dead LLM, the backend restarted, the session restored — and the model, reading a history that said "asked, never answered", dutifully answered both stale questions plus the new one. History has to say what the user experienced. The assistant message carries the **same `TURN_FAILURE_APOLOGY` constant the WebSocket speaks** (it lives in the session layer for exactly that reason, so the spoken words and the recorded words cannot drift) plus a short bracketed reason — `… [turn failed: connection error]`. The reason is for the model, not the user: it is the difference between "I could not reach my language model" and "that took too long". Appended in the session layer, so WebSocket, REST and the REPL all get it, and *after* any tool-group completion, so ordering stays valid.
- **A tool-call group is never persisted incomplete.** An assistant `tool_calls` message whose results are missing is rejected outright by the API, so leaving one in history would break *every later turn in that session*, not just the one that failed. When a failure cuts a group short, calls that ran **keep their real results** — a tool with side effects has already had them, and the model cannot account for what it is not told — and every call that never ran gets an explicit `not executed … Nothing happened` placeholder. Rejected alternative: truncating the group, which is simpler but hides a side effect that actually occurred.

**Logging.** One line per tool call (`tool <name> ok|error|timeout|declined|cancelled|unknown <ms> <args truncated to 120 chars>`), one per failed LLM attempt (`llm attempt 1/2 failed: status=429 retry-after=10`), one per abort (`llm aborted: no chunk for 15000ms (stream inactivity)`), and one for the malformed-tool-call retry, which was previously silent.

**Can a turn still hang?** Every LLM call and every tool execution is now bounded, so `submitTurn`'s `finally` is always reached and **the idle timer always re-arms**. One honest caveat: the SDK's retry backoff `sleep` is not abortable, so the request ceiling is enforced at the next attempt boundary and can overshoot by that sleep — bounded by the SDK's own 60s cap on `retry-after`, so still bounded, not indefinite.

**Verification.** 20 automated cases (147 total, up from 127), driven against local stub servers rather than Groq, because a real provider cannot be asked to stall: a dead backend, a request that never gets headers, and a server that sends headers plus one chunk and then stops. Live end-to-end against the real stack with the LLM pointed at a dead port: error at 514ms, apology spoken through real Kokoro, message order `error → audioStart → audioOutputEnd → replyEnd`, socket still open.

The restore case was then replayed in full — two failed turns, backend restarted, session restored — and the next turn answered only the new question. Asked afterwards what had happened, Ixa said *"I had a brief connection hiccup when you asked the time, so the reply didn't go through"*, which is both true and only possible because the bracketed reason is in history.

### LLM abstraction and configuration
- Application config values are read through **one config module** (`src/config.ts`). Exceptions: some files read `HOME`, and the shell tools and `src/core/sidecars.ts` pass the process environment through to child processes. Don't add new direct `process.env` reads for config.
- The canonical list of variables lives in **`.env.example`**, not in this doc. Several (e.g. `STT_URL`, `TTS_URL`, `STT_MODEL`) have working defaults in `config.ts`.

### Confirmation gate
```typescript
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  requiresConfirmation: boolean   // set once, enforced always
  execute: (input: unknown) => Promise<unknown>
}
```
(Illustrative. The real definition in the tool registry is authoritative.)

Tool **descriptions** are read by the LLM when it chooses tools, so they must stay accurate. For example, `web_search` must describe Tavily, not a previous provider.

### Session ownership ✅ (Phase 3a)
- Sessions outlive client connections. `SessionManager` owns them; clients re-attach on reconnect and lose nothing.
- **Policy is one shared primary session.** The data model is multi-session, but every connection, REST request and the REPL attaches to the same primary. No session id crosses the wire, so no client had to change. Per-device sessions remain possible later without a redesign.
- **A transport must never cache a `Session`.** Every turn resolves it through the manager, so a connection that stayed attached across an idle timeout lands on the new session rather than writing into an ended one.
- **Turns are serialized per session.** Each turn chains onto the previous one, because two concurrent tool loops appending to the same history would interleave and produce a sequence where a tool result no longer follows its call — which the API rejects outright.
- **A dismiss ends the listening window, not the session.** With one shared session, a dismiss on one device would otherwise wipe context for every device.
- **Disconnecting cancels only what belongs to that connection**: its pending confirmations resolve as cancelled and its in-flight TTS is abandoned, while a turn already in the tool loop runs to completion and records its result. The session itself survives.
- **The idle timer is disarmed while work is outstanding**, so an in-flight or queued turn can never be timed out underneath itself.

### Context windowing ✅ (Phase 3a)
- Stored history grows without bound and is **never trimmed** — it is the record, and episodes are summarized from it. What each *request* carries is capped instead (`maxMessages` and a character budget; whichever is hit first stops the walk).
- The budget is a **character count, not a token count**: a tokenizer would be a dependency and a per-turn cost for an approximation that is good enough to bound a request.
- **Tool-call groups are atomic.** An assistant message carrying `tool_calls` and the tool messages answering it are taken whole or not at all.
- Leading system messages are always kept regardless of budget.

### MCP integration layer (🔜 decided, not built)
- **The harness is an MCP client.** Imported MCP tools are adapted into the same `Tool` shape as native tools and enter the same registry and tool loop.
- **Policy table.** An Ixa-owned mapping from `server + tool name → requiresConfirmation` (plus an optional enable/disable flag). MCP tools carry no Ixa confirmation semantics, so the policy table is the only source of that bit.
  - **Default for any tool not in the table: confirm.** A newly exposed tool on a server can never silently gain free execution.
  - Read-only tools are explicitly allowlisted as free.
- **Exposure.** MCP servers are reached over the tailnet only. Nothing is exposed publicly.
- **Trust.** Only servers chosen and reviewed deliberately. No marketplace auto-install.
- **First consumer: Home Assistant** via HA's built-in Model Context Protocol Server integration (Streamable HTTP), which exposes control through HA's Assist API. The HA auth method is to be settled in the design pass.
- Gmail/Sheets may also arrive as MCP servers rather than native googleapis wrappers. Evaluate when Phase 5 starts.

### Browser / computer use (🔜)
1. Browser session is a **persistent first-class object**: open once, run many tool calls against it, close when done. Never one-shot per call. This holds whether the layer is raw Playwright or Stagehand.
2. `screenshot()` is first-class alongside `navigate`, `click`, `type`, `scroll` from day one.
3. **Stagehand** is the planned SDK. Routine/repeatable flows use deterministic Playwright calls; AI actions are reserved for unfamiliar or changing pages.
4. The vision loop (Phase 8) sits on top of the same primitives: `screenshot → vision model → structured action → repeat`. No rewrite if session persistence is built correctly now.

### Memory architecture
- **Working memory:** LLM context window. ✅
- **Preference memory:** SQLite. ✅ (Phase 3b)
- **Episodic memory:** session summaries in SQLite, embedded into Qdrant. ✅ (Phase 3c)
- **Semantic memory:** markdown notes Ixa writes → chunk → nomic-embed → Qdrant. 🔜 (Phase 3d)
- **The notebook is Ixa's, and she is the only writer.** See *Ixa's notebook* below. ~~Obsidian is the human write interface. The agent never writes to the vault; it queries Qdrant. The vault is Wyatt's; the vector store is Ixa's view of it.~~ **Retired.** That decision is the reverse of what 3d builds.

**Preferences are append-only.** ✅ An update never overwrites: the old row is stamped superseded (with a pointer to its replacement) and a new row is inserted. Forgetting is a soft delete. Active means neither superseded nor removed, and there is at most one active row per topic, matched case-insensitively so "Coffee" updates "coffee" instead of forking a near-duplicate. This is the temporal-facts idea in its cheapest form: *when* a preference became true is data, not a lost overwrite, without needing a graph database.

**Preferences are injected on EVERY LLM call** ✅, built fresh in `messagesForCall` and never written to history. Injecting once at session start would mean an update did not apply until the next session, and would let the context budget drop it. The block is capped by row count and characters, and a truncating cap logs a warning.

**SQLite is the source of truth; Qdrant is a rebuildable index.** ✅ This is the central episodic-memory decision and everything else follows from it:
- The episode row is written **before** any embedding is attempted, so an Ollama or Qdrant outage costs an index entry, never a memory. Unindexed rows are a backlog, retried at startup and on a timer.
- Qdrant point ids **are** the SQLite episode ids, so there is no mapping to keep in sync, and payloads carry only what filtering needs. Summaries are read back from SQLite, so the two cannot disagree about text.
- A deleted episode stays deleted: recall resolves hits to rows, drops any hit whose row is gone and deletes the stale vector, and a rebuild reads rows. Neither path can resurrect it.
- `dev/scripts/rebuild-episode-index.ts` recreates the collection from SQLite, which is what makes changing the embedding model a one-command operation.

**Recall happens once per user turn, not once per LLM call** ✅, before the first call, inside the turn chain. The question does not change inside a turn, and a tool loop can make several calls. It runs under **one hard latency budget** covering embedding and search together: over budget, the turn proceeds with no recall. Memory is never allowed to make a voice reply slow.

**Degradation is silent by design.** ✅ If Qdrant or Ollama is unreachable, Ixa works normally without recall and logs **one** warning (and one line when it recovers), never one per turn. `search_memory` is the exception: asked a direct question, it says it cannot search rather than guessing.

**Recency is a SQLite question, not a vector question.** ✅ (behaviour fixes) "What did we talk about last time?" could not be answered: automatic recall and `search_memory` both match on *meaning*, and a question with no subject in it embeds to a vector near nothing and falls under the score threshold. `search_memory`'s `query` is therefore **optional**, and with no query it returns the most recent episodes, newest first, straight from `EpisodeStore.recent()`.

- Ordering by `ended_at` is something that table already has, so routing recency through Qdrant would add a dependency to get a worse answer. It is **the one memory question that needs no embedding**, and it works with Ollama and Qdrant both down.
- Ordered by `ended_at`, **not** `id`, so a backlog retry or an index rebuild cannot reorder history.
- A blank `query` string is treated as no query: the model sometimes sends `query: ""` rather than omitting the field, and embedding an empty string returns nothing — the opposite of what it meant.

**Dates are local time throughout, and the model has no clock.** ✅ (behaviour fixes) `search_memory`'s `from`/`to` are parsed with the local-time `Date` constructor and rendered back with `toLocaleString`, both in the **backend's local timezone** — the user means their own Tuesday, not UTC's, and a UTC parse would put a day boundary up to a day off for anyone west of Greenwich. Episodes are stored as epoch ms, so bounds and rendered dates only have to be built in the same zone to agree. The model cannot know "now" by itself, so the tool description tells it to call `get_date` (also local) before building a relative range like "yesterday". Rendered episodes carry the **time of day as well as the date**: without it, two conversations on the same day render identically and the model cannot say which was the last one.

**Episode summaries are written when a session ends**, except on shutdown ✅. A summary is an LLM call taking seconds, and shutdown offers under one. A session left live in SQLite by a Ctrl-C is restored on the next startup if it is still fresh, or expired and summarized then — so nothing is lost by refusing to rush it. Sessions with fewer than a configured number of user turns are skipped.

### Ixa's notebook (🔜 decided, not built)

**The premise is reversed from what this document said through Phase 3c.** It said Obsidian was the human write interface and *"the agent never writes to the vault"*. It is now the opposite: **Ixa writes the notes and is the only writer.** The user does not hand-edit them, and Obsidian is a viewer over the same directory — useful for reading, linking and searching by eye, with no part in the write path. The retired design had a vault the user filled and Ixa read; this one has a notebook Ixa keeps and the user can look at.

That change deletes a whole component. **There is no chokidar watcher and no file-change pipeline.** Watching for edits only earns its complexity when something else does the editing; here the writer and the indexer are the same process, and it indexes what it just wrote.

**The markdown files are the source of truth.** This inverts the episodic rule rather than contradicting it: for episodes, SQLite is truth and Qdrant is the rebuildable index; for notes, **the files are truth and both SQLite and Qdrant are rebuildable** from them. The reason is that the file is the artifact — it is what Obsidian renders, what Syncthing replicates, and what survives the database being deleted. So the write order is file first (atomically, temp + rename), then chunk rows, then vectors, and an indexing failure leaves a readable note plus an unindexed backlog, which is the same failure shape episodes already have. SQLite keeps the chunks and their hashes so that **re-saving a note re-embeds only the chunks whose text actually changed**.

**Chunking: heading-based, measured rather than assumed** (`dev/scripts/notes-spike-*`, branch `phase-3d-spike`). Sections under ~150 proxy tokens merge into the parent, sections over ~400 split on paragraph boundaries with the heading line re-attached to each part, and the proxy is chars ÷ 4 — consistent with the context budget, which is deliberately counted in characters. **Only the chunk text is embedded.** Title, heading path, type, status and date go in the Qdrant payload, where they can be filtered on, not into the embedded string.

What the spike measured, over 24 notes / 97 sections / 19 questions:

- **The chunking variants are separated by noise.** Fixed 300-token windows, heading-based, and heading-based with a title/type/date prefix landed within one or two questions of each other. The prefix *lost* a top-1 (12/19 against 13/19) and bought the best cross-note margin, which is why metadata is kept but kept in the payload.
- **No score threshold works.** Chunks that genuinely answered the question scored as low as **0.586** while chunks from entirely unrelated notes reached **0.755**. The bands overlap completely and `IXA_RECALL_MIN_SCORE`'s 0.60 sits inside the overlap. So notes retrieval uses **rank, not a floor**: top 3, filtered to `status: active`, no `score_threshold` at all, and the tool result tells the model the results may be unrelated so a weak match is discarded by the reader rather than by a number. **Do not reuse the episode threshold here**, and treat it as evidence that the episode threshold is weak too (see Current open items).
- **Small-to-big gained nothing** and is not adopted. With a merge rule the chunks already *are* sections for 18 of 19 questions, so there is no parent to expand into; and for fixed windows the "parent" is not even a superset of the chunk, so returning it scored *worse* (13/19 → 11/19). Small-to-big is not well defined without heading structure to define a parent.
- **Paraphrasing costs score but not rank.** A question reworded to share almost no vocabulary with the note lost ~0.087 of absolute score while the right chunk stayed at rank 1 — the same finding as the threshold one, from the other side.
- **A superseded note outranks its replacement** for two of three changed facts. A `status: active` filter is what fixes that, which is why status is in the payload and indexed.

**The real failure the spike found was not retrieval.** Three of ten note requests never reached `save_note` at all: they were routed to `remember_preference`, whose shipped description claims any request to *"remember something"*. Deleting that one clause flipped two of the three. So **the two descriptions are written and changed as a pair**, each naming the other's territory, and the pair is tested in both directions — a note must not become a preference, and a preference must not become a note.

**Supersede, not overwrite** ✅ by design, the same shape as preferences. The replaced note is changed *only* by a status stamp and a pointer added in code; its body and its path are untouched, so no Obsidian link breaks and the old reasoning survives for comparison. The new note must state what it replaces and why. The spike is the reason this is spelled out: asked to supersede, the model replaced three sections of reasoning with a single line, which is overwriting under another name.

**A price in a note is guarded, because the existing guard cannot see it.** The price guard (`src/core/prices.ts`) inspects the draft *reply*. A price inside a `save_note` argument is a tool call, so the guard never sees it — and the spike confirmed it: `$600` reached a note body with no `web_search` in that turn, written as *"is currently selling for about $600"* with no attribution to the user who had said "like six hundred bucks". Unguarded, a fabricated price would reach disk and be read back later as a measurement. So **a currency amount in a note must appear in the user's own turn or in a `web_search` result executed that turn**, or the tool refuses and tells the model to search or omit. The comparison is on normalised value, not on text, because the user says "six hundred bucks" and the model writes "$600". Amounts that pass get an *as stated on \<date>, may be out of date* line appended **by code**.

**A reconcile scan is a safety net, not the mechanism.** Since Ixa is the only writer there is nothing to detect — but a scan that reports notes on disk with no SQLite row (and the reverse) is how a silent divergence gets found, and it is how a hand-edit would be noticed if one ever happened. It is a later step, as is **Syncthing** (gaming PC **Send Only**, every viewer **Receive Only** — the topology that keeps "Ixa is the only writer" true across devices rather than merely intended).

**Open, and known to be open:**
- **A claimed action with no tool call.** With the `remember_preference` clause removed, one spike request made *no* tool call and said *"I'll stop using the Tavily web_search tool and rely on your self-hosted Searx instance instead"* — an action it had not taken, which is exactly what `SYSTEM_PROMPT`'s honesty rule forbids. Reading back what the tool returned is the mitigation; it is not a fix.
- **Mishearing survives into the notebook.** The model wrote "Quadrant" and "Alama" into note text *after* reading search results that spelled Qdrant and Ollama correctly. STT hints help the transcript, not the writer.
- **FTS5 is not needed yet.** An exact-phrase fallback over note text is cheap to add if semantic search misses something a keyword would have caught. Nothing measured so far asks for it.
- **The episode recall threshold is probably weak for the same reason.** 0.60 was already flagged provisional; the notes measurement shows how completely related and unrelated score bands can overlap with this embedder.

### Client architecture
- Clients hold no conversation state. They do own their local audio state: wake model, VAD, frame buffer, and their own conversation state machine (see Voice pipeline).
- **Reconnects resume seamlessly** ✅: sessions live on the backend and outlive connections, so dropping and reconnecting keeps the conversation. A backend restart keeps it too, as long as the session has not passed its idle timeout.
- The desktop client reads the backend address from the **`IXA_HOST` env var** (defaults to localhost). It must be set for remote testing, e.g. `IXA_HOST=<tailscale-ip> python client.py`.

---

## Repository Layout

Reconciled against the tree on 2026-10-03.

```
ixa/
├── ARCHITECTURE.md
├── .env / .env.example          ← canonical env var list lives in .env.example
├── data/                        ← gitignored runtime state: ixa.db (SQLite)
├── src/
│   ├── index.ts                 ← startup: db, memory, sessions, REST, sidecars, WS
│   ├── config.ts                ← every config value is read here
│   ├── core/
│   │   ├── session.ts           ← Session, messagesForCall, runToolLoop
│   │   ├── session-manager.ts   ← owns sessions, idle timers, restore-on-startup
│   │   ├── session-store.ts     ← SessionStore interface + InMemorySessionStore
│   │   ├── sqlite-session-store.ts ← durable sessions (write-through cache)
│   │   ├── context-window.ts    ← buildWindow, atomic tool-call groups
│   │   ├── confirmation.ts      ← Confirmer, cancel-on-disconnect
│   │   ├── connection.ts        ← Connection interface (one attached client)
│   │   ├── session-context.ts   ← SessionControl, the channel a tool uses to end its session
│   │   ├── harness.ts           ← stdin REPL (text mode) + handleLocalCommand ("/reset")
│   │   ├── llm.ts               ← OpenAI-compatible streaming chat
│   │   └── sidecars.ts          ← spawns STT/TTS sidecars, TCP readiness probe
│   ├── memory/
│   │   ├── db.ts                ← SQLite handle + versioned migrations
│   │   ├── preferences.ts       ← PreferenceStore (supersede / soft delete)
│   │   ├── episodes.ts          ← EpisodeStore (source of truth for episodes)
│   │   ├── summarizer.ts        ← session → {summary, tags}
│   │   ├── embeddings.ts        ← Ollama embedder (nomic task prefixes)
│   │   ├── qdrant.ts            ← Qdrant REST client (the rebuildable index)
│   │   ├── episodic-memory.ts   ← write path, recall, backlog, degradation
│   │   ├── notes-markdown.ts    ← 🔜 frontmatter, render/parse, path from type+slug+date
│   │   ├── note-chunks.ts       ← 🔜 heading-based chunking (merge <150, split >400)
│   │   ├── notes.ts             ← 🔜 NoteStore (notes + note_chunks; both rebuildable)
│   │   └── notebook.ts          ← 🔜 write path, search, backlog — files are the truth
│   ├── tools/
│   │   ├── registry.ts          ← Tool interface + registry
│   │   ├── register.ts          ← registers all 12 tools (🔜 14)
│   │   ├── time.ts · date.ts · echo.ts · notify.ts
│   │   ├── search.ts            ← Tavily web_search
│   │   ├── shell-read.ts · shell-write.ts
│   │   ├── preferences.ts       ← remember / forget / list_preferences
│   │   ├── search-memory.ts     ← explicit episodic recall (by meaning, or by recency)
│   │   ├── notes.ts             ← 🔜 save_note / search_notes (the paired descriptions)
│   │   └── conversation.ts      ← start_new_conversation
│   ├── voice/
│   │   ├── tts.ts               ← speakStreaming (streaming TTS client)
│   │   ├── stt.ts               ← transcribe
│   │   ├── sanitize.ts          ← sanitizeForSpeech: strips markdown before TTS
│   │   └── dismiss.ts           ← dismiss-phrase detection
│   ├── proactive/
│   │   ├── scheduler.ts         ← node-cron
│   │   └── notifier.ts          ← Ntfy
│   └── api/
│       ├── rest.ts              ← Hono: /chat, /reset, /health, /test
│       ├── websocket.ts         ← WS server, audio protocol, speak()
│       ├── types.ts             ← WsMessage
│       ├── test-client.ts       ← the /test browser page
│       ├── static-assets.ts     ← ONNX models + onnxruntime-web for /test
│       └── wake-check.ts        ← browser-vs-Python wake fixture comparison
├── test/                        ← node:test suites (127 cases)
├── dev/scripts/                 ← throwaway verification clients, not shipped
├── tools/wakeword/              ← wake word training + fixtures
├── sidecars/
│   ├── stt/main.py              ← faster-whisper (own venv)
│   └── tts/main.py              ← Kokoro streaming + sentence split_pattern
└── clients/
    └── desktop/
        ├── client.py            ← reads IXA_HOST
        ├── conversation.py      ← ConversationState machine + 2-frame wake rule
        ├── wakeword.py          ← openWakeWord wrapper, Model.reset() on sleep
        ├── recorder.py          ← Silero VAD constants
        ├── vad.py               ← Silero reimplementation (onnxruntime + numpy)
        └── audio_framing.py     ← FrameBuffer
```

---

## Development Environment and Workflow

- **Division of labor:** architecture and design happen in Claude.ai chat. Implementation prompts are written there and run by Claude Code in a **WSL2 terminal on the gaming PC**.
- **Every command must state:** which machine (gaming PC backend vs Framework 13 client), WSL2 vs Windows (PowerShell), and inside vs outside which venv.
- **Only checkout:** `/home/wyatt/Projects/ixa` (native WSL2 filesystem). A stale pre-migration checkout under `/mnt/c/Users/.../Projects/ixa` caused hours of phantom bugs and has been removed. If one ever reappears, do not use it. (If Windows file locks block deletion: `wsl --shutdown`, then delete from PowerShell.)
- **Secrets:** Claude Code does not read, modify, or print `.env`. Keys are added by hand.

### Recurring pitfalls
- **Commit and push before cross-device testing.** Uncommitted work on the gaming PC means the Framework 13 tests stale code.
- **Restart `npm run dev` after changes.** Stale processes silently serve old code. This includes dev servers started by a Claude Code session: stop those before running your own.
- **esbuild platform mismatch:** Windows npm contaminating WSL2 `node_modules`. Fix with `rm -rf node_modules && npm install` inside WSL2.
- **WSL2 localhost is not reachable from Windows.** Use `curl.exe` or the Tailscale IP.
- **Windows Firewall** may block dev ports. Add rules with `New-NetFirewallRule`.
- **WSL2 Tailscale is its own node.** Confirm the IP with `tailscale status` inside WSL2.
- **Env vars do not migrate themselves.** After any checkout/machine change, diff `.env` against `.env.example`.
- **Copy files into WSL with `cp` from the Linux side**, not Explorer drag-and-drop into `\\wsl$`. The latter creates stray `:Zone.Identifier` files.

---

## Deployment Phases

### Phase 1 — Voice loop + basic chat — ✅ DONE
WebSocket/REST layer (Hono), `WsMessage` audio protocol, STT sidecar, client-side Silero VAD, push-to-talk toggle, Kokoro streaming TTS (now sentence-chunked), placeholder tools, sidecar auto-start.
**Wake word ✅:** "Hey Ixa" validated live on Framework 13 (sensitivity, false-positive resistance, VAD cutoff, 20s timeout). Browser `/test` client with client-side wake word validated on iPhone.

### Phase 2 — Tool calling — ✅ DONE
Confirmation gate (transport-agnostic `Confirmer`), Tavily search, `shell_read`/`shell_write`, Ntfy `notify`, node-cron morning debrief skeleton.
(Home Assistant moved to Phase 4 and will be built via MCP.)

### Current open items
- **Groq free tier — resolved, measurements retained.** Ixa is now on the **Groq Dev tier**, so 429s are rare and the daily cap no longer blocks live verification; the decision flagged below (paid tier vs. local-LLM migration) has been made in favour of the paid tier for now. The measurements are kept because they still say where the token budget goes. Previously measured limits: **8000 tokens per minute** and **200000 tokens per day**, both enforced as 429s (`x-ratelimit-limit-tokens: 8000`). A single request larger than the per-minute allowance is rejected outright — the 413 seen on an 8123-token request. Measured sizes, which say where the budget actually goes:

  | Piece | Size |
  |---|---|
  | Tool schemas (12 tools, every call) | 8015 chars / **~1400 tok** |
  | `SYSTEM_PROMPT` | 2138 chars / **522 tok** |
  | `VOICE_RESPONSE_PROMPT` (voice turns only) | 1619 chars / **471 tok** |
  | A `web_search` result | ~5300 chars |
  | Full voice request, `IXA_CONTEXT_BUDGET_CHARS=24000` | **~6400 tok** |
  | Full voice request, `IXA_CONTEXT_BUDGET_CHARS=12000` | **~4900 tok** |

  Consequences: **the per-day cap is reached easily** — a day of development testing exhausted 200000 and the window then refills by trickle, costing ~6 minutes of waiting per 2000-token request, which blocks live verification entirely. **The freshness rule increases `web_search` traffic**, and a search turn is two LLM calls, the second carrying the ~5300-char result. And **the prompt trim did not save tokens**: removing the duplicated tool list saved less than the memory, honesty and freshness rules cost, so `SYSTEM_PROMPT` grew from 262 to 522 tokens. The real levers are the tool schemas (`remember_preference`'s description alone is ~1470 chars) and `IXA_CONTEXT_BUDGET_CHARS`. ~~Decide between a paid Groq tier and the local-LLM migration~~ — decided: Dev tier.
- **Sidecar warmup** before readiness (removes the small cold-start inter-chunk gap).
- **SearXNG:** `SEARXNG_URL` is in `.env.example`. Determine whether `search.ts` has a SearXNG path. A self-hosted, keyless search backend fits the project better than Tavily long-term.
- **Re-benchmark TTS** now that WSL exposes 8 vCPUs (see Compute gotcha). The recorded real-time factors are still the 4-vCPU ones.
- **An episode lost to a summarizer failure is not retried.** The backlog sweep retries *indexing* of rows that exist; a session whose summarization LLM call failed never gets a row at all, and nothing goes back for it. The raw history is still in SQLite, so a re-summarization pass over ended sessions with no episode row is possible and cheap to add. Relevant now that `start_new_conversation` makes ending a session a routine, user-driven act.

- ~~**Three sentences does not mean a short reply.**~~ **Resolved by the word budget.** The measurement stands and is why it exists: the model obeyed the sentence count and then wrote sentences of 5.0–11.9 seconds. `IXA_VOICE_MAX_WORDS` (default 40) fixed it — see *Voice behaviour*. What remains is that a single sentence over the budget is still spoken whole, by design, because there is no boundary inside it to cut at.
- **Concision is not a model-size problem.** The same scoreboard on `openai/gpt-oss-120b` gives a 22.0s mean, 37.0s worst, 2–3 sentences, backstop never firing — indistinguishable from 20b. Relevant to homelab GPU sizing: a bigger local model will not buy shorter spoken replies. No code depends on 120b.
- **STT segment filtering is safe and, on the evidence so far, unnecessary.** Now measured against real room tone (`Ixa-Tests/stt/noise-room.wav`, 15.8s): it transcribes to **nothing in all four hint modes with no filtering at all**, and across the whole threshold sweep **not one segment was ever dropped**. faster-whisper's `vad_filter=True` is already suppressing what the filter was built to catch. The thresholds remain as a backstop and are confirmed safe — 0.6 / -1.0 keeps every short utterance, and with real room tone in the set even 0.5 / -0.8 does, while 0.4 / -0.6 still deletes a spoken "yes" and would break the confirmation gate. The live hallucination ("Please the President.") therefore came from audio unlike this sample — probably speech-like noise rather than room tone — so keep the thresholds, and treat client-side turn detection in Phase 4 as the real fix. Hint modes do NOT make hallucination worse: room tone stays empty hinted or not.
- **The model-number hints are unverified.** `RTX 3090/4090/5090` were added on the strength of the live "RTX 39D" mishearing, and the measurement **cannot confirm them**: all four RTX cases pass with hints *off* on synthesized audio, because Kokoro's rendering of "RTX 4090" is clean enough that `base.en` gets the digits unaided. What the run does show is that they do no harm — 18/18 hinted against 13/18 unhinted, with room tone still silent. Record `Ixa-Tests/stt/rtx-3090.m4a` from a real microphone and the script will prefer it over synthesis.
- **The segment-filter sweep is not stable between runs.** With the 12-word hint list even 0.4 / -0.6 kept every short utterance, where with the 9-word list it deleted a spoken "yes". The boundary moves with the hint list, which is a reason not to chase the tightest value: 0.6 / -1.0 is kept for the margin, not because 0.5 was measured as unsafe.
- **The domain-word measurement is on synthesized audio.** Kokoro's "RTX 3090" is cleaner than a microphone's. The vocabulary failures it fixed are real (`base.en` returns "Kakaro", "Q-Drant", "Alama", "tail skill" unhinted), but a case that only fails on real audio needs a real recording to prove fixed. Drop recordings into `Ixa-Tests/stt/<slug>.<ext>` and the script prefers them.
- **`base.en` is still the model.** If hints stop being enough, `small.en` is the next lever before anything cleverer.
- **Why four user turns in the live database have no reply.** Session `df025239` holds "Please the President.", "Here is the president." and two "Who is the president?" with no assistant message between them — whisper inventing words over room noise, persisted as user turns. They have no `[turn failed: …]` apology beside them because the dead-LLM test ran on `b22f6cf`, one commit before `e9a1b35` recorded a failed turn as the apology the user heard. Not a live defect. The remaining exposure is STT hallucination itself, whose real fix is client-side turn detection in Phase 4, not a hint list. `voice-behavior-verify.ts strays` re-runs the check read-only.
- **The browser `/test` page ignores `replyEnd`.** It falls through to "unhandled" where `client.py` handles it, so the page's turn timing lags the desktop client's. It does handle `sessionEnd`, so the dismiss change works there.

**Resolved since Phase 3c:** `TAVILY_API_KEY` is set and `web_search` works. The WSL vCPU limit is raised (4 → 8). The `SYSTEM_PROMPT` tool-list duplication is gone — see *What Ixa knows about her own memory*.
- **Recall threshold is provisional, and the notes spike suggests it is worse than thin.** 0.60 was set from a small sample. Against real episodes, genuinely related questions scored 0.58–0.81 and unrelated ones 0.46–0.57, so the margin is thin and one weak-but-real match (a topic mentioned in passing in a multi-topic summary) fell just under. **Over 19 questions against 24 notes the same embedder put real answers as low as 0.586 and wrong-note text as high as 0.755** — fully overlapping bands with 0.60 inside them. That is a different corpus, so it is evidence rather than proof, but the notes path abandoned the floor entirely in favour of rank plus a status filter, and episodes should be re-measured the same way. It is a config value (`IXA_RECALL_MIN_SCORE`).
- **Ixa can claim an action she did not take, still.** `SYSTEM_PROMPT` forbids it and the honesty rule was live-verified in Phase 3c, but the 3d spike reproduced it once: with no tool call at all the model said it would stop using Tavily and switch to a self-hosted Searx. One sample, in a probe harness rather than the real loop — but the failure mode is the one the whole honesty rule exists to prevent, so it is written down rather than filed as noise.
- **Mishearing reaches storage, not just the transcript.** The STT hint list fixes what the decoder returns. It does not stop the *model* writing "Quadrant" and "Alama" into a note, which the spike observed it doing immediately after reading search results that spelled both correctly.
- **FTS5 is not needed yet.** An exact-phrase search over note text is cheap to add when semantic search is seen to miss something a keyword would have caught. Nothing measured so far asks for it.
- **Multi-topic summaries compress the similarity separation.** One summary covering three subjects matches everything weakly. This is the argument for topic segmentation in 3d, not just for a different threshold.
- **Next phase:** the post-3c behaviour fixes, **turn resilience** and **voice behaviour** are all done and live-verified. Next is the branch after this one — shadow-mode preference extraction, re-summarizing ended sessions with no episode row, a `search_memory` timeout, and trimming the tool descriptions (the largest fixed cost in every request). After that, Phase 3d (the notebook) or Phase 4 (voice polish + MCP), which are independent of each other. **Phase 3d started ahead of that list**, and its step 1 spike has already taken one item off it: trimming `remember_preference`'s description is no longer a token-saving nicety but the fix for `save_note` being unreachable.

### Phase 3a — Session ownership — ✅ DONE
`SessionManager` owning sessions independently of connections, one shared primary session, `SessionStore` interface, `Connection` abstraction, turn serialization, cancel-on-disconnect, idle timeout with the timer disarmed while turns are outstanding, and context windowing with atomic tool-call groups.

### Phase 3b — Preferences + session persistence — ✅ DONE
SQLite (better-sqlite3) with versioned migrations, the append-only preference store (supersede on update, soft delete on forget), `remember_preference` / `forget_preference` / `list_preferences`, preference injection on every LLM call, and `SqliteSessionStore` — sessions survive a backend restart, restored if still inside the idle timeout and otherwise expired and ended.

### Phase 3c — Episodic memory — ✅ DONE
Episodes summarized when a session ends and written to SQLite first, embedded with nomic-embed-text via Ollama and indexed in Qdrant (localhost-only Docker, storage on a host volume), per-turn recall under a hard latency budget, `search_memory`, graceful degradation when either service is down with a retried backlog, and dev scripts to rebuild the index from SQLite or forget one episode.

Measured: recall costs 41–104ms per turn (warm embed ~40ms); related questions score 0.58–0.81 against real episodes while unrelated ones top out at 0.57.

### Post-3c behaviour fixes — ✅ DONE (live-verified)
Five problems found in live voice testing, all of them behaviour rather than plumbing:
1. **No way to end a conversation.** `start_new_conversation`, the REPL's local `/reset`, and a deferred end at the turn boundary. See *Conversation lifecycle*.
2. **Ixa did not know she had memory.** A memory description in `SYSTEM_PROMPT`, and the duplicated tool list removed. See *What Ixa knows about her own memory*.
3. **Voice replies far too long and formatted for text** (87 seconds of speech, with lists and bold). A stricter `VOICE_RESPONSE_PROMPT` plus `sanitizeForSpeech` at the TTS boundary. See *Voice response shaping*.
4. **Prices and products stated without searching.** A freshness rule in `SYSTEM_PROMPT`.
5. **"What did we talk about last time?" unanswerable.** `search_memory`'s query is optional; no query means recency, from SQLite. See *Memory architecture*.

**Verification status — ✅ live-verified.** The automated suite covers all five, and the live end-to-end run finished on the Dev tier (the free tier's daily cap was what had blocked it). Live testing then found five further behaviour gaps, which is what the *Voice behaviour* work below fixes.

### Voice behaviour — ✅ DONE
Five gaps found in live voice testing after the post-3c fixes.

**Spoken replies are shortened at a boundary, never mid-sentence.** `VOICE_RESPONSE_PROMPT` gained three short example exchanges (examples, not more rules — the rules were already being read as having an escape hatch), and `shortenForSpeech` (`src/voice/shorten.ts`) is the backstop for when they lose. It counts **spoken units**, not sentences: a line break is a boundary, because the sanitizer turns a heading or list item into its own sentence, and counting only sentence-ending punctuation would wave a six-item markdown list straight through. It cuts the **original** text by offset, so the kept prefix keeps its markdown and still goes through `sanitizeForSpeech` at the TTS boundary — `sanitize.ts`'s "nothing is truncated" invariant is untouched. If there is no boundary at or before the limit the whole reply is spoken, logged; a verbose reply is survivable, one that stops mid-sentence sounds broken. What the user HEARS is the trimmed text plus a fixed offer; what history RECORDS is that text plus `[reply shortened for speech: spoke 3 of 5 sentences]` — the inverse of `turnFailureReply`. The dropped sentences are not kept: regenerating under the same prompt beats keeping an example of a long spoken reply in history. Voice-origin turns only.

**Length is bounded by words, not sentences.** Added after the first scoreboard: with only a unit count, the model kept to three sentences and wrote sentences of 5 to 12 seconds, so `IXA_VOICE_MAX_WORDS` (default 40, a little above the ~35 the prompt asks for so an on-budget answer is never cut) now runs alongside `IXA_VOICE_MAX_SENTENCES`, and whichever binds first applies. Whole units are kept while the cumulative word count fits; the **first unit is always kept**, because a single sentence over budget has no boundary inside it and speaking a long sentence beats speaking none. Measured over the same six questions: both limits off gives a 26.2s mean, 71.1s worst, 59.2 words mean and 176 worst; with both on it is **13.9s mean, 19.5s worst, 30.5 words mean, 39 worst**, the backstop firing on 2 replies in 6 — the first run in which nothing ran past the 25s target.

**Recency needed a fact in context, not just a tool.** `search_memory` could answer "what did we talk about last time?" since 3c, but the model had to know there was something to look up. Recall matches on meaning and that question has no subject, so nothing was injected and the preference block was the only memory-shaped text in the request — so that is what Ixa answered from. `EpisodicMemory.lastEpisodeLine()` now injects one line per call naming when the last conversation ended and its tags, straight from SQLite (no embedding, no network, so it survives Qdrant and Ollama both being down), and the preference block's header says it is not a record of past conversations. The line is the date, the time and the tags and **nothing else**: the first version also explained when to call `search_memory` and not to answer from preferences, which `SYSTEM_PROMPT`, the tool's own description and the preference header already said, and which cost 90 tokens per call to repeat. Trimmed to 86 chars / **26 tok** (122 chars / 34 tok with six tags), verified still to produce the `search_memory` call.

**Freshness is about the fact, not the question.** The old rule read as being about price *questions*, so a price named in passing inside a recommendation escaped it. It now applies to any specific price, availability or current product wherever it appears, and says to name the product without the number if there was no search.

**And the rule has a backstop, because the prompt still loses sometimes.** Asked "what CPU should I get for local AI?" the model produced a tiered list with a price against every tier and no search at all. The **price guard** (`src/core/prices.ts`) now checks every draft reply before anything is recorded or delivered: a currency amount with no `web_search` executed *in that turn* is not delivered. Instead the correction is injected and the loop runs again, so the retry goes through the **normal tool loop** — a search it provokes is a real, recorded `web_search` with a real result, never a claimed one. It retries **once**; a second priced draft is delivered with a warning rather than looping, because the user is waiting and one unsearched price beats a turn spent arguing. Both origins, and it runs *before* the spoken-length backstop so the shortening applies to the reply that actually goes out.

Neither the rejected draft nor the correction is written to history. The user never heard the draft, and history claiming otherwise is the same drift the turn-failure path exists to prevent; the correction, like the preference block and the voice constraint, is a statement about one call.

What counts as a price is deliberately narrow, because this domain is full of numbers that are not money — "RTX 3090", "16 GB", "1440p", "7B", "24000 chars" — so a match needs a currency symbol or an explicit currency word beside the digits. The one shape that caught us out was the model's own: it writes thousands with a **narrow no-break space** ("$1 200–$1 500") at least as often as a comma, and matching only commas pulled "$1" out of it and quoted that back as the figure it had stated.

**Dismiss matches only at the end of an utterance, and never negated.** `isDismissPhrase` matched anywhere in the transcript, so "What's the capital of Japan? Stop listening." was dismissed without being answered. `parseDismiss` matches the phrase as a word-sequence **suffix**, rejects it if any negator appears before it ("don't stop listening", "I didn't say stop listening"), and returns the preceding words as a remainder to run as a normal turn — closing the window after the reply rather than instead of it. Filler before the phrase ("okay, thanks") is manners, not a turn; "yes" and "no" are answers, so they are words. The costs are lopsided — a missed dismiss waits out a 20s timeout, a false one throws the question away — so it leans towards not dismissing. `src/voice/dismiss.ts` is the only phrase list; both clients merely react to `sessionEnd`. An utterance that asks and then dismisses now gets `replyEnd` **and** `sessionEnd`, in that order.

**STT is told what vocabulary to expect, and drops segments it invented.** `base.en` returned "Kakaro", "Q-Drant", "Alama" and "tail skill" unhinted, and turned "RTX 3090" into "$30.90" in a live price question. `sidecars/stt/hints.py` builds the hint arguments and is imported by both the sidecar and the measurement script, so what is measured is what runs. In faster-whisper 1.2.1 `hotwords` and `initial_prompt` land in the same decoder slot and compose; measured over 14 phrases, unhinted scored 9/14 and `hotwords`, `prompt` and `both` all scored 14/14, so the tie went to `prompt` on transcript quality (`hotwords` alone returns "is the RTX 3090 still worth buying." with no capital and no question mark). The list carries whole model names (`RTX 3090`, `RTX 4090`, `RTX 5090`) as well as the bare brand, because the two fail separately: live testing heard "RTX 3090" as **"RTX 39D"** — the decoder got "RTX" and then guessed at four digits it had no reason to expect. Segment filtering on `no_speech_prob` / `avg_logprob` is what drops an invented segment — see Current open items for why it is proven safe but not yet proven useful.

### Turn resilience — ✅ DONE
LLM request ceiling and stream-inactivity deadline, explicit `maxRetries`, a logging `fetch` wrapper instead of a second retry policy, a generic per-tool ceiling with confirmation time excluded, bounded `fetch` in `web_search` and the notifier, a TTS inactivity deadline, fail-well on all three transports (`replyEnd` from a `finally`, socket kept open), the user message persisted before the turn runs, tool-call groups completed truthfully on failure, and a failed turn recorded as the apology the user heard rather than as an unanswered question. See *Turn resilience*.

### Phase 3d — Ixa's notebook — 🔜
Five steps. **Step 1 was a throwaway spike** (branch `phase-3d-spike`, unmerged) that decided the note shape and chunking by measurement; its findings are recorded under *Ixa's notebook* and the scripts are not shipped. **Step 2 builds it:**
- `save_note` and `search_notes`, ungated, with their descriptions written as a pair against `remember_preference`.
- Markdown written atomically by Ixa into her own vault (`~/Ixa-Vault` by default, `OBSIDIAN_VAULT_PATH`), path built in code from type + slug + date; a note's id is `<date>-<slug>` and a superseded note keeps its path.
- Heading-based chunking into SQLite, embedded into **a second Qdrant collection** (`ixa_notes`); re-embedding only chunks whose hash changed.
- Retrieval by rank: top 3, `status: active`, **no score floor**.
- A price in a note must come from the user's turn or a `web_search` run that turn.
- `dev/scripts/rebuild-note-index.ts`, the notes equivalent of the episode rebuild (Qdrant from the SQLite chunks).

Later steps: the reconcile scan, Syncthing (gaming PC Send Only, viewers Receive Only), and — still open — semantic session boundaries / topic-drift detection, if conversations turn out to need finer episodes than "one session, one summary".

**Out of scope for step 2:** the reconcile scan, Syncthing, FTS5, and autonomous writing (Ixa deciding on her own to write a note without being asked).

Done when: Ixa writes a note when asked, finds it again later, and never writes a fact nobody gave her.

### Phase 4 — Voice polish + integration layer — 🔜
- Smart Turn v3 on top of Silero (desktop), validated against the reference implementation.
- Browser VAD: port Silero + Smart Turn to onnxruntime-web, replacing tap-to-end-turn.
- MCP client in the harness + Ixa policy table (default confirm).
- Home Assistant via HA's MCP server: read state freely, physical actions confirmed.
- Optional: overlap LLM token streaming with TTS (send each completed sentence to TTS while the LLM is still generating).

Done when: turn-ending feels natural on both clients, and Ixa can query and (with confirmation) control HA devices through MCP.

### Phase 5 — Code execution + Google — 🔜
- Sandboxed shell with file read/write; isolated execution (subprocess or Docker sandbox).
- Voice-driven coding flow (transcribed chat log).
- Gmail + Sheets (native googleapis vs MCP server: decide at phase start; resolve keytar-on-headless first).

Done when: you can voice-drive a coding session and Ixa executes the code to verify it.

### Phase 6 — Research pipeline + proactive — 🔜
- Multi-step research loop (search → fetch → summarize → repeat), Readability.js extraction.
- OctoPrint webhooks (Hono receiver), full morning debrief (weather, calendar, tasks).
- Self-hosted Ntfy.

Done when: you ask for research and get a sourced, synthesized answer without touching a browser.

### Phase 7 — Browser / alongside mode — 🔜
- Persistent Stagehand/Playwright session; full `navigate`/`click`/`type`/`scroll`/`screenshot` set.
- Alongside mode (visible window) + supervision interface (approve/interrupt).

Done when: you can watch Ixa complete a multi-step website task.

### Phase 8 — Vision loop / computer use (future) — 🔜
- Vision-capable model (Claude API or local multimodal such as Qwen-VL), structured action output, state tracking across act → screenshot → reason cycles.
- Needs the homelab for local vision models.
- Built on Phase 7 primitives with no rewrite.

---

## Evaluated and Not Adopted

| Option | Decision | Reason |
|---|---|---|
| **OpenClaw** (self-hosted assistant) | Study only | Same goals, but its 2026 record is the cautionary tale: hundreds of malicious marketplace skills, tens of thousands of internet-exposed instances, no isolation between skills. It reinforces Ixa's hardcoded confirmation, tailnet-only exposure, and no-unreviewed-code rules. |
| **Leon** (Node personal assistant) | Study only | Architecturally closest, but mid-rewrite with its 2.0 core in developer preview. Possibly useful for skill-structure ideas. |
| **Pipecat / LiveKit Agents** (voice frameworks) | Not adopted | Would replace an already-built, tuned pipeline. Pipecat is Python-only; LiveKit's turn detector is license-bound to LiveKit. *Exception:* Pipecat's **Smart Turn** model is adopted standalone. |
| **Speaches** (OpenAI-compatible STT/TTS server) | Not adopted now | Would replace working sidecars for modest gain. Borrow its model-preload-before-healthy pattern. Revisit when consolidating sidecars on the homelab. |
| **Mem0 / Letta / Graphiti** (agent memory) | Not adopted | Phase 3 built its own memory to fit the harness. Mem0 is Python and duplicates that role; Letta is a full runtime that would replace the harness; Graphiti needs a graph DB. Temporal-fact idea noted. |
| **browser-use** | Not adopted | Python-only. Stagehand covers the need in TS. |
| **WebRTC transport** | Not adopted | One-to-one client↔backend voice works over WebSocket when VAD runs client-side. WebRTC earns its complexity only for telephony, video, or multi-party. |
| **GPU TTS on RX 6600 XT** | Not pursued | AMD card: CUDA impossible, ROCm-on-WSL unsupported for this card. GPU synthesis waits for the homelab's NVIDIA GPU. A CPU-only torch wheel would shed the unused CUDA libraries (cleanup, not urgent). |
| **ElevenLabs** | Ruled out | Cloud dependency, latency, privacy, and recurring cost conflict with the self-hosted design. Kokoro is the production TTS. |
| **Disk-streaming LLM inference** (AirLLM, mmap offload) | Ruled out | MoE random expert access compounds latency across multiple LLM calls per turn, which is incompatible with the sub-2s voice target. |
| **Brave Search** | Replaced | Tavily is the search provider (SearXNG under consideration). |
| **Hetzner CX32 (~$8/mo)** | Fallback only | Cloud fallback if self-hosting is temporarily impractical. |

---

## What This Is Not

- Not a framework. The tool loop is small, readable TypeScript.
- Not a cloud service. Cloud pieces (Groq, Tavily, ntfy.sh) are interim with a planned exit.
- Not a single-device app. Clients are thin; the backend is the product.
- Not finished. This document describes the target and marks what is built (✅) versus planned (🔜).

---

*Last updated: 2026-10-10 (seventh entry: the notebook premise reversed). **Ixa writes the notes.** The vault is her own notebook, she is the only writer, Obsidian is a viewer, and the markdown files are the source of truth with SQLite chunks and Qdrant rebuildable from them — so "the agent never writes to the vault" and the Obsidian → Syncthing → chokidar flow are both retired, and the chokidar watcher is deleted from the design rather than deferred. Added the *Ixa's notebook* decision section with what the step-1 spike measured: no score threshold works (real answers down to 0.586, wrong-note text up to 0.755, with `IXA_RECALL_MIN_SCORE`'s 0.60 inside the overlap), the three chunking variants differ by noise, small-to-big gains nothing and is not adopted, and the real failure was routing rather than retrieval — `remember_preference`'s description made `save_note` unreachable for three of ten requests, so the two descriptions are now written and tested as a pair. Recorded that `save_note`/`search_notes` are ungated on the memory-tools argument plus the difference that argument does not cover — a wrong note persists — mitigated by read-back, harness-stamped provenance, supersede-not-overwrite, and a path built in code so the model cannot name one. Recorded the note price rule (an amount must come from the user's turn or a `web_search` run that turn, compared on normalised value, with an "as stated on" line appended by code) and why the existing price guard cannot catch it: it reads the draft reply and never sees a tool argument. Phase 3d is now five steps with the reconcile scan, Syncthing (Send Only / Receive Only) and FTS5 out of scope for step 2. Corrected two stale figures: the tool schemas measure **8533 chars / ~2133 tok**, not 8015 / ~1400, and `remember_preference`'s 1470 chars are its whole schema entry, not its description (852). New open items: a claimed action with no tool call, mishearing reaching storage, FTS5, and the episode recall threshold probably being weak for the same reason the notes threshold was abandoned. Sixth entry: the price guard. Added a backstop behind the freshness rule: a draft reply containing a currency amount with no `web_search` executed in that turn is not delivered, and one corrective pass runs through the normal tool loop so any search it provokes is real and recorded; it retries once and then delivers with a warning rather than looping, on both voice and text turns, ahead of the spoken-length backstop. Neither the rejected draft nor the correction reaches stored history. Added whole GPU model names to the STT hint list after live testing heard "RTX 3090" as "RTX 39D", measured at 18/18 hinted against 13/18 unhinted — though the model-number cases pass unhinted on synthesized audio, so that specific fix is unverified. Test count 194 → 206. Fifth entry: concision by length. Bounded spoken replies by WORDS as well as sentence count — `IXA_VOICE_MAX_WORDS`, default 40 — after measurement showed the model obeying a three-sentence limit and then writing 12-second sentences; mean spoken time fell from 26.2s to 13.9s and the 25s target is met for the first time. Trimmed the recency line from 402 chars / 90 tok to 86 chars / 26 tok by deleting instructions three other places already carry. Measured STT segment filtering against real room tone: it transcribes to nothing unfiltered in every hint mode and no segment was dropped at any threshold, so the filter is safe but so far unnecessary — `vad_filter` is already doing that job. Test count 186 → 194. Fourth entry: voice behaviour. Added the Voice behaviour decisions — the spoken-length backstop and why it cuts the original text at sanitizer-equivalent boundaries, the recency line as a SQLite read injected per call, freshness as a rule about facts rather than questions, suffix-only dismiss matching with a negation guard, and STT vocabulary hints with segment filtering. Marked the post-3c behaviour fixes live-verified and turn resilience done. Replaced the stale ~4500-token full voice request figure with ~6400 at 24000 / ~4900 at 12000; after this branch's prompt growth the same synthetic request measures 7947 tok at 24000 and 5281 at 12000 (SYSTEM_PROMPT 522 → 608 tok, VOICE_RESPONSE_PROMPT 269 → 428 tok, plus the 160-tok recency line). Test count 127 → 186. New open items: three sentences is not a short reply, concision is not a model-size problem, segment filtering is proven safe but not useful, the domain-word measurement is synthesized, and why four user turns in the live database have no reply. Third entry: turn resilience. Second entry: post-3c behaviour fixes. Added the Conversation lifecycle, Voice response shaping and memory self-knowledge decisions; recorded that recency is a SQLite question and that dates are local time throughout; noted that `sanitizeForSpeech` works on a complete reply and will need to become incremental if Phase 4 overlaps streaming with TTS; documented why `start_new_conversation` is ungated in terms of what was actually traced (session rows are never deleted; the episode summary is best effort and not retried). Refreshed stale open items: Groq's free-tier limits are now the binding constraint and carry measured numbers, `TAVILY_API_KEY` is set, WSL exposes 8 vCPUs (TTS not yet re-benchmarked), and the `SYSTEM_PROMPT` tool-list duplication is resolved. Tool count 11 → 12, test count 84 → 127. Earlier entry: phases 3a, 3b and 3c marked done and described; the contradictions reported during 3a/3b fixed; the client conversation state machine added. Update this document when a decision changes, not after the fact. When code and this doc disagree on specifics, the code wins. Fix the doc.*
