import logging
import os
import time
from enum import Enum, auto
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("ixa.client.conversation")

# How long to keep listening for a follow-up after Ixa finishes speaking before
# requiring the wake phrase again. This clock runs ONLY in LISTENING — see
# ConversationState. Tune alongside SPEECH_PROB_THRESHOLD and
# TRAILING_SILENCE_MS in recorder.py; they all shape the same felt sense of
# "is Ixa still listening to me".
CONVERSATION_TIMEOUT_MS = float(os.environ.get("IXA_CONVERSATION_TIMEOUT_MS", "20000"))

# Safety net for WAITING: how long to wait for a reply that never comes (a
# backend crash, a dropped turn, a tool loop that wedged) before giving up and
# going back to sleep. Must be comfortably longer than the slowest real
# tool-using turn, or it will cut off legitimate replies — that is what the
# conversation timeout used to do.
RESPONSE_TIMEOUT_MS = float(os.environ.get("IXA_RESPONSE_TIMEOUT_MS", "90000"))

# Consecutive 80ms wake word frames that must score >= threshold before
# waking. In the 2026-09-30 measurements, every false wake on room tone was a
# single frame (peaks up to 0.845), while the real phrase always held for 6-7
# frames at every chunk phase. 2 rejects those at the cost of 80ms latency.
# PROVISIONAL: all of that false-wake data came from a fake mic playing
# recorded room tone, not a real mic in a real room — revisit after the
# Framework 13 live test. Counted here rather than via openwakeword's own
# `patience` argument, which is broken in 0.6.0: it stores suppressed frames
# as 0.0 and then checks that same buffer, so it never fires at all.
# Keep in sync with WAKE_CONSECUTIVE_FRAMES in src/api/test-client.ts.
WAKE_CONSECUTIVE_FRAMES = 2


class ConversationState(Enum):
    """Where this client is in a conversation.

    The conversation timeout runs in LISTENING and nowhere else. That is the
    whole point of splitting WAITING and SPEAKING out of what used to be one
    "awake" state: a turn that takes 30s to think and 20s to speak must not
    burn down the window the user is given to reply.
    """

    SLEEPING = auto()  # only the wake word model sees audio. No timer.
    LISTENING = auto()  # conversation open, user's move. Conversation timer runs.
    WAITING = auto()  # utterance sent, reply not started. Response timer runs.
    SPEAKING = auto()  # reply audio is playing. No timer; mic is dropped.


# Which timer each state arms. Keeping this next to the enum is what stops
# "is the timer running?" from becoming a question about scattered flags.
_TIMER: dict[ConversationState, Optional[str]] = {
    ConversationState.SLEEPING: None,
    ConversationState.LISTENING: "conversation",
    ConversationState.WAITING: "response",
    ConversationState.SPEAKING: None,
}


class ConversationGate:
    """The client's conversation state machine (see ConversationState).

    It owns one timer at a time, derived from the current state, and it is the
    only thing that decides when the client goes back to sleep. Audio I/O stays
    outside: callers feed it wake-word scores, VAD verdicts and protocol events
    and it calls back on the transitions that matter. That split is what makes
    it unit-testable without a mic, and it is where Smart Turn, barge-in and
    "thinking" sounds will attach — each is a rule about one of these states.

    Time comes from an injected `clock` and is only read when `tick()` is
    called, so nothing here depends on audio frames still flowing. The old
    timeout counted silence per VAD frame, which meant the clock silently
    froze whenever the mic was dropped.
    """

    def __init__(
        self,
        on_wake: Callable[[], Awaitable[None]],
        on_sleep: Callable[[], Awaitable[None]],
        on_response_timeout: Optional[Callable[[], Awaitable[None]]] = None,
        conversation_timeout_ms: float = CONVERSATION_TIMEOUT_MS,
        response_timeout_ms: float = RESPONSE_TIMEOUT_MS,
        wake_word_enabled: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._on_wake = on_wake
        self._on_sleep = on_sleep
        self._on_response_timeout = on_response_timeout
        self._conversation_timeout_ms = conversation_timeout_ms
        self._response_timeout_ms = response_timeout_ms
        # Without a wake word there is nothing to come back from, so SLEEPING
        # is unreachable: the client starts listening and stays that way, as it
        # behaved before wake word existed.
        self._wake_word_enabled = wake_word_enabled
        self._clock = clock

        self.state = ConversationState.SLEEPING if wake_word_enabled else ConversationState.LISTENING
        self._deadline: Optional[float] = None
        self._wake_run = 0  # consecutive frames >= threshold so far
        # Where to go when playback finishes. A reply can be spoken while
        # asleep (a typed message in conversation-less use), and that must not
        # leave the client awake.
        self._after_speaking = ConversationState.LISTENING
        self._arm_timer()

    # ---------- transitions ----------

    def _arm_timer(self) -> None:
        timer = _TIMER[self.state]
        if timer == "conversation" and self._wake_word_enabled:
            self._deadline = self._clock() + self._conversation_timeout_ms / 1000.0
        elif timer == "response":
            self._deadline = self._clock() + self._response_timeout_ms / 1000.0
        else:
            self._deadline = None

    def _enter(self, state: ConversationState, reason: str) -> None:
        previous = self.state
        self.state = state
        self._arm_timer()
        logger.debug("%s -> %s (%s)", previous.name, state.name, reason)

    async def handle_wake_frame(self, score: float, threshold: float) -> None:
        """Call once per wake word frame, in order, while SLEEPING."""
        if self.state is not ConversationState.SLEEPING:
            return
        if score < threshold:
            self._wake_run = 0
            return
        self._wake_run += 1
        if self._wake_run < WAKE_CONSECUTIVE_FRAMES:
            logger.debug("Wake frame %d/%d (score=%.3f)", self._wake_run, WAKE_CONSECUTIVE_FRAMES, score)
            return
        logger.info("Wake word detected (score=%.3f, %d consecutive frames)", score, self._wake_run)
        self._wake_run = 0
        self._enter(ConversationState.LISTENING, "wake word")
        await self._on_wake()

    async def note_vad_frame(self, is_speech: bool) -> None:
        """Call once per VAD frame while awake. Speech restarts the
        conversation timeout; silence needs no bookkeeping, since the deadline
        is wall-clock now."""
        if is_speech and self.state is ConversationState.LISTENING:
            self._arm_timer()

    async def note_utterance_sent(self) -> None:
        """The user's utterance has gone to the backend; a reply is owed.
        Stops the conversation timeout for however long the turn takes."""
        if self.state is ConversationState.SLEEPING:
            return  # e.g. a typed message with no conversation open
        if self.state is ConversationState.SPEAKING:
            # A barge-in (only reachable by typing or push-to-talk; the mic is
            # dropped during playback). Stay in SPEAKING so playback keeps the
            # mic dropped — the reply to it arrives with its own audioStart.
            return
        # Re-entering WAITING restarts the response timeout, which is right:
        # the newest utterance is the one awaiting a reply.
        self._enter(ConversationState.WAITING, "utterance sent")

    async def note_reply_audio_started(self) -> None:
        """First chunk of reply audio arrived."""
        if self.state is ConversationState.SPEAKING:
            return
        self._after_speaking = (
            ConversationState.SLEEPING
            if self.state is ConversationState.SLEEPING
            else ConversationState.LISTENING
        )
        self._enter(ConversationState.SPEAKING, "reply audio started")

    async def note_reply_finished(self) -> None:
        """The reply is over: audio has played out, or there was none to play.

        Idempotent, because it is driven by two independent signals — local
        playback completion and the backend's end-of-reply message — and
        either may arrive first depending on whether the reply had audio.
        """
        if self.state is ConversationState.SPEAKING:
            if self._after_speaking is ConversationState.SLEEPING:
                await self.sleep("reply finished while asleep")
            else:
                self._enter(ConversationState.LISTENING, "playback finished")
        elif self.state is ConversationState.WAITING:
            # A reply with no audio at all: text-only, empty, or an error.
            self._enter(ConversationState.LISTENING, "reply finished without audio")

    async def tick(self) -> None:
        """Call periodically. Fires whichever timeout the current state owns."""
        if self._deadline is None or self._clock() < self._deadline:
            return

        if self.state is ConversationState.LISTENING:
            logger.info("Conversation timed out after %.0fms idle", self._conversation_timeout_ms)
            await self.sleep("conversation timeout")
        elif self.state is ConversationState.WAITING:
            logger.warning(
                "No reply within %.0fms — giving up on this turn and going back to sleep",
                self._response_timeout_ms,
            )
            if self._on_response_timeout is not None:
                await self._on_response_timeout()
            await self.sleep("response timeout")

    async def sleep(self, reason: str = "dismissed") -> None:
        """Close the conversation: wake phrase required again. No-op if already
        asleep, or if there is no wake word to come back from."""
        if self.state is ConversationState.SLEEPING:
            return
        if not self._wake_word_enabled:
            self._enter(ConversationState.LISTENING, f"{reason} (no wake word: staying awake)")
            return
        self._wake_run = 0
        self._enter(ConversationState.SLEEPING, reason)
        await self._on_sleep()
