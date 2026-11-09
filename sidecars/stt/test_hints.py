"""Unit tests for the STT segment filter.

Run from sidecars/stt:   venv/bin/python -m unittest -v test_hints

Stdlib unittest and plain objects standing in for faster-whisper segments — no
model, no audio. The numbers below are not invented: they are what
dev/scripts/stt-tail-check.py measured (see ARCHITECTURE.md, "STT segment
filtering"), and each test says which measurement it pins.
"""

import unittest
from types import SimpleNamespace

from hints import (
    HINT_FRAME,
    NO_SPEECH_CONFIRM_LOGPROB,
    buildInitialPrompt,
    defaultHintWords,
    describeSegment,
    isHintEcho,
    segmentRejection,
)

MAX_NO_SPEECH = 0.6
MIN_LOGPROB = -1.0


def segment(text="hello", noSpeech=0.0, logprob=-0.2, **extra):
    return SimpleNamespace(text=text, no_speech_prob=noSpeech, avg_logprob=logprob, **extra)


def reject(seg, **kwargs):
    return segmentRejection(seg, MAX_NO_SPEECH, MIN_LOGPROB, **kwargs)


class HighNoSpeechNeedsCorroboration(unittest.TestCase):
    def test_confident_speech_in_a_high_no_speech_window_is_kept(self):
        # The live failure: the tail of a long utterance, its own decode
        # window, no_speech_prob 0.90. Real speech windows measured
        # avg_logprob -0.06 .. -0.38.
        self.assertIsNone(reject(segment("be around $300, but I am not sure yet.", 0.90, -0.30)))

    def test_the_old_rule_would_have_dropped_it(self):
        # Pins what changed: confirmLogprob=None is the pre-fix behaviour.
        reason = reject(segment("be around $300, but I am not sure yet.", 0.90, -0.30), confirmLogprob=None)
        self.assertIn("no_speech_prob 0.90", reason)

    def test_zero_restores_the_old_rule(self):
        # What IXA_STT_NO_SPEECH_CONFIRM_LOGPROB=0 means.
        self.assertIsNotNone(reject(segment("be around $300", 0.90, -0.30), confirmLogprob=0.0))

    def test_unconfident_text_in_a_high_no_speech_window_is_dropped(self):
        # Hallucinations over room tone measured nsp 0.74..0.91, lp -0.72..-0.95.
        for text, noSpeech, logprob in [("You", 0.77, -0.84), ("Okay.", 0.74, -0.95), ("Okay.", 0.79, -0.87)]:
            with self.subTest(text=text):
                self.assertIn("no_speech_prob", reject(segment(text, noSpeech, logprob)))

    def test_the_threshold_sits_between_the_two_measured_populations(self):
        # Hallucinations topped out at -0.69, real speech windows bottomed
        # out at -0.38.
        self.assertGreater(NO_SPEECH_CONFIRM_LOGPROB, -0.69)
        self.assertLess(NO_SPEECH_CONFIRM_LOGPROB, -0.38)

    def test_boundary_is_exclusive_on_the_confident_side(self):
        self.assertIsNone(reject(segment("x", 0.9, NO_SPEECH_CONFIRM_LOGPROB)))
        self.assertIsNotNone(reject(segment("x", 0.9, NO_SPEECH_CONFIRM_LOGPROB - 0.01)))

    def test_missing_logprob_still_drops_on_no_speech(self):
        # Nothing to corroborate with means nothing to be lenient on.
        self.assertIsNotNone(reject(SimpleNamespace(text="x", no_speech_prob=0.9)))


class UnchangedBehaviour(unittest.TestCase):
    def test_low_logprob_alone_still_drops(self):
        self.assertIn("avg_logprob", reject(segment("mumble", 0.1, -1.4)))

    def test_ordinary_speech_is_kept(self):
        self.assertIsNone(reject(segment("Yes.", 0.05, -0.15)))

    def test_short_confirmations_survive_a_middling_no_speech_prob(self):
        # The confirmation gate: a 250ms "yes" must never be filtered away.
        self.assertIsNone(reject(segment("Yes.", 0.55, -0.9)))

    def test_thresholds_of_none_disable_each_check(self):
        self.assertIsNone(segmentRejection(segment("x", 0.99, -3.0), None, None))


class HintEcho(unittest.TestCase):
    LIVE = "The conversation may mention Ixa, RTX 3090, RTX 3090."

    def test_the_live_echo_is_dropped_even_at_confident_scores(self):
        # Echoes measured lp -0.72..-0.91, but the echo is the most predictable
        # text in the window, so confidence can't be what catches it.
        for noSpeech, logprob in [(0.85, -0.80), (0.2, -0.1), (0.0, -0.05)]:
            with self.subTest(noSpeech=noSpeech, logprob=logprob):
                self.assertEqual(reject(segment(self.LIVE, noSpeech, logprob)), "hint-prompt echo")

    def test_measured_variants(self):
        for text in [
            "The conversation may mention Ixa, RTX 3090.",
            "The conversation may mention Ixa, RTX 5090, RTX 5090.",
            "The conversation may mention Ixa, RTX 3090. The conversation may mention Ixa, RTX 3090.",
            "  the conversation may mention ixa  ",
            "THE CONVERSATION MAY MENTION IXA",
        ]:
            with self.subTest(text=text):
                self.assertTrue(isHintEcho(text))

    def test_vocabulary_alone_is_never_an_echo(self):
        # "RTX 3090" and "Ixa" are exactly what the user is likely to say.
        for text in ["RTX 3090.", "Ixa, what time is it?", "Is Qdrant up?", "Ollama, Groq, Kokoro"]:
            with self.subTest(text=text):
                self.assertFalse(isHintEcho(text))
                self.assertIsNone(reject(segment(text)))

    def test_ordinary_use_of_the_words_is_not_an_echo(self):
        self.assertFalse(isHintEcho("The conversation was long."))
        self.assertFalse(isHintEcho("Did the conversation mention Ixa?"))

    def test_the_prompt_the_sidecar_sends_is_recognised(self):
        # If buildInitialPrompt's wording changes, the filter must follow.
        prompt = buildInitialPrompt(defaultHintWords() or ["Ixa", "RTX 3090"])
        self.assertTrue(prompt.startswith(HINT_FRAME))
        self.assertTrue(isHintEcho(prompt))

    def test_empty_and_missing_text(self):
        self.assertFalse(isHintEcho(""))
        self.assertIsNone(reject(SimpleNamespace(no_speech_prob=0.0, avg_logprob=-0.1)))


class Describe(unittest.TestCase):
    def test_reports_window_timing_and_scores(self):
        text = describeSegment(segment(noSpeech=0.9, logprob=-0.3, start=29.2, end=33.0, seek=2920))
        self.assertIn("29.2-33.0s (3.8s long)", text)
        self.assertIn("window from 29.2s", text)
        self.assertIn("no_speech_prob 0.90", text)
        self.assertIn("avg_logprob -0.30", text)

    def test_tolerates_missing_fields(self):
        self.assertEqual(describeSegment(SimpleNamespace()), "")
        self.assertEqual(describeSegment(SimpleNamespace(avg_logprob=-0.5)), "avg_logprob -0.50")


if __name__ == "__main__":
    unittest.main()
