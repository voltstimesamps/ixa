# Ixa desktop voice client

Python client for the Framework 13 (and any other machine with a mic). Wake
word and VAD run here; all reasoning, STT and TTS happen on the backend.

```bash
cd clients/desktop
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
pip install openwakeword          # see wakeword.py for the model
IXA_HOST=<backend-tailscale-ip> python client.py
```

Type a message and press Enter to send text; say "Hey Ixa" to start a spoken
conversation.

## Environment variables

All optional except `IXA_HOST`, which must be set for anything but a backend
on this same machine.

| Variable | Default | What it does |
|---|---|---|
| `IXA_HOST` | `localhost` | Backend address. Use the harness's Tailscale IP for remote use (`tailscale status` **inside WSL2** on the gaming PC). The client talks to `ws://$IXA_HOST:3001`. |
| `IXA_LOG_LEVEL` | `INFO` | Python log level. `DEBUG` shows per-frame VAD/wake scores and every conversation state transition. |
| `IXA_RECORD_MODE` | `vad` | `vad`: Silero VAD starts and ends recording. `ptt`: type `:rec` to start/stop (debugging, noisy rooms). |
| `IXA_WAKE_THRESHOLD` | `0.5` | Wake word score a frame must reach to count. Two consecutive frames are required (`WAKE_CONSECUTIVE_FRAMES`). |
| `IXA_SKIP_WAKE_WORD` | unset | `1`/`true`/`yes` bypasses the wake word: straight to VAD-triggered recording, and the conversation never closes. |
| `IXA_TRAILING_SILENCE_MS` | `1500` | How long the user has to pause before the utterance is considered finished and sent. Raise it if Ixa cuts you off mid-thought; lower it for snappier turns. (Smart Turn v3 will eventually replace this fixed timer.) |
| `IXA_CONVERSATION_TIMEOUT_MS` | `20000` | How long Ixa keeps listening for a follow-up before the wake phrase is needed again. Runs **only** while waiting for the user to speak — never while Ixa is thinking or talking. |
| `IXA_RESPONSE_TIMEOUT_MS` | `90000` | Safety net: how long to wait for a reply that never arrives before giving up on the turn and going back to sleep. Must stay comfortably above the slowest real tool-using turn. |

## Conversation states

`conversation.py` holds the state machine. Which timer is running is a
function of the state, not of a pile of flags:

| State | Meaning | Timer |
|---|---|---|
| `SLEEPING` | Only the wake word model sees audio. | none |
| `LISTENING` | Conversation open, waiting for the user. | `IXA_CONVERSATION_TIMEOUT_MS` |
| `WAITING` | Utterance sent, reply not started. | `IXA_RESPONSE_TIMEOUT_MS` |
| `SPEAKING` | Reply audio playing; mic dropped. | none |

Transitions: wake word → `LISTENING`; utterance sent → `WAITING`; first audio
chunk → `SPEAKING`; playback actually played out (or the backend's `replyEnd`
for a reply with no audio) → `LISTENING` with a fresh window; conversation
timeout or dismiss phrase → `SLEEPING`.

Tests (stdlib `unittest`, no mic, no models, fake clock):

```bash
cd clients/desktop && python -m unittest -v test_conversation
```
