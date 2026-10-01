"""Ground-truth wake word score curve from the real openwakeword package.

Feeds a 16kHz mono int16 WAV through openwakeword's Model.predict() in
1280-sample (80ms) chunks — exactly how clients/desktop/wakeword.py drives it
— and dumps the per-frame score curve to JSON. The browser port in
src/api/test-client.ts is validated against this output.

Model.predict() is called directly rather than via predict_clip(), because
predict_clip() pads the clip with 1s of zeros on each side, which the live
client never does.

Warm-up: AudioFeatures seeds its embedding buffer with embeddings of *random*
noise and its melspectrogram buffer with ones, so the first ~16 frames (1.28s,
the classifier's 16-embedding input window) depend on random state. The seed
is fixed here so reruns are reproducible, but those frames still can't be
matched by an independent implementation; they're flagged `warmup: true`.

Requires openwakeword (0.6.0) + onnxruntime, with melspectrogram.onnx and
embedding_model.onnx in the package's resources/models/ directory.

Convert other formats first, e.g.:
    ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le out.wav

Fixtures (fixtures/*.wav, each with a <name>.baseline.json beside it):
    hey_ixa_test.wav  silence, "Hey Ixa", silence — must fire once, at the phrase
    (negative clip)   ordinary speech, no wake phrase — must stay below threshold

Usage:
    python baseline.py                     # every fixtures/*.wav
    python baseline.py some.wav [--out PATH] [--model PATH]
"""
import argparse
import glob
import json
import os
import wave
from importlib.metadata import version

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_DEFAULT_MODEL = os.path.join(_REPO_ROOT, "clients", "desktop", "models", "hey_ixa.onnx")
_FIXTURE_DIR = os.path.join(_HERE, "fixtures")

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # WakeWordDetector.CHUNK_SAMPLES
WARMUP_FRAMES = 16  # hey_ixa.onnx input is [1, 16, 96]
WAKE_THRESHOLD = 0.5  # client.py's IXA_WAKE_THRESHOLD default
SEED = 0


def load_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        if (wf.getnchannels(), wf.getframerate(), wf.getsampwidth()) != (1, SAMPLE_RATE, 2):
            raise ValueError(
                f"{path} must be 16kHz mono 16-bit PCM; got {wf.getnchannels()}ch "
                f"{wf.getframerate()}Hz {wf.getsampwidth() * 8}-bit"
            )
        return np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)


def run_fixture(wav_path: str, model_path: str, out_path: str | None) -> None:
    # Fresh Model per clip, reseeded, so every fixture starts from the same
    # warm-up state regardless of how many ran before it.
    np.random.seed(SEED)  # AudioFeatures.__init__ draws its warm-up noise from here
    from openwakeword.model import Model

    model = Model(wakeword_models=[model_path], inference_framework="onnx")
    name = os.path.splitext(os.path.basename(model_path))[0]

    audio = load_wav(wav_path)
    n_frames = len(audio) // CHUNK_SAMPLES  # trailing partial chunk dropped, as FrameBuffer does

    frames = []
    for i in range(n_frames):
        chunk = audio[i * CHUNK_SAMPLES:(i + 1) * CHUNK_SAMPLES]
        score = float(model.predict(chunk)[name])
        frames.append({
            "frame": i,
            "tEnd": round((i + 1) * CHUNK_SAMPLES / SAMPLE_RATE, 3),
            "score": score,
            "warmup": i < WARMUP_FRAMES,
        })

    out_path = out_path or os.path.splitext(wav_path)[0] + ".baseline.json"
    with open(out_path, "w") as f:
        json.dump({
            "source": os.path.basename(wav_path),
            "model": os.path.basename(model_path),
            "openwakewordVersion": version("openwakeword"),
            "onnxruntimeVersion": version("onnxruntime"),
            "sampleRate": SAMPLE_RATE,
            "chunkSamples": CHUNK_SAMPLES,
            "warmupFrames": WARMUP_FRAMES,
            "threshold": WAKE_THRESHOLD,
            "seed": SEED,
            "frames": frames,
        }, f, indent=1)

    scored = [fr for fr in frames if not fr["warmup"]]
    peak = max(scored, key=lambda fr: fr["score"])
    crossings = [fr["frame"] for fr in scored if fr["score"] >= WAKE_THRESHOLD]
    print(f"Wrote {len(frames)} frames to {out_path}")
    print(f"Peak (post-warmup): {peak['score']:.4f} at frame {peak['frame']} (t={peak['tEnd']:.2f}s)")
    print(f"Frames >= {WAKE_THRESHOLD}: {crossings or 'none'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wav", nargs="?", help="defaults to every fixtures/*.wav")
    parser.add_argument("--model", default=_DEFAULT_MODEL)
    parser.add_argument("--out", help="defaults to <wav>.baseline.json; single-wav only")
    args = parser.parse_args()

    if args.wav:
        run_fixture(args.wav, args.model, args.out)
        return

    if args.out:
        parser.error("--out needs an explicit wav")
    wavs = sorted(glob.glob(os.path.join(_FIXTURE_DIR, "*.wav")))
    if not wavs:
        parser.error(f"no .wav fixtures in {_FIXTURE_DIR}")
    for i, wav in enumerate(wavs):
        if i:
            print()
        print(f"== {os.path.basename(wav)}")
        run_fixture(wav, args.model, None)


if __name__ == "__main__":
    main()
