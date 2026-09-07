# sidecars/stt/main.py
import io
import json
import os
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

from faster_whisper import WhisperModel

modelName = os.environ.get('STT_MODEL', 'base.en')
port = int(os.environ.get('STT_PORT', '5002'))

print(f"Loading faster-whisper model '{modelName}'...")
model = WhisperModel(modelName, device='cpu', compute_type='int8')
print("faster-whisper ready.")


def transcribeWav(wavBytes: bytes):
    with wave.open(io.BytesIO(wavBytes), 'rb') as wf:
        if wf.getnchannels() != 1:
            raise ValueError(f"expected mono audio, got {wf.getnchannels()} channel(s)")
        if wf.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit PCM, got {wf.getsampwidth() * 8}-bit")

    audioBuf = io.BytesIO(wavBytes)
    segments, info = model.transcribe(audioBuf, beam_size=5, vad_filter=True)
    text = "".join(segment.text for segment in segments).strip()
    return text, info.language


class SttHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/transcribe':
            self.send_response(404)
            self.end_headers()
            return

        contentLength = int(self.headers.get('Content-Length', 0))
        if contentLength == 0:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error": "audio data is required"}')
            return

        body = self.rfile.read(contentLength)

        start = time.monotonic()
        try:
            text, language = transcribeWav(body)
        except (wave.Error, ValueError) as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'invalid WAV audio: {e}'}).encode())
            return
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
            return

        durationMs = int((time.monotonic() - start) * 1000)

        preview = text[:80] + ("..." if len(text) > 80 else "")
        print(f"[STT] transcribed in {durationMs}ms: {preview!r}")

        response = json.dumps({'text': text, 'language': language, 'durationMs': durationMs}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format, *args):
        print(f"[STT] {args[0]} {args[1]}")


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', port), SttHandler)
    print(f"STT sidecar listening on port {port}")
    server.serve_forever()
