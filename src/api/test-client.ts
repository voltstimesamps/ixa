/**
 * A single self-contained page for poking the voice loop from a phone over
 * Tailscale. Listens for "Hey Ixa" locally in the browser while the tab is in
 * the foreground (a browser can't keep the mic in the background), mirroring
 * the desktop client's ConversationGate: asleep, audio only reaches the
 * on-device wake word model and nothing is sent; a wake streams turns to the
 * harness until the conversation times out or is dismissed.
 *
 * Turn endpointing is a placeholder: the user taps to end each turn, where
 * the desktop client uses Silero VAD. endTurn() is the single place a turn
 * ends, so VAD can drive it later without restructuring anything.
 *
 * No build step: the page JS is inline, and onnxruntime-web plus the models
 * are served by rest.ts (see static-assets.ts). The page JS deliberately
 * avoids template literals so it can live inside this one.
 *
 * Audio contract, matching src/api/types.ts and src/voice/stt.ts:
 *   out: {type:"audioStart"} -> raw 16kHz mono int16 PCM frames -> {type:"audioInputEnd"}
 *   in:  {type:"audioStart"} -> one standalone 24kHz WAV blob per chunk -> {type:"audioOutputEnd"}
 */

/**
 * Browser port of openWakeWord's streaming pipeline — openwakeword 0.6.0's
 * utils.py AudioFeatures._streaming_features() and model.py Model.predict()
 * — exactly as clients/desktop/wakeword.py drives it: one call per
 * 1280-sample chunk, so only the n_prepared_samples == 1280 path is ported.
 *
 * Python keeps longer histories (10s raw, 970 mel frames, 120 embeddings)
 * but only ever reads the newest 1760 samples / 76 frames / 16 embeddings,
 * so this keeps just those. Validated frame-by-frame against
 * tools/wakeword/baseline.py on /test/wake-check.
 *
 * Shared verbatim by the /test page and the /test/wake-check harness, so the
 * harness validates the code that ships. Defines a global IxaWake; needs
 * onnxruntime-web's ort.wasm.min.js loaded first. Embedded in a template
 * literal, so: no backticks, no dollar-brace, no backslashes.
 */
export const wakePipelineJs = `
var IxaWake = (function () {
  "use strict";

  var SAMPLE_RATE = 16000;
  var CHUNK_SAMPLES = 1280;       // 80ms: one Model.predict() step
  var MEL_CONTEXT_SAMPLES = 480;  // _streaming_melspectrogram reads raw[-(n + 160*3):]
  var MEL_BINS = 32;
  var MEL_WINDOW = 76;            // embedding_model input [1, 76, 32, 1]
  var MEL_STRIDE = 8;             // _get_embeddings window step (= mel frames per chunk)
  var EMBED_DIM = 96;
  var FEATURE_WINDOW = 16;        // hey_ixa.onnx input [1, 16, 96]
  var ZEROED_PREDICTIONS = 5;     // Model.predict() zeroes its first 5 scores
  var NOISE_SAMPLES = 64000;      // AudioFeatures warm-up: randint(-1000, 1000, 16000*4)

  // AudioFeatures' default melspec_transform (x/10 + 2), rounded at each step
  // the way numpy's float32 arithmetic does.
  function melTransform(v) { return Math.fround(Math.fround(v / 10) + 2); }

  function Detector(ort, mel, emb, cls) {
    this._ort = ort;
    this._mel = mel;
    this._emb = emb;
    this._cls = cls;
    this._queue = Promise.resolve();
    this.backlog = 0;     // chunks queued but not yet scored
    this.lastMs = 0;      // wall time of the most recent process() step
  }

  // Runs steps strictly one at a time, in call order: each chunk's mel/
  // embedding state depends on every chunk before it, so nothing may overlap
  // or be dropped.
  Detector.prototype._enqueue = function (step) {
    var self = this;
    self.backlog++;
    var run = self._queue.then(step);
    self._queue = run.then(done, done);
    function done() { self.backlog--; }
    return run;
  };

  Detector.prototype._melFrames = async function (samples) {
    var out = await this._mel.run({ input: new this._ort.Tensor("float32", samples, [1, samples.length]) });
    var t = out[this._mel.outputNames[0]];  // [1, 1, frames, 32]
    var spec = new Float32Array(t.data.length);
    for (var i = 0; i < spec.length; i++) spec[i] = melTransform(t.data[i]);
    return { data: spec, frames: t.dims[2] };
  };

  Detector.prototype._embed = async function (windows, batch) {
    var out = await this._emb.run({
      input_1: new this._ort.Tensor("float32", windows, [batch, MEL_WINDOW, MEL_BINS, 1])
    });
    return new Float32Array(out[this._emb.outputNames[0]].data);  // [batch, 1, 1, 96]
  };

  // AudioFeatures.reset() + Model.reset().
  Detector.prototype._resetNow = async function () {
    this._rawTail = new Float32Array(0);
    this._melWindow = new Float32Array(MEL_WINDOW * MEL_BINS).fill(1);  // np.ones((76, 32))

    // feature_buffer starts as embeddings of random noise. Python windows the
    // noise's melspectrogram every 8 frames (dropping short windows) into 41
    // embeddings; only the newest 16 can ever reach the classifier.
    var noise = new Float32Array(NOISE_SAMPLES);
    for (var i = 0; i < NOISE_SAMPLES; i++) noise[i] = Math.floor(Math.random() * 2000) - 1000;
    var spec = await this._melFrames(noise);
    var nWindows = Math.floor((spec.frames - MEL_WINDOW) / MEL_STRIDE) + 1;
    var windowSize = MEL_WINDOW * MEL_BINS;
    var batch = new Float32Array(FEATURE_WINDOW * windowSize);
    for (var k = 0; k < FEATURE_WINDOW; k++) {
      var start = (nWindows - FEATURE_WINDOW + k) * MEL_STRIDE * MEL_BINS;
      batch.set(spec.data.subarray(start, start + windowSize), k * windowSize);
    }
    this._features = await this._embed(batch, FEATURE_WINDOW);
    this._predictions = 0;
  };

  Detector.prototype._processNow = async function (chunk) {
    if (chunk.length !== CHUNK_SAMPLES) {
      throw new Error("IxaWake.process needs exactly " + CHUNK_SAMPLES + " samples, got " + chunk.length);
    }
    var t0 = performance.now();

    // Raw audio -> melspectrogram: this chunk plus up to 480 samples of the
    // previous one, as int16-valued float32 (no scaling). The very first
    // chunk has no context, so it yields 5 mel frames instead of 8 — same as
    // Python.
    var raw = new Float32Array(this._rawTail.length + CHUNK_SAMPLES);
    raw.set(this._rawTail, 0);
    for (var i = 0; i < CHUNK_SAMPLES; i++) raw[this._rawTail.length + i] = chunk[i];
    this._rawTail = raw.slice(Math.max(0, raw.length - MEL_CONTEXT_SAMPLES));

    var spec = await this._melFrames(raw);
    var shift = Math.min(spec.frames, MEL_WINDOW) * MEL_BINS;
    this._melWindow.copyWithin(0, shift);
    this._melWindow.set(spec.data.subarray(spec.data.length - shift), this._melWindow.length - shift);

    // Newest 76 mel frames -> one embedding, appended to the feature window.
    var embedding = await this._embed(this._melWindow.slice(), 1);
    this._features.copyWithin(0, EMBED_DIM);
    this._features.set(embedding, (FEATURE_WINDOW - 1) * EMBED_DIM);

    // Newest 16 embeddings -> wake score. Raw score, no smoothing.
    var feeds = {};
    feeds[this._cls.inputNames[0]] = new this._ort.Tensor("float32", this._features.slice(), [1, FEATURE_WINDOW, EMBED_DIM]);
    var out = await this._cls.run(feeds);
    var score = out[this._cls.outputNames[0]].data[0];

    if (this._predictions < ZEROED_PREDICTIONS) {
      this._predictions++;
      score = 0;
    }
    this.lastMs = performance.now() - t0;
    return score;
  };

  /** chunk: exactly 1280 int16-valued samples (Int16Array or similar). Resolves to the wake score. */
  Detector.prototype.process = function (chunk) {
    var self = this;
    return self._enqueue(function () { return self._processNow(chunk); });
  };

  /** Back to the just-loaded state (fresh warm-up noise, first 5 scores zeroed). */
  Detector.prototype.reset = function () {
    var self = this;
    return self._enqueue(function () { return self._resetNow(); });
  };

  // opts.ortBaseUrl / opts.modelBaseUrl: URL prefixes ending in "/".
  async function create(opts) {
    var ort = window.ort;
    // Single-threaded wasm: no SharedArrayBuffer, so no COOP/COEP headers.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = opts.ortBaseUrl;
    var options = { executionProviders: ["wasm"] };
    var mel = await ort.InferenceSession.create(opts.modelBaseUrl + "melspectrogram.onnx", options);
    var emb = await ort.InferenceSession.create(opts.modelBaseUrl + "embedding_model.onnx", options);
    var cls = await ort.InferenceSession.create(opts.modelBaseUrl + "hey_ixa.onnx", options);
    var detector = new Detector(ort, mel, emb, cls);
    await detector.reset();
    return detector;
  }

  return { create: create, SAMPLE_RATE: SAMPLE_RATE, CHUNK_SAMPLES: CHUNK_SAMPLES };
})();
`

export function renderTestClient(wsPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Ixa — test client</title>
<link rel="icon" href="data:,">
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
  #talk.awake { background:#2f6f45; }
  #talk:disabled { background:#333a46; color:var(--dim); }
  #wake { display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:12px; color:var(--dim);
          font-variant-numeric:tabular-nums; }
  #meter { position:relative; flex:1; height:6px; border-radius:3px; background:var(--panel); border:1px solid var(--line); overflow:hidden; }
  #meterFill { position:absolute; left:0; top:0; bottom:0; width:0; background:var(--accent); }
  #meter::after { content:""; position:absolute; top:0; bottom:0; left:50%; width:1px; background:var(--dim); }
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

<div id="wake"><span id="wakeText">wake word: loading models…</span><div id="meter"><div id="meterFill"></div></div></div>

<button id="talk">Start listening</button>

<form id="textForm" autocomplete="off">
  <input id="textInput" placeholder="…or type a message" enterkeyhint="send">
  <button type="submit">Send</button>
</form>

<footer id="conn"></footer>

<script src="/vendor/ort/ort.wasm.min.js"></script>
<script>${wakePipelineJs}</script>
<script>
(function () {
  "use strict";

  var WS_PORT = ${wsPort};

  var MIC_RATE = 16000;      // src/voice/stt.ts pcmToWav() hardcodes 16kHz mono int16
  var FRAME_SAMPLES = 1024;  // ~64ms per binary frame; the server just concatenates
  var DRAIN_MS = 80;         // let in-flight AudioWorklet messages land before audioInputEnd

  // Mirrored from the desktop client — tune there first, then copy here.
  var WAKE_THRESHOLD = 0.5;             // client.py IXA_WAKE_THRESHOLD default
  // PROVISIONAL, pending the Framework 13 live test: see the rationale on
  // WAKE_CONSECUTIVE_FRAMES in clients/desktop/conversation.py.
  var WAKE_CONSECUTIVE_FRAMES = 2;      // clients/desktop/conversation.py
  var CONVERSATION_TIMEOUT_MS = 20000;  // clients/desktop/conversation.py
  var WAKE_CHIME_HZ = 880;              // client.py
  var WAKE_CHIME_MS = 120;

  var logEl = document.getElementById("log");
  var dotEl = document.getElementById("dot");
  var stateEl = document.getElementById("stateText");
  var talkEl = document.getElementById("talk");
  var connEl = document.getElementById("conn");
  var formEl = document.getElementById("textForm");
  var inputEl = document.getElementById("textInput");
  var meterFillEl = document.getElementById("meterFill");
  var wakeTextEl = document.getElementById("wakeText");

  function abs(path) { return new URL(path, location.href).href; }

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

  // audioOutputEnd only means the last chunk arrived; it may still be
  // decoding or scheduled ahead. Resolve once the speaker has gone quiet.
  function whenPlaybackDone(fn) {
    playChain.then(function () {
      var remaining = outCtx ? Math.max(0, playHead - outCtx.currentTime) : 0;
      setTimeout(fn, remaining * 1000);
    });
  }

  // Local-only confirmation that the wake word fired, like client.py's
  // playChime(): no server round trip, so it's instant.
  function playChime() {
    var ctx = playbackContext();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.frequency.value = WAKE_CHIME_HZ;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + WAKE_CHIME_MS / 1000);
  }

  // ---------- capture ----------
  var micStream = null;
  var micCtx = null;
  var micNode = null;
  var srcNode = null;
  var turnOpen = false;    // a turn is streaming: between audioStart and audioInputEnd
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

  // One 16kHz int16 stream, routed by state: an open turn streams it to the
  // harness; asleep, it only ever reaches the on-device wake word model.
  function onSamples(float32, srcRate) {
    var resampled = toMicRate(float32, srcRate);
    if (speaking) return;  // mic dropped entirely during playback, like client.py's isSpeaking

    var pcm = new Int16Array(resampled.length);
    for (var i = 0; i < resampled.length; i++) {
      var s = Math.max(-1, Math.min(1, resampled[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    if (turnOpen) {
      for (var j = 0; j < pcm.length; j++) pcmQueue.push(pcm[j]);
      while (pcmQueue.length >= FRAME_SAMPLES) sendFrame(FRAME_SAMPLES);
    } else if (mode === "asleep") {
      pushWakeSamples(pcm);
    }
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

    // Raw mic by default, matching the desktop client's sounddevice capture
    // (openWakeWord sees unprocessed audio there). Echo cancellation buys
    // nothing here, since the mic is dropped entirely while Ixa speaks. Not a
    // false-wake fix: in a fake-mic soak, raw and processed both falsely woke
    // on quiet room tone. ?dsp=on restores the browser's auto-gain/noise
    // suppression/echo cancellation for A/B comparison on a real device.
    var dsp = new URLSearchParams(location.search).get("dsp") === "on";
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: dsp, noiseSuppression: dsp, autoGainControl: dsp }
    });

    var Ctx = window.AudioContext || window.webkitAudioContext;
    // Ask for 16kHz so no resampling is needed; iOS often ignores this, hence
    // toMicRate() above.
    try { micCtx = new Ctx({ sampleRate: MIC_RATE }); } catch (e) { micCtx = new Ctx(); }

    srcNode = micCtx.createMediaStreamSource(micStream);

    var rate = micCtx.sampleRate;
    // Worth knowing on each device: the wake word model is sensitive to the
    // 4-8kHz band in quiet audio, and toMicRate() is plain linear
    // interpolation with no anti-aliasing filter.
    log("sys", "mic " + rate + "Hz" + (rate === MIC_RATE ? " (no resampling)" : ", resampled to 16kHz in JS") +
      " · processing " + (dsp ? "on (?dsp=on)" : "off (raw, like the desktop client)"));
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

  // ---------- wake word + conversation state ----------
  // Mirrors clients/desktop/conversation.py's ConversationGate:
  //   "asleep": mic audio only reaches the on-device wake word model.
  //   "awake":  turns stream to the harness, until CONVERSATION_TIMEOUT_MS of
  //             inactivity or a spoken dismiss (sessionEnd) puts it back to sleep.
  // "off" (mic not started, or iOS suspended it) and "loading" are page-only.
  var mode = "off";
  var speaking = false;       // assistant audio playing (client.py's isSpeaking)
  var awaitingReply = false;  // turn sent, reply not started yet
  var timeoutId = null;
  var wakeError = null;

  // Starts downloading the runtime + models right away (no gesture needed),
  // so "Start listening" usually doesn't wait on the network.
  var detectorReady = IxaWake.create({ ortBaseUrl: abs("/vendor/ort/"), modelBaseUrl: abs("/models/") });
  var detector = null;
  detectorReady.then(function (d) { detector = d; render(); }, function (err) {
    wakeError = "wake word unavailable: " + (err && err.message || err);
    log("err", wakeError);
    render();
  });

  // Same FrameBuffer idea as client.py: the detector takes exactly 1280 samples.
  var wakeChunk = new Int16Array(IxaWake.CHUNK_SAMPLES);
  var wakeFill = 0;
  var wakeGeneration = 0;  // bumped on every reset, so stale in-flight scores are ignored
  var wakeRun = 0;         // consecutive frames >= WAKE_THRESHOLD in this generation

  function pushWakeSamples(pcm) {
    for (var i = 0; i < pcm.length; i++) {
      wakeChunk[wakeFill++] = pcm[i];
      if (wakeFill === wakeChunk.length) {
        scoreWakeChunk(wakeChunk);
        wakeChunk = new Int16Array(IxaWake.CHUNK_SAMPLES);
        wakeFill = 0;
      }
    }
  }

  function scoreWakeChunk(chunk) {
    var generation = wakeGeneration;
    detector.process(chunk).then(function (score) {
      // Chunks queued before a wake or reset still finish scoring; only the
      // current, still-asleep generation may act on its score.
      if (generation !== wakeGeneration || mode !== "asleep" || speaking) return;
      meterFillEl.style.width = Math.min(100, score * 100) + "%";
      wakeTextEl.textContent = "wake " + score.toFixed(3) + " · " + detector.lastMs.toFixed(1) + "ms";
      // WAKE_CONSECUTIVE_FRAMES in a row over threshold, like
      // ConversationGate.handle_wake_frame. Scores arrive strictly in chunk
      // order (the detector's queue), so a plain counter is enough.
      wakeRun = score >= WAKE_THRESHOLD ? wakeRun + 1 : 0;
      if (wakeRun >= WAKE_CONSECUTIVE_FRAMES) wake(score);
    }, function (err) {
      log("err", "wake word inference failed: " + err.message);
    });
  }

  // (Re)start feeding the wake word model. Any gap in the audio it has seen —
  // being awake, the assistant speaking, the tab hidden — leaves its 1.28s
  // window holding stale audio (e.g. the phrase that last woke it), so it
  // always starts fresh, like WakeWordDetector.reset() on the desktop.
  function resumeWakeListening() {
    wakeGeneration++;
    wakeFill = 0;
    wakeRun = 0;
    meterFillEl.style.width = "0";
    detector.reset();  // queued ahead of any chunk pushed after this
  }

  function wake(score) {
    if (mode !== "asleep") return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("sys", "heard the wake word (" + score.toFixed(2) + ") but not connected");
      resumeWakeListening();
      return;
    }
    log("sys", "wake word (" + score.toFixed(2) + ")");
    mode = "awake";
    playChime();
    openTurn();
  }

  function sleep(reason) {
    if (mode !== "awake") return;
    clearTimeout(timeoutId);
    if (turnOpen) abandonTurn();
    awaitingReply = false;
    mode = "asleep";
    log("sys", "asleep (" + reason + ") — say “Hey Ixa”");
    if (!speaking) resumeWakeListening();  // else: once playback ends
    render();
  }

  // Placeholder for the desktop's VAD-silence timeout: 20s of no activity,
  // restarted on wake, on each turn end and when each reply finishes playing,
  // and paused while Ixa speaks. An open turn counts as inactivity, since
  // there's no VAD yet to tell talking from silence.
  function armTimeout() {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(function () { if (!speaking) sleep("timed out"); }, CONVERSATION_TIMEOUT_MS);
  }

  function openTurn() {
    if (turnOpen || mode !== "awake" || !ws || ws.readyState !== WebSocket.OPEN) return;
    pcmQueue = [];
    turnOpen = true;
    awaitingReply = false;
    ws.send(JSON.stringify({ type: "audioStart" }));
    armTimeout();
    render();
  }

  // The single place a turn ends. Today the "done" tap calls it; once the
  // browser has Silero VAD, trailing silence will call it instead.
  function endTurn() {
    if (!turnOpen) return;
    turnOpen = false;
    awaitingReply = true;
    armTimeout();
    render();
    // Worklet messages already posted are still in flight; give them a moment
    // so the tail of the utterance isn't cut off, then close the turn.
    setTimeout(function () {
      flushFrames();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audioInputEnd" }));
      log("sys", "sent audio");
    }, DRAIN_MS);
  }

  // Drop an open turn without transcribing it: no audioInputEnd, so the
  // harness discards the partial audio on the next audioStart. (Sending it
  // would hand whisper mostly silence, which it tends to "hear" as words.)
  function abandonTurn() {
    turnOpen = false;
    pcmQueue = [];
  }

  function onReplyStart() {
    speaking = true;
    clearTimeout(timeoutId);
    if (turnOpen) abandonTurn();  // e.g. a typed message's reply while a turn was open
    awaitingReply = false;
    render();
  }

  function onReplyDone() {
    speaking = false;
    if (mode === "awake") openTurn();             // conversation mode: next turn, no wake word
    else if (mode === "asleep") resumeWakeListening();
    render();
  }

  async function startListening() {
    if (mode !== "off") return;
    mode = "loading";
    render();
    try {
      // Both contexts must be unlocked from inside a user gesture on iOS, so
      // this happens before anything else is awaited.
      await ensureMic();
      if (micCtx.state !== "running") await micCtx.resume();
      var out = playbackContext();
      if (out.state !== "running") await out.resume();
      await detectorReady;
    } catch (err) {
      mode = "off";
      log("err", err.message);
      render();
      return;
    }
    mode = "asleep";
    resumeWakeListening();
    log("sys", "listening for “Hey Ixa” — nothing is sent until it hears it");
    render();
  }

  // Foreground only: iOS stops the mic in a background tab. Leaving ends any
  // conversation; coming back resumes wake listening from a clean slate, or
  // asks for a tap if iOS won't restart audio without a gesture.
  document.addEventListener("visibilitychange", function () {
    if (mode === "off" || mode === "loading") return;
    if (document.hidden) {
      sleep("tab hidden");
      return;
    }
    micCtx.resume().catch(function () {}).then(function () {
      if (micCtx.state !== "running") {
        mode = "off";
        log("sys", "audio paused by the browser — tap to resume listening");
      } else if (mode === "asleep" && !speaking) {
        resumeWakeListening();
      }
      render();
    });
  });

  function render() {
    var connected = !!ws && ws.readyState === WebSocket.OPEN;
    var label, cls = "", disabled = true;
    if (mode === "off") {
      label = wakeError ? "Wake word unavailable" : (micNode ? "Tap to resume listening" : "Start listening");
      disabled = !!wakeError;
    } else if (mode === "loading") {
      label = detector ? "Starting mic…" : "Loading wake word…";
    } else if (speaking) {
      label = "Ixa is speaking…";
    } else if (mode === "asleep") {
      label = "Say “Hey Ixa”";
    } else if (turnOpen) {
      label = "Listening — tap when done";
      cls = "rec";
      disabled = false;
    } else if (awaitingReply) {
      label = "Thinking…";
      cls = "awake";
    } else {
      label = connected ? "Awake" : "Awake — reconnecting…";
      cls = "awake";
    }
    talkEl.textContent = label;
    talkEl.className = cls;
    talkEl.disabled = disabled;
    if (mode !== "asleep" || speaking) {
      meterFillEl.style.width = "0";
      wakeTextEl.textContent = wakeError ? "wake word: unavailable"
        : !detector ? "wake word: loading models…"
        : mode === "awake" ? "wake word: awake" : "wake word: ready";
    }
  }

  talkEl.addEventListener("click", function () {
    if (mode === "off") startListening();
    else if (turnOpen) endTurn();
  });

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
      render();
    };

    ws.onclose = function () {
      setState("disconnected — retrying", false);
      // A reconnect gets a fresh server-side Session, so the conversation is
      // over either way; and an audioOutputEnd that will never arrive must
      // not leave the mic dropped forever.
      sleep("disconnected");
      if (speaking) whenPlaybackDone(onReplyDone);
      render();
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
          // An empty reply has no audio to wait for: straight to the next turn.
          if (!(msg.content || "").trim() && awaitingReply) openTurn();
          break;
        case "chunk":
          log("assistant", msg.content || "", "ixa");
          break;
        case "audioStart":
          playHead = 0;
          onReplyStart();
          break;
        case "audioOutputEnd":
          whenPlaybackDone(onReplyDone);
          break;
        case "confirm":
          askConfirm(msg);
          break;
        case "error":
          log("err", msg.content || "unknown error");
          // e.g. "Transcription failed": let the user just say it again.
          if (awaitingReply) openTurn();
          break;
        case "sessionEnd":
          // Spoken dismiss, detected server-side; "Goodbye." may still be
          // playing, and wake listening resumes once it finishes.
          sleep("dismissed");
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

  render();
  connect();
})();
</script>
</body>
</html>`
}
