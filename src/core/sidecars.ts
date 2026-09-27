import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import * as readline from "node:readline"
import { config } from "../config"

// Repo root, resolved relative to this module so it works both under tsx
// (src/core/) and after `npm run build` (dist/core/) without depending on cwd.
const repoRoot = path.resolve(__dirname, "..", "..")

interface SidecarSpec {
  name: string
  /** Directory holding main.py and venv/ */
  dir: string
  /** URL the harness will call, so the readiness probe targets the same port. */
  url: string
  /** Extra env the sidecar reads (see its main.py). */
  env: Record<string, string>
}

const specs: SidecarSpec[] = [
  {
    name: "stt",
    dir: path.join(repoRoot, "sidecars", "stt"),
    url: config.voice.sttUrl,
    // main.py reads both of these; STT_PORT must agree with STT_URL.
    env: { STT_MODEL: config.voice.sttModel, STT_PORT: String(portOf(config.voice.sttUrl)) },
  },
  {
    name: "tts",
    dir: path.join(repoRoot, "sidecars", "tts"),
    url: config.voice.ttsUrl,
    // tts/main.py hardcodes port 5001 — there is no env var to pass. If TTS_URL
    // names a different port the readiness probe below will say so rather than
    // hanging, but the fix is to edit main.py.
    env: {},
  },
]

/** Sidecars this process spawned, and must therefore clean up. */
const owned = new Map<string, ChildProcess>()
let signalsWired = false
let shuttingDown = false

function portOf(url: string): number {
  const parsed = new URL(url)
  if (parsed.port) return Number(parsed.port)
  return parsed.protocol === "https:" ? 443 : 80
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
}

/** True if something is already accepting TCP connections on the port. */
function isPortOpen(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function prefixOutput(name: string, child: ChildProcess): void {
  for (const [stream, sink] of [
    [child.stdout, console.log],
    [child.stderr, console.error],
  ] as const) {
    if (!stream) continue
    readline.createInterface({ input: stream }).on("line", (line) => sink(`[${name}] ${line}`))
  }
}

/**
 * Wait until the sidecar's port accepts connections. Both sidecars load their
 * model at import time and only then bind, so an accepted connection means the
 * model is loaded and the thing is genuinely ready — no fixed sleep needed.
 * Rejects immediately if the child dies first, instead of waiting out the
 * timeout on a process that is never coming up.
 */
async function waitForReady(spec: SidecarSpec, child: ChildProcess | null, timeoutMs: number): Promise<void> {
  const port = portOf(spec.url)
  const host = new URL(spec.url).hostname
  const deadline = Date.now() + timeoutMs

  // Held in an object so the polling loop below reads the callback's write
  // rather than a value TypeScript has narrowed to its initializer.
  const died: { reason?: string } = {}
  child?.once("exit", (code, signal) => {
    died.reason = signal ? `killed by ${signal}` : `exited with code ${code}`
  })

  while (Date.now() < deadline) {
    if (died.reason) {
      throw new Error(`[${spec.name}] sidecar ${died.reason} before it became ready — see the [${spec.name}] output above`)
    }
    if (await isPortOpen(port, host)) return
    await new Promise((r) => setTimeout(r, 250))
  }

  throw new Error(
    `[${spec.name}] sidecar did not start listening on port ${port} within ${Math.round(timeoutMs / 1000)}s. ` +
      `Raise SIDECAR_TIMEOUT_MS if the model is still downloading.`
  )
}

function start(spec: SidecarSpec): ChildProcess {
  const python = path.join(spec.dir, "venv", "bin", "python")
  const entry = path.join(spec.dir, "main.py")

  if (!existsSync(entry)) {
    throw new Error(`[${spec.name}] sidecar entry point is missing: ${entry}`)
  }
  if (!existsSync(python)) {
    const req = path.join(spec.dir, "requirements.txt")
    const install = existsSync(req)
      ? `python3 -m venv ${path.relative(repoRoot, path.join(spec.dir, "venv"))} && ${path.relative(repoRoot, python)} -m pip install -r ${path.relative(repoRoot, req)}`
      : `python3 -m venv ${path.relative(repoRoot, path.join(spec.dir, "venv"))}  # then pip install this sidecar's deps`
    throw new Error(
      `[${spec.name}] sidecar venv is missing: ${python}\n` +
        `  Create it from the repo root with:\n    ${install}\n` +
        `  Or set SIDECAR_AUTOSTART=false to run the sidecars yourself.`
    )
  }

  const child = spawn(python, [entry], {
    cwd: spec.dir,
    // PYTHONUNBUFFERED so the sidecar's prints reach our console as they
    // happen rather than in blocks when its pipe buffer fills.
    env: { ...process.env, PYTHONUNBUFFERED: "1", ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so shutdown can kill the whole group (see stopSidecars)
    // and no Python grandchild survives `npm run dev` exiting. The tradeoff is
    // that a terminal Ctrl+C no longer reaches the child on its own, which is
    // exactly why the signal handlers below are mandatory, not polish.
    detached: true,
  })

  prefixOutput(spec.name, child)

  child.once("error", (err) => {
    console.error(`[${spec.name}] failed to spawn: ${err.message}`)
  })

  child.once("exit", (code, signal) => {
    owned.delete(spec.name)
    if (!shuttingDown) {
      console.error(`[${spec.name}] sidecar exited unexpectedly (${signal ?? `code ${code}`})`)
    }
  })

  owned.set(spec.name, child)
  return child
}

/** Kill every sidecar we spawned. Synchronous, so it is safe from an `exit` handler. */
export function stopSidecars(signal: NodeJS.Signals = "SIGTERM"): void {
  // Any deliberate stop means the exits that follow are expected, not crashes.
  shuttingDown = true
  for (const [name, child] of owned) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue
    try {
      // Negative pid targets the whole process group created by detached: true.
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        console.error(`[${name}] could not be killed (pid ${child.pid}) — check for a stray python process`)
      }
    }
  }
}

function wireSignals(): void {
  if (signalsWired) return
  signalsWired = true

  // Last line of defense: runs however the process is winding down, including
  // when another SIGINT handler (see core/harness.ts) calls process.exit
  // straight away. SIGKILL because at this point there is no time left to be
  // polite, and a surviving Python process holding a lock is the failure mode
  // this exists to prevent.
  process.on("exit", () => {
    shuttingDown = true
    stopSidecars("SIGKILL")
  })

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`\nShutting down sidecars (${sig})...`)
      stopSidecars("SIGTERM")
      // Brief grace period for a clean exit, then leave; the `exit` handler
      // above SIGKILLs anything still standing.
      setTimeout(() => process.exit(0), 750).unref()
    })
  }
}

/**
 * Spawn the STT and TTS sidecars and resolve once both are accepting requests.
 * Call before the WebSocket server starts accepting clients: a connection that
 * arrives before the sidecars are up cannot transcribe or speak.
 */
export async function startSidecars(): Promise<void> {
  if (!config.sidecars.autostart) {
    console.log("Sidecar autostart disabled (SIDECAR_AUTOSTART=false) — start sidecars/{stt,tts}/main.py yourself.")
    return
  }

  wireSignals()

  const pending: Array<Promise<void>> = []

  // The spawn loop is inside the try so that a failure on the second sidecar
  // still tears down the first one, rather than leaving it to the exit handler.
  try {
    for (const spec of specs) {
      const port = portOf(spec.url)

      if (!isLocal(spec.url)) {
        console.log(`[${spec.name}] ${spec.url} is remote — not spawning a local sidecar.`)
        continue
      }

      // A sidecar already on the port is either one you started by hand or an
      // orphan from a previous run. Either way, spawning a second would just
      // die with EADDRINUSE, so adopt the running one instead — and leave it
      // alone at shutdown, since we did not start it.
      if (await isPortOpen(port, "127.0.0.1")) {
        console.log(`[${spec.name}] already listening on port ${port} — reusing it (not spawned by this harness).`)
        continue
      }

      console.log(`[${spec.name}] starting ${path.relative(repoRoot, path.join(spec.dir, "main.py"))} (loading model, this can take a while)...`)
      const child = start(spec)
      pending.push(
        waitForReady(spec, child, config.sidecars.timeoutMs).then(() => {
          console.log(`[${spec.name}] ready on port ${port}`)
        })
      )
    }

    await Promise.all(pending)
  } catch (err) {
    stopSidecars("SIGTERM")
    throw err
  }
}
