"""Where a confirmation prompt and a typed line meet.

THE SENDER OWNS STDIN. Nothing else may read it.

This replaces a blocking `input()` that sat in the WebSocket receiver. That
call froze the single event loop for as long as the prompt was open, which
stopped: the receiver itself (so no audio, no `replyEnd`, no `error`), the
conversation ticker (so neither timeout could fire), the consumption of mic
frames (they piled up in a queue and were then fed stale to a stateful VAD and
wake model), playback completion, and the WebSocket library's own ping task.

It also read fd 0 while `sender()` was parked in `sys.stdin.readline` on a
worker thread — two readers of one file descriptor, racing for the line the
user typed, with the answer liable to be sent as a chat message instead.

So the receiver only *prints* now, and every line goes to `sender()`, which
asks this router what the line means. The router is pure: it reads the clock
only through the injected `clock`, performs no I/O, and returns a description
of what the caller should do. That is what lets the whole thing be tested
without a microphone, a backend or a terminal.
"""

from dataclasses import dataclass
from typing import Callable, Optional
import os
import time

# Fallback only. The backend sends the real deadline as `timeoutMs` on the
# `confirm` message; this is what to assume if an older backend does not.
CONFIRM_TIMEOUT_MS = float(os.environ.get("IXA_CONFIRM_TIMEOUT_MS", "60000"))

# The local prompt expires this much BEFORE the backend's own deadline, so the
# "no" it sends arrives while the request is still answerable. Without the
# margin the two timers fire together and the decline races the server's
# timeout — same outcome for the model either way, but the user would be told
# "expired" by a client that had just sent an answer into a closed request.
EXPIRY_MARGIN_MS = 1000.0

# One warning before the deadline, rather than a redrawn countdown: this client
# prints plain lines interleaved with log output, and a `\r` spinner would
# fight both. Press Enter at any time to see the time remaining.
WARN_AT_MS = 10000.0


@dataclass(frozen=True)
class Reply:
    """Send this as a `confirmReply` over the WebSocket."""

    request_id: str
    content: str  # "yes" or "no"


@dataclass(frozen=True)
class Chat:
    """Send this as a normal `user` turn — nothing was pending."""

    text: str


@dataclass(frozen=True)
class Reprompt:
    """Neither yes nor no, with a prompt still open. Print and keep waiting."""

    message: str


@dataclass(frozen=True)
class AlreadyExpired:
    """A yes/no typed just after the prompt expired. Say so rather than
    swallowing it — silence is what made the old 30-second server timeout so
    confusing."""

    message: str


@dataclass(frozen=True)
class Expired:
    """Produced by tick(): the local deadline passed. The reply is sent on the
    user's behalf, because an unanswered prompt is a no either way and saying
    so is better than letting the backend time out in silence."""

    reply: Reply
    message: str


@dataclass(frozen=True)
class Warning_:
    """Produced by tick() once, when the deadline is close."""

    message: str


LineResult = object  # Reply | Chat | Reprompt | AlreadyExpired
TickResult = object  # Expired | Warning_ | None

YES = ("yes", "y")
NO = ("no", "n")

# How long after an expiry a yes/no still gets "that already expired" rather
# than being treated as conversation. Long enough to cover a slow typist, short
# enough that an unrelated "yes" later in the conversation is not swallowed.
_EXPLAIN_WINDOW_S = 30.0


class ConfirmationRouter:
    """At most one prompt is open at a time.

    That is not a simplification: the backend's tool loop awaits each
    confirmation before moving to the next tool call, so one connection cannot
    be asked two questions at once. A second `confirm` arriving anyway
    supersedes the first and says so, rather than queueing answers the user
    cannot see.
    """

    def __init__(
        self,
        default_timeout_ms: float = CONFIRM_TIMEOUT_MS,
        margin_ms: float = EXPIRY_MARGIN_MS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._default_timeout_ms = default_timeout_ms
        self._margin_ms = margin_ms
        self._clock = clock
        self._request_id: Optional[str] = None
        self._expires_at: float = 0.0
        self._warned = False
        self._last_expired_at: Optional[float] = None

    # ----------------------------------------------------------- state

    @property
    def pending(self) -> bool:
        return self._request_id is not None

    @property
    def request_id(self) -> Optional[str]:
        return self._request_id

    def remaining_s(self) -> Optional[float]:
        if self._request_id is None:
            return None
        return max(0.0, self._expires_at - self._clock())

    # ---------------------------------------------------------- prompt

    def prompt(
        self,
        request_id: str,
        description: str,
        timeout_ms: Optional[float] = None,
    ) -> str:
        """Open a prompt. Returns the text to print — this never reads stdin."""
        superseded = self._request_id
        budget = timeout_ms if timeout_ms else self._default_timeout_ms
        # Never negative, however small a timeout the backend sends.
        local = max(budget - self._margin_ms, budget / 2.0)

        self._request_id = request_id
        self._expires_at = self._clock() + local / 1000.0
        self._warned = False

        lines = []
        if superseded is not None:
            lines.append(f"[previous confirmation {superseded[:8]} superseded]")
        lines.append(f"\nConfirm: {description}")
        lines.append(
            f"Type yes or no within {local / 1000.0:.0f}s "
            f"(Enter on its own shows the time left):"
        )
        return "\n".join(lines)

    # ------------------------------------------------------------ line

    def line(self, text: str) -> LineResult:
        """Interpret one line typed by the user."""
        stripped = text.strip()
        normalized = stripped.lower()

        if self._request_id is not None:
            if not stripped:
                return Reprompt(f"[{self.remaining_s():.0f}s left — type yes or no]")
            if normalized in YES or normalized in NO:
                request_id = self._request_id
                self._clear()
                return Reply(request_id, "yes" if normalized in YES else "no")
            return Reprompt(
                f"[please type yes or no — {self.remaining_s():.0f}s left]"
            )

        if not stripped:
            return Chat("")

        # Nothing pending. A bare yes/no just after an expiry is almost
        # certainly the answer to the prompt that just closed, so explain
        # instead of sending it as conversation. Outside that window a "yes" is
        # an ordinary thing to say to Ixa and goes through as one.
        if self._recently_expired() and (normalized in YES or normalized in NO):
            return AlreadyExpired(
                "[that request already expired — it was answered as no. "
                "Ask again if you still want it.]"
            )

        return Chat(stripped)

    # ------------------------------------------------------------ tick

    def tick(self) -> TickResult:
        """Called on the client's existing ticker. Returns an Expired (whose
        reply must be sent), a one-off Warning_, or None."""
        if self._request_id is None:
            return None

        remaining = self._expires_at - self._clock()
        if remaining <= 0:
            request_id = self._request_id
            self._clear()
            self._last_expired_at = self._clock()
            return Expired(
                Reply(request_id, "no"),
                "[confirmation expired — answered no. Nothing was executed.]",
            )

        if not self._warned and remaining * 1000.0 <= WARN_AT_MS:
            self._warned = True
            return Warning_(f"[{remaining:.0f}s left to answer the confirmation]")

        return None

    # --------------------------------------------------------- private

    def _clear(self) -> None:
        self._request_id = None
        self._expires_at = 0.0
        self._warned = False

    def _recently_expired(self) -> bool:
        if self._last_expired_at is None:
            return False
        return self._clock() - self._last_expired_at <= _EXPLAIN_WINDOW_S
