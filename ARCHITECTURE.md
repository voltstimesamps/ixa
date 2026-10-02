# Ixa — Architecture Document

> Source of truth for **decisions and their rationale**. Every Claude Code session should read this before touching code.
>
> **What this doc is authoritative for:** vision, principles, design decisions, status, and what was evaluated and rejected.
> **What it is NOT authoritative for:** exact file paths, env var names, function signatures. The code, `.env.example`, and `package.json` win on specifics. Where this doc says **(verify)**, reconcile it against the repo and update the doc.
>
> Project name: **Ixa** (pronounced "eh-chs-uh"), wake phrase **"Hey Ixa"**. Internal code name: `jarvis` (appears in older notes and some identifiers).
> Repo: `voltstimesamps/ixa`. Canonical checkout: `/home/wyatt/Projects/ixa` (native WSL2 filesystem on the gaming PC).

---

## Vision

Ixa is a personal AI operating system: a persistent, voice-native agent deeply integrated with the tools and environment of daily life. It is not a chatbot with plugins. It is a coordinator with tool access, memory, and modality switching. It runs continuously in the background and can be invoked from any device.

North star: it should feel like a capable person who is always available, knows your context, remembers your history, acts on your behalf with appropriate confirmation, and is reachable at the desk, on the move, or at home.

---

## Core Philosophy

- **Backend-first intelligence.** All reasoning, tool execution, memory, and speech synthesis/recognition live on the backend. Clients stay thin and stateless.
  - **Deliberate exception:** wake-word detection and voice activity detection run **on the client**. This keeps the mic stream local until the user actually addresses Ixa, avoids streaming continuous room audio over the network, and removes a network round-trip from the latency-critical "is someone talking?" decision. Clients still hold no conversation state.
- **Always-on (target).** The harness is designed to run as a daemon that fires scheduled tasks, receives webhooks, and sends alerts with no client connected. During development it runs via `npm run dev`.
- **Swappable backends.** The LLM is reached through one `LLM_BASE_URL` + `LLM_API_KEY` (+ `LLM_MODEL`) env var set using the `openai` npm package. Moving from Groq to a homelab Ollama/llama.cpp instance is a `.env` change, not a code change.
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
│   ├── Ryzen 5 5600G, RX 6600 XT
│   ├── Harness (Node/TS), STT + TTS Python sidecars
│   └── Qdrant (Docker), nomic-embed-text via Ollama   (verify host details)
├── Framework 13 (AMD 7040, Fedora 44, 32GB) — primary voice client (Python desktop client)
├── iPhone (Safari)       — browser test client at /test over Tailscale HTTPS
└── Surface Pro 7s (×3)   — thin client terminals (optional)
```

**Networking gotcha:** Tailscale inside WSL2 is a **separate node** from any Windows-side Tailscale, with its own IP (shown as e.g. `desktop-1 (wsl)`). Always confirm the backend address with `tailscale status` **inside WSL2** after any networking change. Never reuse an IP from earlier in a session.

### Future (homelab online)

```
Tailscale mesh
├── Homelab (24GB-class GPU, e.g. RTX 3090) — local inference (Ollama/llama.cpp), embeddings, possibly Qdrant
├── SFF desktop (Optiplex / EliteDesk / ThinkCentre, 8th–10th gen) — always-on services node:
│     harness daemon, sidecars, self-hosted Ntfy, webhooks, cron
├── Framework 13 — primary client
└── Phone / Surfaces / other clients
```

Migration is configuration only: `LLM_BASE_URL`, `QDRANT_URL`, and Ollama URL change, with no client code changes. Target local models once 24GB of VRAM is available: gpt-oss-20b or Qwen3-Coder-30B-A3B fully in VRAM. The RX 6600 XT limits local inference to roughly 7B models, which is why Groq is the interim backend.

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
- **Episodic memory.** Session summaries retrieved semantically at session start.
- **Preference learning.** Structured store of learned preferences.
- **Notes.** Obsidian vault as the human write interface, embedded for semantic search.

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
- Encoded as `requiresConfirmation: boolean` on every tool. The gate is **transport-agnostic**: a `Confirmer` is injected, so the same gate works over voice (TTS readback + spoken yes/no) and text clients.
- **Imported (MCP) tools follow the same rule** via an Ixa-side policy table. **Unknown tools default to confirm.**

---

## Tech Stack

### Languages
- **TypeScript** for the harness, API, tools, memory, and proactive layer. Naming: PascalCase for classes/types/interfaces, camelCase for variables/functions.
- **Python** only where the ecosystem requires it: speech sidecars and the desktop voice client. Each sidecar has its own venv (TTS uses Python 3.11).

### Current stack by layer

| Layer | Choice | Notes |
|---|---|---|
| LLM | Groq, `openai/gpt-oss-20b` | Via `openai` npm package; swappable by env |
| API | Hono (REST) + WebSocket | `WsMessage` protocol including audio message types |
| STT | faster-whisper (Python sidecar) | `vad_filter=True` |
| TTS | Kokoro, voice `af_nova` (Python sidecar) | Streaming: chunked HTTP transfer encoding, per-chunk WAV blobs, 20MB frame ceiling on both sides |
| Wake word | openWakeWord, custom `hey_ixa.onnx` (~772KB) | Client-side. See Voice Pipeline decisions |
| VAD | Silero VAD as pure `onnxruntime` + `numpy` reimplementation | Client-side; no torch (avoids ~5GB dependency); bit-identical to official wrapper |
| Browser-side inference | onnxruntime-web | Wake word ported and validated in browser |
| Web search | Tavily | Replaced Brave from the original plan |
| Shell | `shell_read` / `shell_write` | Cross-platform command translation; session-scoped working directory |
| Vector DB | Qdrant (Docker) | Episodic memory |
| Embeddings | nomic-embed-text via Ollama | 768-dim |
| Preferences | SQLite via better-sqlite3 | |
| Scheduling | node-cron | Morning debrief skeleton exists |
| Notifications | Ntfy | ntfy.sh public server in dev; self-host planned |
| Networking | Tailscale | All clients reach the backend over the tailnet |
| Notes (planned) | Obsidian + Syncthing + chokidar | Not yet built |
| OAuth tokens (planned) | keytar | **Open question:** keytar needs a running Secret Service (libsecret), which headless WSL2/server installs usually lack. Decide before Gmail work. |

### Adopted from 2026-10 integration research (planned, not yet built)

| Component | Choice | Why |
|---|---|---|
| Turn detection | **Smart Turn v3** (Pipecat), ONNX | Decides end-of-turn from intonation, not a fixed silence timer. ~8M params, 8MB int8 ONNX, Whisper-Tiny encoder + linear head. BSD 2-Clause (not tied to Pipecat). Layers **on top of** Silero, which must use a ~0.2s stop threshold to match training. |
| Integration protocol | **MCP client in the harness** | One generic adapter instead of a bespoke wrapper per service. First consumer: Home Assistant's native MCP server (Streamable HTTP). |
| Browser layer (Phase 7) | **Stagehand** (TS, MIT) | Playwright-compatible; deterministic Playwright calls and AI actions can be mixed in one script. Use deterministic paths for routine flows; AI actions are less reliable than plain selectors. |

---

## Architecture

### System Layers

```
Cloud APIs (Groq, Tavily, ntfy.sh)          MCP servers (HA first; others later)
        │ HTTPS                                      │ Streamable HTTP over tailnet
        ▼                                            ▼
┌───────────────────────────────────────────────────────────┐
│                    Backend (gaming PC, WSL2)              │
│                                                           │
│  Core Harness                                             │
│    SessionManager · tool loop · confirmation gate · LLM   │
│                                                           │
│  Tool layer                    Memory                     │
│    native tools (shell,          Qdrant episodic          │
│    search, time/date, …)         SQLite preferences       │
│    MCP client + policy table     (vault pipeline planned) │
│                                                           │
│  Proactive                     API layer                  │
│    node-cron · Ntfy              WebSocket (voice)        │
│    (webhooks planned)            Hono REST (text, /test)  │
│                                                           │
│  Python sidecars (own venvs, spawned by npm run dev)      │
│    STT: faster-whisper    TTS: Kokoro (streaming)         │
└───────────────────────────────────────────────────────────┘
        │ Tailscale
        ▼
Clients (stateless; wake word + VAD run locally)
  Framework 13 desktop client (Python) · iPhone /test (browser) · Surfaces
```

### Key Data Flows

**Voice turn:**
```
[client] mic → wake word ("Hey Ixa", 2-frame rule) → conversation opens
[client] end of utterance:
         desktop: Silero VAD (SPEECH_PROB_THRESHOLD / TRAILING_SILENCE_MS)
         browser: tap-to-end-turn (VAD deferred)
         planned: Silero + Smart Turn v3 on both
→ audio over WebSocket → [backend] STT sidecar → LLM + tool loop
→ confirmation gate (if tool requires it) → tool execute → LLM response
→ TTS sidecar streams chunks → [client] plays first chunk while later chunks synthesize
→ loop until dismiss phrase or 20s conversation timeout
→ [client] reset wake model (Model.reset()) before listening again
```

**Session and memory:**
```
SessionManager (singleton) tracks a session across turns
→ semantic session boundaries: topic drift detected via cosine similarity
→ at boundary: summarize session → embed (nomic-embed-text, 768-dim) → upsert to Qdrant
→ at session start: retrieve relevant episodes + preferences → inject into context
```

**Tool execution with confirmation:**
```
LLM calls a tool
→ harness looks up requiresConfirmation
    native tool: from its definition
    MCP tool: from the Ixa policy table (unknown → confirm)
→ if true: Confirmer prompts via the active transport
    voice: TTS readback "I'm about to … Confirm?" → spoken yes/no
→ yes: execute, append result, resume loop
→ no:  append cancellation, ask what to do instead
```

**Proactive interrupt (target):**
```
cron fires OR webhook received (HA / OctoPrint)
→ check HA presence
→ if home and a session is active: speak via client
→ always: Ntfy push
→ desktop: notification popup
→ DND 11pm–7am: queue unless critical
```

**Memory pipeline for notes (planned):**
```
note saved in Obsidian (any device) → Syncthing → backend vault copy
→ chokidar detects change → chunk → nomic-embed → upsert to Qdrant (filename, date, tags)
```

---

## Key Design Decisions

### Voice pipeline
1. **Wake word runs client-side** (desktop: Python `openwakeword`; browser: onnxruntime-web port validated to within 3e-6 of the Python pipeline, ~4.3ms mean per 80ms chunk on iPhone).
2. **Trigger rule: 2 consecutive frames ≥ 0.5.** `hey_ixa.onnx` can spike on room tone for a single frame (observed up to 0.84). openWakeWord's own `patience` parameter is broken in v0.6.0 (it suppresses real triggers too), so the custom rule is implemented **identically** on desktop and browser. Validated live on Framework 13.
3. **Always reset the wake model on sleep** (`Model.reset()`) after timeout or dismiss. Without it, residual state causes an immediate false re-wake.
4. **Frame buffer is separate from the VAD state machine** (`audio_framing.py`), so wake word, VAD, and future turn detection attach to the same frames without rework.
5. **Turn detection direction:** Silero decides "is there speech"; Smart Turn v3 (planned) decides "is the speaker finished." Port it with the same pattern as the wake word: baseline script → fixture comparison against the reference implementation → wire in only once validated.
6. **Voice-origin responses are shaped differently.** A `MessageOrigin` type threads through `send()` / `runToolLoop()`. Voice turns get a short plain-sentence system prompt addition. `messagesForCall()` builds a fresh message array per call and never mutates session state.
7. **Sidecar readiness must mean ready to infer fast**, not just port open. `npm run dev` spawns both sidecars from their own venvs and waits on a readiness probe. A TCP probe alone can pass before models are warm, so a warmup synthesis/transcription before reporting ready is the intended fix (verify current behavior).
8. **Push-to-talk** exists as a toggle (`:rec`) for debugging and noisy environments.

### LLM abstraction
- All environment-specific values are read in **one config module** (`src/config.ts`, verify). No other file reads `process.env`.
- The canonical list of variables lives in **`.env.example`**, not in this doc.

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

### MCP integration layer (decided, not built)
- **The harness is an MCP client.** Imported MCP tools are adapted into the same `Tool` shape as native tools and enter the same registry and tool loop.
- **Policy table.** An Ixa-owned mapping from `server + tool name → requiresConfirmation` (plus an optional enable/disable flag). MCP tools carry no Ixa confirmation semantics, so the policy table is the only source of that bit.
  - **Default for any tool not in the table: confirm.** A newly exposed tool on a server can never silently gain free execution.
  - Read-only tools are explicitly allowlisted as free.
- **Exposure.** MCP servers are reached over the tailnet only. Nothing is exposed publicly.
- **Trust.** Only servers chosen and reviewed deliberately. No marketplace auto-install.
- **First consumer: Home Assistant** via HA's built-in Model Context Protocol Server integration (Streamable HTTP), which exposes control through HA's Assist API. The HA auth method is to be settled in the design pass.
- Gmail/Sheets may also arrive as MCP servers rather than native googleapis wrappers. Evaluate when Phase 5 starts.

### Browser / computer use
1. Browser session is a **persistent first-class object**: open once, run many tool calls against it, close when done. Never one-shot per call. This holds whether the layer is raw Playwright or Stagehand.
2. `screenshot()` is first-class alongside `navigate`, `click`, `type`, `scroll` from day one.
3. **Stagehand** is the planned SDK. Routine/repeatable flows use deterministic Playwright calls; AI actions are reserved for unfamiliar or changing pages.
4. The vision loop (Phase 8) sits on top of the same primitives: `screenshot → vision model → structured action → repeat`. No rewrite if session persistence is built correctly now.

### Memory architecture
- **Working memory:** LLM context window.
- **Episodic memory:** session summaries in Qdrant, with semantic session boundaries and topic-drift detection.
- **Semantic memory (planned):** Obsidian vault → chokidar → nomic-embed → Qdrant.
- **Preference memory:** SQLite (better-sqlite3).
- Obsidian is the human write interface. The agent never writes to the vault; it queries Qdrant. The vault is Wyatt's; the vector store is Ixa's view of it.
- **Idea noted for later:** temporal facts (Graphiti-style). Record *when* a preference became true so "drinks tea now, previously coffee" is data, not an overwrite. Not adopted now because it needs a graph database.

### Client architecture
- Clients are stateless with respect to conversation; the harness holds all session state, so reconnects resume seamlessly.
- Clients do own their local audio state: wake model, VAD, and frame buffer.
- The desktop client reads the backend address from the **`IXA_HOST` env var** (defaults to localhost). It must be set for remote testing, e.g. `IXA_HOST=<tailscale-ip> python client.py`.

---

## Repository Layout (verify)

Known files and their roles. Reconcile against the actual tree and expand this section.

```
ixa/
├── ARCHITECTURE.md
├── .env / .env.example          ← canonical env var list lives in .env.example
├── src/
│   ├── config.ts                ← only place env vars are read (verify)
│   ├── core/
│   │   ├── harness.ts           ← main loop, runToolLoop
│   │   └── session.ts           ← SessionManager, session lifecycle
│   ├── voice/
│   │   └── tts.ts               ← speakStreaming (streaming TTS client)
│   ├── tools/                   ← tool registry + native tools (verify names)
│   ├── memory/                  ← Qdrant episodic, SQLite prefs (verify names)
│   ├── proactive/               ← node-cron, Ntfy (verify names)
│   └── api/                     ← WebSocket + Hono REST, /test client route (verify)
├── sidecars/
│   ├── stt/                     ← faster-whisper (own venv)
│   └── tts/main.py              ← Kokoro streaming (own venv, Python 3.11)
└── clients/
    └── desktop/
        ├── client.py            ← reads IXA_HOST
        ├── wakeword.py          ← openWakeWord wrapper, Model.reset() on sleep
        ├── conversation.py      ← 2-consecutive-frame trigger rule
        ├── recorder.py          ← Silero VAD constants
        └── audio_framing.py     ← FrameBuffer
```

---

## Development Environment and Workflow

- **Division of labor:** architecture and design happen in Claude.ai chat. Implementation prompts are written there and run by Claude Code in a **WSL2 terminal on the gaming PC**.
- **Every command must state:** which machine (gaming PC backend vs Framework 13 client), WSL2 vs Windows (PowerShell), and inside vs outside which venv.
- **Only checkout:** `/home/wyatt/Projects/ixa` (native WSL2 filesystem). A stale pre-migration checkout under `/mnt/c/Users/.../Projects/ixa` caused hours of phantom bugs and has been removed. If one ever reappears, do not use it. (If Windows file locks block deletion: `wsl --shutdown`, then delete from PowerShell.)

### Recurring pitfalls
- **Commit and push before cross-device testing.** Uncommitted work on the gaming PC means the Framework 13 tests stale code.
- **Restart `npm run dev` after changes.** Stale processes silently serve old code.
- **esbuild platform mismatch:** Windows npm contaminating WSL2 `node_modules`. Fix with `rm -rf node_modules && npm install` inside WSL2.
- **WSL2 localhost is not reachable from Windows.** Use `curl.exe` or the Tailscale IP.
- **Windows Firewall** may block dev ports. Add rules with `New-NetFirewallRule`.
- **WSL2 Tailscale is its own node.** Confirm the IP with `tailscale status` inside WSL2.
- **Env vars do not migrate themselves.** After any checkout/machine change, diff `.env` against `.env.example`.

---

## Deployment Phases

### Phase 1 — Voice loop + basic chat — ✅ DONE
WebSocket/REST layer (Hono), `WsMessage` audio protocol, session refactor, STT sidecar, client-side Silero VAD, push-to-talk toggle, Kokoro streaming TTS, placeholder tools.
**Wake word — ✅ DONE:** "Hey Ixa" validated live on Framework 13 (sensitivity, false-positive resistance, VAD cutoff, 20s timeout). Browser `/test` client with client-side wake word validated on iPhone.

### Phase 2 — Tool calling — ✅ DONE
Confirmation gate (transport-agnostic `Confirmer`), Tavily search, `shell_read`/`shell_write`, Ntfy, node-cron morning debrief skeleton.
(Home Assistant moved to Phase 4 and will be built via MCP.)

### Phase 3 — Memory — ✅ MOSTLY DONE
Done: Qdrant episodic memory, SQLite preference store, SessionManager with semantic boundaries and topic-drift detection, episode/preference injection at session start.
Remaining: Obsidian vault pipeline (chokidar → embed → Qdrant) and Syncthing sync.

### Current open items (fix before Phase 4)
- **TTS chunking regression (unconfirmed).** A live log showed `1 chunk(s)` with the first chunk at 5.4s. Hypotheses: timer scope, sidecar cold start, sidecar buffering, or a TS call path regressed in a merge.
- **Tool registry check.** Confirm that Tavily search and the shell tools are registered and firing. HA/Gmail/Sheets/OctoPrint were never built, so their absence is expected, not a regression.

### Phase 4 — Voice polish + integration layer — NEXT
- Smart Turn v3 on top of Silero (desktop), validated against the reference implementation.
- Browser VAD: port Silero + Smart Turn to onnxruntime-web, replacing tap-to-end-turn.
- Sidecar warmup before readiness.
- MCP client in the harness + Ixa policy table (default confirm).
- Home Assistant via HA's MCP server: read state freely, physical actions confirmed.

Done when: turn-ending feels natural on both clients, and Ixa can query and (with confirmation) control HA devices through MCP.

### Phase 5 — Code execution + Google
- Sandboxed shell with file read/write; isolated execution (subprocess or Docker sandbox).
- Voice-driven coding flow (transcribed chat log).
- Gmail + Sheets (native googleapis vs MCP server: decide at phase start; resolve keytar-on-headless first).

Done when: you can voice-drive a coding session and Ixa executes the code to verify it.

### Phase 6 — Research pipeline + proactive
- Multi-step research loop (search → fetch → summarize → repeat), Readability.js extraction.
- OctoPrint webhooks (Hono receiver), full morning debrief (weather, calendar, tasks).
- Self-hosted Ntfy.

Done when: you ask for research and get a sourced, synthesized answer without touching a browser.

### Phase 7 — Browser / alongside mode
- Persistent Stagehand/Playwright session; full `navigate`/`click`/`type`/`scroll`/`screenshot` set.
- Alongside mode (visible window) + supervision interface (approve/interrupt).

Done when: you can watch Ixa complete a multi-step website task.

### Phase 8 — Vision loop / computer use (future)
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
| **Mem0 / Letta / Graphiti** (agent memory) | Not adopted | Phase 3 already covers Mem0's role; Letta is a full runtime that would replace the harness; Graphiti needs a graph DB. Temporal-fact idea noted. |
| **browser-use** | Not adopted | Python-only. Stagehand covers the need in TS. |
| **WebRTC transport** | Not adopted | One-to-one client↔backend voice works over WebSocket when VAD runs client-side. WebRTC earns its complexity only for telephony, video, or multi-party. |
| **ElevenLabs** | Ruled out | Cloud dependency, latency, privacy, and recurring cost conflict with the self-hosted design. Kokoro is the production TTS. |
| **Disk-streaming LLM inference** (AirLLM, mmap offload) | Ruled out | MoE random expert access compounds latency across multiple LLM calls per turn, which is incompatible with the sub-2s voice target. |
| **Brave Search** | Replaced | Tavily is the search provider. |
| **Hetzner CX32 (~$8/mo)** | Fallback only | Cloud fallback if self-hosting is temporarily impractical. |

---

## What This Is Not

- Not a framework. The tool loop is small, readable TypeScript.
- Not a cloud service. Cloud pieces (Groq, Tavily, ntfy.sh) are interim with a planned exit.
- Not a single-device app. Clients are thin; the backend is the product.
- Not finished. This document describes the target and marks what is done.

---

*Last updated: 2026-10-01. Rewritten to reflect actual implementation state (Phases 1–3), the gaming-PC/WSL2 backend, client-side wake word/VAD, and decisions from the 2026-10 integration research (MCP client, Smart Turn v3, Stagehand). Update this document when a decision changes, not after the fact. When code and this doc disagree on specifics, the code wins. Fix the doc.*
