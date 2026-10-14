# sidecars/tts/main.py
import io
import json
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch
from kokoro import KPipeline

print("Loading Kokoro model...")
pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
print("Kokoro ready.")


# Whether Kokoro can pronounce a word that is not in its dictionary.
#
# THIS IS LOAD-BEARING AND IT FAILS SILENTLY. misaki's lexicon has never heard
# of "Ixa", "Wyatt", "Qdrant" or "Kokoro", and KPipeline constructs its G2P
# with `unk=''` — so an unpronounceable token contributes NOTHING. It is not
# spoken as a noise or spelled out; it disappears.
#
# What covers it is an espeak fallback that KPipeline tries to build, and
# catches and logs if it cannot (kokoro/pipeline.py: "EspeakFallback not
# Enabled: OOD words will be skipped"). The library carries on without it.
# There is no system espeak-ng here: `libespeak-ng.so` ships inside the venv
# via espeakng_loader, a transitive pip dependency — which is exactly why it
# can go missing without anyone touching this project.
#
# Measured through the real G2P, with the fallback and without it:
#
#   "/home/wyatt/Projects/ixa"  with  -> "slash home slash wyatt slash
#                                         projects slash ixa"
#                               without -> "home Projects"
#   "/home/wallet/project/Ixa"  without -> "home wallet project"
#
# Every slash is dropped and both proper nouns vanish. The WRONG path then
# sounds more complete than the right one, because "wallet" is a real word and
# "wyatt" is not — so save_note's read-back, whose whole job is to make a
# misheard value audible, would be reading back the wrong thing convincingly.
# Ixa cannot say her own name either.
#
# Checked functionally rather than by testing `g2p.fallback is None`: what
# matters is whether a word comes out with phonemes on it, not which object
# claims it would provide them.
OOD_PROBE = 'Ixa'


def checkOutOfDictionaryWords() -> None:
    try:
        phonemes, _ = pipeline.g2p(OOD_PROBE)
    except Exception as e:
        phonemes = ''
        print(f"[TTS] could not probe the G2P: {e}", flush=True)

    if phonemes and phonemes.strip():
        print(f"[TTS] out-of-dictionary words are pronounceable ({OOD_PROBE!r} -> {phonemes.strip()!r})", flush=True)
        return

    for line in (
        "=" * 72,
        "[TTS] WARNING: espeak fallback is NOT working.",
        f"[TTS]   {OOD_PROBE!r} phonemized to nothing, so any word outside misaki's",
        "[TTS]   dictionary will be SILENTLY DROPPED from speech — names, paths and",
        "[TTS]   product names among them. Ixa cannot say her own name, and a note's",
        "[TTS]   read-back will omit the value it exists to read back.",
        "[TTS]   Nothing will error; replies will just be quietly missing words.",
        "[TTS]   Fix: reinstall this sidecar's venv from sidecars/tts/requirements.txt",
        "[TTS]   (espeakng_loader ships the library), or install espeak-ng system-wide.",
        "=" * 72,
    ):
        print(line, flush=True)


checkOutOfDictionaryWords()

sampleRate = 24000
defaultVoice = 'af_nova'
port = 5001

# Kokoro re.split()s the text on this pattern and synthesizes each piece as
# its own chunk. Its default, newlines only, left voice replies (plain
# sentences, no line breaks) as one chunk, so no audio went out until the
# whole reply was synthesized. This splits on whitespace after . ! or ?,
# optionally followed by one closing quote or bracket (e.g. ." .) ?'), and
# still on newlines. The two lookbehinds are separate because Python
# lookbehinds must be fixed-width. Groups are non-capturing, or re.split
# would return the delimiters as extra pieces. No abbreviation list: an early
# split after "Dr." or "e.g." is acceptable. Empty pieces cannot reach
# synthesis: the text is stripped before splitting and Kokoro skips
# whitespace-only pieces.
splitPattern = r'''(?:(?<=[.!?])|(?<=[.!?]["'”’)\]]))\s+|\s*\n\s*'''

# The harness aborts an in-flight TTS request when the WebSocket connection
# that asked for the reply goes away (see speakStreaming's AbortController), so
# a half-written response is routine, not a fault. It surfaces here on the next
# write to the socket as one of these.
connectionLost = (BrokenPipeError, ConnectionResetError)


def audioToWav(audioTensor) -> bytes:
    audioNp = audioTensor.numpy()
    audioInt16 = (audioNp * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sampleRate)
        wf.writeframes(audioInt16.tobytes())
    return buf.getvalue()


class TtsHandler(BaseHTTPRequestHandler):
    # Required for chunked transfer encoding + connection reuse.
    protocol_version = 'HTTP/1.1'

    # Set once per request, the first time a write finds the peer gone.
    clientGone = False

    def _writeChunk(self, data: bytes) -> None:
        # Manual HTTP/1.1 chunked-transfer framing: size line, payload, CRLF.
        # An empty payload writes the terminating "0\r\n\r\n" chunk.
        self.wfile.write(f"{len(data):x}\r\n".encode())
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _noteClientGone(self) -> None:
        # One line per request, however many writes fail afterwards, and never
        # a traceback: there is nothing wrong here to debug.
        if not self.clientGone:
            self.clientGone = True
            print("[TTS] client disconnected, stopping synthesis", flush=True)
        self.close_connection = True

    def do_POST(self):
        try:
            self._doPost()
        except connectionLost:
            # Backstop for the writes outside the streaming loop (the response
            # headers, an error body): without it these reach socketserver,
            # which prints a traceback for what is a normal disconnect.
            self._noteClientGone()

    def _doPost(self):
        if self.path != '/speak':
            self.send_response(404)
            self.end_headers()
            return

        contentLength = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(contentLength))
        text = body.get('text', '').strip()
        voice = body.get('voice', defaultVoice)

        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error": "text is required"}')
            return

        # Stream one length-prefixed, independently-valid WAV blob per Kokoro
        # chunk as it's synthesized, rather than buffering the whole reply.
        # Frame = 4-byte big-endian length + that many bytes of WAV data.
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        startTime = time.monotonic()
        firstChunkTime = None
        chunkCount = 0

        try:
            for _, _, audio in pipeline(text, voice=voice, split_pattern=splitPattern):
                if audio is None:
                    continue
                wavBytes = audioToWav(audio)
                frame = len(wavBytes).to_bytes(4, 'big') + wavBytes
                try:
                    self._writeChunk(frame)
                except connectionLost:
                    # Nobody is listening any more, and Kokoro is CPU-bound:
                    # finishing this reply would just delay the next real one.
                    self._noteClientGone()
                    return
                chunkCount += 1
                if firstChunkTime is None:
                    firstChunkTime = time.monotonic()
                    print(f"[TTS] first chunk sent after {firstChunkTime - startTime:.3f}s", flush=True)

            totalTime = time.monotonic() - startTime
            print(f"[TTS] done: {chunkCount} chunk(s), total {totalTime:.3f}s", flush=True)
        except Exception as e:
            # A real failure: full traceback, on the same stream as every other
            # sidecar line so the harness's captured output stays in order.
            print(f"[TTS] error mid-stream: {e}\n{traceback.format_exc()}", flush=True)
        finally:
            if not self.clientGone:
                try:
                    self._writeChunk(b'')
                except connectionLost:
                    self._noteClientGone()

    def log_message(self, format, *args):
        # flush like every other line here: stdout is a pipe under the harness,
        # so without it the request lines land out of order in the captured log.
        print(f"[TTS] {args[0]} {args[1]}", flush=True)


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', port), TtsHandler)
    print(f"TTS sidecar listening on port {port}")
    server.serve_forever()
