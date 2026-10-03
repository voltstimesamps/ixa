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
- **Notes.** 🔜 Obsidian vault as the human write interface, embedded for semantic search.

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

**Registered tools today** (`src/tools/register.ts`): `get_time`, `get_date`, `echo`, `web_search`, `shell_read`, `shell_write`, `notify`, `remember_preference`, `forget_preference`, `list_preferences`, `search_memory`, `start_new_conversation`. All twelve are passed to the LLM for both voice and text turns. Only `echo` and `shell_write` require confirmation; the memory tools and `start_new_conversation` deliberately do not (see Autonomy Policy).

**The tool schemas are the single largest fixed cost in a request:** 8015 characters, ~1400 tokens, on *every* LLM call. That is roughly three times the system prompt. Trimming a verbose description is the cheapest way to buy headroom under Groq's free tier (see Current open items).

### Planned 🔜

| Component | Choice | Why |
|---|---|---|
| Notes | Obsidian + Syncthing + chokidar | Vault → embeddings pipeline (Phase 3d) |
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
│    🔜 MCP client + policy table  🔜 vault pipeline         │
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

**Memory pipeline for notes 🔜:**
```
note saved in Obsidian (any device) → Syncthing → backend vault copy
→ chokidar detects change → chunk → nomic-embed → upsert to Qdrant (filename, date, tags)
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
- **Semantic memory:** Obsidian vault → chokidar → nomic-embed → Qdrant. 🔜 (Phase 3d)
- Obsidian is the human write interface. The agent never writes to the vault; it queries Qdrant. The vault is Wyatt's; the vector store is Ixa's view of it.

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
│   │   └── episodic-memory.ts   ← write path, recall, backlog, degradation
│   ├── tools/
│   │   ├── registry.ts          ← Tool interface + registry
│   │   ├── register.ts          ← registers all 12 tools
│   │   ├── time.ts · date.ts · echo.ts · notify.ts
│   │   ├── search.ts            ← Tavily web_search
│   │   ├── shell-read.ts · shell-write.ts
│   │   ├── preferences.ts       ← remember / forget / list_preferences
│   │   ├── search-memory.ts     ← explicit episodic recall (by meaning, or by recency)
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
- **Groq free tier is now the binding constraint.** Measured limits: **8000 tokens per minute** and **200000 tokens per day**, both enforced as 429s (`x-ratelimit-limit-tokens: 8000`). A single request larger than the per-minute allowance is rejected outright — the 413 seen on an 8123-token request. Measured sizes, which say where the budget actually goes:

  | Piece | Size |
  |---|---|
  | Tool schemas (12 tools, every call) | 8015 chars / **~1400 tok** |
  | `SYSTEM_PROMPT` | 2138 chars / **522 tok** |
  | `VOICE_RESPONSE_PROMPT` (voice turns only) | 828 chars / **269 tok** |
  | A `web_search` result | ~5300 chars |
  | Full voice request, `IXA_CONTEXT_BUDGET_CHARS=24000` | **~4500 tok** |

  Consequences: **the per-day cap is reached easily** — a day of development testing exhausted 200000 and the window then refills by trickle, costing ~6 minutes of waiting per 2000-token request, which blocks live verification entirely. **The freshness rule increases `web_search` traffic**, and a search turn is two LLM calls, the second carrying the ~5300-char result. And **the prompt trim did not save tokens**: removing the duplicated tool list saved less than the memory, honesty and freshness rules cost, so `SYSTEM_PROMPT` grew from 262 to 522 tokens. The real levers are the tool schemas (`remember_preference`'s description alone is ~1470 chars) and `IXA_CONTEXT_BUDGET_CHARS`. **Decide between a paid Groq tier and the local-LLM migration before the next phase that needs live verification.**
- **Sidecar warmup** before readiness (removes the small cold-start inter-chunk gap).
- **SearXNG:** `SEARXNG_URL` is in `.env.example`. Determine whether `search.ts` has a SearXNG path. A self-hosted, keyless search backend fits the project better than Tavily long-term.
- **Re-benchmark TTS** now that WSL exposes 8 vCPUs (see Compute gotcha). The recorded real-time factors are still the 4-vCPU ones.
- **An episode lost to a summarizer failure is not retried.** The backlog sweep retries *indexing* of rows that exist; a session whose summarization LLM call failed never gets a row at all, and nothing goes back for it. The raw history is still in SQLite, so a re-summarization pass over ended sessions with no episode row is possible and cheap to add. Relevant now that `start_new_conversation` makes ending a session a routine, user-driven act.

**Resolved since Phase 3c:** `TAVILY_API_KEY` is set and `web_search` works. The WSL vCPU limit is raised (4 → 8). The `SYSTEM_PROMPT` tool-list duplication is gone — see *What Ixa knows about her own memory*.
- **Recall threshold is provisional.** 0.60 was set from a small sample. Against real episodes, genuinely related questions scored 0.58–0.81 and unrelated ones 0.46–0.57, so the margin is thin and one weak-but-real match (a topic mentioned in passing in a multi-topic summary) fell just under. Revisit once there are dozens of episodes; it is a config value (`IXA_RECALL_MIN_SCORE`).
- **Multi-topic summaries compress the similarity separation.** One summary covering three subjects matches everything weakly. This is the argument for topic segmentation in 3d, not just for a different threshold.
- **Next phase:** the **post-3c behaviour fixes** come first — they are corrections to what 3a–3c already shipped, and both Phase 3d and Phase 4 build on the conversation and voice behaviour they fix. After that, Phase 3d (Obsidian) or Phase 4 (voice polish + MCP), which are independent of each other.

### Phase 3a — Session ownership — ✅ DONE
`SessionManager` owning sessions independently of connections, one shared primary session, `SessionStore` interface, `Connection` abstraction, turn serialization, cancel-on-disconnect, idle timeout with the timer disarmed while turns are outstanding, and context windowing with atomic tool-call groups.

### Phase 3b — Preferences + session persistence — ✅ DONE
SQLite (better-sqlite3) with versioned migrations, the append-only preference store (supersede on update, soft delete on forget), `remember_preference` / `forget_preference` / `list_preferences`, preference injection on every LLM call, and `SqliteSessionStore` — sessions survive a backend restart, restored if still inside the idle timeout and otherwise expired and ended.

### Phase 3c — Episodic memory — ✅ DONE
Episodes summarized when a session ends and written to SQLite first, embedded with nomic-embed-text via Ollama and indexed in Qdrant (localhost-only Docker, storage on a host volume), per-turn recall under a hard latency budget, `search_memory`, graceful degradation when either service is down with a retried backlog, and dev scripts to rebuild the index from SQLite or forget one episode.

Measured: recall costs 41–104ms per turn (warm embed ~40ms); related questions score 0.58–0.81 against real episodes while unrelated ones top out at 0.57.

### Post-3c behaviour fixes — ✅ built, live verification incomplete
Five problems found in live voice testing, all of them behaviour rather than plumbing:
1. **No way to end a conversation.** `start_new_conversation`, the REPL's local `/reset`, and a deferred end at the turn boundary. See *Conversation lifecycle*.
2. **Ixa did not know she had memory.** A memory description in `SYSTEM_PROMPT`, and the duplicated tool list removed. See *What Ixa knows about her own memory*.
3. **Voice replies far too long and formatted for text** (87 seconds of speech, with lists and bold). A stricter `VOICE_RESPONSE_PROMPT` plus `sanitizeForSpeech` at the TTS boundary. See *Voice response shaping*.
4. **Prices and products stated without searching.** A freshness rule in `SYSTEM_PROMPT`.
5. **"What did we talk about last time?" unanswerable.** `search_memory`'s query is optional; no query means recency, from SQLite. See *Memory architecture*.

**Verification status.** The automated suite covers all five (127 cases, up from 84): the sanitizer, `/reset` handled locally with an LLM that fails the test if called, the deferred session end including the queued-turn case, and `search_memory` with and without a query. The **live** end-to-end run (a real voice-origin turn, a real reset, real memory questions) is **incomplete**: the Groq free tier's 200000-token daily cap was exhausted partway through, and the window refills too slowly to finish. Token sizes were measured before it ran out and are recorded under Current open items. Finish the live run when there is LLM budget.

### Phase 3d — Obsidian vault pipeline — 🔜
- Obsidian + Syncthing + chokidar → chunk → nomic-embed → Qdrant (a second collection).
- A note-query tool alongside `search_memory`.
- Semantic session boundaries / topic-drift detection, if conversations turn out to need finer episodes than "one session, one summary".

Done when: Ixa can answer questions from your Obsidian notes.

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

*Last updated: 2026-10-03 (second entry: post-3c behaviour fixes). Added the Conversation lifecycle, Voice response shaping and memory self-knowledge decisions; recorded that recency is a SQLite question and that dates are local time throughout; noted that `sanitizeForSpeech` works on a complete reply and will need to become incremental if Phase 4 overlaps streaming with TTS; documented why `start_new_conversation` is ungated in terms of what was actually traced (session rows are never deleted; the episode summary is best effort and not retried). Refreshed stale open items: Groq's free-tier limits are now the binding constraint and carry measured numbers, `TAVILY_API_KEY` is set, WSL exposes 8 vCPUs (TTS not yet re-benchmarked), and the `SYSTEM_PROMPT` tool-list duplication is resolved. Tool count 11 → 12, test count 84 → 127. Earlier entry: phases 3a, 3b and 3c marked done and described; the contradictions reported during 3a/3b fixed; the client conversation state machine added. Update this document when a decision changes, not after the fact. When code and this doc disagree on specifics, the code wins. Fix the doc.*
