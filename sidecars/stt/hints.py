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
# what the measurement measures is what the sidecar runs.

# Which hint mechanism to use. In faster-whisper 1.2.1 both land in the same
# decoder slot and compose, so "both" is a real option rather than a conflict:
# `hotwords` is tokenized and prepended to the prompt, and `initial_prompt`
# seeds the preceding-text tokens behind it. (`hotwords` is ignored only when
# `prefix` is set, which the sidecar never sets.)
HINT_MODES = ("off", "hotwords", "prompt", "both")


def parseHintWords(raw):
    """A comma- or newline-separated hint list into a list of words."""
    if not raw:
        return []
    words = []
    for piece in raw.replace("\n", ",").split(","):
        word = piece.strip()
        if word and word not in words:
            words.append(word)
    return words


def buildHotwords(words):
    """The `hotwords` argument: just the vocabulary, comma separated.

    Kept short deliberately. faster-whisper truncates the hint tokens at half
    the model's context and anything in this slot competes with the audio for
    the decoder's attention, so a long list makes every word in it weaker.
    """
    return ", ".join(words) if words else None


def buildInitialPrompt(words):
    """The `initial_prompt` argument: the vocabulary as a sentence.

    `initial_prompt` is interpreted as *preceding transcript text*, so it works
    best when it reads like something that was actually said rather than as a
    bare list — the decoder is being told "this is the kind of sentence you are
    continuing".
    """
    if not words:
        return None
    return f"The conversation may mention {', '.join(words)}."


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


def segmentRejection(segment, maxNoSpeechProb, minAvgLogprob):
    """Why this segment should be dropped, or None to keep it.

    Two independent signals, because they catch different things:

      no_speech_prob — the model's own estimate that the window held no
        speech at all. High on room tone, a door, a cough. This is the one
        that catches an invented sentence over silence.
      avg_logprob — how confident the decoder was in the tokens it chose.
        Low when it was guessing at something it could hear but not resolve.

    Thresholds are passed in, never read from the environment here, so the
    measurement script can sweep them without touching the sidecar's config.

    The returned string is a log line, not an error: a dropped segment is an
    ordinary event and the caller logs it and carries on.
    """
    noSpeech = getattr(segment, "no_speech_prob", None)
    if noSpeech is not None and maxNoSpeechProb is not None and noSpeech > maxNoSpeechProb:
        return f"no_speech_prob {noSpeech:.2f} > {maxNoSpeechProb:.2f}"

    avgLogprob = getattr(segment, "avg_logprob", None)
    if avgLogprob is not None and minAvgLogprob is not None and avgLogprob < minAvgLogprob:
        return f"avg_logprob {avgLogprob:.2f} < {minAvgLogprob:.2f}"

    return None
