class FrameBuffer:
    """Accumulates raw PCM bytes and emits fixed-size windows.

    Ingests arbitrarily-sized chunks (e.g. from a sounddevice capture callback,
    which isn't guaranteed to hand back exactly `window_samples` every time) and
    hands back windows of a caller-chosen sample count.

    This is deliberately the only piece of code that knows about chunk sizing.
    Silero VAD wants 512-sample windows at 16kHz; a future openWakeWord gate will
    want 1280-sample windows (exactly 2.5x) fed from the same 16kHz capture
    stream. Each consumer gets its own FrameBuffer instance over the same raw
    capture, so wake word can be added later without touching the capture path
    or the VAD state machine.
    """

    def __init__(self, window_samples: int, sample_width: int = 2):
        self.window_samples = window_samples
        self.window_bytes = window_samples * sample_width
        self._buf = bytearray()

    def push(self, chunk: bytes) -> list[bytes]:
        self._buf.extend(chunk)
        windows = []
        while len(self._buf) >= self.window_bytes:
            windows.append(bytes(self._buf[: self.window_bytes]))
            del self._buf[: self.window_bytes]
        return windows

    def reset(self) -> None:
        self._buf.clear()
