import logging
from enum import Enum, auto
from typing import Awaitable, Callable

logger = logging.getLogger("ixa.client.vad")

# Tunable against the actual mic/room — run with logging at DEBUG to watch scores
# at each transition while tuning.
SPEECH_PROB_THRESHOLD = 0.5
TRAILING_SILENCE_MS = 600.0
FRAME_MS = 32.0  # SileroVAD.CHUNK_SAMPLES (512) at 16kHz


class RecorderState(Enum):
    IDLE = auto()
    RECORDING = auto()


class VoiceActivityRecorder:
    """Idle/Recording state machine driven by per-frame VAD scores.

    Knows nothing about audio capture or the network transport — it's handed a
    frame and its VAD score and calls back on state transitions and frames while
    recording. This is the seam where wake-word detection slots in later: a
    wake-word hit would transition Idle -> Recording exactly like a VAD threshold
    crossing does today, without this class or the frame-buffer changing.
    """

    def __init__(
        self,
        on_speech_start: Callable[[], Awaitable[None]],
        on_frame: Callable[[bytes], Awaitable[None]],
        on_speech_end: Callable[[], Awaitable[None]],
    ):
        self.state = RecorderState.IDLE
        self._silence_ms = 0.0
        self._on_speech_start = on_speech_start
        self._on_frame = on_frame
        self._on_speech_end = on_speech_end

    async def handle_frame(self, frame: bytes, score: float) -> None:
        is_speech = score >= SPEECH_PROB_THRESHOLD

        if self.state is RecorderState.IDLE:
            if is_speech:
                logger.debug("Idle -> Recording (score=%.3f)", score)
                self.state = RecorderState.RECORDING
                self._silence_ms = 0.0
                await self._on_speech_start()
                await self._on_frame(frame)
            return

        await self._on_frame(frame)
        if is_speech:
            self._silence_ms = 0.0
            return

        self._silence_ms += FRAME_MS
        if self._silence_ms >= TRAILING_SILENCE_MS:
            logger.debug("Recording -> Idle (score=%.3f, trailing silence=%.0fms)", score, self._silence_ms)
            self.state = RecorderState.IDLE
            await self._on_speech_end()
