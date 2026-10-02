# dev/scripts

Throwaway verification clients, not part of the backend and not shipped.
Run them against a backend already started with `npm run dev`.

- `phase3a-verify.ts` — the Phase 3a acceptance run: context across a
  reconnect, the shared session across transports, turn serialization,
  cancel-on-disconnect, idle timeout, and context windowing.
- `phase3a-voice-smoke.ts` — one plain voice-path turn over WebSocket
  (text in, TTS chunks out), to confirm the voice pipeline still works.

Usage:
    npx tsx dev/scripts/phase3a-verify.ts
    npx tsx dev/scripts/phase3a-voice-smoke.ts
