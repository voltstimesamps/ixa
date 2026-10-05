// Measures how Kokoro RENDERS written text as speech, through the real spoken
// path, and writes audio to listen to.
//
// Live voice testing found TTS mis-reading written forms: "$1,360" is spoken
// "one three hundred sixty dollars". The extent was unknown, and a
// normalization layer written against an impression would fix the wrong
// things. This produces the evidence instead: one WAV per fixture plus a table
// with an empty verdict column, filled in by ear.
//
// WHAT IS MEASURED IS WHAT RUNS. sanitizeForSpeech and speakStreaming are
// imported, not reimplemented, and Kokoro is reached only through the sidecar's
// HTTP interface — the same two calls speak() makes in src/api/websocket.ts.
// Following sidecars/stt/hints.py, which the STT sidecar and
// dev/scripts/stt-vocab-check.py both import for the same reason. When a
// normalization step is eventually written it belongs in src/voice/sanitize.ts
// (see PAIRS below for where in the pipeline), and this script picks it up for
// free.
//
// Needs the TTS sidecar, not the backend:
//
//     npm run dev                                           # spawns it as usual
//     sidecars/tts/venv/bin/python sidecars/tts/main.py      # or TTS alone
//     npx tsx dev/scripts/tts-render-check.ts
//
// This script never spawns Kokoro. Loading the model is the dominant cost and
// main.py hardcodes port 5001, so a second copy would collide with the one
// `npm run dev` already owns.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { speakStreaming } from "../../src/voice/tts"
import { sanitizeForSpeech } from "../../src/voice/sanitize"
import { config } from "../../src/config"

const repoRoot = path.resolve(__dirname, "..", "..")
const outDir = path.join(repoRoot, "Ixa-Tests", "tts")
const reportPath = path.join(outDir, "report.md")
// The fixture list, so dev/scripts/tts-phonemes.py can report on the SAME
// strings without a second copy of them existing anywhere.
const fixturesPath = path.join(outDir, "fixtures.json")

// ----------------------------------------------------------------- fixtures
//
// `raw` is fed in exactly as the model wrote it, markdown and all, so the
// sanitizer is measured too and not bypassed.
//
// REAL strings are copied verbatim out of data/ixa.db (9 sessions, 45
// assistant messages). They contain invisible characters that are part of what
// is under test and must not be retyped: the model writes U+202F NARROW
// NO-BREAK SPACE between a number and its unit ("32 GB", "RTX 3080" — 127
// occurrences) and U+2011 NON-BREAKING HYPHEN inside compounds ("12‑GB",
// "7‑B", "pre‑built" — 72 occurrences). Neither is touched by the sanitizer,
// whose whitespace collapse is ASCII-only, so both reach Kokoro intact.
//
// INVENTED strings exist only where the corpus has no real example. Those gaps
// are stated rather than papered over: there are no snake_case or dotted
// identifiers, no URLs, no file paths, no dates, no vCPU, and no unit other
// than GB/W/B/bit in any recorded reply.
interface Fixture {
  // Two digits so files sort in list order; the suffix letter groups a pair.
  id: string
  slug: string
  source: "real" | "invented"
  raw: string
  note?: string
}

const BASE: Fixture[] = [
  // ----- currency, including the confirmed bug -------------------------------
  {
    id: "01a",
    slug: "currency-1360",
    source: "real",
    raw: "A used RTX\u202F3090 is around $1,360 right now.",
    note: "the confirmed bug: heard as \"one three hundred sixty dollars\"",
  },
  {
    id: "02",
    slug: "currency-1360-usd",
    source: "real",
    raw: "A used RTX\u202F3090 is selling for roughly $1,360\u202FUSD right now.",
    note: "same amount with a trailing currency word",
  },
  {
    id: "03",
    slug: "currency-range-endash",
    source: "real",
    raw: "The RTX\u202F3090 is currently selling in the used market for roughly $1,300\u202F–\u202F$1,400, with most listings around $1,360.",
    note: "three separated amounts and a spaced en-dash range",
  },
  {
    id: "04",
    slug: "currency-range-tight",
    source: "real",
    raw: "It’s usually listed for $350–$400.",
    note: "en-dash range, no separators",
  },
  {
    id: "05",
    slug: "currency-markdown-unit",
    source: "real",
    raw: "**Used RTX\u202F3060 12\u202FGB** – about $180–$220.",
    note: "bold heading, U+202F before the unit, and a range",
  },
  {
    id: "06",
    slug: "currency-plain",
    source: "real",
    raw: "Here are a few used builds that fit under $500 and can run a lightweight AI assistant.",
    note: "a round amount with no separator",
  },
  {
    id: "07",
    slug: "currency-lte-symbol",
    source: "real",
    raw: "**Budget (≤\u202F$400)** – *AMD\u202FRyzen\u202F7\u202F7700X* or *Intel\u202FCore\u202Fi7\u201113700K*: 8–12 cores, 16–24 threads, PCIe\u202F4.0, good price\u2011to\u2011performance.",
    note: "U+2264, U+2011 compounds, bare ranges, a version number",
  },
  {
    id: "08",
    slug: "currency-in-recap",
    source: "real",
    raw: "We discussed GPU options for a $500 budget, like the RTX\u202F3060 and RTX\u202F4070, and gave token\u2011per\u2011second estimates for 7\u2011B models.",
    note: "U+2011 compounds in prose",
  },

  // ----- units, and the two invisible characters -----------------------------
  {
    id: "09a",
    slug: "units-nnbsp-and-nbhyphen",
    source: "real",
    raw: "A single\u2011board CPU like an AMD Ryzen 5 5600G or an Intel i5\u201112400, 16\u202FGB of DDR4 RAM, and a 12\u2011GB or 16\u2011GB GPU will do.",
    note: "both invisible characters in one string; the twins isolate each",
  },
  {
    id: "10",
    slug: "units-vram-params",
    source: "real",
    raw: "12\u202FGB of VRAM lets you run 7\u201113\u202FB models with good speed.",
  },
  {
    id: "11",
    slug: "units-tokens-per-second",
    source: "real",
    raw: "For example, DeepSeek\u202FLLM\u202F7B runs about 30\u202Ftok/s for coding and 55\u202Ftok/s for chat, while Qwen\u202F2.5\u202F7B and Mistral\u202F7B hit around 45\u201148\u202Ftok/s.",
    note: "a slash unit, bare 7B, and a version number",
  },
  {
    id: "12",
    slug: "units-quantization",
    source: "real",
    raw: "Use a 1\u20113\u202FB or even 1\u2011B model that’s quantized to 4\u2011bit or 8\u2011bit, which will run comfortably on a laptop’s integrated GPU or a low\u2011end discrete card like an RTX\u202F3050\u202F4\u202FGB.",
  },

  // ----- product names, acronyms, versions ----------------------------------
  {
    id: "13",
    slug: "product-zbook-slashes",
    source: "real",
    raw: "**HP ZBook Fury 15 G8** – 10th\u2011gen Intel Core i7/i9 or Xeon, 32\u202FGB RAM, RTX\u202F3070\u202FTi or RTX\u202F3080.",
    note: "a slashed pair of model names and an ordinal compound",
  },
  {
    id: "14",
    slug: "product-model-run",
    source: "real",
    raw: "**Gaming PCs with RTX\u202F3060/3070/3080** – Look for models from Alienware, ASUS ROG, or MSI that have at least 16\u202FGB RAM (upgrade to 32\u202FGB if possible).",
    note: "a slash-run of three model numbers, four acronyms",
  },
  {
    id: "15",
    slug: "product-version-lts",
    source: "real",
    raw: "Also make sure the OS can be re\u2011installed cleanly; most of these machines ship with Windows, but you can install Ubuntu 24.04 LTS for a lightweight, AI\u2011friendly environment.",
    note: "a dotted version and an acronym",
  },

  // ----- short real replies, clock, arithmetic, controls ---------------------
  {
    id: "16",
    slug: "time-clock",
    source: "real",
    raw: "It's 6:25\u202FPM.",
    note: "the clock answer, as actually spoken",
  },
  {
    id: "17",
    slug: "arithmetic-spelled-out",
    source: "real",
    raw: "2 plus 2 equals 4.",
    note: "control: the model already spells arithmetic out",
  },
  {
    id: "18",
    slug: "control-prose-one",
    source: "real",
    raw: "You asked what time it was.",
    note: "PLAIN-PROSE CONTROL — known to render correctly; expect 1 chunk",
  },
  {
    id: "19",
    slug: "control-prose-two",
    source: "real",
    raw: "Check eBay for used cards, Newegg for new or refurbished, Amazon for quick shipping, and local classifieds like Craigslist or Facebook Marketplace for in\u2011person deals. All are good spots for AI GPUs.",
    note: "PLAIN-PROSE CONTROL — two sentences; expect exactly 2 chunks",
  },
  {
    id: "20",
    slug: "control-one-word",
    source: "real",
    raw: "Tokyo.",
    note: "a real one-word reply; expect exactly 1 chunk",
  },

  // ----- invented, only where the corpus has nothing ------------------------
  {
    id: "21",
    slug: "gap-identifiers",
    source: "invented",
    raw: "Run npm run dev and check sidecars/tts/main.py for the split_pattern.",
    note: "GAP: no snake_case, dotted identifier or file path in any real reply",
  },
  {
    id: "22",
    slug: "gap-dates",
    source: "invented",
    raw: "The RTX 5090 launched on 2025-01-30, and prices settled by March 2025.",
    note: "GAP: no dates in any real reply",
  },
  {
    id: "23",
    slug: "gap-units-other",
    source: "invented",
    raw: "The clip is 480p, 2.5 MB on disk, and WSL reports 4 vCPUs at 3.8 GHz.",
    note: "GAP: no p, MB, vCPU or GHz in any real reply",
  },
  {
    id: "24a",
    slug: "gap-separated-no-currency",
    source: "invented",
    raw: "The context window is 24,000 characters, about 128,000 tokens.",
    note: "GAP: isolates whether the comma or the $ causes 01a's failure",
  },
  {
    id: "25a",
    slug: "gap-nnbsp-separator",
    source: "invented",
    raw: "Expect to pay $1\u202F200 to $1\u202F500 for a used one.",
    note: "GAP here, but real live shape: src/core/prices.ts documents replies containing \"$1 200–$1 500\" with U+202F as the thousands separator",
  },
  {
    id: "26",
    slug: "quirk-dr",
    source: "invented",
    raw: "Dr. Chen said the 3090 is fine.",
    note: "KNOWN QUIRK, not a bug: main.py's split_pattern has no abbreviation list, so expect an early split — 2 chunks",
  },
  {
    id: "27",
    slug: "quirk-eg",
    source: "invented",
    raw: "Use a smaller model, e.g. a 7B, for quick replies.",
    note: "KNOWN QUIRK, not a bug: same early split — expect 2 chunks",
  },
]

// --------------------------------------------------------------------- twins
//
// Every hypothesized cause appears twice: the real broken string, and a twin
// with ONE candidate normalization applied and nothing else changed. Each twin
// is GENERATED from its original by a single substitution rather than retyped,
// so the only difference is the character under test and a typo cannot
// masquerade as a finding.
//
// A transform that changes nothing means the character being substituted is not
// the one in the string. That is a broken experiment, not a passing one, so it
// is reported loudly instead of producing a twin identical to its original.
interface Twin {
  of: string
  id: string
  slug: string
  // The single substitution, stated for the report.
  substitution: string
  apply: (raw: string) => string
}

const TWINS: Twin[] = [
  {
    of: "01a",
    id: "01b",
    slug: "currency-1360-nocomma",
    substitution: "thousands comma removed: $1,360 → $1360",
    apply: (raw) => raw.replace("$1,360", "$1360"),
  },
  {
    of: "01a",
    id: "01c",
    slug: "currency-1360-words",
    substitution: "fully expanded to words: $1,360 → one thousand three hundred sixty dollars",
    apply: (raw) => raw.replace("$1,360", "one thousand three hundred sixty dollars"),
  },
  {
    of: "09a",
    id: "09b",
    slug: "units-ascii-space",
    substitution: "every U+202F → ASCII space",
    apply: (raw) => raw.replace(/ /g, " "),
  },
  {
    of: "09a",
    id: "09c",
    slug: "units-ascii-hyphen",
    substitution: "every U+2011 → ASCII hyphen",
    apply: (raw) => raw.replace(/‑/g, "-"),
  },
  {
    of: "24a",
    id: "24b",
    slug: "gap-separated-nocommas",
    substitution: "thousands commas removed: 24,000 / 128,000 → 24000 / 128000",
    apply: (raw) => raw.replace(/(\d),(\d{3})/g, "$1$2"),
  },
  {
    of: "25a",
    id: "25b",
    slug: "gap-nnbsp-removed",
    substitution: "U+202F thousands separator removed: $1 200 → $1200",
    apply: (raw) => raw.replace(/(\d) (\d{3})/g, "$1$2"),
  },
]

function buildFixtures(): { fixtures: Fixture[]; pairs: Map<string, Twin[]>; broken: string[] } {
  const byId = new Map(BASE.map((f) => [f.id, f]))
  const pairs = new Map<string, Twin[]>()
  const broken: string[] = []
  const built = [...BASE]

  for (const twin of TWINS) {
    const original = byId.get(twin.of)
    if (!original) throw new Error(`twin ${twin.id} has no original ${twin.of}`)
    const raw = twin.apply(original.raw)
    if (raw === original.raw) {
      // The substitution found nothing. Do not synthesize a duplicate that
      // would read as "normalization made no difference".
      broken.push(`${twin.id}: "${twin.substitution}" changed nothing in ${twin.of}`)
      continue
    }
    built.push({
      id: twin.id,
      slug: twin.slug,
      source: original.source,
      raw,
      note: `TWIN of ${twin.of} — ${twin.substitution}`,
    })
    pairs.set(twin.of, [...(pairs.get(twin.of) ?? []), twin])
  }

  // Pair members sort adjacent: "01a" < "01b" < "01c" < "02".
  built.sort((a, b) => a.id.localeCompare(b.id))
  return { fixtures: built, pairs, broken }
}

// ------------------------------------------------------------- wav handling
//
// The sidecar sends one independently-valid WAV per Kokoro chunk. Chunk COUNT
// is part of the measurement — the split_pattern's behaviour is what decides
// it — so the frames are counted as they arrive and only then concatenated
// into one playable file per fixture.
interface Pcm {
  samples: Buffer
  sampleRate: number
  channels: number
  bitsPerSample: number
}

function parseWav(wav: Buffer): Pcm {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("sidecar frame is not a RIFF/WAVE blob")
  }
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let samples: Buffer | null = null

  // Walk the RIFF chunk list rather than assuming a 44-byte header.
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === "fmt ") {
      channels = wav.readUInt16LE(body + 2)
      sampleRate = wav.readUInt32LE(body + 4)
      bitsPerSample = wav.readUInt16LE(body + 14)
    } else if (id === "data") {
      samples = wav.subarray(body, Math.min(body + size, wav.length))
    }
    // Chunks are word-aligned.
    offset = body + size + (size % 2)
  }

  if (!samples || !sampleRate || !channels || !bitsPerSample) {
    throw new Error("sidecar frame is missing fmt or data")
  }
  return { samples, sampleRate, channels, bitsPerSample }
}

function writeWav(file: string, pieces: Pcm[]): number {
  const { sampleRate, channels, bitsPerSample } = pieces[0]!
  const data = Buffer.concat(pieces.map((piece) => piece.samples))
  const bytesPerFrame = channels * (bitsPerSample / 8)

  const header = Buffer.alloc(44)
  header.write("RIFF", 0, "ascii")
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8, "ascii")
  header.write("fmt ", 12, "ascii")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28)
  header.writeUInt16LE(bytesPerFrame, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write("data", 36, "ascii")
  header.writeUInt32LE(data.length, 40)

  writeFileSync(file, Buffer.concat([header, data]))
  return data.length / bytesPerFrame / sampleRate
}

// ----------------------------------------------------------------- reporting
//
// Invisible characters are the whole point of several pairs, so anywhere two
// strings have to be COMPARED they are printed with the non-ASCII ones named.
// The table keeps the strings readable instead.
function visible(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, (char) => {
    const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
    return `⟨U+${code}⟩`
  })
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

interface Result {
  fixture: Fixture
  sanitized: string
  chunks: number
  chunkSeconds: number[]
  seconds: number
  file: string
  words: number
  error?: string
}

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).filter((token) => /[a-z0-9]/i.test(token)).length
}

// Things the numbers alone can show, without listening to anything.
function staticFlags(results: Result[]): string[] {
  const flags: string[] = []
  const ok = results.filter((r) => !r.error)

  // A rate far off the corpus median is either a stall or a swallowed word.
  const rates = ok.filter((r) => r.words > 0).map((r) => r.seconds / r.words).sort((a, b) => a - b)
  const median = rates.length ? rates[Math.floor(rates.length / 2)]! : 0

  for (const result of ok) {
    const { fixture } = result
    if (result.chunks === 0) {
      flags.push(`${fixture.id} ${fixture.slug}: NO AUDIO — sidecar returned zero chunks`)
      continue
    }
    if (result.words === 1 && result.chunks > 1) {
      flags.push(`${fixture.id} ${fixture.slug}: ${result.chunks} chunks for a one-word fixture`)
    }
    if (median > 0 && result.words >= 3) {
      const rate = result.seconds / result.words
      if (rate > median * 1.6) {
        flags.push(
          `${fixture.id} ${fixture.slug}: ${rate.toFixed(2)}s/word vs ${median.toFixed(2)}s/word median ` +
            `— long for the text (something is being read out that is not a word?)`
        )
      } else if (rate < median * 0.55) {
        flags.push(
          `${fixture.id} ${fixture.slug}: ${rate.toFixed(2)}s/word vs ${median.toFixed(2)}s/word median ` +
            `— short for the text (something may be skipped)`
        )
      }
    }
  }

  // Sentence count vs chunk count, since the split_pattern is under test.
  for (const result of ok) {
    const sentences = (result.sanitized.match(/[.!?]+(?=\s|$)/g) ?? []).length
    if (sentences > 0 && result.chunks > sentences) {
      flags.push(
        `${result.fixture.id} ${result.fixture.slug}: ${result.chunks} chunks for ${sentences} ` +
          `sentence${sentences === 1 ? "" : "s"} — split_pattern fired mid-sentence`
      )
    }
  }

  return flags
}

function writeReport(results: Result[], pairs: Map<string, Twin[]>, broken: string[], flags: string[]): void {
  const byId = new Map(results.map((r) => [r.fixture.id, r]))
  const lines: string[] = []

  lines.push("# TTS rendering measurement")
  lines.push("")
  lines.push(
    "How Kokoro renders written text as speech, measured through the real spoken path: " +
      "`sanitizeForSpeech` (src/voice/sanitize.ts) then `speakStreaming` (src/voice/tts.ts) " +
      "into the running sidecar, exactly as `speak()` in src/api/websocket.ts does it."
  )
  lines.push("")
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Sidecar: ${config.voice.ttsUrl} (voice: the sidecar's own default)`)
  lines.push(`- Regenerate: \`npx tsx dev/scripts/tts-render-check.ts\``)
  lines.push(`- Audio: \`Ixa-Tests/tts/\`, named in list order`)
  lines.push(
    "- Phonemes for these same fixtures: `phonemes.md`, from " +
      "`sidecars/tts/venv/bin/python dev/scripts/tts-phonemes.py`"
  )
  lines.push("")
  lines.push(
    "**The verdict column is deliberately empty.** It is filled in by ear; the numbers " +
      "here cannot tell you whether a rendering sounded right."
  )
  lines.push("")

  lines.push("## Fixtures")
  lines.push("")
  lines.push("Twins sort directly under their original, so each pair reads back to back.")
  lines.push("")
  lines.push("| # | Raw | Sanitized | Chunks | Duration | File | Verdict |")
  lines.push("| --- | --- | --- | --- | --- | --- | --- |")
  for (const result of results) {
    const file = result.error ? "—" : `\`${path.basename(result.file)}\``
    const chunks = result.error ? "—" : String(result.chunks)
    const duration = result.error ? "—" : `${result.seconds.toFixed(2)}s`
    const sanitized = result.error ? `**${result.error}**` : cell(result.sanitized)
    lines.push(
      `| ${result.fixture.id} | ${cell(result.fixture.raw)} | ${sanitized} | ${chunks} | ${duration} | ${file} |  |`
    )
  }
  lines.push("")

  lines.push("## Pairs")
  lines.push("")
  lines.push(
    "Each twin was generated from its original by one substitution, so the only " +
      "difference is the character under test. Non-ASCII characters are named here " +
      "because they are invisible in the table above."
  )
  lines.push("")
  for (const [originalId, twins] of [...pairs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const original = byId.get(originalId)
    if (!original) continue
    lines.push(`### ${originalId} — ${original.fixture.slug}`)
    lines.push("")
    lines.push(`- \`${originalId}\` original — ${original.chunks} chunk(s), ${original.seconds.toFixed(2)}s`)
    lines.push(`  - \`${visible(original.fixture.raw)}\``)
    for (const twin of twins) {
      const result = byId.get(twin.id)
      if (!result) continue
      lines.push(
        `- \`${twin.id}\` ${twin.substitution} — ${result.chunks} chunk(s), ${result.seconds.toFixed(2)}s`
      )
      lines.push(`  - \`${visible(result.fixture.raw)}\``)
    }
    lines.push("")
  }

  lines.push("## Notes per fixture")
  lines.push("")
  lines.push("| # | Source | Why it is here |")
  lines.push("| --- | --- | --- |")
  for (const result of results) {
    if (!result.fixture.note) continue
    lines.push(`| ${result.fixture.id} | ${result.fixture.source} | ${cell(result.fixture.note)} |`)
  }
  lines.push("")

  lines.push("## Static flags")
  lines.push("")
  if (broken.length) {
    lines.push("**Broken twins — the substitution matched nothing, so no audio was made:**")
    lines.push("")
    for (const line of broken) lines.push(`- ${line}`)
    lines.push("")
  }
  if (flags.length) {
    lines.push("Detected from the numbers alone. None of these is a verdict:")
    lines.push("")
    for (const flag of flags) lines.push(`- ${flag}`)
  } else {
    lines.push("Nothing the numbers alone flag as out of proportion.")
  }
  lines.push("")

  lines.push("## Chunk timings")
  lines.push("")
  lines.push("| # | Chunks | Each (s) | Total |")
  lines.push("| --- | --- | --- | --- |")
  for (const result of results) {
    if (result.error) continue
    lines.push(
      `| ${result.fixture.id} | ${result.chunks} | ${result.chunkSeconds.map((s) => s.toFixed(2)).join(", ")} | ` +
        `${result.seconds.toFixed(2)}s |`
    )
  }
  lines.push("")

  writeFileSync(reportPath, lines.join("\n"))
}

// ---------------------------------------------------------------------- main

async function sidecarIsUp(): Promise<boolean> {
  // The sidecar has no /health — main.py answers /speak and 404s the rest — so
  // any HTTP reply at all proves something is listening and speaking HTTP.
  try {
    await fetch(config.voice.ttsUrl, { signal: AbortSignal.timeout(3000) })
    return true
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError"
  }
}

async function main(): Promise<void> {
  const { fixtures, pairs, broken } = buildFixtures()

  if (!(await sidecarIsUp())) {
    console.error(`No TTS sidecar answering at ${config.voice.ttsUrl}.`)
    console.error("This script does not spawn Kokoro. Start it with either:")
    console.error("    npm run dev")
    console.error("    sidecars/tts/venv/bin/python sidecars/tts/main.py")
    process.exitCode = 1
    return
  }

  mkdirSync(outDir, { recursive: true })
  console.log(`${fixtures.length} fixtures -> ${outDir}`)
  if (broken.length) {
    for (const line of broken) console.error(`  !! ${line}`)
  }

  const results: Result[] = []
  const produced = new Set<string>()

  for (const fixture of fixtures) {
    const sanitized = sanitizeForSpeech(fixture.raw)
    const name = `${fixture.id}-${fixture.slug}.wav`
    const file = path.join(outDir, name)
    const pieces: Pcm[] = []

    process.stdout.write(`  ${fixture.id} ${fixture.slug.padEnd(28)} `)

    if (!sanitized) {
      // speak() returns early on an empty sanitize, so there would be no audio
      // in production either. Recorded, not synthesized.
      console.log("sanitizer emptied it — no audio in production either")
      results.push({
        fixture, sanitized, chunks: 0, chunkSeconds: [], seconds: 0, file,
        words: countWords(fixture.raw), error: "sanitized to empty",
      })
      continue
    }

    try {
      await speakStreaming(sanitized, (chunk) => pieces.push(parseWav(chunk)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`FAILED: ${message}`)
      results.push({
        fixture, sanitized, chunks: pieces.length, chunkSeconds: [], seconds: 0, file,
        words: countWords(sanitized), error: `synthesis failed: ${message}`,
      })
      continue
    }

    if (pieces.length === 0) {
      console.log("no audio frames returned")
      results.push({
        fixture, sanitized, chunks: 0, chunkSeconds: [], seconds: 0, file,
        words: countWords(sanitized), error: "no audio frames returned",
      })
      continue
    }

    const chunkSeconds = pieces.map(
      (piece) => piece.samples.length / (piece.channels * (piece.bitsPerSample / 8)) / piece.sampleRate
    )
    const seconds = writeWav(file, pieces)
    produced.add(name)
    console.log(`${pieces.length} chunk(s), ${seconds.toFixed(2)}s`)

    results.push({
      fixture, sanitized, chunks: pieces.length, chunkSeconds, seconds, file,
      words: countWords(sanitized),
    })
  }

  const flags = staticFlags(results)
  writeReport(results, pairs, broken, flags)

  // One source of fixtures for both halves of the measurement: the audio here,
  // and the phonemes in dev/scripts/tts-phonemes.py.
  writeFileSync(
    fixturesPath,
    JSON.stringify(
      results.map((r) => ({
        id: r.fixture.id,
        slug: r.fixture.slug,
        source: r.fixture.source,
        note: r.fixture.note ?? null,
        raw: r.fixture.raw,
        sanitized: r.sanitized,
        chunks: r.chunks,
        seconds: Number(r.seconds.toFixed(3)),
        file: path.basename(r.file),
        error: r.error ?? null,
      })),
      null,
      2
    )
  )

  // A .wav left over from an earlier fixture list would be played as if it
  // belonged to this run.
  const stale = readdirSync(outDir).filter((name) => name.endsWith(".wav") && !produced.has(name))

  console.log(`\nreport: ${reportPath}`)
  const spoken = results.filter((r) => !r.error)
  console.log(
    `${spoken.length}/${results.length} fixtures produced audio, ` +
      `${spoken.reduce((total, r) => total + r.seconds, 0).toFixed(1)}s in total`
  )
  if (flags.length) {
    console.log("\nstatic flags (not verdicts):")
    for (const flag of flags) console.log(`  - ${flag}`)
  }
  if (stale.length) {
    console.log(`\nstale WAVs from an earlier run, not part of this report: ${stale.join(", ")}`)
  }
  console.log("\nListen, then fill in the verdict column by hand.")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
