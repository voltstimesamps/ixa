"""Unit tests for the client's confirmation router.

Run from clients/desktop:   python -m unittest -v test_confirmation

Stdlib unittest and a fake clock only — no microphone, no backend, no event
loop. The router reads time solely through its injected clock and performs no
I/O, which is the whole reason the confirmation path can be tested at all: the
code this replaces was a blocking input() buried in a WebSocket receiver.
"""

import unittest

from confirmation import (
    AlreadyExpired,
    Chat,
    ConfirmationRouter,
    Expired,
    Reply,
    Reprompt,
    Warning_,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RouterTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.router = ConfirmationRouter(clock=self.clock)

    def openPrompt(self, timeout_ms: float | None = None, request_id: str = "req-1") -> str:
        return self.router.prompt(request_id, "Run shell_write: rm -rf build", timeout_ms)


class Prompting(RouterTestCase):
    def test_prompt_returns_text_and_opens_a_window(self) -> None:
        text = self.openPrompt(60_000)

        self.assertIn("Run shell_write", text)
        self.assertIn("yes or no", text)
        self.assertTrue(self.router.pending)
        self.assertEqual(self.router.request_id, "req-1")

    def test_the_local_deadline_sits_inside_the_backends(self) -> None:
        # One second early, so the "no" it sends lands while the request is
        # still answerable rather than racing the backend's own timer.
        self.openPrompt(60_000)
        self.assertAlmostEqual(self.router.remaining_s(), 59.0, places=3)
        self.assertIn("59s", self.openPrompt(60_000, "req-2"))

    def test_the_time_left_is_shown_in_the_prompt(self) -> None:
        self.assertIn("within 59s", self.openPrompt(60_000))

    def test_a_missing_timeout_falls_back_to_the_default(self) -> None:
        # An older backend does not send timeoutMs. The field is optional and
        # the client must still show a deadline.
        self.openPrompt(None)
        self.assertAlmostEqual(self.router.remaining_s(), 59.0, places=3)

    def test_a_tiny_timeout_never_goes_negative(self) -> None:
        self.openPrompt(400)
        self.assertGreater(self.router.remaining_s(), 0.0)
        self.assertAlmostEqual(self.router.remaining_s(), 0.2, places=3)

    def test_nothing_is_pending_before_a_prompt(self) -> None:
        self.assertFalse(self.router.pending)
        self.assertIsNone(self.router.remaining_s())
        self.assertIsNone(self.router.tick())


class ProtocolContract(RouterTestCase):
    def test_a_real_backend_confirm_message_drives_the_prompt(self) -> None:
        # The exact shape src/core/confirmation.ts sends:
        #   send({ type: "confirm", content: description, requestId, timeoutMs })
        # Field names are the contract; this fails if either side renames one.
        msg = {
            "type": "confirm",
            "content": "Run shell_write: git push",
            "requestId": "8f14e45f-ea8f-4b4c-9b3a-000000000000",
            "timeoutMs": 60000,
        }
        text = self.router.prompt(
            msg.get("requestId", ""), msg.get("content", "(no description)"), msg.get("timeoutMs")
        )

        self.assertIn("git push", text)
        self.assertEqual(self.router.request_id, msg["requestId"])

        reply = self.router.line("yes")
        self.assertEqual(reply.request_id, msg["requestId"])
        self.assertEqual(reply.content, "yes")

    def test_an_older_backend_without_timeoutms_still_works(self) -> None:
        msg = {"type": "confirm", "content": "Run shell_write: git push", "requestId": "r"}
        text = self.router.prompt(
            msg.get("requestId", ""), msg.get("content", "(no description)"), msg.get("timeoutMs")
        )
        self.assertIn("within 59s", text, "the client's own default fills in")


class Answering(RouterTestCase):
    def test_yes_and_no_in_every_spelling(self) -> None:
        for text, expected in [
            ("yes", "yes"),
            ("YES", "yes"),
            ("  y  ", "yes"),
            ("no", "no"),
            ("N", "no"),
        ]:
            with self.subTest(text=text):
                router = ConfirmationRouter(clock=self.clock)
                router.prompt("req-x", "do it", 60_000)
                result = router.line(text)
                self.assertIsInstance(result, Reply)
                self.assertEqual(result.request_id, "req-x")
                self.assertEqual(result.content, expected)
                self.assertFalse(router.pending, "answering closes the prompt")

    def test_an_answer_is_never_sent_as_conversation(self) -> None:
        # The bug this file exists for: with two stdin readers, the typed "yes"
        # could leave as {"type":"user","content":"yes"} and start a turn.
        self.openPrompt(60_000)
        for text in ["yes", "no", "something else entirely", ""]:
            with self.subTest(text=text):
                router = ConfirmationRouter(clock=self.clock)
                router.prompt("req-y", "do it", 60_000)
                self.assertNotIsInstance(router.line(text), Chat)

    def test_a_non_answer_reprompts_and_keeps_the_window_open(self) -> None:
        self.openPrompt(60_000)
        result = self.router.line("what exactly are you asking")

        self.assertIsInstance(result, Reprompt)
        self.assertIn("yes or no", result.message)
        self.assertIn("59s", result.message, "with the time left, so the user can judge")
        self.assertTrue(self.router.pending)

    def test_a_bare_enter_shows_the_time_left(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(20)
        result = self.router.line("")

        self.assertIsInstance(result, Reprompt)
        self.assertIn("39s left", result.message)
        self.assertTrue(self.router.pending, "and does not answer anything")

    def test_with_nothing_pending_a_line_is_a_message(self) -> None:
        result = self.router.line("what time is it")
        self.assertIsInstance(result, Chat)
        self.assertEqual(result.text, "what time is it")

    def test_an_empty_line_with_nothing_pending_is_an_empty_message(self) -> None:
        # The caller drops these, as it always did.
        result = self.router.line("   ")
        self.assertIsInstance(result, Chat)
        self.assertEqual(result.text, "")


class Expiring(RouterTestCase):
    def test_nothing_fires_before_the_deadline(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(5)
        self.assertIsNone(self.router.tick())

    def test_one_warning_then_silence(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(50)  # 9s left of the local 59

        first = self.router.tick()
        self.assertIsInstance(first, Warning_)
        self.assertIn("9s left", first.message)
        self.assertIsNone(self.router.tick(), "a warning is said once, not every 100ms")

    def test_expiry_answers_no_and_says_so(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(59)

        result = self.router.tick()
        self.assertIsInstance(result, Expired)
        self.assertEqual(result.reply, Reply("req-1", "no"))
        self.assertIn("expired", result.message)
        self.assertIn("Nothing was executed", result.message)
        self.assertFalse(self.router.pending)
        self.assertIsNone(self.router.tick(), "and it expires once")

    def test_an_answer_after_expiry_is_explained_not_swallowed(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(59)
        self.router.tick()

        result = self.router.line("yes")
        self.assertIsInstance(result, AlreadyExpired)
        self.assertIn("already expired", result.message)

    def test_a_yes_long_afterwards_is_just_conversation(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(59)
        self.router.tick()
        self.clock.advance(31)  # past the explain window

        result = self.router.line("yes")
        self.assertIsInstance(result, Chat)
        self.assertEqual(result.text, "yes")

    def test_a_warning_is_fresh_for_each_prompt(self) -> None:
        self.openPrompt(60_000)
        self.clock.advance(50)
        self.assertIsInstance(self.router.tick(), Warning_)
        self.router.line("no")

        self.openPrompt(60_000, "req-2")
        self.clock.advance(50)
        self.assertIsInstance(self.router.tick(), Warning_, "the new prompt warns too")


class Superseding(RouterTestCase):
    def test_a_second_prompt_replaces_the_first_and_says_so(self) -> None:
        # The backend's tool loop awaits each confirmation in turn, so this
        # should not happen. If it ever does, the user is told rather than
        # answering a question they can no longer see.
        self.openPrompt(60_000, "req-old")
        text = self.openPrompt(60_000, "req-new")

        self.assertIn("superseded", text)
        self.assertEqual(self.router.request_id, "req-new")

        result = self.router.line("yes")
        self.assertEqual(result.request_id, "req-new")


if __name__ == "__main__":
    unittest.main()
