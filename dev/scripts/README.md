# dev/scripts

Throwaway verification clients, not part of the backend and not shipped.
Run them against a backend already started with `npm run dev`.

- `phase3a-verify.ts` — the Phase 3a acceptance run: context across a
  reconnect, the shared session across transports, turn serialization,
  cancel-on-disconnect, idle timeout, and context windowing.
- `phase3a-voice-smoke.ts` — one plain voice-path turn over WebSocket
  (text in, TTS chunks out), to confirm the voice pipeline still works.
- `phase3b-verify.ts` — the Phase 3b acceptance run: remember / apply /
  update / forget over WebSocket with the SQLite rows checked directly, a
  session reset, restart survival, and preference injection under a tiny
  context budget. Modes: `prefs`, `fact`, `recall`, `recall-expired`,
  `window`. Run the backend and the script against the SAME `IXA_DB_PATH`.
- `tts-abort.ts` — hangs up on the TTS sidecar mid-stream, the way the harness
  does when a client disconnects during a reply. Needs only the sidecar, not
  the backend. The sidecar should log one "client disconnected, stopping
  synthesis" line and no traceback; `complete` is the control run.

Usage:
    npx tsx dev/scripts/phase3a-verify.ts
    npx tsx dev/scripts/phase3a-voice-smoke.ts
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts prefs
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts window
    npx tsx dev/scripts/tts-abort.ts            # expect the one-line disconnect
    npx tsx dev/scripts/tts-abort.ts complete   # control: expect "done: N chunk(s)"
