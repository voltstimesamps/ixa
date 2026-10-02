# sidecars/tts/main.py
import io
import json
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch
from kokoro import KPipeline

print("Loading Kokoro model...")
pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
print("Kokoro ready.")

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

    def _writeChunk(self, data: bytes) -> None:
        # Manual HTTP/1.1 chunked-transfer framing: size line, payload, CRLF.
        # An empty payload writes the terminating "0\r\n\r\n" chunk.
        self.wfile.write(f"{len(data):x}\r\n".encode())
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def do_POST(self):
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
                self._writeChunk(frame)
                chunkCount += 1
                if firstChunkTime is None:
                    firstChunkTime = time.monotonic()
                    print(f"[TTS] first chunk sent after {firstChunkTime - startTime:.3f}s", flush=True)

            totalTime = time.monotonic() - startTime
            print(f"[TTS] done: {chunkCount} chunk(s), total {totalTime:.3f}s", flush=True)
        except Exception as e:
            print(f"[TTS] error mid-stream: {e}", flush=True)
        finally:
            self._writeChunk(b'')

    def log_message(self, format, *args):
        print(f"[TTS] {args[0]} {args[1]}")


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', port), TtsHandler)
    print(f"TTS sidecar listening on port {port}")
    server.serve_forever()
