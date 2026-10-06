"""Unit tests for the VAD recorder's state machine.

Run from clients/desktop:   python -m unittest -v test_recorder

Stdlib unittest only — recorder.py imports nothing but logging, os, enum and
typing, so this needs no audio device, no model and no venv.
"""

import unittest

from recorder import FRAME_MS, TRAILING_SILENCE_MS, RecorderState, VoiceActivityRecorder

SPEECH = 0.9
SILENCE = 0.1
FRAME = b"\x00\x00" * 512


class RecorderTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.events: list[str] = []

        async def on_speech_start() -> None:
            self.events.append("start")

        async def on_frame(frame: bytes) -> None:
            self.events.append("frame")

        async def on_speech_end() -> None:
            self.events.append("end")

        self.recorder = VoiceActivityRecorder(on_speech_start, on_frame, on_speech_end)

    async def speak(self, frames: int = 3) -> None:
        for _ in range(frames):
            await self.recorder.handle_frame(FRAME, SPEECH)

    async def stay_quiet(self, frames: int) -> None:
        for _ in range(frames):
            await self.recorder.handle_frame(FRAME, SILENCE)

    # Frames of silence needed to cross the trailing-silence threshold.
    def silence_frames(self) -> int:
        return int(TRAILING_SILENCE_MS / FRAME_MS) + 1

    # ------------------------------------------------------- a normal turn

    async def test_a_normal_turn_is_unaffected(self) -> None:
        await self.speak()
        self.assertEqual(self.recorder.state, RecorderState.RECORDING)
        await self.stay_quiet(self.silence_frames())

        self.assertEqual(self.recorder.state, RecorderState.IDLE)
        self.assertEqual(self.events[0], "start")
        self.assertEqual(self.events[-1], "end", "the utterance was sent")
        self.assertEqual(self.events.count("start"), 1)
        self.assertEqual(self.events.count("end"), 1)

    async def test_a_second_turn_opens_cleanly_after_the_first(self) -> None:
        await self.speak()
        await self.stay_quiet(self.silence_frames())
        self.events.clear()

        await self.speak()
        await self.stay_quiet(self.silence_frames())

        self.assertEqual(self.events[0], "start", "the next turn sends its own audioStart")
        self.assertEqual(self.events[-1], "end")

    # ----------------------------------------------------------- abandoning
    #
    # The browser client has fixed this since src/api/test-client.ts gained
    # abandonTurn(); this is the same semantics on the desktop client. Without
    # it the recorder had no way out of RECORDING except trailing silence, and
    # the mic loop stops delivering frames the moment Ixa starts speaking — so
    # a user who talked over a reply left the recorder RECORDING for the whole
    # reply, and their next utterance was appended to the abandoned one.

    async def test_abandon_returns_to_idle_without_sending_the_audio(self) -> None:
        await self.speak()
        self.assertEqual(self.recorder.state, RecorderState.RECORDING)
        self.events.clear()

        self.recorder.abandon()

        self.assertEqual(self.recorder.state, RecorderState.IDLE)
        self.assertNotIn(
            "end",
            self.events,
            "no audioInputEnd: the backend drops the partial audio on the next audioStart",
        )

    async def test_the_utterance_after_an_abandon_starts_its_own_turn(self) -> None:
        # Spoken over the top of a reply, and abandoned when the reply started.
        await self.speak()
        self.recorder.abandon()
        self.events.clear()

        # What the user says once the reply has finished.
        await self.speak()
        await self.stay_quiet(self.silence_frames())

        self.assertEqual(
            self.events[0],
            "start",
            "a fresh audioStart, which is what makes the backend discard the fragment",
        )
        self.assertEqual(self.events[-1], "end")
        self.assertEqual(self.events.count("start"), 1)

    async def test_abandon_is_a_no_op_when_nothing_is_open(self) -> None:
        self.recorder.abandon()
        self.assertEqual(self.recorder.state, RecorderState.IDLE)
        self.assertEqual(self.events, [])

        # And the ordinary case still works after one.
        await self.speak()
        self.assertEqual(self.events.count("start"), 1)

    async def test_abandon_clears_the_silence_it_had_counted(self) -> None:
        await self.speak()
        # Partway to the trailing-silence threshold, but not across it.
        await self.stay_quiet(self.silence_frames() // 2)
        self.recorder.abandon()
        self.events.clear()

        # The next utterance gets the full pause budget, not the remainder.
        await self.speak()
        await self.stay_quiet(self.silence_frames() - 1)

        self.assertEqual(self.recorder.state, RecorderState.RECORDING)
        self.assertNotIn("end", self.events, "the next turn was not cut short early")


if __name__ == "__main__":
    unittest.main()
