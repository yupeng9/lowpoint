// pose.js - in-browser pose extraction with MediaPipe tasks-vision 1.1.0 (vendored).
//
//   import { extractPose } from './js/pose.js';
//   const r = await extractPose(file, { model: 'full', onProgress: p => ..., signal });
//   // r = { lm: [n][33][x,y,z,vis] (normalized, NaN where no pose), fps, w, h, n, start, end, srcFps, ... }
//
// Frame i of the result is the source instant start + (i + 0.5) / fps, i.e. the same frame as frame i of
// `ffmpeg -vf fps=<fps>` / the Python pipeline (which uses frame i at i/fps of a CFR clip).
// All URLs are relative to this module, so it works under /lowpoint/ on GitHub Pages and on the local server.

const VENDOR = new URL('../vendor/mediapipe/', import.meta.url).href;
const MODELS = {
  full: new URL('../models/pose_landmarker_full.task', import.meta.url).href,
  lite: new URL('../models/pose_landmarker_lite.task', import.meta.url).href,
};
export const MAX_SECONDS = 20;
const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 100, 120, 240];

let visionMod = null;      // Promise<module>
let fileset = null;        // Promise<WasmFileset>
let lmkState = null;       // { model, delegate, promise }
let tsCursor = 0;          // VIDEO mode needs monotonically increasing timestamps (ms) across calls
let queue = Promise.resolve();  // serialize calls (one shared landmarker)

function abortError() { return new DOMException('Pose extraction cancelled', 'AbortError'); }
function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadVision() {
  if (!visionMod) visionMod = import(VENDOR + 'vision_bundle.mjs');
  const vision = await visionMod;
  // FilesetResolver probes WebAssembly SIMD and picks vision_wasm_internal.* or vision_wasm_nosimd_internal.*
  // (nosimd = iOS < 16.4 and other old engines).
  if (!fileset) fileset = vision.FilesetResolver.forVisionTasks(VENDOR + 'wasm');
  return { vision, files: await fileset };
}

/** Lazy-load (and cache) the PoseLandmarker. GPU delegate first, CPU fallback. */
export async function getLandmarker(model = 'full') {
  if (!MODELS[model]) throw new Error(`unknown model "${model}"`);
  if (lmkState && lmkState.model === model) return lmkState.promise;
  if (lmkState) {
    const old = lmkState.promise;
    lmkState = null;
    old.then(l => l.close()).catch(() => {});
  }
  const state = { model, delegate: null, promise: null };
  state.promise = (async () => {
    const { vision, files } = await loadVision();
    const make = delegate => vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODELS[model], delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    try {
      const l = await make('GPU');
      state.delegate = 'GPU';
      return l;
    } catch (e) {
      console.warn('[pose] GPU delegate failed, falling back to CPU:', e);
      const l = await make('CPU');
      state.delegate = 'CPU';
      return l;
    }
  })();
  state.promise.catch(() => { if (lmkState === state) lmkState = null; });
  lmkState = state;
  return state.promise;
}

// ------------------------------------------------------------------ video helpers
function waitEvent(el, ok, { timeout = 10000, signal, fail = ['error'] } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, v) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      fail.forEach(f => el.removeEventListener(f, onFail));
      signal && signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onOk = () => done(resolve, true);
    const onFail = () => done(reject, new Error(`video ${ok} failed: ${el.error ? el.error.message || el.error.code : 'error'}`));
    const onAbort = () => done(reject, abortError());
    el.addEventListener(ok, onOk);
    fail.forEach(f => el.addEventListener(f, onFail));
    signal && signal.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(resolve, false), timeout);  // resolve(false) = timed out
  });
}

function makeVideo(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('muted', '');
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  // iOS Safari only decodes frames for videos that are in the DOM and "visible" - keep it 1 px, transparent,
  // in-viewport (not display:none / visibility:hidden / far offscreen).
  Object.assign(v.style, {
    position: 'fixed', left: '0', top: '0', width: '2px', height: '2px',
    opacity: '0.01', pointerEvents: 'none', zIndex: '-1',
  });
  v.src = url;
  document.body.appendChild(v);
  v.load();
  return v;
}

const hasRVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/** Seek and wait until the frame is decoded/presented. Returns presented mediaTime (or null). */
async function seekFrame(v, t, signal, timeout = 4000) {
  let mediaTime = null, cbId = null;
  const frameP = hasRVFC
    ? new Promise(res => { cbId = v.requestVideoFrameCallback((_, m) => { mediaTime = m.mediaTime; res(true); }); })
    : null;
  const seekedP = waitEvent(v, 'seeked', { timeout, signal });
  v.currentTime = t;
  let ok = await seekedP;
  if (!ok) {  // seeked never fired (iOS hiccup) - nudge once and retry
    v.currentTime = t + 1e-4;
    ok = await waitEvent(v, 'seeked', { timeout, signal });
    if (!ok) throw new Error(`seek to ${t.toFixed(3)}s timed out`);
  }
  if (frameP) {
    // rVFC fires once the new frame is composited. If the seek landed on the frame already shown, no callback
    // comes - cap the wait.
    const got = await Promise.race([frameP, sleep(250).then(() => false)]);
    if (!got && cbId !== null) v.cancelVideoFrameCallback(cbId);
  }
  return mediaTime;
}

function snapFps(f) {
  for (const c of COMMON_FPS) if (Math.abs(f - c) / c < 0.06) return c;
  return Math.round(f);
}

/** Estimate the source fps from rVFC mediaTime deltas during a short slowed, muted play. */
async function detectFps(v, signal, at = 0) {
  if (!hasRVFC) return { fps: null, method: 'none' };
  const times = [];
  let id = null, stop = false;
  const cb = (_, m) => { times.push(m.mediaTime); if (!stop) id = v.requestVideoFrameCallback(cb); };
  try {
    await seekFrame(v, at, signal);
    v.playbackRate = 0.25;  // 240 fps * 0.25 = 60 presented frames/s, so no frames are skipped at 60 Hz
    id = v.requestVideoFrameCallback(cb);
    await v.play();
    const t0 = performance.now();
    while (performance.now() - t0 < 1500 && times.length < 24) { checkAbort(signal); await sleep(50); }
  } catch (e) {
    if (e && e.name === 'AbortError' && signal && signal.aborted) throw e;
    console.warn('[pose] fps probe play() failed:', e);
  } finally {
    stop = true;
    if (id !== null) v.cancelVideoFrameCallback(id);
    v.pause();
    v.playbackRate = 1;
  }
  const d = [];
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 1e-4) d.push(x); }
  if (d.length < 3) return { fps: null, method: 'rvfc-failed' };
  d.sort((a, b) => a - b);
  const q = d[Math.floor(d.length * 0.25)];  // low quantile: skipped frames only make deltas larger
  return { fps: snapFps(1 / q), method: 'rvfc', raw: 1 / q };
}

// ------------------------------------------------------------------ main API
/**
 * @param {File|Blob} fileOrBlob video
 * @param {{model?:'full'|'lite', targetFps?:number, start?:number, end?:number, maxDim?:number,
 *          onProgress?:(p:{stage:string, frac:number, i?:number, n?:number, msPerFrame?:number})=>void,
 *          signal?:AbortSignal}} opts
 */
export function extractPose(fileOrBlob, opts = {}) {
  const run = queue.then(() => extractPoseImpl(fileOrBlob, opts));
  queue = run.catch(() => {});
  return run;
}

async function extractPoseImpl(blob, { model = 'full', targetFps, start, end, maxDim = 1280, onProgress, signal } = {}) {
  const progress = p => { try { onProgress && onProgress(p); } catch (e) { console.error(e); } };
  checkAbort(signal);
  progress({ stage: 'load', frac: 0 });
  const lmkP = getLandmarker(model);
  const url = URL.createObjectURL(blob);
  const v = makeVideo(url);
  try {
    if (!(await waitEvent(v, 'loadedmetadata', { timeout: 20000, signal })))
      throw new Error('video metadata did not load (unsupported codec?)');
    if (v.readyState < 2) await waitEvent(v, 'loadeddata', { timeout: 10000, signal });
    const w = v.videoWidth, h = v.videoHeight;  // rotation-corrected (display) size
    const duration = v.duration;
    if (!w || !h || !isFinite(duration) || duration <= 0) throw new Error(`bad video (${w}x${h}, ${duration}s)`);

    // window
    let s = Math.max(0, Math.min(+start || 0, duration));
    let e = end == null ? duration : Math.max(s, Math.min(+end, duration));
    if (e - s > MAX_SECONDS) e = s + MAX_SECONDS;

    progress({ stage: 'fps', frac: 0 });
    const probe = await detectFps(v, signal, s);
    const srcFps = probe.fps || 30;
    const fps = targetFps ? +targetFps : (srcFps >= 30 ? 30 : srcFps);
    const n = Math.max(1, Math.floor((e - s) * fps + 1e-6));

    progress({ stage: 'model', frac: 0 });
    const lmk = await lmkP;
    checkAbort(signal);
    await lmk.setOptions({});  // re-initialises the graph: no tracking state carried over from a previous clip

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    const lm = new Array(n);
    const mediaTimes = new Array(n).fill(null);
    let detected = 0, tDetect = 0;
    const t0 = performance.now();
    const tsBase = tsCursor + 1000;
    for (let i = 0; i < n; i++) {
      checkAbort(signal);
      const t = s + (i + 0.5) / fps;
      mediaTimes[i] = await seekFrame(v, t, signal);
      ctx.drawImage(v, 0, 0, cw, ch);
      const ts = Math.round(tsBase + (i * 1000) / fps);
      const td = performance.now();
      const res = lmk.detectForVideo(canvas, ts);
      tDetect += performance.now() - td;
      tsCursor = ts;
      const p = res.landmarks && res.landmarks[0];
      if (p && p.length === 33) {
        lm[i] = p.map(q => [q.x, q.y, q.z, q.visibility ?? NaN]);
        detected++;
      } else {
        lm[i] = Array.from({ length: 33 }, () => [NaN, NaN, NaN, NaN]);
      }
      if (i % 3 === 0 || i === n - 1)
        progress({ stage: 'pose', frac: (i + 1) / n, i: i + 1, n, msPerFrame: (performance.now() - t0) / (i + 1) });
    }
    const totalMs = performance.now() - t0;
    progress({ stage: 'done', frac: 1, i: n, n });
    return {
      lm, fps, w, h, n, start: s, end: s + n / fps, srcFps,
      srcFpsMethod: probe.method, duration, model, delegate: lmkState ? lmkState.delegate : null,
      detected, msPerFrame: totalMs / n, detectMsPerFrame: tDetect / n, mediaTimes,
    };
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

// Bones used for drawing (MediaPipe indices), shared with the test page.
export const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25],
  [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
