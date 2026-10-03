"""Unit tests for the client's conversation state machine.

Run from clients/desktop:   python -m unittest -v test_conversation

Stdlib unittest and a fake clock only — no audio devices, no models, no new
dependencies. ConversationGate reads time solely through its injected clock
and only when tick() is called, so a whole conversation's worth of timing can
be driven deterministically from here.
"""

import unittest

from conversation import ConversationGate, ConversationState


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class GateTestCase(unittest.IsolatedAsyncioTestCase):
    CONVERSATION_MS = 20_000.0
    RESPONSE_MS = 90_000.0

    def setUp(self) -> None:
        self.clock = FakeClock()
        self.wakes = 0
        self.sleeps = 0
        self.response_timeouts = 0

    def makeGate(self, wake_word_enabled: bool = True) -> ConversationGate:
        async def on_wake() -> None:
            self.wakes += 1

        async def on_sleep() -> None:
            self.sleeps += 1

        async def on_response_timeout() -> None:
            self.response_timeouts += 1

        return ConversationGate(
            on_wake,
            on_sleep,
            on_response_timeout=on_response_timeout,
            conversation_timeout_ms=self.CONVERSATION_MS,
            response_timeout_ms=self.RESPONSE_MS,
            wake_word_enabled=wake_word_enabled,
            clock=self.clock,
        )

    async def wake(self, gate: ConversationGate) -> None:
        """Two consecutive over-threshold frames, as WAKE_CONSECUTIVE_FRAMES
        requires."""
        await gate.handle_wake_frame(0.9, 0.5)
        await gate.handle_wake_frame(0.9, 0.5)
        self.assertIs(gate.state, ConversationState.LISTENING)

    async def advance(self, gate: ConversationGate, seconds: float) -> None:
        self.clock.advance(seconds)
        await gate.tick()


class TestWakeAndSleep(GateTestCase):
    async def test_starts_asleep_with_no_timer(self) -> None:
        gate = self.makeGate()
        self.assertIs(gate.state, ConversationState.SLEEPING)
        await self.advance(gate, 10_000)
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.sleeps, 0)

    async def test_wake_needs_two_consecutive_frames(self) -> None:
        gate = self.makeGate()
        await gate.handle_wake_frame(0.9, 0.5)
        self.assertIs(gate.state, ConversationState.SLEEPING)
        await gate.handle_wake_frame(0.1, 0.5)  # run broken
        await gate.handle_wake_frame(0.9, 0.5)
        self.assertIs(gate.state, ConversationState.SLEEPING)
        await gate.handle_wake_frame(0.9, 0.5)
        self.assertIs(gate.state, ConversationState.LISTENING)
        self.assertEqual(self.wakes, 1)

    async def test_idle_in_listening_sleeps(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await self.advance(gate, 19.9)
        self.assertIs(gate.state, ConversationState.LISTENING)
        await self.advance(gate, 0.2)
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.sleeps, 1)

    async def test_speech_restarts_the_conversation_timeout(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await self.advance(gate, 19.0)
        await gate.note_vad_frame(True)
        await self.advance(gate, 19.0)
        self.assertIs(gate.state, ConversationState.LISTENING)
        await self.advance(gate, 1.5)
        self.assertIs(gate.state, ConversationState.SLEEPING)

    async def test_dismiss_sleeps_from_listening(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.sleep("dismiss phrase")
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.sleeps, 1)
        await gate.sleep("dismiss phrase")  # idempotent
        self.assertEqual(self.sleeps, 1)


class TestTimerPausedDuringTurn(GateTestCase):
    async def test_conversation_timeout_does_not_run_while_waiting(self) -> None:
        """The reported bug: a long tool-using turn used to put the client back
        to sleep before its own reply arrived."""
        gate = self.makeGate()
        await self.wake(gate)
        await self.advance(gate, 15.0)  # user thought for a while, then spoke
        await gate.note_utterance_sent()
        self.assertIs(gate.state, ConversationState.WAITING)

        await self.advance(gate, 60.0)  # 60s of tool calls: well past 20s
        self.assertIs(gate.state, ConversationState.WAITING)
        self.assertEqual(self.sleeps, 0)

    async def test_conversation_timeout_does_not_run_while_speaking(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await gate.note_reply_audio_started()
        self.assertIs(gate.state, ConversationState.SPEAKING)

        await self.advance(gate, 300.0)  # a very long spoken reply
        self.assertIs(gate.state, ConversationState.SPEAKING)
        self.assertEqual(self.sleeps, 0)

    async def test_timer_restarts_only_once_playback_finishes(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await gate.note_reply_audio_started()
        await self.advance(gate, 300.0)

        await gate.note_reply_finished()
        self.assertIs(gate.state, ConversationState.LISTENING)

        # A full fresh window, counted from the end of playback.
        await self.advance(gate, 19.9)
        self.assertIs(gate.state, ConversationState.LISTENING)
        self.assertEqual(self.sleeps, 0)
        await self.advance(gate, 0.2)
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.sleeps, 1)

    async def test_reply_finished_is_idempotent(self) -> None:
        """audioOutputEnd and replyEnd both land for a spoken reply."""
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await gate.note_reply_audio_started()
        await gate.note_reply_finished()
        await self.advance(gate, 10.0)
        await gate.note_reply_finished()  # second signal must not re-arm
        self.assertIs(gate.state, ConversationState.LISTENING)
        await self.advance(gate, 10.1)
        self.assertIs(gate.state, ConversationState.SLEEPING)

    async def test_a_second_utterance_restarts_the_response_timeout(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await self.advance(gate, 80.0)
        await gate.note_utterance_sent()
        await self.advance(gate, 80.0)
        self.assertIs(gate.state, ConversationState.WAITING)
        await self.advance(gate, 11.0)
        self.assertIs(gate.state, ConversationState.SLEEPING)


class TestNoAudioReply(GateTestCase):
    async def test_reply_without_audio_returns_to_listening(self) -> None:
        """Text-only, empty or failed replies produce no audio at all, so only
        the end-of-reply signal can close the turn."""
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await self.advance(gate, 5.0)

        await gate.note_reply_finished()
        self.assertIs(gate.state, ConversationState.LISTENING)
        self.assertEqual(self.sleeps, 0)

        await self.advance(gate, 19.9)
        self.assertIs(gate.state, ConversationState.LISTENING)
        await self.advance(gate, 0.2)
        self.assertIs(gate.state, ConversationState.SLEEPING)

    async def test_reply_finished_while_listening_is_ignored(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await self.advance(gate, 15.0)
        await gate.note_reply_finished()  # stray: no turn was open
        self.assertIs(gate.state, ConversationState.LISTENING)
        # The existing window is untouched, not extended.
        await self.advance(gate, 5.1)
        self.assertIs(gate.state, ConversationState.SLEEPING)

    async def test_reply_finished_while_asleep_is_ignored(self) -> None:
        gate = self.makeGate()
        await gate.note_reply_finished()
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.wakes, 0)


class TestResponseTimeout(GateTestCase):
    async def test_response_timeout_gives_feedback_and_sleeps(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()

        await self.advance(gate, 89.9)
        self.assertIs(gate.state, ConversationState.WAITING)
        self.assertEqual(self.response_timeouts, 0)

        await self.advance(gate, 0.2)
        self.assertEqual(self.response_timeouts, 1)
        self.assertEqual(self.sleeps, 1)
        self.assertIs(gate.state, ConversationState.SLEEPING)

    async def test_response_timeout_is_cancelled_by_reply_audio(self) -> None:
        gate = self.makeGate()
        await self.wake(gate)
        await gate.note_utterance_sent()
        await self.advance(gate, 89.0)
        await gate.note_reply_audio_started()

        await self.advance(gate, 600.0)
        self.assertIs(gate.state, ConversationState.SPEAKING)
        self.assertEqual(self.response_timeouts, 0)


class TestSpokenReplyWhileAsleep(GateTestCase):
    async def test_playback_while_asleep_returns_to_sleeping(self) -> None:
        """A typed message's reply can be spoken with no conversation open.
        The mic is still dropped during playback, but it must not leave the
        client listening afterwards."""
        gate = self.makeGate()
        await gate.note_utterance_sent()
        self.assertIs(gate.state, ConversationState.SLEEPING)

        await gate.note_reply_audio_started()
        self.assertIs(gate.state, ConversationState.SPEAKING)

        await gate.note_reply_finished()
        self.assertIs(gate.state, ConversationState.SLEEPING)
        self.assertEqual(self.sleeps, 1)  # resets the wake model
        self.assertEqual(self.wakes, 0)


class TestWakeWordDisabled(GateTestCase):
    async def test_starts_listening_and_never_sleeps(self) -> None:
        """IXA_SKIP_WAKE_WORD / push-to-talk: there is no phrase to come back
        from, so the conversation timeout is off."""
        gate = self.makeGate(wake_word_enabled=False)
        self.assertIs(gate.state, ConversationState.LISTENING)

        await self.advance(gate, 10_000.0)
        self.assertIs(gate.state, ConversationState.LISTENING)
        self.assertEqual(self.sleeps, 0)

        await gate.sleep("dismiss phrase")
        self.assertIs(gate.state, ConversationState.LISTENING)
        self.assertEqual(self.sleeps, 0)

    async def test_response_timeout_still_closes_the_turn(self) -> None:
        gate = self.makeGate(wake_word_enabled=False)
        await gate.note_utterance_sent()
        self.assertIs(gate.state, ConversationState.WAITING)
        await self.advance(gate, 90.1)
        self.assertEqual(self.response_timeouts, 1)
        self.assertIs(gate.state, ConversationState.LISTENING)


if __name__ == "__main__":
    unittest.main()
