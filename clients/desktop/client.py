import asyncio
import io
import json
import logging
import os
import sys
import wave

import numpy as np
import sounddevice as sd
import websockets

from audio_framing import FrameBuffer
from recorder import VoiceActivityRecorder
from vad import SileroVAD

logging.basicConfig(level=os.environ.get("IXA_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("ixa.client")

IXA_HOST = os.environ.get("IXA_HOST", "localhost")  # set to the harness's Tailscale IP for remote use
WS_URL = f"ws://{IXA_HOST}:3001"

PLAYBACK_SAMPLE_RATE = 24000  # matches the Kokoro TTS sidecar's WAV output
MIC_SAMPLE_RATE = SileroVAD.SAMPLE_RATE  # 16000 — required by Silero VAD and faster-whisper

# "vad" (default): Silero VAD triggers recording automatically.
# "ptt": type ":rec" and press Enter to start recording, again to stop.
# A literal press-and-hold key isn't reliable from a plain terminal (no key-up
# events without raw evdev access) and would need a second stdin reader racing
# the existing chat input, so this is a toggle sharing the one input stream.
RECORD_MODE = os.environ.get("IXA_RECORD_MODE", "vad")


async def playWav(wavBytes: bytes, loop: asyncio.AbstractEventLoop) -> None:
    buf = io.BytesIO(wavBytes)
    with wave.open(buf, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32767
    sd.play(audio, samplerate=PLAYBACK_SAMPLE_RATE)
    await loop.run_in_executor(None, sd.wait)


async def main() -> None:
    print(f"Connecting to {WS_URL}...")
    async with websockets.connect(WS_URL) as ws:
        print("Connected. Type a message and press Enter.\n")
        loop = asyncio.get_event_loop()

        audioBuffer = bytearray()
        collectingAudio = False
        isSpeaking = False  # True while TTS audio is playing — gates the mic so playback can't trigger recording

        vad = SileroVAD()
        frameBuffer = FrameBuffer(window_samples=SileroVAD.CHUNK_SAMPLES)

        async def onSpeechStart() -> None:
            logger.info("Recording...")
            await ws.send(json.dumps({"type": "audioStart"}))

        async def onFrame(frame: bytes) -> None:
            await ws.send(frame)

        async def onSpeechEnd() -> None:
            logger.info("Done recording.")
            await ws.send(json.dumps({"type": "audioInputEnd"}))

        recorder = VoiceActivityRecorder(onSpeechStart, onFrame, onSpeechEnd)

        async def receiver() -> None:
            nonlocal audioBuffer, collectingAudio, isSpeaking
            async for message in ws:
                if isinstance(message, bytes):
                    if collectingAudio:
                        audioBuffer.extend(message)
                else:
                    msg = json.loads(message)
                    msgType = msg.get("type")
                    if msgType == "sessionStart":
                        print("Session started.")
                    elif msgType == "assistant":
                        print(f"\nIxa: {msg.get('content', '')}\n")
                    elif msgType == "audioStart":
                        audioBuffer = bytearray()
                        collectingAudio = True
                    elif msgType == "audioOutputEnd":
                        collectingAudio = False
                        if audioBuffer:
                            isSpeaking = True
                            try:
                                await playWav(bytes(audioBuffer), loop)
                            finally:
                                isSpeaking = False
                                # clear VAD context/state so playback tail can't bleed into the next utterance
                                vad.reset()
                    elif msgType == "confirm":
                        answer = input(f"\nConfirm: {msg.get('content')} (yes/no): ")
                        await ws.send(json.dumps({
                            "type": "confirmReply",
                            "content": answer.strip().lower(),
                            "requestId": msg.get("requestId")
                        }))
                    elif msgType == "error":
                        print(f"Error: {msg.get('content')}")

        async def pttRecordSession(stopEvent: asyncio.Event) -> None:
            frameQueue: asyncio.Queue[bytes] = asyncio.Queue()

            def onAudioBlock(indata, frames, time_info, status):
                if status:
                    logger.debug("sounddevice input status: %s", status)
                loop.call_soon_threadsafe(frameQueue.put_nowait, indata.tobytes())

            await onSpeechStart()
            with sd.InputStream(
                samplerate=MIC_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=SileroVAD.CHUNK_SAMPLES,
                callback=onAudioBlock,
            ):
                while not stopEvent.is_set():
                    try:
                        frame = await asyncio.wait_for(frameQueue.get(), timeout=0.1)
                    except asyncio.TimeoutError:
                        continue
                    await onFrame(frame)
            await onSpeechEnd()

        async def sender() -> None:
            pttTask: asyncio.Task | None = None
            pttStop: asyncio.Event | None = None
            while True:
                text = await loop.run_in_executor(None, sys.stdin.readline)
                text = text.strip()
                if not text:
                    continue

                if RECORD_MODE == "ptt" and text == ":rec":
                    if pttTask is None:
                        pttStop = asyncio.Event()
                        pttTask = asyncio.ensure_future(pttRecordSession(pttStop))
                        print("[recording... type :rec again to stop]")
                    else:
                        pttStop.set()
                        await pttTask
                        pttTask = None
                    continue

                await ws.send(json.dumps({"type": "user", "content": text}))

        async def micLoopVad() -> None:
            frameQueue: asyncio.Queue[bytes] = asyncio.Queue()

            def onAudioBlock(indata, frames, time_info, status):
                if status:
                    logger.debug("sounddevice input status: %s", status)
                loop.call_soon_threadsafe(frameQueue.put_nowait, indata.tobytes())

            with sd.InputStream(
                samplerate=MIC_SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=SileroVAD.CHUNK_SAMPLES,
                callback=onAudioBlock,
            ):
                while True:
                    chunk = await frameQueue.get()
                    if isSpeaking:
                        continue  # drop mic input while the assistant is talking
                    for window in frameBuffer.push(chunk):
                        samples = np.frombuffer(window, dtype=np.int16).astype(np.float32) / 32768.0
                        score = vad.process(samples)
                        await recorder.handle_frame(window, score)

        tasks = [receiver(), sender()]
        if RECORD_MODE == "vad":
            tasks.append(micLoopVad())
        else:
            print("Push-to-talk mode: type \":rec\" and press Enter to start/stop recording.")

        await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
