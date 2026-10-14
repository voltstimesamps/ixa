#!/usr/bin/env python3
"""Measures STT vocabulary hints and segment filtering, before and after.

Run with the STT sidecar's own venv — it needs faster-whisper and PyAV, and it
loads the model in-process rather than going through the sidecar so it can try
every hint mode against the same audio without restarting anything:

    sidecars/stt/venv/bin/python dev/scripts/stt-vocab-check.py

and the path matrix alone — model x hint list x mode, timed — with

    sidecars/stt/venv/bin/python dev/scripts/stt-vocab-check.py paths

The sidecar does not need to be running, and no backend is needed.

Two things are being measured, and they pull in opposite directions:

  1. Do the hints fix the domain words? The live failures were "RTX 3090"
     transcribed as "$30.90" and "Hey Ixa, what did I just ask?" as "I better
     not just ask you."
  2. Do they make hallucination worse? Whisper invents text over noise, and a
     vocabulary hint gives it more interesting things to invent — if "Ixa"
     starts appearing in silence, the hint list is a net loss.

So every config is run against three sets: the domain phrases, the noise
samples (which must stay empty), and SHORT real utterances. The short ones are
not optional. Confirmations are answered with "yes" and "no", and a
no_speech_prob threshold tight enough to kill hallucinations can also kill a
250ms "yes" — which would silently break the confirmation gate.

Real recordings are used when present under Ixa-Tests/stt/ (any format PyAV
can decode, named <slug>.<ext> matching a case's `slug`); anything missing is
synthesized with the Kokoro TTS sidecar if it is reachable, and skipped
otherwise. Synthesized audio is cleaner than a microphone, so it can show that
hints do not HURT and can show some wins, but a case that only fails on real
audio needs a real recording to prove fixed.
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import wave
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sidecars", "stt"))

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

from hints import HINT_MODES, defaultHintWords, hintArgs, parseHintWords, segmentRejection

repoRoot = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
samplesDir = os.path.join(repoRoot, "Ixa-Tests", "stt")
cacheDir = os.path.join(repoRoot, "Ixa-Tests", "stt", "synthesized")

modelName = os.environ.get("STT_MODEL", "base.en")
ttsUrl = os.environ.get("TTS_URL", "http://localhost:5001")
# The shipped list, from the file src/config.ts reads for the same purpose.
# There used to be a second copy of these twelve words right here, identical by
# hand, with nothing to say so if they drifted.
hintWords = (
    parseHintWords(os.environ["STT_HOTWORDS"])
    if "STT_HOTWORDS" in os.environ
    else defaultHintWords()
)

# expect: a substring the transcript must contain, case-insensitively.
# The two marked "live failure" are the exact phrases from the session log.
DOMAIN_CASES = [
    ("rtx-3090", "Is the RTX 3090 still worth buying?", "3090"),       # live failure: "$30.90"
    ("just-ask", "Hey Ixa, what did I just ask?", "ask"),              # live failure
    ("vram", "How much VRAM does that card have?", "vram"),
    ("groq", "Which Groq model are we running?", "groq"),
    ("kokoro", "Is Kokoro using all four threads?", "kokoro"),
    ("qdrant", "Is Qdrant still up?", "qdrant"),
    ("ollama", "Restart Ollama for me.", "ollama"),
    ("tailscale", "Connect over Tailscale.", "tailscale"),
    # Model NUMBERS, which fail separately from the brand: live testing heard
    # "RTX 3090" as "RTX 39D", so the expectation is the digits, not "RTX".
    ("rtx-4090", "Is the RTX 4090 overkill for this?", "4090"),
    ("rtx-5090", "How much faster is the RTX 5090?", "5090"),
    ("rtx-3090-again", "I am looking at a used RTX 3090.", "3090"),
]

# Must transcribe to nothing. Named recordings only — synthesizing silence
# through a TTS engine does not produce the room tone that causes the problem.
#
# Drop any room-tone recording into Ixa-Tests/stt/ named noise-*.<ext> and it
# joins this set automatically. That matters: digital silence is a weak test,
# because the hallucination seen live ("Please the President.") came from a
# room with sound in it, not from an empty file.
NOISE_CASES = [
    ("silence", None, ""),
]

# Real speech that was not addressed to Ixa. Transcribing it is CORRECT — the
# wake word is what decides whether an utterance is for her, not STT — so
# these are reported for information and never scored. Listed separately
# because treating them as hallucinations would make every hint mode look
# worse than it is.
SPEECH_CASES = [
    ("random-words", None),
]

# Must NOT be filtered away. A threshold that drops one of these is wrong
# however many hallucinations it removes.
SHORT_CASES = [
    ("yes", "Yes.", "yes"),
    ("no", "No.", "no"),
    ("stop", "Stop.", "stop"),
    ("okay", "Okay.", "okay"),
    ("thanks", "Thanks.", "thanks"),
]

# ---------------------------------------------------------------- paths
#
# A PATH IS A SENTENCE FULL OF PROPER NOUNS, and that is a different problem
# from a product name. The live failure: "write a note that the Ixa repo is at
# /home/wyatt/Projects/ixa", spoken with the slashes said aloud, came back as
#
#   "... slash home slash WALLET slash PROJECT slash Ixa"
#
# and the note on disk said /home/wallet/project/Ixa. Two errors, both lexical:
# base.en has no reason to prefer the name "Wyatt" over the common noun
# "wallet", and nothing in the hint list mentions either "Wyatt" or "Projects".
# "Ixa" came through, which is the available evidence that the mechanism works.
#
# Scored on THE TOKENS THAT BROKE, not on the whole sentence: "projects"
# rendered with a lowercase p is not a mishearing anyone can hear, and demanding
# the full sentence would score punctuation.
#
# `forbid` is the negative control. A hint list that simply teaches the decoder
# to prefer "Wyatt" wherever it used to hear "wallet" has not fixed anything —
# it has moved the error onto every sentence about a wallet. One case asks about
# a wallet and must still say so.
PATH_CASES = [
    {
        "slug": "path-wyatt-note",
        "text": "Write a note in your notebook that the Ixa repo is at slash home slash wyatt slash Projects slash ixa",
        "expect": ["wyatt", "projects", "ixa"],
        "forbid": [],
    },
    {
        "slug": "path-backend-src",
        "text": "The backend lives at slash home slash wyatt slash Projects slash ixa slash src",
        "expect": ["wyatt", "projects", "ixa", "src"],
        "forbid": [],
    },
    {
        "slug": "path-vault",
        "text": "Open slash home slash wyatt slash Ixa dash Vault",
        "expect": ["wyatt", "ixa", "vault"],
        "forbid": [],
    },
    {
        "slug": "path-home",
        "text": "Remember that my home directory is slash home slash wyatt",
        "expect": ["wyatt", "home"],
        "forbid": [],
    },
    {
        "slug": "wallet-control",
        "text": "Where did I leave my wallet?",
        "expect": ["wallet"],
        "forbid": ["wyatt"],
    },
]

# The candidate addition, measured against the shipped list rather than
# replacing it. Both words come straight from the live failure.
EXTRA_HINT_WORDS = ["Wyatt", "Projects"]

# Which models to compare. small.en is the next lever named in
# ARCHITECTURE.md's open items; it is ~3.3x base.en's parameters and is
# downloaded on first use.
PATH_MODELS = [m.strip() for m in os.environ.get("STT_MODELS", "base.en,small.en").split(",") if m.strip()]

# Only the two that matter for this question. "hotwords" and "both" tie with
# "prompt" on the domain cases and "prompt" already won that tie on transcript
# quality; what is unknown here is whether hints help a path AT ALL.
PATH_MODES = ["off", "prompt"]


# Threshold pairs to sweep. (maxNoSpeechProb, minAvgLogprob); None disables.
THRESHOLDS = [
    (None, None),
    (0.9, -1.5),
    (0.8, -1.2),
    (0.6, -1.0),
    (0.5, -0.8),
    (0.4, -0.6),
]


AUDIO_EXTENSIONS = (".wav", ".m4a", ".mp3", ".flac", ".ogg", ".webm")


def findSample(slug):
    """A real recording for this case, or None."""
    if not os.path.isdir(samplesDir):
        return None
    for name in sorted(os.listdir(samplesDir)):
        base, ext = os.path.splitext(name)
        if base == slug and ext.lower() in AUDIO_EXTENSIONS:
            return os.path.join(samplesDir, name)
    return None


def findLegacySample(slug):
    """The pre-existing wake-word recordings sit directly in Ixa-Tests/."""
    legacy = os.path.join(repoRoot, "Ixa-Tests")
    for name in sorted(os.listdir(legacy)) if os.path.isdir(legacy) else []:
        base, ext = os.path.splitext(name)
        if base == slug and ext.lower() in AUDIO_EXTENSIONS:
            return os.path.join(legacy, name)
    return None


def synthesize(text, slug):
    """Speak `text` with the Kokoro sidecar, cached as a 16kHz mono WAV.

    The sidecar streams length-prefixed WAV frames; each is independently
    valid, so they are decoded and concatenated.
    """
    os.makedirs(cacheDir, exist_ok=True)
    path = os.path.join(cacheDir, f"{slug}.wav")
    if os.path.exists(path):
        return path

    request = urllib.request.Request(
        f"{ttsUrl}/speak",
        data=json.dumps({"text": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
    except (urllib.error.URLError, OSError) as err:
        print(f"  ! cannot synthesize {slug}: TTS sidecar unreachable at {ttsUrl} ({err})")
        return None

    pieces = []
    rate = 24000
    offset = 0
    while offset + 4 <= len(body):
        length = int.from_bytes(body[offset:offset + 4], "big")
        frame = body[offset + 4:offset + 4 + length]
        offset += 4 + length
        with wave.open(BytesIO(frame), "rb") as wf:
            rate = wf.getframerate()
            pieces.append(np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16))
    if not pieces:
        print(f"  ! cannot synthesize {slug}: no audio frames returned")
        return None

    audio = np.concatenate(pieces).astype(np.float32) / 32768.0
    # Linear resample to 16kHz, which is what the mic path delivers.
    target = int(len(audio) * 16000 / rate)
    audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)

    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes((audio * 32767).astype(np.int16).tobytes())
    return path


def loadAudio(slug, text):
    """(audio, source) for a case, or (None, None) if it cannot be had."""
    path = findSample(slug) or findLegacySample(slug)
    if path:
        return decode_audio(path, sampling_rate=16000), f"recorded ({os.path.basename(path)})"
    if text is None:
        return None, None
    path = synthesize(text, slug)
    if not path:
        return None, None
    return decode_audio(path, sampling_rate=16000), "synthesized"


def transcribe(model, audio, mode, maxNoSpeechProb, minAvgLogprob):
    """Mirrors the sidecar's own call, and returns the dropped segments too."""
    segments, _info = model.transcribe(
        audio, beam_size=5, vad_filter=True, **hintArgs(mode, hintWords)
    )
    kept, dropped = [], []
    for segment in segments:
        rejection = segmentRejection(segment, maxNoSpeechProb, minAvgLogprob)
        if rejection:
            dropped.append((segment.text.strip(), rejection))
        else:
            kept.append(segment.text)
    return "".join(kept).strip(), dropped


def transcribeTimed(model, audio, kwargs, maxNoSpeechProb=None, minAvgLogprob=None):
    """One transcription, and how long it took. Mirrors the sidecar's call."""
    start = time.monotonic()
    segments, _info = model.transcribe(audio, beam_size=5, vad_filter=True, **kwargs)
    # faster-whisper's generator is lazy: the work happens while the segments
    # are consumed, so the clock has to stop AFTER the list is built or the
    # timing measures setting up an iterator.
    kept = []
    for segment in segments:
        if not segmentRejection(segment, maxNoSpeechProb, minAvgLogprob):
            kept.append(segment.text)
    elapsed = time.monotonic() - start
    return "".join(kept).strip(), elapsed


def scorePath(case, text):
    """(missing, forbidden) for one path case, matched case-insensitively."""
    flat = text.lower()
    missing = [token for token in case["expect"] if token.lower() not in flat]
    forbidden = [token for token in case["forbid"] if token.lower() in flat]
    return missing, forbidden


def pathAudio():
    """Every path case's audio, with whether it is a real recording.

    Real recordings are what this measurement is FOR. The existing domain-word
    run is on synthesized speech and ARCHITECTURE.md already says so twice: a
    case that only fails on a microphone cannot be proved fixed by Kokoro.
    Worse here than there — Kokoro renders "Wyatt" through the same espeak
    fallback Whisper is then asked to recover it from, so a synthesized pass
    measures a round trip through one pronunciation guess, not a voice.
    """
    out = {}
    for case in PATH_CASES:
        slug = case["slug"]
        path = findSample(slug) or findLegacySample(slug)
        if path:
            out[slug] = (decode_audio(path, sampling_rate=16000), True, os.path.basename(path))
            continue
        synthesized = synthesize(case["text"], slug)
        if synthesized:
            out[slug] = (decode_audio(synthesized, sampling_rate=16000), False, "synthesized")
        else:
            print(f"  SKIP  {slug:<18} no recording and could not synthesize")
    return out


def reportPathTable(title, rows, cases):
    """One table per audio source. Rows are (model, mode, listName, slug, ...)."""
    if not rows:
        return
    print(f"\n  --- {title} ---")
    arms = []
    for row in rows:
        arm = (row["model"], row["mode"], row["list"])
        if arm not in arms:
            arms.append(arm)

    header = f"  {'model':<9} {'mode':<6} {'hints':<14} {'score':<7}  " + "  ".join(
        f"{case['slug'][:16]:<16}" for case in cases
    )
    print(header)
    for arm in arms:
        mine = [row for row in rows if (row["model"], row["mode"], row["list"]) == arm]
        passed = sum(1 for row in mine if row["ok"])
        cells = []
        for case in cases:
            row = next((entry for entry in mine if entry["slug"] == case["slug"]), None)
            if row is None:
                cells.append(f"{'-':<16}")
            elif row["ok"]:
                cells.append(f"{'ok':<16}")
            else:
                bad = ",".join(row["missing"] + [f"!{token}" for token in row["forbidden"]])
                cells.append(f"{bad[:16]:<16}")
        print(f"  {arm[0]:<9} {arm[1]:<6} {arm[2]:<14} {passed}/{len(mine):<5}  " + "  ".join(cells))

    print("\n  transcripts:")
    for arm in arms:
        for row in [entry for entry in rows if (entry["model"], entry["mode"], entry["list"]) == arm]:
            mark = "ok  " if row["ok"] else "FAIL"
            print(f"    {mark} [{row['model']} {row['mode']} {row['list']}] {row['slug']}: {row['text']!r}")


def verifyPaths():
    """The path matrix: model x hint list x mode, timed."""
    print("\n=== paths: model x hint list x mode ===")
    print("  Scored on the tokens the live failure broke (wyatt, projects), with")
    print("  one negative control that must still say 'wallet'.\n")
    print("  STT RUNS ON THIS MACHINE — the backend spawns the sidecar in-process,")
    print("  so these timings are the ones the voice loop actually pays.\n")

    audioByCase = pathAudio()
    for case in PATH_CASES:
        if case["slug"] in audioByCase:
            audio, real, source = audioByCase[case["slug"]]
            print(f"  ok    {case['slug']:<18} {len(audio) / 16000:5.1f}s  {source}")

    lists = [("shipped", hintWords), ("shipped+paths", hintWords + EXTRA_HINT_WORDS)]
    rows = []
    timings = {}

    for name in PATH_MODELS:
        print(f"\n  loading '{name}' (cpu/int8)...")
        try:
            start = time.monotonic()
            model = WhisperModel(name, device="cpu", compute_type="int8")
            loadSeconds = time.monotonic() - start
        except Exception as err:
            print(f"  ! cannot load {name}: {err}")
            continue
        # First load of a model DOWNLOADS it (small.en is 464MB), so this
        # figure is startup cost only on a machine that already has it —
        # measured at 0.8s cached for both models.
        print(f"    loaded in {loadSeconds:.1f}s (includes the download on first use)")
        timings[name] = {"load": loadSeconds, "runs": []}

        for mode in PATH_MODES:
            for listName, words in lists:
                # With hints off the list is not read at all, so measuring both
                # lists against it would report the same number twice.
                if mode == "off" and listName != lists[0][0]:
                    continue
                kwargs = hintArgs(mode, words)
                for case in PATH_CASES:
                    if case["slug"] not in audioByCase:
                        continue
                    audio, real, _source = audioByCase[case["slug"]]
                    text, elapsed = transcribeTimed(model, audio, kwargs)
                    timings[name]["runs"].append((elapsed, len(audio) / 16000))
                    missing, forbidden = scorePath(case, text)
                    rows.append({
                        "model": name, "mode": mode,
                        "list": "n/a" if mode == "off" else listName,
                        "slug": case["slug"], "real": real, "text": text,
                        "missing": missing, "forbidden": forbidden,
                        "ok": not missing and not forbidden,
                    })

    realCases = [case for case in PATH_CASES if audioByCase.get(case["slug"], (None, False, ""))[1]]
    synthCases = [case for case in PATH_CASES if case["slug"] in audioByCase and not audioByCase[case["slug"]][1]]
    reportPathTable("REAL RECORDINGS", [row for row in rows if row["real"]], realCases)
    reportPathTable("SYNTHESIZED (weak evidence — see pathAudio)", [row for row in rows if not row["real"]], synthCases)

    print("\n  --- latency, per transcription ---")
    print(f"  {'model':<9} {'load':>7}  {'median':>8} {'max':>8}  {'median rtf':>10}  runs")
    for name, data in timings.items():
        if not data["runs"]:
            continue
        times = sorted(entry[0] for entry in data["runs"])
        rtfs = sorted(entry[0] / entry[1] for entry in data["runs"])
        print(
            f"  {name:<9} {data['load']:6.1f}s  {statistics.median(times) * 1000:7.0f}ms"
            f" {max(times) * 1000:7.0f}ms  {statistics.median(rtfs):10.2f}  {len(times)}"
        )
    if len(timings) > 1:
        names = list(timings.keys())
        base = statistics.median(sorted(entry[0] for entry in timings[names[0]]["runs"]))
        for other in names[1:]:
            mine = statistics.median(sorted(entry[0] for entry in timings[other]["runs"]))
            print(f"\n  {other} is {mine / base:.1f}x {names[0]} per transcription.")
    print("\n  This latency is serial with the turn: STT finishes before the LLM")
    print("  call starts, so it is added to time-to-first-audio on every turn.")


def main():
    # `paths` runs the path matrix alone. The sections above load their own
    # model and sweep thresholds, which is several minutes of work answering a
    # different question, and the path matrix already loads every model it
    # compares.
    if "paths" in sys.argv[1:]:
        print(f"Hint vocabulary: {', '.join(hintWords)}")
        print(f"Candidate addition: {', '.join(EXTRA_HINT_WORDS)}")
        verifyPaths()
        return

    print(f"Loading faster-whisper '{modelName}' (cpu/int8)...")
    model = WhisperModel(modelName, device="cpu", compute_type="int8")
    print(f"Hint vocabulary: {', '.join(hintWords)}\n")

    # Any noise-*.<ext> recording dropped into Ixa-Tests/stt/ is a noise case.
    discovered = []
    if os.path.isdir(samplesDir):
        for name in sorted(os.listdir(samplesDir)):
            base, ext = os.path.splitext(name)
            if base.startswith("noise-") and ext.lower() in AUDIO_EXTENSIONS:
                discovered.append((base, None, ""))

    cases = (
        [("domain", *c) for c in DOMAIN_CASES]
        + [("noise", *c) for c in NOISE_CASES + discovered]
        + [("short", *c) for c in SHORT_CASES]
        + [("speech", slug, text, "") for slug, text in SPEECH_CASES]
    )

    audioByCase = {}
    print("=== audio ===")
    for kind, slug, text, _expect in cases:
        audio, source = loadAudio(slug, text)
        if audio is None:
            print(f"  SKIP  {slug:<14} no recording and could not synthesize")
            continue
        audioByCase[slug] = audio
        print(f"  ok    {slug:<14} {len(audio) / 16000:.1f}s  {source}")

    # --------------------------------------------------- hint mode comparison
    # Unfiltered, so this isolates the hints from the thresholds.
    print("\n=== hint modes (no segment filtering) ===")
    modeResults = {}
    for mode in HINT_MODES:
        hits, total, lines = 0, 0, []
        for kind, slug, _text, expect in cases:
            if slug not in audioByCase:
                continue
            text, _dropped = transcribe(model, audioByCase[slug], mode, None, None)
            if kind == "speech":
                # Not scored: see SPEECH_CASES.
                lines.append((kind, slug, None, text))
                continue
            ok = text.strip() == "" if kind == "noise" else expect.lower() in text.lower()
            total += 1
            hits += 1 if ok else 0
            lines.append((kind, slug, ok, text))
        modeResults[mode] = (hits, total, lines)
        print(f"\n  mode '{mode}': {hits}/{total}")
        for kind, slug, ok, text in lines:
            mark = "----" if ok is None else ("PASS" if ok else "FAIL")
            print(f"    {mark}  [{kind}] {slug:<14} {text!r}")

    print("\n  summary:")
    for mode, (hits, total, _lines) in modeResults.items():
        print(f"    {mode:<9} {hits}/{total}")

    # ------------------------------------------------------ threshold sweep
    # Run under the best hint mode, since that is what will ship. Modes tie
    # often — all three scored 14/14 on the first run — so the tie-break is
    # stated rather than left to dict order: "prompt" and "both" return
    # properly punctuated sentences where "hotwords" alone returns
    # "is the RTX 3090 still worth buying." with no capital and no question
    # mark, and "prompt" gets that for less of the decoder's prompt slot.
    TIE_BREAK = ("prompt", "both", "hotwords", "off")
    topScore = max(modeResults[m][0] for m in modeResults)
    best = next(m for m in TIE_BREAK if modeResults[m][0] == topScore)
    print(f"\n=== segment filtering (hint mode '{best}') ===")
    print("  A threshold is only usable if every short utterance survives it.\n")

    for maxNoSpeech, minLogprob in THRESHOLDS:
        label = (
            "none"
            if maxNoSpeech is None
            else f"no_speech>{maxNoSpeech} / logprob<{minLogprob}"
        )
        noiseClean, noiseTotal = 0, 0
        shortsKept, shortsTotal = 0, 0
        casualties, removals = [], []

        for kind, slug, _text, expect in cases:
            if slug not in audioByCase:
                continue
            text, dropped = transcribe(model, audioByCase[slug], best, maxNoSpeech, minLogprob)
            if kind == "noise":
                noiseTotal += 1
                if text.strip() == "":
                    noiseClean += 1
                removals.extend(f"{slug}: {t!r} ({why})" for t, why in dropped)
            elif kind == "speech":
                continue
            elif kind == "short":
                shortsTotal += 1
                if expect.lower() in text.lower():
                    shortsKept += 1
                else:
                    casualties.append(f"{slug} -> {text!r}")
            elif expect.lower() not in text.lower():
                casualties.append(f"{slug} -> {text!r}")

        verdict = "USABLE" if shortsKept == shortsTotal else "TOO TIGHT"
        print(f"  {verdict:<10} {label}")
        print(f"             noise silenced {noiseClean}/{noiseTotal}, short words kept {shortsKept}/{shortsTotal}")
        for removal in removals:
            print(f"             dropped {removal}")
        for casualty in casualties:
            print(f"             LOST    {casualty}")

    verifyPaths()

    print("\nSet IXA_STT_HINT_MODE, IXA_STT_MAX_NO_SPEECH_PROB and")
    print("IXA_STT_MIN_AVG_LOGPROB from the rows above.")
    print("The path matrix changes NO defaults on its own: STT_MODEL and")
    print("IXA_STT_HOTWORDS are decided by reading the numbers.")


if __name__ == "__main__":
    main()
