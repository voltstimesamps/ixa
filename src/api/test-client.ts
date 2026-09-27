/**
 * A single self-contained page for poking the voice loop from a phone over
 * Tailscale. Push-to-talk only: a browser can't run an always-on wake word in
 * the background, so this is the PTT bypass path, not a replacement for the
 * real client.
 *
 * Everything is inline — no build step, no npm frontend deps. The page JS
 * deliberately avoids template literals so it can live inside this one.
 *
 * Audio contract, matching src/api/types.ts and src/voice/stt.ts:
 *   out: {type:"audioStart"} -> raw 16kHz mono int16 PCM frames -> {type:"audioInputEnd"}
 *   in:  {type:"audioStart"} -> one standalone 24kHz WAV blob per chunk -> {type:"audioOutputEnd"}
 */
export function renderTestClient(wsPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Ixa — test client</title>
<style>
  :root { color-scheme: dark; --bg:#111318; --panel:#1a1d24; --line:#2c313b; --fg:#e6e8ec; --dim:#8b93a3; --accent:#5b8cff; --live:#ff4d5e; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; }
  body { background:var(--bg); color:var(--fg); font:15px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
         display:flex; flex-direction:column; padding:env(safe-area-inset-top) 12px calc(env(safe-area-inset-bottom) + 12px); }
  header { display:flex; align-items:center; gap:8px; padding:10px 2px; }
  header h1 { font-size:15px; font-weight:600; margin:0; flex:1; }
  #state { font-size:12px; color:var(--dim); }
  #dot { width:8px; height:8px; border-radius:50%; background:#555; display:inline-block; margin-right:5px; }
  #dot.on { background:#39d353; }
  #log { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; background:var(--panel);
         border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:10px; }
  .msg { margin:0 0 8px; padding:7px 10px; border-radius:8px; white-space:pre-wrap; word-break:break-word; }
  .msg.assistant { background:#20283a; }
  .msg.user { background:#2a2f3a; }
  .msg.sys { color:var(--dim); font-size:12.5px; padding:2px 2px; }
  .msg.err { background:#3a2026; color:#ffb4bd; }
  .msg b { display:block; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); margin-bottom:2px; }
  .confirm button { margin:6px 6px 0 0; }
  button { font:inherit; color:var(--fg); background:#2c313b; border:1px solid var(--line);
           border-radius:8px; padding:8px 14px; }
  #talk { width:100%; padding:26px 0; font-size:18px; font-weight:600; border-radius:14px;
          background:var(--accent); border:none; color:#fff; touch-action:none; user-select:none; -webkit-user-select:none; }
  #talk.rec { background:var(--live); }
  #talk:disabled { background:#333a46; color:var(--dim); }
  form { display:flex; gap:8px; margin-top:10px; }
  input { flex:1; min-width:0; font:inherit; color:var(--fg); background:var(--panel);
          border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  footer { color:var(--dim); font-size:11.5px; margin-top:8px; word-break:break-all; }
</style>
</head>
<body>
<header>
  <h1>Ixa</h1>
  <span id="state"><span id="dot"></span><span id="stateText">connecting…</span></span>
</header>

<div id="log" aria-live="polite"></div>

<button id="talk" disabled>Hold to talk</button>

<form id="textForm" autocomplete="off">
  <input id="textInput" placeholder="…or type a message" enterkeyhint="send">
  <button type="submit">Send</button>
</form>

<footer id="conn"></footer>

<script>
(function () {
  "use strict";

  var WS_PORT = ${wsPort};

  var MIC_RATE = 16000;      // src/voice/stt.ts pcmToWav() hardcodes 16kHz mono int16
  var FRAME_SAMPLES = 1024;  // ~64ms per binary frame; the server just concatenates
  var DRAIN_MS = 80;         // let in-flight AudioWorklet messages land before audioInputEnd

  var logEl = document.getElementById("log");
  var dotEl = document.getElementById("dot");
  var stateEl = document.getElementById("stateText");
  var talkEl = document.getElementById("talk");
  var connEl = document.getElementById("conn");
  var formEl = document.getElementById("textForm");
  var inputEl = document.getElementById("textInput");

  // ---------- WebSocket URL ----------
  // Never hardcode an address: derive from whatever host served this page, so a
  // bare Tailscale IP and a *.ts.net name both work. An https page cannot open
  // ws:// (mixed content), so over TLS we assume a "tailscale serve" path
  // mapping at /ws -> localhost:WS_PORT. ?ws=... overrides both.
  function wsUrl() {
    var override = new URLSearchParams(location.search).get("ws");
    if (override) return override;
    if (location.protocol === "https:") return "wss://" + location.host + "/ws";
    return "ws://" + location.hostname + ":" + WS_PORT;
  }
  var WS_URL = wsUrl();
  connEl.textContent = WS_URL + "  ·  add ?ws=wss://host/path to override";

  function log(kind, text, label) {
    var p = document.createElement("div");
    p.className = "msg " + kind;
    if (label) {
      var b = document.createElement("b");
      b.textContent = label;
      p.appendChild(b);
    }
    p.appendChild(document.createTextNode(text));
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
    return p;
  }

  function setState(text, ok) {
    stateEl.textContent = text;
    dotEl.className = ok ? "on" : "";
  }

  // ---------- playback: one standalone WAV blob per binary frame ----------
  var outCtx = null;
  var playHead = 0;
  var playChain = Promise.resolve();

  function playbackContext() {
    if (!outCtx) outCtx = new (window.AudioContext || window.webkitAudioContext)();
    return outCtx;
  }

  function enqueueAudio(arrayBuf) {
    var ctx = playbackContext();
    // Chained so blobs play in arrival order even though decoding is async.
    playChain = playChain.then(function () {
      return ctx.decodeAudioData(arrayBuf);
    }).then(function (buf) {
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      var now = ctx.currentTime;
      if (playHead < now + 0.02) playHead = now + 0.02;
      src.start(playHead);
      playHead += buf.duration;
    }).catch(function (err) {
      log("err", "playback failed: " + err.message);
    });
  }

  // ---------- capture ----------
  var micStream = null;
  var micCtx = null;
  var micNode = null;
  var srcNode = null;
  var capturing = false;
  var pcmQueue = [];       // pending Int16 samples, flushed in FRAME_SAMPLES frames
  var resampleTail = new Float32Array(0);
  var resampleCursor = 0;

  var WORKLET_SRC =
    "class PcmTap extends AudioWorkletProcessor {" +
    "  process(inputs) {" +
    "    var ch = inputs[0] && inputs[0][0];" +
    // Copy: the worklet reuses the same backing buffer every render quantum.
    "    if (ch) this.port.postMessage(new Float32Array(ch));" +
    "    return true;" +
    "  }" +
    "}" +
    "registerProcessor('pcm-tap', PcmTap);";

  // Linear resample to 16kHz, carrying the fractional cursor and one tail
  // sample across blocks so block boundaries don't click.
  function toMicRate(input, srcRate) {
    if (srcRate === MIC_RATE) return input;
    var buf = new Float32Array(resampleTail.length + input.length);
    buf.set(resampleTail, 0);
    buf.set(input, resampleTail.length);

    var ratio = srcRate / MIC_RATE;
    var out = [];
    var pos = resampleCursor;
    while (pos + 1 < buf.length) {
      var i = Math.floor(pos);
      var frac = pos - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      pos += ratio;
    }
    var consumed = Math.min(Math.floor(pos), buf.length);
    resampleTail = buf.slice(consumed);
    resampleCursor = pos - consumed;
    return Float32Array.from(out);
  }

  function onSamples(float32, srcRate) {
    if (!capturing) return;
    var resampled = toMicRate(float32, srcRate);
    for (var i = 0; i < resampled.length; i++) {
      var s = Math.max(-1, Math.min(1, resampled[i]));
      pcmQueue.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    while (pcmQueue.length >= FRAME_SAMPLES) sendFrame(FRAME_SAMPLES);
  }

  function sendFrame(count) {
    var frame = new Int16Array(count);
    for (var i = 0; i < count; i++) frame[i] = pcmQueue[i];
    pcmQueue.splice(0, count);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
  }

  function flushFrames() {
    if (pcmQueue.length) sendFrame(pcmQueue.length);
  }

  async function ensureMic() {
    if (micNode) return;

    // getUserMedia only exists in a secure context. On iOS Safari, http:// to a
    // bare Tailscale IP silently has no mediaDevices at all — the fix is to
    // reach this page over https via "tailscale serve", not a code workaround.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        "Microphone unavailable: this page is not a secure context. Open it over https:// " +
        "(tailscale serve) instead of http://, then reload."
      );
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    var Ctx = window.AudioContext || window.webkitAudioContext;
    // Ask for 16kHz so no resampling is needed; iOS often ignores this, hence
    // toMicRate() above.
    try { micCtx = new Ctx({ sampleRate: MIC_RATE }); } catch (e) { micCtx = new Ctx(); }

    srcNode = micCtx.createMediaStreamSource(micStream);

    var rate = micCtx.sampleRate;
    var blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    try {
      await micCtx.audioWorklet.addModule(blobUrl);
      micNode = new AudioWorkletNode(micCtx, "pcm-tap");
      micNode.port.onmessage = function (ev) { onSamples(ev.data, rate); };
    } catch (err) {
      // Older WebKit without AudioWorklet: deprecated, but it still captures.
      micNode = micCtx.createScriptProcessor(4096, 1, 1);
      micNode.onaudioprocess = function (ev) {
        onSamples(new Float32Array(ev.inputBuffer.getChannelData(0)), rate);
      };
      log("sys", "AudioWorklet unavailable — using ScriptProcessor fallback.");
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    srcNode.connect(micNode);
    // ScriptProcessor only fires while connected to a destination; the worklet
    // doesn't need this, and a zero-gain sink keeps it from echoing either way.
    var sink = micCtx.createGain();
    sink.gain.value = 0;
    micNode.connect(sink);
    sink.connect(micCtx.destination);
  }

  async function startTalking() {
    if (capturing || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      // Both contexts must be unlocked from inside a user gesture on iOS.
      await ensureMic();
      if (micCtx.state === "suspended") await micCtx.resume();
      var out = playbackContext();
      if (out.state === "suspended") await out.resume();
    } catch (err) {
      log("err", err.message);
      return;
    }

    pcmQueue = [];
    resampleTail = new Float32Array(0);
    resampleCursor = 0;
    capturing = true;
    talkEl.classList.add("rec");
    talkEl.textContent = "Listening — release to send";
    ws.send(JSON.stringify({ type: "audioStart" }));
  }

  function stopTalking() {
    if (!capturing) return;
    capturing = false;
    talkEl.classList.remove("rec");
    talkEl.textContent = "Hold to talk";
    // Worklet messages already posted are still in flight; give them a moment
    // so the tail of the utterance isn't cut off, then close the turn.
    setTimeout(function () {
      flushFrames();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audioInputEnd" }));
      log("sys", "sent audio");
    }, DRAIN_MS);
  }

  talkEl.addEventListener("pointerdown", function (ev) { ev.preventDefault(); startTalking(); });
  talkEl.addEventListener("pointerup", function (ev) { ev.preventDefault(); stopTalking(); });
  talkEl.addEventListener("pointercancel", stopTalking);
  talkEl.addEventListener("pointerleave", stopTalking);
  talkEl.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

  formEl.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    log("user", text, "you");
    ws.send(JSON.stringify({ type: "user", content: text }));
    inputEl.value = "";
  });

  // ---------- connection ----------
  var ws = null;
  var retryMs = 500;

  function connect() {
    setState("connecting…", false);
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      retryMs = 500;
      setState("connected", true);
      talkEl.disabled = false;
    };

    ws.onclose = function () {
      setState("disconnected — retrying", false);
      talkEl.disabled = true;
      capturing = false;
      talkEl.classList.remove("rec");
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };

    ws.onerror = function () { /* onclose handles recovery */ };

    ws.onmessage = function (ev) {
      if (ev.data instanceof ArrayBuffer) {
        enqueueAudio(ev.data);
        return;
      }
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { log("err", "bad frame: " + ev.data); return; }

      switch (msg.type) {
        case "sessionStart":
          log("sys", "session started");
          break;
        case "assistant":
          log("assistant", msg.content || "", "ixa");
          break;
        case "chunk":
          log("assistant", msg.content || "", "ixa");
          break;
        case "audioStart":
          playHead = 0;
          break;
        case "audioOutputEnd":
          break;
        case "confirm":
          askConfirm(msg);
          break;
        case "error":
          log("err", msg.content || "unknown error");
          break;
        case "sessionEnd":
          log("sys", "session ended (dismissed)");
          break;
        default:
          log("sys", "unhandled: " + msg.type);
      }
    };
  }

  function askConfirm(msg) {
    var row = log("assistant", msg.content || "Confirm?", "confirm");
    row.classList.add("confirm");
    ["yes", "no"].forEach(function (answer) {
      var btn = document.createElement("button");
      btn.textContent = answer;
      btn.onclick = function () {
        ws.send(JSON.stringify({ type: "confirmReply", content: answer, requestId: msg.requestId }));
        row.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
        log("sys", "answered " + answer);
      };
      row.appendChild(btn);
    });
  }

  connect();
})();
</script>
</body>
</html>`
}
