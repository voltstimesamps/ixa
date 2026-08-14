# Ixa — Architecture Document

> This document is the source of truth for the Ixa project. Every Claude Code session should read this before touching any code. It captures the vision, decisions, constraints, and rationale built up before a single line was written.

---

## Vision

Ixa is a personal AI operating system — a persistent, voice-native agent with deep integration into the tools and environment of daily life. It is not a chatbot with plugins. It is a coordinator with tool access, memory, and modality switching that runs continuously in the background and can be invoked from any device.

The north star: it should feel like having a capable person available at all times who knows your context, remembers your history, can act on your behalf with appropriate confirmation, and is reachable whether you're at your desk, on the move, or at home.

---

## Core Philosophy

- **Backend-first.** All intelligence lives on the backend node. Clients are thin — they capture audio, display output, and relay input. Nothing important runs on a client.
- **Always-on.** The harness runs as a systemd daemon. It does not require a client to be connected to fire scheduled tasks, receive webhooks, or send alerts.
- **Swappable backends.** The LLM backend is abstracted behind a single `LLM_BASE_URL` + `LLM_API_KEY` environment variable pair. Switching from Groq to a homelab Ollama instance is one line in `.env`.
- **Confirmation gate.** Actions with real-world consequences require explicit confirmation before execution. Read operations are free; write/act operations ask first.
- **Open source and self-hosted wherever practical.** Prefer self-hosted services over SaaS. Prefer open-weight models over proprietary ones where quality allows.

---

## Hardware Topology

### Current (no homelab)

```
Cloud
├── Groq API              — LLM inference (primary)
├── Brave Search API      — Web search
└── Google APIs           — Gmail, Sheets

Tailscale mesh
├── Optiplex SFF          — Always-on backend (target hardware)
│   └── Fedora Server / Ubuntu Server
├── Framework 13          — Primary client (voice I/O, display)
├── Surface Pro 7s        — Thin terminals (optional)
└── Phone                 — Ntfy push notifications, future mobile app
```

### Future (homelab online)

The Optiplex becomes a pure services node. The homelab takes over inference. The only change is `LLM_BASE_URL` in `.env` and the Qdrant/Ollama URLs. No client code changes.

```
Tailscale mesh
├── Homelab               — GPU inference (Ollama), Qdrant, embedding model
├── Optiplex SFF          — Always-on services (harness, Ntfy, webhooks, cron)
├── Framework 13          — Primary client
└── Phone / other clients
```

---

## Capabilities

### Interaction
- **Voice I/O** — Wake word activates a persistent session. Dismiss phrase closes it. Always-on across any connected audio device.
- **Computer use** — Shell-level access (sandboxed) and browser/screen-level control via Playwright. Alongside mode preferred (user can watch); away mode as fallback.
- **Coding assistance** — Voice-driven pair programming, transcripted into a running chat log. Text is the source of truth; voice is the input method.

### Management
- **Email** — On-demand via Gmail API. Read, search, draft, send (confirmation required to send).
- **Calendar / planner** — Read and write Google Sheets planner via Sheets API.
- **Home Assistant** — Device state queries, automation triggers, presence detection. Confirmation required for physical automations.
- **3D printer** — OctoPrint monitoring, status queries, webhook alerts on print events.
- **Shopping / logistics** — Research, price comparison, order placement (confirmation required).

### Memory and Knowledge
- **Note taking** — Capture to Obsidian vault during conversation. Automatically embedded into vector store.
- **Task and project tracking** — Episodic memory records session summaries. Retrieves relevant context at session start.
- **Preference learning** — Structured store of learned preferences (music, routines, communication style).

### Proactive Behavior
- **Morning debrief** — Triggered by scheduled alarm or "good morning" phrase. Weather, calendar, tasks, context for the day.
- **Arrival home** — Triggered by Home Assistant presence detection. Music, automations, context switch.
- **Reminders and interrupts** — Scheduled via node-cron. Delivered via voice (if session active), Ntfy (phone), or desktop notification.
- **Monitoring and alerting** — Polling loops for OctoPrint, homelab health, Home Assistant anomalies. DND window enforced (no alerts 11pm–7am unless critical).

### Hardware (long-term)
- Smart glasses with HUD
- Native earbuds

---

## Usage Patterns and Key Decisions

### Voice
- Wake word → persistent session → dismiss phrase → session closes
- All audio devices supported depending on context (desk speakers, headphones, earbuds)
- Mobile via future React Native client connecting over WebSocket + Tailscale

### Autonomy
- **Read freely:** email, calendar, Home Assistant state, files, web search, shell read-only commands
- **Confirm first:** send email, push code, trigger physical automations, place orders, write/delete files outside sandbox, modify system state
- Encoded as `requiresConfirmation: boolean` on every tool definition — not reasoned at runtime

### Computer use
- Alongside mode preferred: a window shows the agent operating the browser in real time
- Away mode fallback: agent acts autonomously and returns a result
- Supervised for sensitive actions (accounts, payments), more autonomous for low-stakes tasks

### Voice-driven coding
- Voice input, transcripted into a running chat log
- Produces file artifacts and code blocks inline
- Text log is the source of truth; voice is input only

---

## Tech Stack

### Language
- **TypeScript** throughout the harness. No Python in the main process.
- **Python** for voice sidecars only (faster-whisper, Kokoro, openWakeWord). Called over local Unix sockets or HTTP.

### LLM Backend (abstracted)
- **openai** npm package — used for all LLM calls regardless of actual backend
- Groq now; homelab Ollama later; swap is one `.env` change

### Voice Layer (Python sidecars)
| Component | Library | Notes |
|---|---|---|
| Wake word | openWakeWord | Local, open source, runs on CPU |
| STT | faster-whisper | `base` model for speed, `small` for accuracy |
| TTS | Kokoro | Higher quality than Piper; streaming output |
| Audio I/O | node-record-lpcm16 + sox | Mic capture in Node |

### Browser and Computer Use
| Component | Library | Notes |
|---|---|---|
| Browser control | Playwright | Persistent session — see design decision below |
| Page extraction | Readability.js | Mozilla's reader-mode parser |

### Management APIs
| Service | Approach | Notes |
|---|---|---|
| Home Assistant | Custom fetch wrapper | REST + WebSocket API, bearer token |
| Gmail | googleapis npm | OAuth 2.0, auto token refresh |
| Google Sheets | googleapis npm | Same OAuth credentials as Gmail |
| OctoPrint | Custom fetch wrapper | Simple API key auth |
| OAuth token storage | keytar | OS keychain via libsecret on Linux |

### Memory and Knowledge
| Component | Library | Notes |
|---|---|---|
| Vector store | Qdrant | Docker, REST API, TS client |
| Embedding model | nomic-embed-text via Ollama | Local, private, 270MB |
| Vault sync | Syncthing | Cross-device Obsidian vault sync |
| Obsidian | Obsidian desktop app | Human write interface; files are plain markdown |
| File watcher | chokidar | Watches vault for changes → triggers re-embedding |
| Episodic memory | Custom on Qdrant | Session summaries stored and retrieved semantically |
| Preference store | better-sqlite3 | Structured key-value for learned preferences |

### Proactive and Notifications
| Component | Library | Notes |
|---|---|---|
| Scheduler | node-cron | Inside harness process |
| Push notifications | Ntfy (self-hosted) | Docker, phone app, REST API |
| Webhook receiver | Hono | Receives HA and OctoPrint callbacks |
| Desktop notifications | node-notifier | Calls notify-send on Linux |

### Research Pipeline
| Component | Library | Notes |
|---|---|---|
| Web search | Brave Search API | Free tier: 2000 queries/month |
| Scraping | Playwright + Readability.js | Already in stack |

---

## Architecture

### System Layers

```
Cloud APIs (Groq, Brave, Google)
        │ (HTTPS)
        ▼
┌─────────────────────────────────────┐
│         Optiplex Backend            │
│                                     │
│  ┌──────────────────────────────┐   │
│  │        Core Harness          │   │
│  │  session · tool loop ·       │   │
│  │  confirmation gate · LLM     │   │
│  └──────────────────────────────┘   │
│                                     │
│  ┌────────────┐  ┌───────────────┐  │
│  │ Voice layer│  │  Tool layer   │  │
│  │ wake·STT   │  │ Playwright·   │  │
│  │ TTS        │  │ shell·HA·     │  │
│  └────────────┘  │ OctoPrint·   │  │
│                  │ search        │  │
│  ┌────────────┐  └───────────────┘  │
│  │   Memory   │                     │
│  │ Qdrant·    │  ┌───────────────┐  │
│  │ embed·     │  │  Proactive    │  │
│  │ chokidar·  │  │ cron·webhooks │  │
│  │ prefs      │  │ Ntfy·notify   │  │
│  └────────────┘  └───────────────┘  │
│                                     │
│  ┌──────────────────────────────┐   │
│  │          API Layer           │   │
│  │  WebSocket (voice sessions)  │   │
│  │  Hono REST (text clients)    │   │
│  └──────────────────────────────┘   │
│                                     │
│  [Python sidecars — local sockets]  │
└─────────────────────────────────────┘
        │ (Tailscale)
        ▼
Clients: Framework 13 · Phone · Surfaces
```

### Key Data Flows

**Voice session:**
```
wake word → open WebSocket session → audio in → STT → LLM + tools
→ confirmation gate (if needed) → tool execute → LLM response
→ TTS → audio out → loop until dismiss
→ session end → summarize → store in Qdrant episodic memory
```

**Proactive interrupt:**
```
cron fires OR webhook received (HA / OctoPrint)
→ check HA presence (home or away?)
→ if home: speak via active client
→ always: Ntfy push to phone
→ if desktop: node-notifier popup
→ DND check: queue if 11pm–7am unless critical
```

**Memory pipeline:**
```
note saved in Obsidian (any device)
→ Syncthing propagates to Optiplex vault copy
→ chokidar detects change
→ file chunked into passages
→ nomic-embed generates embeddings via Ollama
→ upserted into Qdrant with metadata (filename, date, tags)
→ available for semantic search at next session start
```

**Tool execution with confirmation:**
```
LLM calls send_email(to, subject, body)
→ harness checks tool.requiresConfirmation → true
→ TTS reads back: "I'm about to send an email to [name] about [subject]. Confirm?"
→ user says yes/no
→ yes: execute, append result, resume loop
→ no: append cancellation, ask what to do instead
```

---

## Key Design Decisions

### Browser / Computer Use Layer
1. Playwright is the near-term browser control layer. Tools: `navigate(url)`, `click(selector)`, `type(text)`, `scroll()`, `screenshot()`.
2. **CRITICAL:** Browser session must be a persistent first-class object — open once, run multiple tool calls against it, close when done. Never stateless/one-shot per call.
3. `screenshot()` is a first-class tool alongside `click()` and `navigate()` from day one.
4. Vision loop (computer use) is a **future upgrade** that sits on top of the Playwright layer. It uses the same primitives, adds: `screenshot → vision model → structured action → repeat`.
5. Retrofitting the vision loop later requires: a vision-capable model (Claude API or local multimodal like Qwen-VL), a prompt that outputs structured actions, and session state tracking. No rewrite needed if session persistence is built correctly now.

### LLM Abstraction
All LLM calls go through a single config object. No environment-specific code anywhere except `config.ts`:

```typescript
// config.ts
export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "llama-3.3-70b-versatile",
  },
  qdrant: { url: process.env.QDRANT_URL ?? "http://localhost:6333" },
  homeAssistant: { url: process.env.HA_URL ?? "", token: process.env.HA_TOKEN ?? "" },
  octoprint: { url: process.env.OCTOPRINT_URL ?? "", apiKey: process.env.OCTOPRINT_KEY ?? "" },
  ntfy: { url: process.env.NTFY_URL ?? "http://localhost:2586", topic: process.env.NTFY_TOPIC ?? "ixa" },
}
```

### Confirmation Gate
Encoded at tool definition time, not reasoned at runtime:

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  requiresConfirmation: boolean   // ← set once, enforced always
  execute: (input: unknown) => Promise<unknown>
}
```

### Memory Architecture
Four distinct memory types, each with a different technical implementation:
- **Working memory** — LLM context window (native, no system needed)
- **Episodic memory** — Conversation summaries → Qdrant with timestamp + topic tags
- **Semantic memory** — Obsidian vault → chokidar → nomic-embed → Qdrant
- **Preference memory** — Structured SQLite via better-sqlite3

Obsidian is the human write interface. The agent never writes to Obsidian directly — it queries Qdrant. The vault is Wyatt's; the vector store is Ixa's view of it.

### Client Architecture
Clients are stateless. The harness maintains all state. A client that disconnects and reconnects resumes seamlessly. This is what makes mobile and multi-device work without complexity.

---

## Folder Structure

```
ixa/
├── ARCHITECTURE.md            ← this file
├── .env                       ← LLM_BASE_URL, keys, service URLs (never commit)
├── .env.example               ← template with all required vars
├── package.json
├── tsconfig.json
│
├── src/
│   ├── config.ts              ← all env var access, single source of truth
│   │
│   ├── core/
│   │   ├── harness.ts         ← main agent loop, session lifecycle
│   │   ├── session.ts         ← session state, open/close, summarize
│   │   ├── llm.ts             ← LLM client abstraction (openai package)
│   │   └── confirmation.ts    ← confirmation gate middleware
│   │
│   ├── tools/
│   │   ├── registry.ts        ← tool type definitions + registry
│   │   ├── home-assistant.ts
│   │   ├── gmail.ts
│   │   ├── sheets.ts
│   │   ├── octoprint.ts
│   │   ├── browser.ts         ← Playwright persistent session wrapper
│   │   ├── shell.ts           ← sandboxed shell tool
│   │   ├── search.ts          ← Brave Search API
│   │   └── memory.ts          ← Qdrant query tools (exposed to LLM)
│   │
│   ├── memory/
│   │   ├── vector.ts          ← Qdrant client wrapper
│   │   ├── episodic.ts        ← session summary store + retrieval
│   │   ├── preferences.ts     ← SQLite preference store
│   │   └── watcher.ts         ← chokidar → chunk → embed → upsert pipeline
│   │
│   ├── voice/
│   │   ├── wake.ts            ← openWakeWord sidecar wrapper
│   │   ├── stt.ts             ← faster-whisper sidecar wrapper
│   │   └── tts.ts             ← Kokoro sidecar wrapper (streaming)
│   │
│   ├── proactive/
│   │   ├── scheduler.ts       ← node-cron job definitions
│   │   ├── webhooks.ts        ← Hono webhook receiver (HA, OctoPrint)
│   │   └── notifier.ts        ← Ntfy + node-notifier dispatch
│   │
│   └── api/
│       ├── websocket.ts       ← client voice session WebSocket server
│       └── rest.ts            ← Hono REST API for text clients
│
├── sidecars/
│   ├── stt/                   ← faster-whisper HTTP wrapper (Python)
│   │   ├── main.py
│   │   └── requirements.txt
│   ├── tts/                   ← Kokoro streaming wrapper (Python)
│   │   ├── main.py
│   │   └── requirements.txt
│   └── wake/                  ← openWakeWord socket wrapper (Python)
│       ├── main.py
│       └── requirements.txt
│
└── clients/
    └── desktop/               ← future: web UI / Electron client
```

---

## Deployment Phases

### Phase 1 — Voice loop + basic chat
**Goal:** Prove the latency is acceptable. Talk to Ixa, get a response, hear it spoken back.

Components:
- Groq as LLM backend
- faster-whisper STT sidecar
- Kokoro TTS sidecar (streaming)
- openWakeWord wake word detection
- Core harness with basic tool loop
- WebSocket server for Framework 13 client
- `time`, `date`, and `echo` as placeholder tools

Done when: you can have a natural voice conversation with sub-2-second response latency.

---

### Phase 2 — Tool calling
**Goal:** Ixa can act, not just talk. Real tools with the confirmation gate.

Components:
- Home Assistant tools (read + controlled write)
- Web search via Brave API
- Shell tool (sandboxed, whitelist of allowed commands)
- Confirmation gate middleware
- node-cron scheduler (morning debrief skeleton)
- Ntfy for push notifications

Done when: you can ask Ixa to turn off a light, search the web, and it asks before doing anything destructive.

---

### Phase 3 — Memory
**Goal:** Ixa remembers things. Conversations have continuity across sessions.

Components:
- Qdrant running in Docker on Optiplex
- nomic-embed via Ollama
- Episodic memory (session summary + retrieval)
- Obsidian vault on Optiplex watched by chokidar
- Syncthing cross-device vault sync
- Semantic search tools exposed to LLM
- Preference store (SQLite)

Done when: Ixa recalls context from a week ago without being told, and can answer questions from your Obsidian notes.

---

### Phase 4 — Code execution
**Goal:** Ixa can write and run code. Pair programming becomes possible.

Components:
- Sandboxed shell with file read/write
- Code execution environment (isolated subprocess or Docker sandbox)
- Voice-driven coding flow (transcripted chat log)
- Gmail and Sheets API integration (OAuth setup)

Done when: you can voice-drive a coding session and have Ixa execute the code to verify it works.

---

### Phase 5 — Research pipeline
**Goal:** Ixa can research topics autonomously and return synthesized answers.

Components:
- Playwright browser layer (persistent session)
- Readability.js page extraction
- Multi-step research loop (search → fetch → summarize → repeat)
- OctoPrint webhook integration
- Full morning debrief with weather, calendar, tasks

Done when: you can ask Ixa to research a topic and it returns a sourced, synthesized answer without you touching the browser.

---

### Phase 6 — Browser / alongside mode
**Goal:** Ixa can operate a browser visibly, with you watching.

Components:
- Alongside mode: Playwright window streams to a display
- Full tool set: `navigate`, `click`, `type`, `scroll`, `screenshot`
- Supervision interface (approve/interrupt actions)

Done when: you can watch Ixa navigate a website and complete a multi-step task.

---

### Phase 7 — Vision loop / computer use (future)
**Goal:** Ixa can operate any application a human can see, not just structured websites.

Requirements:
- Vision-capable model (Claude API or local multimodal — Qwen-VL, LLaVA)
- Prompt that outputs structured actions from screenshots
- Session state tracking across act → screenshot → reason cycles
- Homelab online with sufficient compute for local vision model

Note: The Playwright layer built in Phase 6 requires no rewrite. The vision loop sits on top of it using the same `navigate`, `click`, `type`, `screenshot` primitives. This was a deliberate design decision.

---

## Environment Variables Reference

```bash
# LLM backend (swap to change provider)
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=llama-3.3-70b-versatile

# Memory
QDRANT_URL=http://localhost:6333
OLLAMA_URL=http://localhost:11434

# Obsidian vault path (on this machine)
OBSIDIAN_VAULT_PATH=/home/wyatt/vault

# Home Assistant
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your_long_lived_token

# OctoPrint
OCTOPRINT_URL=http://octopi.local
OCTOPRINT_KEY=your_api_key

# Notifications
NTFY_URL=http://localhost:2586
NTFY_TOPIC=ixa

# Brave Search
BRAVE_API_KEY=your_brave_key

# Google OAuth (generated by googleapis auth flow)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Tokens managed by keytar (OS keychain) — not stored in .env
```

---

## What This Is Not

- Not a framework. The tool loop is ~150 lines of TypeScript.
- Not a cloud service. Everything runs on hardware you own.
- Not a single-device app. Clients are thin; the backend is the product.
- Not finished. This document describes the target. Phases 1–3 are the near-term build.

---

*Last updated: beginning of project. Update this document when architectural decisions change — not after the fact.*
