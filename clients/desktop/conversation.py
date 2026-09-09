import logging
from enum import Enum, auto
from typing import Awaitable, Callable

logger = logging.getLogger("ixa.client.conversation")

# How long to keep listening for a follow-up after Ixa finishes speaking
# before requiring the wake phrase again. Tune alongside SPEECH_PROB_THRESHOLD
# and TRAILING_SILENCE_MS in recorder.py — they all shape the same felt sense
# of "is Ixa still listening to me".
CONVERSATION_TIMEOUT_MS = 20_000.0
VAD_FRAME_MS = 32.0  # SileroVAD.CHUNK_SAMPLES (512) at 16kHz


class SessionState(Enum):
    ASLEEP = auto()  # only the wake word model sees audio
    AWAKE = auto()  # the VAD recorder sees audio, as if wake word didn't exist


class ConversationGate:
    """Gates the existing VAD recorder behind a wake-word trigger.

    Asleep, raw audio only reaches the wake word detector. A trigger flips to
    Awake and hands audio to the VAD recorder exactly as before wake word
    existed — this class knows nothing about VAD internals, mirroring how
    VoiceActivityRecorder knows nothing about audio capture.

    Awake stays open across multiple back-and-forth turns ("conversation
    mode") instead of requiring the wake phrase on every turn. It only drops
    back to Asleep on a trailing-silence timeout or an explicit dismiss
    signal from the server (a spoken dismiss phrase, detected server-side
    against the STT transcript). The mic is dropped entirely during TTS
    playback (see client.py's isSpeaking gate), so a long spoken reply can
    never itself burn down the timeout — silence only accrues in the actual
    gaps between turns.
    """

    def __init__(
        self,
        on_wake: Callable[[], Awaitable[None]],
        on_sleep: Callable[[], Awaitable[None]],
    ):
        self.state = SessionState.ASLEEP
        self._silence_ms = 0.0
        self._on_wake = on_wake
        self._on_sleep = on_sleep

    async def handle_wake_frame(self, score: float, threshold: float) -> None:
        if self.state is SessionState.ASLEEP and score >= threshold:
            logger.info("Wake word detected (score=%.3f)", score)
            self.state = SessionState.AWAKE
            self._silence_ms = 0.0
            await self._on_wake()

    async def note_vad_frame(self, is_speech: bool) -> None:
        """Call once per VAD frame while Awake to drive the conversation
        timeout."""
        if is_speech:
            self._silence_ms = 0.0
            return

        self._silence_ms += VAD_FRAME_MS
        if self._silence_ms >= CONVERSATION_TIMEOUT_MS:
            logger.info("Conversation timed out after %.0fms of silence", self._silence_ms)
            await self.sleep()

    async def sleep(self) -> None:
        if self.state is SessionState.AWAKE:
            self.state = SessionState.ASLEEP
            self._silence_ms = 0.0
            await self._on_sleep()
