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
- `rebuild-note-index.ts` — drops the notes Qdrant collection and re-embeds every chunk
  row from SQLite. The CHEAP half of a notes rebuild: for notes the markdown file is the
  source of truth, so `vault -> SQLite` (the reconcile scan) is a separate, later thing.
  Run it after an embedding-model change, a Qdrant data loss, or when a search returns
  something the vault does not say — including the case the notebook logs loudly, a note
  marked superseded in SQLite whose vectors still say `active`.
- `notes-verify.ts` — the Phase 3d step 2 acceptance run: the step-1 spike's ten writer
  requests driven through the REAL registered tools, plus a routing set in BOTH directions
  (a note must not become a preference, and a preference must not become a note). Writes
  real markdown, real rows and real vectors — into a throwaway vault, database and
  collection under `/tmp/ixa-notes-verify`, asserted to differ from the configured ones
  before anything runs. `remember_preference` IS executed, which is what makes reverse
  routing measurable. `web_search` is stubbed unless `--live-search`. Seeds two notes first
  so the supersede and duplicate probes can actually fail. Writes
  `notes-verify-report.md`; `--cleanup` drops the collection and the temp vault. Needs
  Ollama, Qdrant and Groq, not the backend.

  Run `--cleanup` **between** runs that are meant to be compared: without it the next
  run starts on the previous run's vault, which changes every duplicate advisory and
  every search result. `notes-verify-report-routing-clause.md` beside it is the same
  script's output for a description change that was measured and reverted — kept because
  it is the only run in which the "remember that \<fact>" case routed correctly, and
  because it shows what that cost. Routing is noisy: expect one run per state to be
  suggestive and not conclusive.
- `tts-abort.ts` — hangs up on the TTS sidecar mid-stream, the way the harness
  does when a client disconnects during a reply. Needs only the sidecar, not
  the backend. The sidecar should log one "client disconnected, stopping
  synthesis" line and no traceback; `complete` is the control run.
- `tts-render-check.ts` — measures how Kokoro RENDERS written text as speech.
  Synthesizes a fixture list through the real spoken path (`sanitizeForSpeech`
  then `speakStreaming`, exactly as `speak()` does), writes one WAV per fixture
  to `Ixa-Tests/tts/` and a `report.md` whose verdict column is filled in BY
  EAR. Fixtures are real assistant replies from `data/ixa.db`, plus invented
  ones only where the corpus has a gap; each hypothesized cause appears twice,
  once broken and once with a single substitution applied, so a pair can be
  compared back to back. Needs only the sidecar, already running — it never
  spawns Kokoro.
- `tts-phonemes.py` — the companion diagnostic: what the G2P decided before the
  vocoder ran, for the same fixtures. Reads `Ixa-Tests/tts/fixtures.json`, which
  `tts-render-check.ts` writes, so the fixture strings exist in one place. Needs
  the TTS sidecar's venv, not the sidecar itself. It says whether a twin's
  substitution changed anything Kokoro can hear, which duration alone cannot:
  `$1,360`, `$1360` and `one thousand three hundred sixty dollars` are
  phoneme-identical.

Usage:
    npx tsx dev/scripts/phase3a-verify.ts
    npx tsx dev/scripts/phase3a-voice-smoke.ts
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts prefs
    IXA_DB_PATH=data/phase3b-verify.db npx tsx dev/scripts/phase3b-verify.ts window
    npx tsx dev/scripts/rebuild-episode-index.ts
    npx tsx dev/scripts/rebuild-note-index.ts
    npx tsx dev/scripts/notes-verify.ts
    npx tsx dev/scripts/notes-verify.ts --cleanup
    npx tsx dev/scripts/forget-episode.ts 12 --dry-run
    npx tsx dev/scripts/tts-abort.ts            # expect the one-line disconnect
    npx tsx dev/scripts/tts-abort.ts complete   # control: expect "done: N chunk(s)"
    npx tsx dev/scripts/tts-render-check.ts     # needs the TTS sidecar running
    sidecars/tts/venv/bin/python dev/scripts/tts-phonemes.py
