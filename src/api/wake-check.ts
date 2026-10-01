import { wakePipelineJs } from "./test-client"

/**
 * Validation harness for the in-browser wake word pipeline: runs every
 * tools/wakeword/fixtures/*.wav through the exact wakePipelineJs the /test
 * page ships, and compares its score curve frame-by-frame against the Python
 * openwakeword baseline (tools/wakeword/baseline.py) for the same clip.
 *
 * Open it on the target device itself (Safari on the iPhone) to validate
 * that device's onnxruntime-web. Results are also left on
 * window.__wakeCheck for headless runs.
 *
 * Like test-client.ts: inline, no build step, no template literals in the
 * page JS.
 */
export function renderWakeCheck(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ixa — wake word check</title>
<style>
  :root { color-scheme: dark; --bg:#111318; --panel:#1a1d24; --line:#2c313b; --fg:#e6e8ec; --dim:#8b93a3;
          --py:#5b8cff; --js:#ffb547; --ok:#39d353; --bad:#ff4d5e; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
         padding:calc(env(safe-area-inset-top) + 12px) 16px calc(env(safe-area-inset-bottom) + 16px); }
  h1 { font-size:16px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .dim { color:var(--dim); font-size:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; margin:12px 0; }
  .badge { font-size:11px; font-weight:700; letter-spacing:.05em; padding:2px 7px; border-radius:5px; }
  .pass { background:#173a22; color:var(--ok); } .fail { background:#3a1a20; color:var(--bad); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; margin:10px 0; font-size:13px; }
  dt { color:var(--dim); } dd { margin:0; font-variant-numeric:tabular-nums; }
  svg { width:100%; height:auto; display:block; }
  .legend span { display:inline-block; width:10px; height:3px; vertical-align:middle; margin:0 4px 0 10px; }
  .scroll { overflow-x:auto; max-height:360px; overflow-y:auto; }
  table { border-collapse:collapse; font-size:12px; font-variant-numeric:tabular-nums; width:100%; }
  th, td { padding:2px 8px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { position:sticky; top:0; background:var(--panel); color:var(--dim); font-weight:500; }
  tr.hot td { background:#20283a; } tr.warm td { color:var(--dim); }
  #status.err { color:var(--bad); }
</style>
</head>
<body>
<h1>Wake word pipeline check</h1>
<div class="dim">Browser (onnxruntime-web) vs Python openwakeword baseline, same clips, frame by frame. Warm-up frames are greyed out and not compared.</div>
<div id="env" class="dim"></div>
<div id="status">loading…</div>
<div id="results"></div>

<script src="/vendor/ort/ort.wasm.min.js"></script>
<script>${wakePipelineJs}</script>
<script>
(function () {
  "use strict";

  // Pass criteria. Scores are compared only after warm-up (Python's warm-up
  // state is random noise; this page's is different random noise).
  var MAX_ABS_DIFF = 0.02;

  var statusEl = document.getElementById("status");
  var resultsEl = document.getElementById("results");
  var result = { done: false, ok: null, env: {}, fixtures: [] };
  window.__wakeCheck = result;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function abs(path) { return new URL(path, location.href).href; }

  async function fetchOk(path) {
    var res = await fetch(abs(path));
    if (!res.ok) throw new Error(path + ": HTTP " + res.status);
    return res;
  }

  // Ground truth for the decode cross-check: the WAV's own int16 samples.
  function parsePcm16(buf) {
    var view = new DataView(buf);
    var off = 12;
    while (off + 8 <= view.byteLength) {
      var id = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
      var size = view.getUint32(off + 4, true);
      if (id === "data") return new Int16Array(buf.slice(off + 8, off + 8 + size));
      off += 8 + size + (size & 1);
    }
    throw new Error("no data chunk in WAV");
  }

  // The path under test: decodeAudioData into a 16kHz context (so no
  // resampling), then back to int16.
  async function decodeToInt16(buf) {
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new Ctx(1, 1, IxaWake.SAMPLE_RATE);
    var audio = await ctx.decodeAudioData(buf);
    if (audio.sampleRate !== IxaWake.SAMPLE_RATE) throw new Error("decoded at " + audio.sampleRate + "Hz");
    var f = audio.getChannelData(0);
    var out = new Int16Array(f.length);
    for (var i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)));
    return out;
  }

  function peakOf(frames, key) {
    var best = null;
    frames.forEach(function (fr) { if (!fr.warmup && (!best || fr[key] > best[key])) best = fr; });
    return best;
  }

  function crossings(frames, key, threshold) {
    return frames.filter(function (fr) { return !fr.warmup && fr[key] >= threshold; }).map(function (fr) { return fr.frame; });
  }

  async function runFixture(detector, fx) {
    var wavBuf = await (await fetchOk("/test/fixtures/" + fx.wav)).arrayBuffer();
    var baseline = await (await fetchOk("/test/fixtures/" + fx.baseline)).json();

    var pcm = parsePcm16(wavBuf.slice(0));
    var decoded = await decodeToInt16(wavBuf.slice(0));
    var decodeMismatches = Math.abs(pcm.length - decoded.length);
    for (var i = 0; i < Math.min(pcm.length, decoded.length); i++) if (pcm[i] !== decoded[i]) decodeMismatches++;

    await detector.reset();
    var chunk = IxaWake.CHUNK_SAMPLES;
    var nFrames = Math.floor(decoded.length / chunk);  // trailing partial chunk dropped, as in Python
    var frames = [];
    var msTotal = 0, msMax = 0;
    for (var n = 0; n < nFrames; n++) {
      var js = await detector.process(decoded.subarray(n * chunk, (n + 1) * chunk));
      msTotal += detector.lastMs;
      msMax = Math.max(msMax, detector.lastMs);
      var py = baseline.frames[n];
      frames.push({
        frame: n, tEnd: py ? py.tEnd : (n + 1) * chunk / IxaWake.SAMPLE_RATE,
        py: py ? py.score : NaN, js: js, warmup: py ? py.warmup : true,
        diff: py ? Math.abs(js - py.score) : NaN
      });
    }

    var compared = frames.filter(function (f) { return !f.warmup; });
    var worst = compared.reduce(function (a, f) { return !a || f.diff > a.diff ? f : a; }, null);
    var meanDiff = compared.reduce(function (s, f) { return s + f.diff; }, 0) / compared.length;
    var pyPeak = peakOf(frames, "py"), jsPeak = peakOf(frames, "js");
    var pyCross = crossings(frames, "py", baseline.threshold);
    var jsCross = crossings(frames, "js", baseline.threshold);

    var checks = {
      frameCount: nFrames === baseline.frames.length,
      decode: decodeMismatches === 0,
      sameCrossings: pyCross.join(",") === jsCross.join(","),
      // On a negative clip the "peak" is the max of near-zero noise, where
      // float-level differences can legitimately pick a different frame;
      // sameCrossings + maxAbsDiff already cover that case.
      samePeakFrame: pyPeak.py < baseline.threshold || pyPeak.frame === jsPeak.frame,
      maxAbsDiff: worst.diff <= MAX_ABS_DIFF
    };
    var ok = Object.keys(checks).every(function (k) { return checks[k]; });

    return {
      name: fx.wav, ok: ok, checks: checks, threshold: baseline.threshold,
      frameCount: { js: nFrames, py: baseline.frames.length }, decodeMismatches: decodeMismatches,
      compared: compared.length, maxAbsDiff: worst.diff, maxAbsDiffFrame: worst.frame, meanAbsDiff: meanDiff,
      peak: { py: { frame: pyPeak.frame, score: pyPeak.py }, js: { frame: jsPeak.frame, score: jsPeak.js } },
      crossings: { py: pyCross, js: jsCross },
      msPerChunk: { mean: msTotal / nFrames, max: msMax },
      frames: frames
    };
  }

  function fmt(v, d) { return isNaN(v) ? "—" : v.toFixed(d == null ? 5 : d); }

  function chart(r) {
    var W = 640, H = 200, P = 26;
    var n = r.frames.length;
    function x(i) { return P + (W - P - 6) * i / Math.max(1, n - 1); }
    function y(v) { return H - P - (H - P - 8) * v; }
    function line(key) {
      return r.frames.map(function (f, i) { return x(i).toFixed(1) + "," + y(f[key]).toFixed(1); }).join(" ");
    }
    var warmEnd = r.frames.filter(function (f) { return f.warmup; }).length;
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    function add(tag, attrs, text) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      svg.appendChild(e);
    }
    add("rect", { x: P, y: 8, width: x(warmEnd) - P, height: H - P - 8, fill: "#ffffff", "fill-opacity": "0.04" });
    [0, 0.5, 1].forEach(function (v) {
      add("line", { x1: P, x2: W - 6, y1: y(v), y2: y(v), stroke: "#2c313b", "stroke-dasharray": v === r.threshold ? "4 3" : "" });
      add("text", { x: P - 4, y: y(v) + 4, "text-anchor": "end", fill: "#8b93a3", "font-size": "10" }, String(v));
    });
    for (var s = 0; s <= n * IxaWake.CHUNK_SAMPLES / IxaWake.SAMPLE_RATE; s++) {
      var i = s * IxaWake.SAMPLE_RATE / IxaWake.CHUNK_SAMPLES - 1;
      if (i < 0) continue;
      add("text", { x: x(i), y: H - 8, "text-anchor": "middle", fill: "#8b93a3", "font-size": "10" }, s + "s");
    }
    add("polyline", { points: line("py"), fill: "none", stroke: "#5b8cff", "stroke-width": "3", "stroke-opacity": "0.7" });
    add("polyline", { points: line("js"), fill: "none", stroke: "#ffb547", "stroke-width": "1.5" });
    return svg;
  }

  function render(r) {
    var card = el("div", { class: "card" });
    var h = el("h2");
    h.appendChild(el("span", { class: "badge " + (r.ok ? "pass" : "fail") }, r.ok ? "PASS" : "FAIL"));
    h.appendChild(el("span", null, r.name));
    card.appendChild(h);

    var legend = el("div", { class: "dim legend" });
    legend.innerHTML = '<span style="background:#5b8cff"></span>Python <span style="background:#ffb547"></span>browser';
    card.appendChild(legend);
    card.appendChild(chart(r));

    var dl = el("dl");
    function row(k, v, good) {
      dl.appendChild(el("dt", null, k));
      var dd = el("dd", null, v);
      if (good === false) dd.style.color = "var(--bad)";
      dl.appendChild(dd);
    }
    row("frames", r.frameCount.js + " browser / " + r.frameCount.py + " python (" + r.compared + " compared)", r.checks.frameCount);
    row("decode", r.decodeMismatches === 0 ? "decodeAudioData matches raw PCM exactly" : r.decodeMismatches + " samples differ from raw PCM", r.checks.decode);
    row("max |Δ|", fmt(r.maxAbsDiff) + " at frame " + r.maxAbsDiffFrame + " (limit " + MAX_ABS_DIFF + ")", r.checks.maxAbsDiff);
    row("mean |Δ|", fmt(r.meanAbsDiff, 6));
    row("peak", "python " + fmt(r.peak.py.score, 4) + " @ frame " + r.peak.py.frame + "  ·  browser " + fmt(r.peak.js.score, 4) + " @ frame " + r.peak.js.frame, r.checks.samePeakFrame);
    row("≥ " + r.threshold, "python [" + r.crossings.py.join(", ") + "]  ·  browser [" + r.crossings.js.join(", ") + "]", r.checks.sameCrossings);
    row("ms / chunk", fmt(r.msPerChunk.mean, 1) + " mean, " + fmt(r.msPerChunk.max, 1) + " max (budget 80)");
    card.appendChild(dl);

    var details = el("details");
    details.appendChild(el("summary", { class: "dim" }, "all frames"));
    var wrap = el("div", { class: "scroll" });
    var table = el("table");
    var head = el("tr");
    ["frame", "t", "python", "browser", "|Δ|"].forEach(function (t) { head.appendChild(el("th", null, t)); });
    table.appendChild(head);
    r.frames.forEach(function (f) {
      var tr = el("tr", { class: f.warmup ? "warm" : (f.py >= r.threshold || f.js >= r.threshold ? "hot" : "") });
      [String(f.frame), f.tEnd.toFixed(2) + "s", fmt(f.py), fmt(f.js), fmt(f.diff, 6)].forEach(function (t) { tr.appendChild(el("td", null, t)); });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    details.appendChild(wrap);
    card.appendChild(details);
    resultsEl.appendChild(card);
  }

  async function main() {
    result.env = {
      userAgent: navigator.userAgent,
      crossOriginIsolated: !!window.crossOriginIsolated,
      ortVersion: window.ort && ort.env.versions ? ort.env.versions.web : "?"
    };
    document.getElementById("env").textContent =
      "onnxruntime-web " + result.env.ortVersion + " · crossOriginIsolated=" + result.env.crossOriginIsolated + " · " + result.env.userAgent;

    var t0 = performance.now();
    var detector = await IxaWake.create({ ortBaseUrl: abs("/vendor/ort/"), modelBaseUrl: abs("/models/") });
    result.loadMs = performance.now() - t0;

    var fixtures = await (await fetchOk("/test/fixtures")).json();
    if (!fixtures.length) throw new Error("no fixtures in tools/wakeword/fixtures (need <name>.wav + <name>.baseline.json)");
    for (var i = 0; i < fixtures.length; i++) {
      statusEl.textContent = "running " + fixtures[i].wav + "…";
      var r = await runFixture(detector, fixtures[i]);
      result.fixtures.push(r);
      render(r);
    }
    result.ok = result.fixtures.every(function (r) { return r.ok; });
    statusEl.textContent = (result.ok ? "All fixtures match." : "MISMATCH — see failing checks below.") +
      " Models + runtime loaded in " + Math.round(result.loadMs) + "ms.";
  }

  main().catch(function (err) {
    result.ok = false;
    result.error = String(err && err.stack || err);
    statusEl.className = "err";
    statusEl.textContent = "Error: " + (err && err.message || err);
  }).then(function () { result.done = true; });
})();
</script>
</body>
</html>`
}
