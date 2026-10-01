import { readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib"
import type { Context } from "hono"

// Static assets for the /test page's in-browser wake word pipeline. Explicit
// allowlists rather than serving directories: only what the page needs.
//
// Paths resolve relative to this module so they work under tsx (src/api/) and
// after `npm run build` (dist/api/) alike — same approach as core/sidecars.ts.
const repoRoot = path.resolve(__dirname, "..", "..")
const modelDir = path.join(repoRoot, "clients", "desktop", "models")
const ortDir = path.join(repoRoot, "node_modules", "onnxruntime-web", "dist")

// melspectrogram + embedding_model are openWakeWord's shared feature models
// (v0.5.1 release assets, Apache-2.0); hey_ixa is the custom classifier the
// desktop client also uses.
export const servedModels: Record<string, string> = {
  "melspectrogram.onnx": path.join(modelDir, "melspectrogram.onnx"),
  "embedding_model.onnx": path.join(modelDir, "embedding_model.onnx"),
  "hey_ixa.onnx": path.join(modelDir, "hey_ixa.onnx"),
}

// onnxruntime-web's wasm-only build. Since 1.19 the only wasm binary shipped
// is "simd-threaded"; its loader drops to numThreads=1 whenever the page
// isn't crossOriginIsolated, so no SharedArrayBuffer or COOP/COEP headers
// are needed. ort.wasm.min.js dynamic-imports the .mjs glue from wasmPaths.
export const servedOrt: Record<string, string> = {
  "ort.wasm.min.js": path.join(ortDir, "ort.wasm.min.js"),
  "ort-wasm-simd-threaded.mjs": path.join(ortDir, "ort-wasm-simd-threaded.mjs"),
  "ort-wasm-simd-threaded.wasm": path.join(ortDir, "ort-wasm-simd-threaded.wasm"),
}

// Validation fixtures for /test/wake-check: each <name>.wav paired with the
// <name>.baseline.json tools/wakeword/baseline.py wrote from it. Listed from
// disk per request, so a newly added fixture shows up without a restart.
const fixtureDir = path.join(repoRoot, "tools", "wakeword", "fixtures")

export interface WakeFixture {
  wav: string
  baseline: string
}

export async function listWakeFixtures(): Promise<{ fixtures: WakeFixture[]; files: Record<string, string> }> {
  let names: string[] = []
  try {
    names = await readdir(fixtureDir)
  } catch {
    // no fixtures directory: empty list
  }
  const fixtures: WakeFixture[] = []
  const files: Record<string, string> = {}
  for (const wav of names.filter((n) => n.endsWith(".wav")).sort()) {
    const baseline = wav.replace(/\.wav$/, ".baseline.json")
    if (!names.includes(baseline)) continue
    fixtures.push({ wav, baseline })
    files[wav] = path.join(fixtureDir, wav)
    files[baseline] = path.join(fixtureDir, baseline)
  }
  return { fixtures, files }
}

const contentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
}

type Encoding = "br" | "gzip"

interface CachedFile {
  version: string // size-mtime; a changed file on disk invalidates the cache
  raw: NonSharedBuffer
  encoded: Partial<Record<Encoding, NonSharedBuffer>>
}

// Everything served here is a few MB at most, and the wasm binary compresses
// 14.2MB -> 2.7MB with brotli — worth it over Tailscale to a phone. Each
// encoding is computed once per file version (~1s for the wasm) and kept.
const cache = new Map<string, CachedFile>()

function pickEncoding(acceptEncoding: string | undefined): Encoding | null {
  const accepted = (acceptEncoding ?? "").toLowerCase()
  if (/\bbr\b/.test(accepted)) return "br"
  if (/\bgzip\b/.test(accepted)) return "gzip"
  return null
}

function encode(raw: NonSharedBuffer, encoding: Encoding): NonSharedBuffer {
  return encoding === "br"
    ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
    : gzipSync(raw, { level: 9 })
}

/**
 * Serves one allowlisted file with revalidation caching. no-cache + ETag
 * makes every page load a cheap 304 that still picks up a retrained
 * hey_ixa.onnx immediately, which a max-age would hide behind a stale cache.
 */
export async function serveAsset(c: Context, allowlist: Record<string, string>, name: string) {
  const filePath = Object.hasOwn(allowlist, name) ? allowlist[name] : undefined
  if (!filePath) return c.notFound()

  let info
  try {
    info = await stat(filePath)
  } catch {
    return c.notFound()
  }

  const version = `${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}`
  let entry = cache.get(filePath)
  if (!entry || entry.version !== version) {
    entry = { version, raw: await readFile(filePath), encoded: {} }
    cache.set(filePath, entry)
  }

  const encoding = pickEncoding(c.req.header("Accept-Encoding"))
  // Distinct ETag per representation, so a cache never pairs one encoding's
  // validator with another encoding's bytes.
  const etag = `"${version}${encoding ? "-" + encoding : ""}"`
  c.header("ETag", etag)
  c.header("Cache-Control", "no-cache")
  c.header("Vary", "Accept-Encoding")
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304)

  c.header("Content-Type", contentTypes[path.extname(name)] ?? "application/octet-stream")
  if (!encoding) return c.body(entry.raw)

  let body = entry.encoded[encoding]
  if (!body) {
    body = encode(entry.raw, encoding)
    entry.encoded[encoding] = body
  }
  c.header("Content-Encoding", encoding)
  return c.body(body)
}
