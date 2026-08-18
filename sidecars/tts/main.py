# sidecars/tts/main.py
import io
import json
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

        try:
            chunks = []
            for _, _, audio in pipeline(text, voice=voice):
                chunks.append(audio)

            combined = torch.cat(chunks, dim=0)
            wavBytes = audioToWav(combined)

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wavBytes)))
            self.end_headers()
            self.wfile.write(wavBytes)

        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, format, *args):
        print(f"[TTS] {args[0]} {args[1]}")


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', port), TtsHandler)
    print(f"TTS sidecar listening on port {port}")
    server.serve_forever()
