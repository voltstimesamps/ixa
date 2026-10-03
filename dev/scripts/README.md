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
- `rebuild-episode-index.ts` — drops the Qdrant collection and re-embeds every
  episode from SQLite. Safe at any time: SQLite is the source of truth. Use it
  after an embedding-model change or a Qdrant data loss. Needs Ollama and
  Qdrant, not the backend.
- `forget-episode.ts` — hard-deletes one episode by id from SQLite and Qdrant.
  `--dry-run` prints it first and deletes nothing. If Qdrant is unreachable the
  SQLite row still goes, which is what makes the episode unreachable; the stale
  vector is cleaned up by recall or by the next rebuild.
- `tts-abort.ts` — hangs up on the TTS sidecar mid-stream, the way the harness
  does when a client disconnects during a reply. Needs only the sidecar, not
  the backend. The sidecar should log one "client disconnected, stopping
  synthesis" line and no traceback; `complete` is the control run.

Usage:
    npx tsx dev/scripts/phase3a-verify.ts
    npx tsx dev/scripts/phase3a-voice-smoke.ts
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts prefs
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts window
    npx tsx dev/scripts/rebuild-episode-index.ts
    npx tsx dev/scripts/forget-episode.ts 12 --dry-run
    npx tsx dev/scripts/tts-abort.ts            # expect the one-line disconnect
    npx tsx dev/scripts/tts-abort.ts complete   # control: expect "done: N chunk(s)"
