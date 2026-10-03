// Aborts a streaming TTS request mid-reply, exactly the way websocket.ts does
// when the WebSocket that asked for the reply goes away. Needs only the TTS
// sidecar (TTS_URL, default http://localhost:5001), not the whole backend.
//
// Expected sidecar output: one "[TTS] client disconnected, stopping synthesis"
// line and no traceback. Before this existed, the terminating chunk written in
// the handler's finally block raised BrokenPipeError out of do_POST and
// socketserver printed a ~20-line traceback for a routine disconnect.
import { speakStreaming } from "../../src/voice/tts"

// Long enough that several sentences are still unsynthesized when the abort
// lands — the point is to catch the sidecar mid-stream.
const TEXT = [
  "This is the first sentence of a deliberately long reply.",
  "This is the second sentence, which should still be synthesizing when the abort lands.",
  "This is the third sentence, and the sidecar should never get this far.",
  "A fourth sentence, for good measure.",
  "And a fifth, so there is plenty of work left to abandon.",
].join(" ")

// "abort" (default) hangs up after the first chunk; "complete" is the control
// run that should still log "[TTS] done: N chunk(s)".
const mode = process.argv[2] ?? "abort"

const abort = new AbortController()
let chunks = 0

speakStreaming(
  TEXT,
  () => {
    chunks++
    console.log(`client: chunk ${chunks} received`)
    if (mode === "abort" && chunks === 1) {
      console.log("client: aborting mid-stream (as a WebSocket close would)")
      abort.abort()
    }
  },
  { signal: abort.signal },
)
  .then(() => console.log(`client: speakStreaming returned after ${chunks} chunk(s)`))
  .catch((err) => {
    console.error("client: speakStreaming threw:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
