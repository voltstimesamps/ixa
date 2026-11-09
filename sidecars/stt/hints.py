# sidecars/stt/hints.py
#
# Vocabulary hints and segment filtering for the STT sidecar.
#
# Both exist because of specific live mishearings, not as general tuning:
#
#   "Is the RTX 3090 still worth buying?"  ->  "... a used $30.90 ..."
#   "Hey Ixa, what did I just ask?"        ->  "I better not just ask you."
#
# base.en has never seen "Ixa", "Qdrant" or "Kokoro", and the words it does
# know it can mangle into a number that reads as a price. The hints bias the
# decoder towards the vocabulary this assistant actually uses.
#
# Segment filtering is a different problem with the same cost. Whisper invents
# words over noise: a live session persisted "Please the President." and "Here
# is the president." as user turns, neither of which was said. faster-whisper
# scores every segment it emits, and those scores are what separate an
# invented segment from a real one.
#
# This module is imported by main.py AND by dev/scripts/stt-vocab-check.py, so
# what the measurement measures is what the sidecar runs. The word list itself
# lives in hint-words.txt beside this file, for the same reason.
import os

# Which hint mechanism to use. In faster-whisper 1.2.1 both land in the same
# decoder slot and compose, so "both" is a real option rather than a conflict:
# `hotwords` is tokenized and prepended to the prompt, and `initial_prompt`
# seeds the preceding-text tokens behind it. (`hotwords` is ignored only when
# `prefix` is set, which the sidecar never sets.)
HINT_MODES = ("off", "hotwords", "prompt", "both")


def parseHintWords(raw):
    """A comma- or newline-separated hint list into a list of words.

    Lines starting with # are dropped, so the shared hint-words.txt can carry
    the reasoning for each entry next to the entry.
    """
    if not raw:
        return []
    words = []
    for line in raw.split("\n"):
        if line.lstrip().startswith("#"):
            continue
        for piece in line.split(","):
            word = piece.strip()
            if word and word not in words:
                words.append(word)
    return words


# The shared word list. ONE FILE, TWO READERS: src/config.ts reads it for the
# STT_HOTWORDS default and dev/scripts/stt-vocab-check.py reads it through
# here, so the measurement cannot be measuring a different vocabulary from the
# one the sidecar runs. It used to be a literal in config.ts with a second copy
# in the script's env default.
HINT_WORDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hint-words.txt")


def defaultHintWords(path=None):
    """The hint list from hint-words.txt, or [] if it is not readable."""
    try:
        with open(path or HINT_WORDS_FILE, encoding="utf-8") as handle:
            return parseHintWords(handle.read())
    except OSError:
        return []


def buildHotwords(words):
    """The `hotwords` argument: just the vocabulary, comma separated.

    Kept short deliberately. faster-whisper truncates the hint tokens at half
    the model's context and anything in this slot competes with the audio for
    the decoder's attention, so a long list makes every word in it weaker.
    """
    return ", ".join(words) if words else None


# The sentence the hint list is wrapped in. A constant because the segment
# filter below has to recognise it when Whisper reads it back out: the two must
# not drift apart.
HINT_FRAME = "The conversation may mention"


def buildInitialPrompt(words):
    """The `initial_prompt` argument: the vocabulary as a sentence.

    `initial_prompt` is interpreted as *preceding transcript text*, so it works
    best when it reads like something that was actually said rather than as a
    bare list — the decoder is being told "this is the kind of sentence you are
    continuing".
    """
    if not words:
        return None
    return f"{HINT_FRAME} {', '.join(words)}."


def hintArgs(mode, words):
    """The transcribe() keyword arguments for one hint mode."""
    if mode not in HINT_MODES:
        raise ValueError(f"unknown hint mode {mode!r}; expected one of {HINT_MODES}")
    args = {}
    if mode in ("hotwords", "both"):
        args["hotwords"] = buildHotwords(words)
    if mode in ("prompt", "both"):
        args["initial_prompt"] = buildInitialPrompt(words)
    return args


# A segment is dropped for no_speech_prob only when the decoder was ALSO unsure
# of what it wrote, i.e. its avg_logprob is below this. Chosen from the gap
# the measurement found (dev/scripts/stt-tail-check.py): every segment Whisper
# emitted over room tone with no_speech_prob > 0.6 scored between -0.69 and
# -0.95, and every window of real speech scored between -0.06 and -0.38.
# -0.55 sits in the middle of that gap. faster-whisper itself applies the same
# AND (no_speech_prob > 0.6 and avg_logprob < -1.0, its own thresholds), so
# anything that reaches this filter with a high no_speech_prob already got past
# the library's check; this is a tighter second opinion, not the only one.
# None restores the old behaviour, where no_speech_prob alone dropped it.
NO_SPEECH_CONFIRM_LOGPROB = -0.55


def isHintEcho(text):
    """True if Whisper read the hint prompt back out as if it were speech.

    Over loud non-speech the decoder continues the prompt it was given, and
    the prompt is the most predictable text in the window, so the echo scores
    a CONFIDENT avg_logprob — which is exactly why a threshold on confidence
    cannot be what catches it. Measured: 12 of 70 hinted noise clips came back
    as "The conversation may mention Ixa, RTX 3090." The framing phrase is the
    tell: nobody says it to a voice assistant, while a bare "RTX 3090" is a
    legitimate thing to say, so the vocabulary alone is never grounds.
    """
    flat = " ".join("".join(c if c.isalnum() else " " for c in text.lower()).split())
    return flat.startswith(HINT_FRAME.lower())


def segmentRejection(segment, maxNoSpeechProb, minAvgLogprob, confirmLogprob=NO_SPEECH_CONFIRM_LOGPROB):
    """Why this segment should be dropped, or None to keep it.

    Three signals, because they catch different things:

      hint echo — the segment is the hint prompt read back. Dropped on the
        text itself, whatever the scores say (see isHintEcho).
      no_speech_prob — the model's own estimate that the window held no
        speech at all. High on room tone, a door, a cough. It is NOT enough
        alone: both numbers below are per DECODE WINDOW, not per segment, so a
        window that starts mid-sentence (the second window of an utterance
        past ~29 seconds is one) scores a high no_speech_prob over perfectly
        good words. A live utterance lost its last clause this way, so a high
        no_speech_prob drops a segment only if avg_logprob is also below
        confirmLogprob. Pass confirmLogprob=None for the old rule.
      avg_logprob — how confident the decoder was in the tokens it chose.
        Low when it was guessing at something it could hear but not resolve.
        On its own against minAvgLogprob it still drops.

    Thresholds are passed in, never read from the environment here, so the
    measurement script can sweep them without touching the sidecar's config.

    The returned string is a log line, not an error: a dropped segment is an
    ordinary event and the caller logs it and carries on.
    """
    if isHintEcho(getattr(segment, "text", "") or ""):
        return "hint-prompt echo"

    noSpeech = getattr(segment, "no_speech_prob", None)
    avgLogprob = getattr(segment, "avg_logprob", None)

    if noSpeech is not None and maxNoSpeechProb is not None and noSpeech > maxNoSpeechProb:
        corroborated = (
            confirmLogprob is None or avgLogprob is None or avgLogprob < confirmLogprob
        )
        if corroborated:
            return f"no_speech_prob {noSpeech:.2f} > {maxNoSpeechProb:.2f}"

    if avgLogprob is not None and minAvgLogprob is not None and avgLogprob < minAvgLogprob:
        return f"avg_logprob {avgLogprob:.2f} < {minAvgLogprob:.2f}"

    return None


def describeSegment(segment):
    """Where a segment came from and what it scored, for the log.

    no_speech_prob and avg_logprob are properties of the decode WINDOW, shared
    by every segment in it, so the window start (`seek` is in 10ms frames) is
    what says whether two segments were judged together or apart.
    """
    start = getattr(segment, "start", None)
    end = getattr(segment, "end", None)
    seek = getattr(segment, "seek", None)
    parts = []
    if start is not None and end is not None:
        parts.append(f"{start:.1f}-{end:.1f}s ({end - start:.1f}s long)")
    if seek is not None:
        parts.append(f"window from {seek / 100:.1f}s")
    for label, name in (("no_speech_prob", "no_speech_prob"), ("avg_logprob", "avg_logprob")):
        value = getattr(segment, name, None)
        if value is not None:
            parts.append(f"{label} {value:.2f}")
    return ", ".join(parts)
