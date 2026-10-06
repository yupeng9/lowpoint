// analyzer.js - browser port of swing_analyzer.py (clean_landmarks, detect_phases, compute_metrics,
// coach_faults) and build_app.py (guide ranges, guidelines, pack). Plain ES module, no dependencies.
// Parity with Python is checked by tools/parity_test.mjs.
//
// Internal landmark layout: Float32Array of n*33*4 values (x_px, y_px, z_px, vis), like the Python
// pose cache (float32, pixels; z scaled by w). Float32 storage mirrors numpy's float32 arrays.

// BlazePose indices
export const NOSE = 0, L_EAR = 7, R_EAR = 8;
export const L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16;
export const L_HIP = 23, R_HIP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;
export const PHASES = ["address", "top", "impact", "finish"];

export const TORSO_CM = 50.0;     // hip-joint-centre -> shoulder-joint-centre length (DTL scale)
export const SHOULDER_CM = 37.0;  // shoulder-joint-centre width (face-on scale)

// ---------------------------------------------------------------- python-compatible number formatting
// Python round(x, nd) / f"{x:.{nd}f}": correctly rounded from the exact binary value, ties to even.
function pyFixedStr(x, nd) {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let s;
  const exact = ax.toFixed(100);              // exact decimal expansion (enough for our magnitudes)
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {                   // exact tie -> half to even
    let big = BigInt(exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + nd));
    if (big % 2n === 1n) big += 1n;
    let d = big.toString().padStart(nd + 1, "0");
    s = nd > 0 ? d.slice(0, d.length - nd) + "." + d.slice(d.length - nd) : d;
  } else {
    s = ax.toFixed(nd);
  }
  return (neg ? "-" : "") + s;
}
const pyRound32 = (x, nd) => pyRound(Math.fround(x), nd);   // round(float(np.float32 x))
export function pyRound(x, nd = 0) {
  return Number(pyFixedStr(x, nd));
}
// numpy round on a float32 scalar (round(np.float32) in Python): rint(x * 10^nd) / 10^nd in float32.
// Used where the Python value is a numpy float32 (computed from the float32 landmark array).
function npRound32(x, nd = 0) {
  const f = Math.fround, p = 10 ** nd;
  return f(rint(f(f(x) * p)) / p);
}
function fmt(x, nd, plus = false) {
  const s = pyFixedStr(x, nd);
  return plus && s[0] !== "-" ? "+" + s : s;
}

// ---------------------------------------------------------------- small numeric helpers
function rint(x) {                 // round half to even (numpy rint)
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function median(arr, float32 = false) {
  const a = Float64Array.from(arr).sort();
  const n = a.length;
  if (!n) return NaN;
  for (let i = 0; i < n; i++) if (Number.isNaN(a[i])) return NaN;
  const m = n >> 1;
  return n % 2 ? a[m] : float32 ? f32(a[m - 1] + a[m]) / 2 : (a[m - 1] + a[m]) / 2;
}
const deg = (r) => r * 180 / Math.PI;
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const hypot32 = (x, y) => Math.fround(Math.hypot(x, y));   // np.hypot on float32 scalars
// The Python works on a float32 landmark array, so landmark-derived means/midpoints/norms are float32
// numpy ops; f32() reproduces their rounding (keeps rounded outputs bit-identical to Python).
const f32 = Math.fround;
const mid2 = (a, b) => [f32(a[0] + b[0]) / 2, f32(a[1] + b[1]) / 2];          // float32 mid()
const norm32 = (a, b) => { const dx = f32(a[0] - b[0]), dy = f32(a[1] - b[1]); return f32(Math.sqrt(dx * dx + dy * dy)); };
const norm2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function argmax(a, lo = 0, hi = a.length) {      // first occurrence, like numpy
  let bi = lo;
  for (let i = lo + 1; i < hi; i++) if (a[i] > a[bi]) bi = i;
  return bi;
}

// Savitzky-Golay smoothing coefficients (centre row of pinv(Vandermonde)), like savgol_coeffs().
const _sgCache = new Map();
function savgolCoeffs(window, order) {
  const key = window + ":" + order;
  if (_sgCache.has(key)) return _sgCache.get(key);
  const m = Math.floor(window / 2), p = order + 1;
  const ks = [];
  for (let k = -m; k <= m; k++) ks.push(k);
  // normal equations: c = e0^T (A^T A)^-1 A^T
  const AtA = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) =>
    ks.reduce((s, k) => s + k ** (i + j), 0)));
  // solve AtA * u = e0 (Gauss-Jordan)
  const M = AtA.map((r, i) => [...r, i === 0 ? 1 : 0]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
    }
  }
  const u = M.map((r, i) => r[p] / r[i]);
  const c = ks.map((k) => u.reduce((s, ui, i) => s + ui * k ** i, 0));
  _sgCache.set(key, c);
  return c;
}

// edge-padded Savitzky-Golay filter, same as savgol(x, window, order)
export function savgol(x, window = 7, order = 2) {
  const c = savgolCoeffs(window, order);
  const m = Math.floor(window / 2), n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < window; k++) s += c[k] * x[clip(i + k - m, 0, n - 1)];
    out[i] = s;
  }
  return out;
}

// Hampel spike filter on an edge-padded window, same as hampel()
export function hampel(x, window = 7, k = 3.0) {
  const m = Math.floor(window / 2), n = x.length;
  const y = Float64Array.from(x);
  const w = new Float64Array(window), dv = new Float64Array(window);
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < window; q++) w[q] = x[clip(i + q - m, 0, n - 1)];
    const med = median(w);
    for (let q = 0; q < window; q++) dv[q] = Math.abs(w[q] - med);
    const mad = 1.4826 * median(dv) + 1e-6;
    if (Math.abs(x[i] - med) > k * mad + 4.0) y[i] = med;   // +4 px floor
  }
  return y;
}

// np.interp(t, xp, fp) for t = 0..n-1 (xp increasing integers)
function interp(n, xp, fp) {
  const out = new Float64Array(n);
  const last = xp.length - 1;
  let j = 0;
  for (let t = 0; t < n; t++) {
    if (t <= xp[0]) { out[t] = fp[0]; continue; }
    if (t >= xp[last]) { out[t] = fp[last]; continue; }
    while (xp[j + 1] <= t) j++;
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    out[t] = slope * (t - xp[j]) + fp[j];
  }
  return out;
}

// ---------------------------------------------------------------- landmark container
class Landmarks {
  constructor(n, data) { this.n = n; this.d = data || new Float32Array(n * 33 * 4).fill(NaN); }
  get(t, j, c) { return this.d[(t * 33 + j) * 4 + c]; }
  set(t, j, c, v) { this.d[(t * 33 + j) * 4 + c] = v; }
  xy(t, j) { const i = (t * 33 + j) * 4; return [this.d[i], this.d[i + 1]]; }
  clone() { return new Landmarks(this.n, Float32Array.from(this.d)); }
}

// normalized MediaPipe [n][33][4] -> pixel Float32 landmarks (x*w, y*h, z*w, vis) like run_pose()
export function toPixels(lm, w, h) {
  const n = lm.length;
  const L = new Landmarks(n);
  for (let t = 0; t < n; t++) {
    const fr = lm[t];
    if (!fr || !fr.length) continue;
    for (let j = 0; j < 33; j++) {
      const p = fr[j];
      if (!p) continue;
      const num = (v) => (v === null || v === undefined ? NaN : v);
      L.set(t, j, 0, num(p[0]) * w);
      L.set(t, j, 1, num(p[1]) * h);
      L.set(t, j, 2, num(p[2]) * w);
      L.set(t, j, 3, num(p[3]));
    }
  }
  return L;
}

// ---------------------------------------------------------------- signal cleaning
/** Interpolate low-visibility / missing points, remove spikes, light Savitzky-Golay smoothing. */
export function cleanLandmarks(lm, visThr = 0.25) {
  if (!(lm instanceof Landmarks)) lm = toPixels(lm, 1, 1);   // nested [n][33][4] already in pixels
  const n = lm.n;
  const out = lm.clone();
  for (let j = 0; j < 33; j++) {
    const vis = new Float32Array(n);
    let ok = [];
    for (let t = 0; t < n; t++) {
      const v = lm.get(t, j, 3);
      vis[t] = Number.isNaN(v) ? 0 : v;
      if (vis[t] >= visThr && !Number.isNaN(lm.get(t, j, 0))) ok.push(t);
    }
    if (ok.length < 2) {
      ok = [];
      for (let t = 0; t < n; t++) if (!Number.isNaN(lm.get(t, j, 0))) ok.push(t);
      if (ok.length < 2) continue;
    }
    for (let c = 0; c < 3; c++) {
      let v = interp(n, ok, ok.map((t) => lm.get(t, j, c)));
      v = savgol(hampel(v), 7, 2);
      for (let t = 0; t < n; t++) out.set(t, j, c, v[t]);
    }
    for (let t = 0; t < n; t++) out.set(t, j, 3, vis[t]);
  }
  return out;
}

// ---------------------------------------------------------------- phase detection
function handsTrack(L) {
  const H = [];
  for (let t = 0; t < L.n; t++) {
    const wl = clip(L.get(t, L_WR, 3), 0.05, 1), wr = clip(L.get(t, R_WR, 3), 0.05, 1);
    H.push([(L.get(t, L_WR, 0) * wl + L.get(t, R_WR, 0) * wr) / (wl + wr),
            (L.get(t, L_WR, 1) * wl + L.get(t, R_WR, 1) * wr) / (wl + wr)]);
  }
  return H;
}

export function detectPhases(L) {
  const n = L.n;
  if (n < 3) throw new Error("detectPhases: need at least 3 frames");
  const sh = [], hp = [];
  for (let t = 0; t < n; t++) {
    sh.push(mid2(L.xy(t, L_SH), L.xy(t, R_SH)));
    hp.push(mid2(L.xy(t, L_HIP), L.xy(t, R_HIP)));
  }
  const torso = median(sh.map((s, t) => norm32(s, hp[t])), true);
  if (!(torso > 0)) throw new Error("detectPhases: no usable torso (pose not detected?)");
  const H0 = handsTrack(L);
  const hx = savgol(H0.map((p) => p[0]), 9, 2), hy = savgol(H0.map((p) => p[1]), 9, 2);
  const H = Array.from(hx, (x, t) => [x, hy[t]]);
  let v = new Float64Array(n);
  for (let t = 1; t < n - 1; t++) v[t] = norm2(H[t + 1], H[t - 1]) / 2.0;
  v[0] = v[1]; v[n - 1] = v[n - 2];
  {
    const vs = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += v[clip(t + k, 0, n - 1)] * 0.2;
      vs[t] = s / torso;                      // torso-lengths / frame
    }
    v = vs;
  }
  const y = hy;

  // 1) the real swing = peak hand speed
  const p = argmax(v);
  // 2) bottom of the swing near the peak (hands lowest)
  const lo = Math.max(0, p - 20), hi = Math.min(n, p + 20);
  const b0 = argmax(y, lo, hi);
  // 3) top: walk back from bottom while hands keep getting higher
  let runMin = y[b0], top = b0;
  for (let t = b0; t >= 0; t--) {
    if (y[t] < runMin) { runMin = y[t]; top = t; }
    if (y[t] - runMin > 0.5 * torso && top < b0) break;
  }
  const near = [];
  for (let t = top; t < b0; t++) if (y[t] - runMin < 0.02 * torso) near.push(t);
  if (near.length) top = near[near.length - 1];
  // 4) address: last low-motion frame before the takeaway, with hands still low
  const still = 0.006;
  let yLow = -Infinity;
  for (let t = 0; t <= top; t++) yLow = Math.max(yLow, y[t]);   // NaN-propagating like numpy max
  let cand = [];
  for (let t = 0; t < top; t++) if (y[t] >= yLow - 0.12 * torso && v[t] < still) cand.push(t);
  if (!cand.length) {
    for (let t = 0; t < top; t++) if (y[t] >= yLow - 0.12 * torso) cand.push(t);
    if (!cand.length) cand = [0];
  }
  const addr = cand[cand.length - 1];
  const addrH = H[addr];
  // 5) impact: after top, hands back closest to their address position
  const end = Math.min(n, top + 3 * Math.max(5, b0 - top) + 15);
  let imp = top + 1, best = Infinity;
  for (let t = top + 1; t < end; t++) {
    const d = y[t] > addrH[1] - 0.6 * torso ? norm2(H[t], addrH) : 1e9;
    if (d < best) { best = d; imp = t; }
  }
  // 6) finish: first stable frame after impact with hands high
  let fin = null, run = 0;
  for (let t = imp + 1; t < n; t++) {
    if (v[t] < still * 1.5 && y[t] < sh[addr][1] + 0.3 * torso) {
      run++;
      if (run >= 8) { fin = t - 7; break; }
    } else run = 0;
  }
  if (fin === null) {
    const wEnd = Math.min(n, imp + 120);
    if (wEnd > imp + 1) {
      fin = imp + 1;
      for (let t = imp + 2; t < wEnd; t++) if (y[t] < y[fin]) fin = t;
    } else fin = n - 1;
  }
  return { phases: { address: addr, top, impact: imp, finish: fin }, hands: H, speed: v, torso, peak: p };
}

// ---------------------------------------------------------------- geometry helpers
function ang3(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const cs = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) + 1e-9);
  return deg(Math.acos(clip(cs, -1, 1)));
}
function Pm(L, t, j, avg = 0) {
  const lo = Math.max(0, t - avg), hi = Math.min(L.n, t + avg + 1);
  let x = 0, y = 0;
  for (let q = lo; q < hi; q++) { x = f32(x + L.get(q, j, 0)); y = f32(y + L.get(q, j, 1)); }   // float32 mean
  return [f32(x / (hi - lo)), f32(y / (hi - lo))];
}
const headAt = (L, t, avg = 0) => mid2(Pm(L, t, L_EAR, avg), Pm(L, t, R_EAR, avg));
function visMin(L, t, ...js) {            // python min() semantics (NaN-propagation as in CPython)
  let m = L.get(t, js[0], 3);
  for (const j of js.slice(1)) { const v = L.get(t, j, 3); if (v < m) m = v; }
  return m;
}

// ---------------------------------------------------------------- metrics
export function computeMetrics(L, det, view, club, fps, slowmo = 1.0) {
  const ph = det.phases;
  const [a, tp, im] = PHASES.map((k) => ph[k]);
  const torso = det.torso, H = det.hands;
  const avg = { address: 2, top: 1, impact: 0, finish: 2 };
  const M = { address: {}, top: {}, impact: {}, finish: {} };
  const conf = [];
  const shm = (t, s = 0) => mid2(Pm(L, t, L_SH, s), Pm(L, t, R_SH, s));
  const hpm = (t, s = 0) => mid2(Pm(L, t, L_HIP, s), Pm(L, t, R_HIP, s));

  const back = tp - a, down = im - tp, sm = slowmo;
  const tempo = { backswing_frames: back, downswing_frames: down,
    ratio: pyRound(back / Math.max(1, down), 2), slowmo_factor: sm,
    backswing_s_real: pyRound(back / fps / sm, 2), downswing_s_real: pyRound(down / fps / sm, 2) };

  const noseA = headAt(L, a, 2);
  let summary, facing;
  const rng = [];
  for (let t = a; t <= im; t++) rng.push(t);
  const HS = (t) => mid2(L.xy(t, L_EAR), L.xy(t, R_EAR));
  if (view === "dtl") {
    const f = H[a][0] > hpm(a)[0] ? 1.0 : -1.0;   // +1: golfer faces +x (toward ball)
    const cm = TORSO_CM / torso, cm32 = f32(cm);
    const hpA = hpm(a, 2);
    for (const k of PHASES) {
      const t = ph[k], s = avg[k];
      const S = shm(t, s), Hh = hpm(t, s);
      const spine = deg(Math.atan2((S[0] - Hh[0]) * f, Hh[1] - S[1]));
      const tk = ang3(Pm(L, t, R_HIP, s), Pm(L, t, R_KN, s), Pm(L, t, R_AN, s));
      const lk = ang3(Pm(L, t, L_HIP, s), Pm(L, t, L_KN, s), Pm(L, t, L_AN, s));
      const nose = headAt(L, t, s);
      const hipShift = f32(Hh[0] - hpA[0]) * f;
      const m = M[k];
      m.spine_forward_bend_deg = pyRound(spine, 1);
      m.trail_knee_flex_deg = pyRound(180 - tk, 1);
      m.lead_knee_flex_deg = pyRound(180 - lk, 1);
      m.head_dx_toward_ball_cm = npRound32(f32(f32(nose[0] - noseA[0]) * f * cm32), 1);
      m.head_dy_up_cm = npRound32(f32(-f32(nose[1] - noseA[1]) * cm32), 1);
      m.hip_toward_ball_cm = npRound32(f32(hipShift * cm32), 1);
      m.lead_elbow_deg = pyRound(ang3(Pm(L, t, L_SH, s), Pm(L, t, L_EL, s), Pm(L, t, L_WR, s)), 1);
      m.lead_arm_visibility = pyRound(visMin(L, t, L_SH, L_EL, L_WR), 2);
    }
    M.impact.spine_change_vs_address_deg = pyRound(M.impact.spine_forward_bend_deg - M.address.spine_forward_bend_deg, 1);
    M.top.spine_change_vs_address_deg = pyRound(M.top.spine_forward_bend_deg - M.address.spine_forward_bend_deg, 1);
    const nx = rng.map((t) => f32(f32(HS(t)[0] - noseA[0]) * f * cm32));
    const ny = rng.map((t) => f32(-f32(HS(t)[1] - noseA[1]) * cm32));
    summary = { max_head_move_toward_ball_cm: pyRound32(Math.max(...nx), 1),
      max_head_move_away_cm: pyRound32(-Math.min(...nx), 1),
      max_head_rise_cm: pyRound32(Math.max(...ny), 1),
      max_head_dip_cm: pyRound32(-Math.min(...ny), 1) };
    conf.push("spine angle at the TOP is distorted by shoulder rotation in 2D; compare address vs impact only");
    if (M.top.lead_arm_visibility < 0.6)
      conf.push("lead arm at top is the far-side arm in DTL (partly hidden) - elbow angle is low confidence");
    conf.push(`cm values assume torso (hip-joint to shoulder-joint) = ${fmt(TORSO_CM, 0)} cm`);
    facing = f;
  } else {
    const tDir = Pm(L, a, L_HIP, 2)[0] > Pm(L, a, R_HIP, 2)[0] ? 1.0 : -1.0;  // +1: target is +x
    if ((H[tp][0] - hpm(tp)[0]) * tDir > 0)
      conf.push("hands at top appear on the target side - left/right labels may be swapped");
    const swA = norm32(Pm(L, a, L_SH, 2), Pm(L, a, R_SH, 2));
    const hwA = norm32(Pm(L, a, L_HIP, 2), Pm(L, a, R_HIP, 2));
    const cm = SHOULDER_CM / swA, cm32 = f32(cm), sw32 = f32(swA);
    const hpA = hpm(a, 2);
    const la0 = Pm(L, a, L_AN, 2), ra0 = Pm(L, a, R_AN, 2);
    for (const k of PHASES) {
      const t = ph[k], s = avg[k];
      const S = shm(t, s), Hh = hpm(t, s);
      const lsh = Pm(L, t, L_SH, s), rsh = Pm(L, t, R_SH, s);
      const lhp = Pm(L, t, L_HIP, s), rhp = Pm(L, t, R_HIP, s);
      const nose = headAt(L, t, s);
      const m = M[k];
      m.spine_tilt_away_deg = pyRound(deg(Math.atan2(-(S[0] - Hh[0]) * tDir, Hh[1] - S[1])), 1);
      m.shoulder_tilt_lead_up_deg = pyRound(deg(Math.atan2(rsh[1] - lsh[1], Math.abs(lsh[0] - rsh[0]) + 1e-6)), 1);
      m.hip_tilt_lead_up_deg = pyRound(deg(Math.atan2(rhp[1] - lhp[1], Math.abs(lhp[0] - rhp[0]) + 1e-6)), 1);
      m.head_sway_toward_target_cm = npRound32(f32(f32(nose[0] - noseA[0]) * tDir * cm32), 1);
      m.head_sway_pct_shoulder = npRound32(f32(f32(f32(nose[0] - noseA[0]) * tDir / sw32) * 100), 0);
      m.head_dy_up_cm = npRound32(f32(-f32(nose[1] - noseA[1]) * cm32), 1);
      m.hip_slide_toward_target_cm = npRound32(f32(f32(Hh[0] - hpA[0]) * tDir * cm32), 1);
      // weight proxy: hip centre between ADDRESS ankles (0 = trail ankle, 1 = lead ankle)
      m.weight_proxy = pyRound((Hh[0] - ra0[0]) / (la0[0] - ra0[0] + 1e-6), 2);
      m.lead_elbow_deg = pyRound(ang3(lsh, Pm(L, t, L_EL, s), Pm(L, t, L_WR, s)), 1);
      m.shoulder_width_ratio = pyRound(norm2(lsh, rsh) / swA, 2);
      m.hip_width_ratio = pyRound(norm2(lhp, rhp) / hwA, 2);
    }
    M.address.stance_width_over_shoulder = pyRound(Math.abs(la0[0] - ra0[0]) / swA, 2);
    const rotS = deg(Math.acos(clip(M.top.shoulder_width_ratio, 0, 1)));
    const rotH = deg(Math.acos(clip(M.top.hip_width_ratio, 0, 1)));
    M.top.shoulder_turn_proxy_deg = pyRound(rotS, 0);
    M.top.hip_turn_proxy_deg = pyRound(rotH, 0);
    M.top.x_factor_proxy_deg = pyRound(rotS - rotH, 0);
    const nx = rng.map((t) => f32(f32(HS(t)[0] - noseA[0]) * tDir * cm32));
    summary = { max_head_sway_away_cm: pyRound32(-Math.min(...nx), 1),
      max_head_sway_toward_target_cm: pyRound32(Math.max(...nx), 1) };
    conf.push("lead-arm angle at the top is foreshortened face-on (arm points toward/away from camera) - low confidence");
    conf.push("shoulder/hip line tilt is meaningless when the line is seen end-on (finish, and shoulders at the top)");
    conf.push("turn proxies from apparent shoulder/hip width shrinkage are rough (forward bend + tilt also shrink width)");
    conf.push(`cm values assume shoulder-joint width = ${fmt(SHOULDER_CM, 0)} cm`);
    facing = tDir;
  }
  conf.push("tempo ratio uses frame counts; valid only if any slow-motion factor is uniform over the swing " +
            "(iPhone slo-mo exports can contain speed ramps)");
  if (down <= 4) conf.push("downswing spans <=4 frames: impact frame timing is +-1 frame (~33 ms)");
  const frames_1based = {};
  for (const k of PHASES) frames_1based[k] = ph[k] + 1;
  return { view, club, fps, facing_sign: facing, frames_1based, tempo, phases: M, summary, confidence_notes: conf };
}

// ---------------------------------------------------------------- coach card faults
export function coachFaults(R) {
  const M = R.phases;
  const faults = [];
  let k;
  if (R.view === "dtl") {
    k = "impact";
    const im = M[k];
    const dSpine = im.spine_change_vs_address_deg, dHip = im.hip_toward_ball_cm;
    if (dSpine <= -5 || dHip >= 2.5) {
      faults.push({ part: "spine_hip", title: "Early extension",
        detail: `Spine ${fmt(Math.abs(dSpine), 0)} deg more upright than address, hips ${fmt(dHip, 0, true)} cm toward the ball`,
        fix: "Drill: butt against a chair/stick at address - keep it there until after impact",
        why: "When the hips move toward the ball the torso stands up and the arms lose room, so the hands " +
             "have to flip or stall: blocks, hooks and thin/fat contact are typical results." });
    }
    const headMv = hypot32(im.head_dx_toward_ball_cm, im.head_dy_up_cm);
    if (headMv >= 5) {
      faults.push({ part: "head", title: "Head moving",
        detail: `Head moved ${fmt(headMv, 0)} cm from its address position`,
        fix: "Keep your eyes on the back of the ball until the club passes it",
        why: "A moving head moves the swing centre, which moves the low point of the arc." });
    }
  } else {
    k = "top";
    const tp = M[k];
    const headSw = -tp.head_sway_toward_target_cm, hipSw = -tp.hip_slide_toward_target_cm;
    if (hipSw >= 5 || headSw >= 10) {
      faults.push({ part: "hip", title: "Sway off the ball",
        detail: `Hips slide ${fmt(hipSw, 0)} cm away from target at the top`,
        fix: "Drill: stick/bag outside trail hip - turn into the trail hip, don't slide into it",
        why: "Sliding instead of turning stores less coil and forces an equal slide back to the ball, " +
             "so low point and timing vary: fat/thin strikes and lost power." });
    }
    if (headSw >= 10) {
      faults.push({ part: "head", title: "Head drifting back",
        detail: `Head moves ${fmt(headSw, 0)} cm away from target in the backswing`,
        fix: "Keep the head inside your address box - rotate around the spine",
        why: "Some drift behind the ball is normal with a driver, but this much has to be undone in the " +
             "downswing - a common cause of inconsistent strike." });
    }
  }
  for (const f of faults) f.phase = k;
  return [k, faults];
}

// ---------------------------------------------------------------- guidelines (build_app.py)
// [phase, key, label, unit, (good_lo, good_hi, warn_lo, warn_hi) | null, note]
export const GUIDE_DTL = [
  ["address", "spine_forward_bend_deg", "Forward bend at address", "°", [30, 45, 25, 50], "Hinge from the hips; camera height/angle skews this"],
  ["address", "trail_knee_flex_deg", "Trail knee flex at address", "°", [15, 30, 10, 35], "Athletic, not squatting"],
  ["top", "lead_elbow_deg", "Lead arm at the top", "°", [160, 180, 145, 180], "Straight-ish lead arm = wide arc"],
  ["impact", "spine_change_vs_address_deg", "Spine angle change at impact", "°", [-4, 4, -7, 7], "Hold your address posture"],
  ["impact", "hip_toward_ball_cm", "Hips toward the ball at impact", "cm", [-4, 1.5, -6, 3.5], "Butt stays on its address line"],
  ["impact", "_head_move_cm", "Head movement at impact", "cm", [0, 5, 0, 8], "Stable swing centre"],
];
export const GUIDE_FACEON = [
  ["address", "stance_width_over_shoulder", "Stance width ÷ shoulder width", "×", null, "Wider for driver"],
  ["top", "_head_sway_away_cm", "Head drift away from target at top", "cm", null, "Some drift is fine with driver"],
  ["top", "_hip_sway_away_cm", "Hip slide away from target at top", "cm", [-10, 3, -10, 6], "Turn, don't slide"],
  ["top", "shoulder_turn_proxy_deg", "Shoulder turn at top (proxy)", "°", [80, 110, 65, 115], "Rough: from shoulder width shrink"],
  ["top", "hip_turn_proxy_deg", "Hip turn at top (proxy)", "°", [30, 55, 20, 65], "Rough: from hip width shrink"],
  ["impact", "hip_slide_toward_target_cm", "Hips ahead of address at impact", "cm", [1, 12, -1, 15], "Pressure moves to the lead side"],
  ["finish", "weight_proxy", "Hips over lead foot at finish", "", [0.8, 1.25, 0.65, 1.35], "0 = trail ankle, 1 = lead ankle"],
];

export function guideRanges(view, club, key, rng) {
  if (rng != null) return rng;
  if (key === "stance_width_over_shoulder") return club === "driver" ? [1.25, 1.7, 1.1, 1.85] : [1.0, 1.4, 0.9, 1.55];
  if (key === "_head_sway_away_cm") return club === "driver" ? [-10, 9, -12, 14] : [-10, 6, -12, 10];
  return null;
}

export function guidelines(R) {
  const M = R.phases, view = R.view, club = R.club;
  const rows = [];
  for (const [ph, key, label, unit, rng, note] of (view === "dtl" ? GUIDE_DTL : GUIDE_FACEON)) {
    const m = M[ph];
    let val;
    if (key === "_head_move_cm") val = hypot32(m.head_dx_toward_ball_cm, m.head_dy_up_cm);
    else if (key === "_head_sway_away_cm") val = -m.head_sway_toward_target_cm;
    else if (key === "_hip_sway_away_cm") val = -m.hip_slide_toward_target_cm;
    else val = m[key];
    if (val === undefined || val === null) continue;
    const [g0, g1, w0, w1] = guideRanges(view, club, key, rng);
    const st = g0 <= val && val <= g1 ? "good" : (w0 <= val && val <= w1 ? "warn" : "bad");
    rows.push({ phase: ph, key, label, unit, value: pyRound(val, 2), good: [g0, g1], warn: [w0, w1], status: st, note });
  }
  return rows;
}

// ---------------------------------------------------------------- full pipeline (build_app.analyze + pack)
const r4 = (x) => (Number.isNaN(x) ? null : rint(x * 1e4) / 1e4);

/**
 * lm: [n][33][4] normalized (x, y, z, visibility) as MediaPipe tasks-vision gives them
 *     (missing frames: null / [] / NaN entries).
 * opts: {w, h, fps, view: "dtl"|"faceon", club: "iron"|"driver", frames?: {address,top,impact,finish} 0-based, slowmo=1}
 * Returns the pack() shape minus id/name/kind (video: null, images: [] for the caller to fill).
 */
export function analyze(lm, { w, h, fps, view, club, frames = null, slowmo = 1 } = {}) {
  if (!(w > 0 && h > 0 && fps > 0)) throw new Error("analyze: w, h and fps are required");
  if (view !== "dtl" && view !== "faceon") throw new Error("analyze: view must be 'dtl' or 'faceon'");
  const raw = toPixels(lm, w, h);
  const L = cleanLandmarks(raw);
  const det = detectPhases(L);
  if (frames) {
    const ph = {};
    for (const k of PHASES) {
      const v = Math.round(Number(frames[k]));
      if (!Number.isInteger(v) || v < 0 || v >= L.n) throw new Error(`analyze: bad frames.${k}`);
      ph[k] = v;
    }
    det.phases = ph;
  }
  const R = computeMetrics(L, det, view, club, fps, slowmo);
  const [, faults] = coachFaults(R);
  const out = [];
  for (let t = 0; t < L.n; t++) {
    const fr = [];
    for (let j = 0; j < 33; j++)
      fr.push([r4(L.get(t, j, 0) / w), r4(L.get(t, j, 1) / h), r4(clip(L.get(t, j, 3), 0, 1))]);
    out.push(fr);
  }
  return {
    view, club, video: null, fps, w, h, n: L.n,
    phases: { ...det.phases },
    torso: det.torso / h,
    facing: R.facing_sign,
    metrics: R.phases, tempo: R.tempo, summary: R.summary,
    notes: R.confidence_notes, faults, guides: guidelines(R),
    images: [],
    lm: out,
  };
}

export { Landmarks };
