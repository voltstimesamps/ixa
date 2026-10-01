import os

import numpy as np
from openwakeword.model import Model

_MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
_DEFAULT_MODEL_PATH = os.path.join(_MODEL_DIR, "hey_ixa.onnx")


class WakeWordDetector:
    """openWakeWord gate for a custom "Hey Ixa" model.

    Frames are 80ms (1280 samples at 16kHz) — the second FrameBuffer window
    size vad.py's docstring reserved for this. openWakeWord's onnx backend
    also runs on onnxruntime with no torch dependency, so this shares the
    same runtime as SileroVAD without adding a second ML stack.

    The "hey_ixa.onnx" model isn't included in this repo — openWakeWord ships
    only stock phrases (e.g. "hey jarvis"). Train a custom one with
    openWakeWord's automatic_model_training notebook
    (https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb)
    using "hey ixa" as the target phrase, then drop the resulting .onnx file
    at clients/desktop/models/hey_ixa.onnx.
    """

    SAMPLE_RATE = 16000
    CHUNK_SAMPLES = 1280

    def __init__(self, model_path: str = _DEFAULT_MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Wake word model not found at {model_path}. Train one with "
                "openWakeWord's automatic_model_training notebook (target phrase "
                "\"hey ixa\") and drop the resulting .onnx file at that path. "
                "Set IXA_SKIP_WAKE_WORD=1 to bypass wake word and go straight "
                "to VAD-triggered recording while you don't have a model yet."
            )
        # vad_threshold intentionally left unset: openWakeWord's built-in Silero
        # VAD gate would suppress wake-word scoring during non-speech audio, but
        # ConversationGate/VoiceActivityRecorder already run a separate, tuned
        # SileroVAD instance for the post-wake utterance boundary. Stacking a
        # second, differently-tuned VAD gate in front of wake-word detection
        # itself would just add a second threshold to fight with during tuning
        # for no real benefit — the external state machine is the single
        # source of truth for "is someone talking".
        self._model = Model(wakeword_models=[model_path], inference_framework="onnx")
        self._name = os.path.splitext(os.path.basename(model_path))[0]

    def process(self, chunk: np.ndarray) -> float:
        """chunk: int16 PCM array of CHUNK_SAMPLES samples. Returns wake word score."""
        scores = self._model.predict(chunk)
        return float(scores[self._name])

    def reset(self) -> None:
        """Clear openWakeWord's audio/feature history. Call before resuming
        detection after a gap in the audio this detector has seen.

        The classifier scores the last 16 embeddings (~1.28s) it was fed, and
        those don't age out on their own — they only shift when new audio
        arrives. Without a reset, the window still holds the wake phrase that
        last woke us, so the first chunk fed after sleeping scores ~0.999 and
        re-wakes immediately. Model.reset() restores the just-loaded state
        (and re-zeroes the first 5 scores while the buffers refill).
        """
        self._model.reset()
