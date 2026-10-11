// Phase 3d step 2 acceptance: the spike's writer probe, against the REAL tools.
//
// The step-1 spike drove a DRAFT save_note and a STUB search_notes and found
// that three of ten note requests never reached save_note at all — they were
// routed to remember_preference, whose description claimed any request to
// "remember something". This re-runs the same ten requests against what is
// actually registered, and adds the measurement the spike could not make:
// ROUTING IN BOTH DIRECTIONS. A note must not become a preference, and a
// preference must not become a note.
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
//   the tool registry        REAL — all 14 tools, the descriptions the model
//                            reads in production
//   save_note / search_notes REAL, writing real markdown and real vectors
//   remember_preference      REAL, AND EXECUTED — into a throwaway database,
//                            which is what lets reverse routing be measured
//   chat()                   REAL (streaming, deadlines, retries)
//   SYSTEM_PROMPT            REAL and unchanged
//   web_search               STUBBED by default, for determinism and to stay
//                            off Tavily. --live-search uses the real one.
//
// NOTHING LIVE IS TOUCHED. The database, the vault and the Qdrant collection
// are all throwaway and are asserted to differ from the configured ones before
// anything runs. Needs Ollama, Qdrant and Groq; does not need the backend.
//
//   npx tsx dev/scripts/notes-verify.ts
//   npx tsx dev/scripts/notes-verify.ts --live-search
//   npx tsx dev/scripts/notes-verify.ts --cleanup     # drop the collection and vault
//
// Env must be set BEFORE anything imports config, which reads process.env at
// module load. dotenv does not override an existing variable, so these win
// over .env.
// The env preload MUST come first: config.ts reads process.env at module load.
import { COLLECTION, DB, RUN_DIR, VAULT } from "./notes-verify-env"
import fs from "fs"
import path from "path"
import { config } from "../../src/config"
import { chat, type Message } from "../../src/core/llm"
import { SYSTEM_PROMPT } from "../../src/core/session"
import { runWithSessionControl } from "../../src/core/session-context"
import { registry } from "../../src/tools/registry"
import { OllamaEmbedder } from "../../src/memory/embeddings"
import { QdrantIndex } from "../../src/memory/qdrant"
import { getNoteStore, type Note } from "../../src/memory/notes"
import { Notebook, setNotebook } from "../../src/memory/notebook"
import { getPreferenceStore } from "../../src/memory/preferences"
import "../../src/tools/register"

const LIVE_SEARCH = process.argv.includes("--live-search")
const CLEANUP_ONLY = process.argv.includes("--cleanup")
const REPORT = path.join(__dirname, "notes-verify-report.md")
const MAX_ITERATIONS = 6

// A canned Tavily-shaped result. Included because without a way to look a
// price up, "do not invent a price" is not a test, it is a trap.
const SEARCH_STUB =
  "Search results for used RTX 3090 pricing:\n" +
  "1. eBay — sold listings for the RTX 3090 cluster around $1,360 shipped.\n" +
  "2. r/hardwareswap — recent sales between $1,250 and $1,420.\n" +
  "3. Newegg — no new stock; refurbished units listed at $1,499."

interface Probe {
  id: number
  testing: string
  text: string
  // What should happen. Checked by hand in the report, not asserted — one
  // sample per shape, as the spike's caveat says.
  expect: string
}

// The spike's ten, verbatim, transcript style and all.
const WRITER_PROBES: Probe[] = [
  {
    id: 1,
    testing: "a clear new decision: right type, specific title, searched first, nothing invented",
    text: "so we decided we're going with tavily for search instead of brave, write that down somewhere",
    expect: "search_notes then save_note, type decision",
  },
  {
    id: 2,
    testing: "a decision that changes an existing note: must supersede, not fork",
    text: "actually scratch that, we're moving off tavily to a self-hosted searx thing, update the note",
    expect: "search_notes then save_note with supersedes set to the tavily note",
  },
  {
    id: 3,
    testing: "a vague request: must ask rather than write a note about nothing",
    text: "note that down would you",
    expect: "no save_note; ask what to write",
  },
  {
    id: 4,
    testing: "a price the USER stated: recording it is faithful, sharpening it is not",
    text: "note down that a used 3090 is going for like six hundred bucks now so that's the plan for the homelab",
    expect: "save_note; the figure matches what the user said; a dated caveat is added by code",
  },
  {
    id: 5,
    testing: "really a preference: must route to remember_preference, not save_note",
    text: "from now on keep your spoken answers really short, like two sentences max",
    expect: "remember_preference only",
  },
  {
    id: 6,
    testing: "a duplicate of a note already written: must not write a second one",
    text: "make a note that we're on the groq dev tier now",
    expect: "search_notes; then either no write or a supersede, never a second active note",
  },
  {
    id: 7,
    testing: "a reference fact not in the notebook: right type and a retrievable title",
    text: "write down that the backend lives in wsl2 on the gaming pc, the windows side doesn't run anything",
    expect: "save_note, type reference",
  },
  {
    id: 8,
    testing: "a project fact with a vague cost claim and no number: must not supply a number",
    text: "the homelab plan is a 24 gig card eventually, it's gonna be expensive, note it",
    expect: "save_note with NO invented figure",
  },
  {
    id: 9,
    testing: "mis-heard model names: must not write 'quadrant' and 'alama' into the notebook",
    text: "note down that we're using quadrant for the vectors and alama for the embeddings",
    expect: "the correct spellings, or a question — not the mis-heard ones",
  },
  {
    id: 10,
    testing: "a price with NO number given: must search before recording a figure",
    text: "find out what a used 3090 costs right now and write it down",
    expect: "web_search before save_note; only searched figures in the note",
  },
]

// Routing, both directions. The spike could only measure one.
const ROUTING_PROBES: Probe[] = [
  {
    id: 11,
    testing: "ROUTING: a genuine preference must still reach remember_preference",
    text: "i prefer my coffee black, remember that",
    expect: "remember_preference",
  },
  {
    id: 12,
    testing: "ROUTING: 'remember' plus a FACT must reach save_note",
    text: "remember that the stt sidecar uses base.en, not small",
    expect: "save_note",
  },
  {
    id: 13,
    testing: "ROUTING: a question about a past CONVERSATION must reach search_memory",
    text: "what did we talk about last time?",
    expect: "search_memory with no query",
  },
  {
    id: 14,
    testing: "ROUTING: a question about something written down must reach search_notes",
    text: "what did i write down about the search provider?",
    expect: "search_notes",
  },
  {
    id: 15,
    testing: "ROUTING: a behaviour instruction phrased as a note must stay a preference",
    text: "make a note to always answer in metric",
    expect: "remember_preference, not save_note",
  },
]

interface CallRecord {
  name: string
  args: string
  result: string
}

interface ProbeResult {
  probe: Probe
  calls: CallRecord[]
  reply: string
  notesWritten: string[]
  error?: string
}

async function run(): Promise<void> {
  // The guard. A verification run that wrote into the real database or the
  // real vault would be worse than no verification run.
  const real = {
    db: path.join(path.resolve(__dirname, "../.."), "data", "ixa.db"),
    collection: "ixa_episodes",
  }
  if (path.resolve(config.data.dbPath) === path.resolve(real.db)) {
    throw new Error(`refusing to run against the live database ${config.data.dbPath}`)
  }
  if (config.notes.collection === real.collection) {
    throw new Error(`refusing to run against the episode collection`)
  }
  if (path.resolve(config.notes.vaultPath) !== path.resolve(VAULT)) {
    throw new Error(`vault is ${config.notes.vaultPath}, expected the throwaway ${VAULT}`)
  }

  const index = new QdrantIndex({
    collection: config.notes.collection,
    payloadIndexes: [{ field: "status", schema: "keyword" }],
  })

  if (CLEANUP_ONLY) {
    await fetch(`${config.qdrant.url}/collections/${config.notes.collection}`, {
      method: "DELETE",
    })
      .then((r) => console.log(`deleted collection ${config.notes.collection}: HTTP ${r.status}`))
      .catch((err) => console.error("collection delete failed:", err))
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    console.log(`removed ${RUN_DIR}`)
    return
  }

  const store = getNoteStore()
  const notebook = new Notebook({
    store,
    embedder: new OllamaEmbedder(),
    index,
  })
  setNotebook(notebook)
  await notebook.start()

  // SEEDED, so that two of the probes can actually fail. Probe 2 must
  // supersede an existing note and probe 6 must not duplicate one — against
  // an empty notebook neither is a test, just a write. Dated earlier than
  // today so the ids differ from anything the probes produce.
  await runWithSessionControl(
    {
      requestNewConversation: () => {},
      evidence: { userText: "seed", source: "text", sessionId: "seed", searchResults: [] },
    },
    async () => {
      await notebook.save({
        type: "decision",
        title: "Tavily is the search provider",
        summary: "Web search goes through Tavily. Brave was evaluated and never wired in.",
        sections: [
          { heading: "The choice", body: "Tavily returns extracted content rather than links." },
          { heading: "Why not Brave", body: "It was evaluated and dropped before any code shipped." },
        ],
        source: "text",
        sessionId: "seed",
        date: "2026-09-01",
      })
      await notebook.save({
        type: "decision",
        title: "Ixa is on the Groq Dev tier",
        summary: "Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.",
        sections: [
          { heading: "The decision", body: "The paid Dev tier was chosen over migrating to a local LLM for now." },
        ],
        source: "text",
        sessionId: "seed",
        date: "2026-09-15",
      })
    }
  )
  console.log(`seeded ${store.countActive()} note(s)\n`)

  const tools = registry.toOpenAI()
  console.log(`${tools.length} tools, ${JSON.stringify(tools).length} chars of schema`)
  console.log(`vault ${VAULT}\ndb ${DB}\ncollection ${COLLECTION}`)
  console.log(`web_search: ${LIVE_SEARCH ? "LIVE (Tavily)" : "stubbed"}\n`)

  const results: ProbeResult[] = []
  let llmCalls = 0

  for (const probe of [...WRITER_PROBES, ...ROUTING_PROBES]) {
    const before = new Set(store.all().map((note: Note) => note.id))
    const calls: CallRecord[] = []
    let reply = ""
    let error: string | undefined

    const searchResults: string[] = []
    try {
      await runWithSessionControl(
        {
          requestNewConversation: () => {},
          evidence: {
            userText: probe.text,
            source: "voice",
            sessionId: `verify-${probe.id}`,
            searchResults,
          },
        },
        async () => {
          const messages: Message[] = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: probe.text },
          ]

          for (let i = 0; i < MAX_ITERATIONS; i++) {
            llmCalls++
            const response = await chat(messages, tools)
            if (response.type === "text") {
              reply = response.content
              return
            }

            messages.push({
              role: "assistant",
              content: null,
              tool_calls: response.calls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            })

            for (const tc of response.calls) {
              const tool = registry.get(tc.name)
              let result: string
              if (!tool) {
                result = `Unknown tool: ${tc.name}`
              } else if (tool.name === "web_search" && !LIVE_SEARCH) {
                result = SEARCH_STUB
                searchResults.push(result)
              } else {
                result = String(await tool.execute(JSON.parse(tc.arguments || "{}")))
                // Exactly what the real tool loop does, and the reason the
                // price rule can tell a searched figure from a remembered one.
                if (tool.name === "web_search") searchResults.push(result)
              }
              calls.push({ name: tc.name, args: tc.arguments, result })
              messages.push({ role: "tool", tool_call_id: tc.id, content: result })
            }
          }
          reply = "(no final reply: hit the iteration ceiling)"
        }
      )
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    const notesWritten = store
      .all()
      .map((note) => note.id)
      .filter((id) => !before.has(id))

    results.push({ probe, calls, reply, notesWritten, ...(error ? { error } : {}) })
    const route = calls.map((call) => call.name).join(" → ") || "(no tool call)"
    console.log(`${probe.id}. ${route}${error ? `  [ERROR ${error}]` : ""}`)
  }

  writeReport(results, llmCalls, notebook, getPreferenceStore())
  console.log(`\nreport: ${REPORT}`)
  console.log(`cleanup: npx tsx dev/scripts/notes-verify.ts --cleanup`)
  notebook.stopBacklogSweep()
}

function writeReport(
  results: ProbeResult[],
  llmCalls: number,
  notebook: { byId(id: string): unknown; vaultRoot: string },
  preferences: { listActive(): Array<{ topic: string; value: string }> }
): void {
  const lines: string[] = []
  lines.push("# Phase 3d step 2 — verification against the real tools")
  lines.push("")
  lines.push(
    `Generated ${new Date().toISOString()} by \`dev/scripts/notes-verify.ts\`. ` +
      `${llmCalls} LLM calls. web_search ${LIVE_SEARCH ? "live" : "stubbed"}. ` +
      `Throwaway vault, database and collection.`
  )
  lines.push("")
  lines.push("## Routing")
  lines.push("")
  lines.push("| # | what it tests | tools called, in order | note written | expected |")
  lines.push("|---|---|---|---|---|")
  for (const r of results) {
    const route = r.calls.map((c) => c.name).join(" → ") || "**(no tool call)**"
    const written = r.notesWritten.length > 0 ? r.notesWritten.join(", ") : "—"
    lines.push(`| ${r.probe.id} | ${r.probe.testing} | ${route} | ${written} | ${r.probe.expect} |`)
  }

  lines.push("")
  lines.push("## Preferences actually stored")
  lines.push("")
  const active = preferences.listActive()
  if (active.length === 0) lines.push("_none_")
  for (const pref of active) lines.push(`- \`${pref.topic}\`: ${pref.value}`)

  lines.push("")
  lines.push("## Every request, verbatim")
  lines.push("")
  for (const r of results) {
    lines.push(`### Request ${r.probe.id}`)
    lines.push("")
    lines.push(`**Testing:** ${r.probe.testing}`)
    lines.push("")
    lines.push("**User said:**")
    lines.push("")
    lines.push(`> ${r.probe.text}`)
    lines.push("")
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`)
      lines.push("")
    }
    if (r.calls.length === 0) {
      lines.push("**No tool call.**")
      lines.push("")
    }
    for (const [i, call] of r.calls.entries()) {
      lines.push(`${i + 1}. \`${call.name}\``)
      lines.push("")
      lines.push("```json")
      lines.push(call.args || "{}")
      lines.push("```")
      lines.push("")
      lines.push("```")
      lines.push(call.result.slice(0, 900))
      lines.push("```")
      lines.push("")
    }
    lines.push("**What it said to the user:**")
    lines.push("")
    lines.push(`> ${r.reply.replace(/\n/g, "\n> ") || "(nothing)"}`)
    lines.push("")
    for (const id of r.notesWritten) {
      const file = path.join(notebook.vaultRoot)
      const found = fs
        .readdirSync(file, { recursive: true })
        .map(String)
        .find((name) => name.includes(id))
      lines.push(`**Note written — \`${id}\`:**`)
      lines.push("")
      lines.push("```markdown")
      lines.push(found ? fs.readFileSync(path.join(file, found), "utf8") : "(file not found)")
      lines.push("```")
      lines.push("")
    }
  }

  fs.writeFileSync(REPORT, lines.join("\n"))
}

run().catch((err) => {
  console.error("verify failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
