import os

import numpy as np
import onnxruntime as ort

_MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "silero_vad.onnx")


class SileroVAD:
    """onnxruntime-only Silero VAD wrapper (16kHz, 512-sample chunks).

    The official `silero-vad` pip package pulls in torch + torchaudio (~5GB) even
    when asked for its onnx backend. This reimplements its OnnxWrapper calling
    convention directly against the raw ONNX graph instead: a 64-sample rolling
    context window is prepended to each 512-sample chunk, and a (2,1,128) state
    tensor carries across calls. Verified against the official wrapper's output
    (max diff ~1e-7 over both random noise and real speech) so behavior — model
    accuracy included — is unchanged, just without the torch dependency.
    Standardizing on onnxruntime here matters because openWakeWord's models are
    also ONNX; this keeps both stages on one runtime instead of two.
    """

    SAMPLE_RATE = 16000
    CHUNK_SAMPLES = 512
    _CONTEXT_SAMPLES = 64

    def __init__(self, model_path: str = _MODEL_PATH):
        self._session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, self._CONTEXT_SAMPLES), dtype=np.float32)

    def process(self, chunk: np.ndarray) -> float:
        """chunk: float32 array of CHUNK_SAMPLES samples in [-1, 1]. Returns speech probability."""
        if chunk.shape[-1] != self.CHUNK_SAMPLES:
            raise ValueError(f"expected {self.CHUNK_SAMPLES} samples, got {chunk.shape[-1]}")

        x = np.concatenate([self._context, chunk.reshape(1, -1)], axis=1).astype(np.float32)
        out, state = self._session.run(
            None,
            {
                "input": x,
                "state": self._state,
                "sr": np.array(self.SAMPLE_RATE, dtype="int64"),
            },
        )
        self._state = state
        self._context = x[:, -self._CONTEXT_SAMPLES :]
        return float(out[0, 0])
