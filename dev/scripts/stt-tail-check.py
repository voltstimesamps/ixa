#!/usr/bin/env python3
"""Measures what the STT segment filter does to the TAIL of a long utterance
and to hallucinations over room noise, under the old rule and the shipped one.

Run with the STT sidecar's own venv (it loads the model in-process; no sidecar,
no backend, no ports):

    sidecars/stt/venv/bin/python dev/scripts/stt-tail-check.py

Why this exists. Live, on 2026-11-08, a ~25 second dictated note lost its last
clause ("...be around $300, but I am not sure yet.") to the filter at
no_speech_prob 0.90, Ixa answered the half that survived, and a turn was wasted.
In the same session the same filter correctly dropped the hint prompt read back
as speech ("The conversation may mention Ixa, RTX 3090, RTX 3090.", 0.85). Both
have a high no_speech_prob, so that number alone cannot tell them apart. This
script measures what does.

Three things to know before reading the numbers:

  * no_speech_prob and avg_logprob are per DECODE WINDOW in faster-whisper, not
    per segment: every segment a window yields carries the same pair. A window
    is a VAD clip, or a 30 second slice of one, so the second window of a long
    utterance starts wherever the first one stopped — often mid-sentence.
  * faster-whisper already drops a window when no_speech_prob > 0.6 AND
    avg_logprob < -1.0 (its own defaults). The sidecar's rule was no_speech_prob
    alone, so it only ever dropped windows the library had judged confident
    enough to keep.
  * The live tail (no_speech_prob 0.90) was NOT reproduced here. Synthesized and
    recorded speech never scored above 0.22 in any window, tail windows
    included. What was reproduced is the hallucination side, and the gap
    between the two populations' avg_logprob, which is what the shipped
    threshold rests on. The claim that the live tail sat on the confident side
    of that gap is an inference from its text, not a measurement.

Audio: the long utterances are synthesized with the Kokoro sidecar at TTS_URL
(cached under Ixa-Tests/stt/synthesized/tail-<piece>.wav, which is gitignored);
room tone is Ixa-Tests/stt/noise-room.wav and real speech is the recordings
beside it. Anything missing is reported and skipped.
"""
import glob
import json
import os
import sys
import urllib.error
import urllib.request
import wave
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sidecars", "stt"))

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

from hints import (
    NO_SPEECH_CONFIRM_LOGPROB,
    defaultHintWords,
    hintArgs,
    isHintEcho,
    segmentRejection,
)

SR = 16000
repoRoot = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
samplesDir = os.path.join(repoRoot, "Ixa-Tests", "stt")
cacheDir = os.path.join(samplesDir, "synthesized")
ttsUrl = os.environ.get("TTS_URL", "http://localhost:5001")
modelName = os.environ.get("STT_MODEL", "base.en")

MAX_NO_SPEECH = float(os.environ.get("STT_MAX_NO_SPEECH_PROB", "0.6"))
MIN_LOGPROB = float(os.environ.get("STT_MIN_AVG_LOGPROB", "-1.0"))
CONFIRM = float(os.environ.get("STT_NO_SPEECH_CONFIRM_LOGPROB", str(NO_SPEECH_CONFIRM_LOGPROB)))

# The pieces of the live utterance, and some sentences to lengthen it with.
PIECES = {
    "A": "When you write a note about my homelab, I'm thinking that I'm going to want either like three or four mini PCs, like Dell Optiplexes or something, or a Dell Precision workstation.",
    "B": "I think each PC should",
    "C": "be around $300, but I am not sure yet.",
    "D": "You write a note about my home lab. I'm thinking that I'm going to want either a Dell Precision or a Dell OptiPlex with an i5, i7, or ideally i9, but I don't think I'm going to find one below my price range of $300.",
    "E": "I also want it to be quiet, because it will sit in the living room next to the television.",
    "F": "So let me know what you think about that.",
    "G": "And then I would like to put the backup drive in the closet, but I have not decided yet.",
}

# Leads that put the 30 second window boundary at different places in the tail
# "I think each PC should ... be around $300, but I am not sure yet."
LEADS = ["DE", "DEF", "DA", "AEFG", "DEG", "DAF", "DEFG", "AEG", "AD"]


def old(seg):
    return segmentRejection(seg, MAX_NO_SPEECH, MIN_LOGPROB, confirmLogprob=None)


def new(seg):
    return segmentRejection(seg, MAX_NO_SPEECH, MIN_LOGPROB, confirmLogprob=CONFIRM)


def synthesize(slug, text):
    os.makedirs(cacheDir, exist_ok=True)
    path = os.path.join(cacheDir, f"tail-{slug}.wav")
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
    pieces, rate, offset = [], 24000, 0
    while offset + 4 <= len(body):
        length = int.from_bytes(body[offset:offset + 4], "big")
        frame = body[offset + 4:offset + 4 + length]
        offset += 4 + length
        with wave.open(BytesIO(frame), "rb") as wf:
            rate = wf.getframerate()
            pieces.append(np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16))
    if not pieces:
        return None
    audio = np.concatenate(pieces).astype(np.float32) / 32768.0
    target = int(len(audio) * SR / rate)
    audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((audio * 32767).astype(np.int16).tobytes())
    return path


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype=np.float32)


def transcribe(model, audio, mode):
    words = defaultHintWords()
    segments, _info = model.transcribe(audio, beam_size=5, vad_filter=True, **hintArgs(mode, words))
    return list(segments)


def show(seg):
    mark = "old:DROP" if old(seg) else "old:keep"
    mark += " new:DROP" if new(seg) else " new:keep"
    return (
        f"    {mark}  window@{seg.seek / 100:5.1f}s  {seg.start:5.1f}-{seg.end:5.1f}s  "
        f"nsp={seg.no_speech_prob:.2f} lp={seg.avg_logprob:.2f}  ...{seg.text.strip()[-56:]!r}"
    )


# ---------------------------------------------------------------- 1. tails

def longUtterances(model):
    print("\n=== 1. long utterances: where do the later windows land? ===")
    audio = {}
    for slug, text in PIECES.items():
        path = synthesize(slug, text)
        if not path:
            print("  SKIP: needs synthesized speech (start the TTS sidecar or drop tail-<A..G>.wav in the cache)")
            return None
        audio[slug] = decode_audio(path, sampling_rate=SR)
    tail = np.concatenate([audio["B"], silence(0.9), audio["C"]])

    worst = 0.0
    windows = 0
    for lead in LEADS:
        body = np.concatenate([np.concatenate([audio[c], silence(0.5)]) for c in lead])
        segs = transcribe(model, np.concatenate([body, tail]), "prompt")
        print(f"\n  lead={lead} ({len(body) / SR:.1f}s) + tail, total {(len(body) + len(tail)) / SR:.1f}s")
        for seg in segs:
            print(show(seg))
        for seg in segs:
            worst = max(worst, seg.no_speech_prob)
        windows += len({s.seek for s in segs})
    print(f"\n  {windows} decode windows over {len(LEADS)} utterances; highest no_speech_prob seen on real speech: {worst:.2f}")
    return worst


# ---------------------------------------------------------------- 2. noise

def noiseCorpus(model):
    print("\n=== 2. hallucinations over room tone (140 clips, seeded) ===")
    path = os.path.join(samplesDir, "noise-room.wav")
    if not os.path.exists(path):
        print("  SKIP: needs Ixa-Tests/stt/noise-room.wav")
        return None
    noise = decode_audio(path, sampling_rate=SR)
    noise = noise / (np.abs(noise).max() + 1e-9)
    rng = np.random.default_rng(11)

    rows = []
    for mode in ("prompt", "off"):
        for amp in (0.05, 0.1, 0.2, 0.4, 0.8):
            for _ in range(14):
                dur = float(rng.choice([0.3, 0.6, 1.0, 1.6, 2.5, 4.0, 6.0]))
                start = int(rng.integers(0, len(noise) - int(dur * SR)))
                clip = noise[start:start + int(dur * SR)] * amp
                audio = np.concatenate([silence(0.4), clip, silence(1.5)]).astype(np.float32)
                for seg in transcribe(model, audio, mode):
                    rows.append((mode, amp, dur, seg))

    high = [r for r in rows if r[3].no_speech_prob > MAX_NO_SPEECH]
    print(f"  {len(rows)} segments from 140 clips; {len(high)} with no_speech_prob > {MAX_NO_SPEECH}")
    for mode, amp, dur, seg in sorted(high, key=lambda r: -r[3].no_speech_prob):
        print(f"    {mode:<6} amp={amp:<4} {dur:<4}s " + show(seg).strip())

    echoes = [r for r in rows if isHintEcho(r[3].text)]
    leaked_old = [r for r in rows if not old(r[3])]
    leaked_new = [r for r in rows if not new(r[3])]
    print(f"\n  hint echoes: {len(echoes)} of {len(rows)} segments "
          f"({len([r for r in echoes if r[0] == 'prompt'])} of 70 hinted clips)")
    if high:
        lps = [r[3].avg_logprob for r in high]
        print(f"  avg_logprob of every high-no_speech segment: {min(lps):.2f} .. {max(lps):.2f}")
    print(f"  hallucinated segments that reach the transcript   old rule: {len(leaked_old)}   shipped rule: {len(leaked_new)}")
    for mode, amp, dur, seg in leaked_new:
        print(f"    LEAK [{mode} amp={amp} {dur}s] {show(seg).strip()}")
    return rows


# ---------------------------------------------------------------- 3. real

def realRecordings(model):
    print("\n=== 3. real recordings, joined with room-tone gaps, past the 30 second window ===")
    noisePath = os.path.join(samplesDir, "noise-room.wav")
    paths = [p for p in sorted(glob.glob(os.path.join(samplesDir, "*.m4a"))) if "control" not in p]
    if not paths or not os.path.exists(noisePath):
        print("  SKIP: needs Ixa-Tests/stt/*.m4a and noise-room.wav")
        return None
    noise = decode_audio(noisePath, sampling_rate=SR)
    clips = [decode_audio(p, sampling_rate=SR) for p in paths]
    worst = 0.0
    for gap in (0.8, 1.5, 2.5):
        n = int(gap * SR)
        room = np.tile(noise, int(np.ceil(n / len(noise))))[:n]
        parts = []
        for clip in clips:
            parts += [clip, room]
        segs = transcribe(model, np.concatenate(parts[:-1]), "prompt")
        print(f"\n  gap {gap}s, {sum(len(c) for c in clips) / SR:.0f}s of speech")
        for seg in segs:
            print(show(seg))
            worst = max(worst, seg.no_speech_prob)
    print(f"\n  highest no_speech_prob on real recordings: {worst:.2f}")
    return worst


def main():
    print(f"model {modelName}; drop if no_speech_prob > {MAX_NO_SPEECH} AND avg_logprob < {CONFIRM} (old: no_speech_prob alone), "
          f"or avg_logprob < {MIN_LOGPROB}, or the hint prompt read back")
    model = WhisperModel(modelName, device="cpu", compute_type="int8")
    longUtterances(model)
    noiseCorpus(model)
    realRecordings(model)


if __name__ == "__main__":
    main()
