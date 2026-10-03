# dev/scripts

Throwaway verification clients, not part of the backend and not shipped.
Run them against a backend already started with `npm run dev`.

- `phase3a-verify.ts` — the Phase 3a acceptance run: context across a
  reconnect, the shared session across transports, turn serialization,
  cancel-on-disconnect, idle timeout, and context windowing.
- `phase3a-voice-smoke.ts` — one plain voice-path turn over WebSocket
  (text in, TTS chunks out), to confirm the voice pipeline still works.
- `tts-abort.ts` — hangs up on the TTS sidecar mid-stream, the way the harness
  does when a client disconnects during a reply. Needs only the sidecar, not
  the backend. The sidecar should log one "client disconnected, stopping
  synthesis" line and no traceback; `complete` is the control run.

Usage:
    npx tsx dev/scripts/phase3a-verify.ts
    npx tsx dev/scripts/phase3a-voice-smoke.ts
    npx tsx dev/scripts/tts-abort.ts            # expect the one-line disconnect
    npx tsx dev/scripts/tts-abort.ts complete   # control: expect "done: N chunk(s)"
