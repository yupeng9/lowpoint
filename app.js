"use strict";
/* Lowpoint swing room — local swing viewer.
   Data: data/index.js + data/<id>.js (built by build_app.py). Landmarks are normalized [x, y, vis]. */

const PH = ["address", "top", "impact", "finish"];
const PH_SHORT = { address: "A", top: "T", impact: "I", finish: "F" };
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
               [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
const TORSO_BONES = new Set(["11-23", "12-24", "23-24"]);
const DOTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 0, 7, 8];
const COL = { ok: "#5ee26f", bad: "#ff4b3e", warn: "#f2b33d", ref: "#6fd8ff", fix: "#f4efe2", chalk: "#ece6d6" };
const TORSO_CM = 50, SHOULDER_CM = 37;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  index: [], clips: {}, A: null, B: null,
  pos: 0, playing: false, rate: 0.25, sync: "phase", overlay: false, last: 0,
  layers: { skel: true, guides: true, fix: false, path: false, readout: true, loop: true },
  tool: null,
};

/* ------------------------------------------------------------------ geometry on a clip */
function P(c, t, j) {
  const p = c.lm[clamp(Math.round(t), 0, c.n - 1)][j];
  return [p[0] * c.w, p[1] * c.h];
}
function Pavg(c, t, j, s = 2) {
  let x = 0, y = 0, k = 0;
  for (let i = t - s; i <= t + s; i++) {
    if (i < 0 || i >= c.n) continue;
    const p = P(c, i, j); x += p[0]; y += p[1]; k++;
  }
  return [x / k, y / k];
}
const hipC = (c, t) => mid(P(c, t, 23), P(c, t, 24));
const shC = (c, t) => mid(P(c, t, 11), P(c, t, 12));
const headC = (c, t) => mid(P(c, t, 7), P(c, t, 8));
const spineAng = (f, H, S) => Math.atan2((S[0] - H[0]) * f, H[1] - S[1]);

function prepare(c) {
  if (!c.lm) return c;
  const a = c.phases.address;
  const hipA = mid(Pavg(c, a, 23), Pavg(c, a, 24));
  const shA = mid(Pavg(c, a, 11), Pavg(c, a, 12));
  const headA = mid(Pavg(c, a, 7), Pavg(c, a, 8));
  const cm = c.view === "dtl" ? TORSO_CM / (c.torso * c.h) : SHOULDER_CM / dist(Pavg(c, a, 11), Pavg(c, a, 12));
  c.K = { a, hipA, shA, headA, cm, torsoPx: dist(hipA, shA), spineA: spineAng(c.facing, hipA, shA) };
  return c;
}

function live(c, t) {
  const K = c.K, f = c.facing, H = hipC(c, t), hd = headC(c, t);
  if (c.view === "dtl") {
    const sp = spineAng(f, H, shC(c, t));
    return { spineD: (sp - K.spineA) * 180 / Math.PI, hipD: (H[0] - K.hipA[0]) * f * K.cm,
             head: dist(hd, K.headA) * K.cm };
  }
  return { headAway: -(hd[0] - K.headA[0]) * f * K.cm, hipAway: -(H[0] - K.hipA[0]) * f * K.cm };
}

function flags(c, t) {
  const ph = c.phases, m = live(c, t);
  if (c.view === "dtl") {
    const win = t >= ph.top + 0.5 * (ph.impact - ph.top) && t <= ph.impact + 0.3 * (ph.finish - ph.impact);
    return { m, spine: win && m.spineD <= -5, hip: win && m.hipD >= 2.5,
             head: t >= ph.address && t <= ph.impact && m.head >= 5 };
  }
  const win = t >= ph.address && t <= ph.impact;
  return { m, hip: win && m.hipAway >= 5, head: win && m.headAway >= 10, spine: false };
}

/* "Fix preview": your own pose with the detected fault removed (illustrative, not a physical model). */
function fixedPose(c, t) {
  const K = c.K, ph = c.phases, pts = [];
  for (let j = 0; j < 33; j++) pts.push(P(c, t, j));
  const upper = [...Array(25).keys()], torsoUp = [...Array(23).keys()];
  const f = c.facing;
  if (c.view === "faceon") {
    const w = t < ph.address ? 0 : t <= ph.impact ? 1 : 1 - smooth((t - ph.impact) / Math.max(1, 0.5 * (ph.finish - ph.impact)));
    if (w <= 0) return pts;
    const drift = (mid(pts[23], pts[24])[0] - K.hipA[0]) * f;
    if (drift < 0) for (const j of upper) pts[j][0] -= drift * f * w;
    const hdrift = (mid(pts[7], pts[8])[0] - K.headA[0]) * f;
    const allow = (c.club === "driver" ? 6 : 4) / K.cm;
    if (hdrift < -allow) for (const j of torsoUp) pts[j][0] -= (hdrift + allow) * f * w;
    return pts;
  }
  const w = t <= ph.top ? 0 : t <= ph.impact ? smooth((t - ph.top) / Math.max(1, ph.impact - ph.top))
    : 1 - smooth((t - ph.impact) / Math.max(1, 0.6 * (ph.finish - ph.impact)));
  if (w <= 0) return pts;
  const d = (mid(pts[23], pts[24])[0] - K.hipA[0]) * f;
  if (d > 0) for (const j of upper) pts[j][0] -= d * f * w;
  const H = mid(pts[23], pts[24]), S = mid(pts[11], pts[12]);
  const dphi = K.spineA - spineAng(f, H, S);
  if (dphi > 0) {
    const th = f * dphi * w, cs = Math.cos(th), sn = Math.sin(th);
    for (const j of torsoUp) {
      const x = pts[j][0] - H[0], y = pts[j][1] - H[1];
      pts[j] = [H[0] + x * cs - y * sn, H[1] + x * sn + y * cs];
    }
  }
  return pts;
}

/* Reference pose mapped into A's image: anchored at address hip centre, scaled by address torso length. */
function mappedPose(cA, cB, tB) {
  const s = cA.K.torsoPx / cB.K.torsoPx, m = cA.facing * cB.facing < 0 ? -1 : 1, out = [];
  for (let j = 0; j < 33; j++) {
    const p = P(cB, tB, j);
    out.push([cA.K.hipA[0] + m * s * (p[0] - cB.K.hipA[0]), cA.K.hipA[1] + s * (p[1] - cB.K.hipA[1])]);
  }
  return out;
}

function phaseList(c) {
  if (!c || !c.phases) return null;
  const v = PH.map(k => c.phases[k]);
  return v.every(x => Number.isFinite(x)) ? v : null;
}
function mapFrame(fA) {
  const A = state.A, B = state.B;
  if (!B) return 0;
  const a = phaseList(A), b = phaseList(B);
  let fB;
  if (state.sync === "phase" && a && b) {
    if (fA <= a[0]) fB = b[0] - (a[0] - fA);
    else if (fA >= a[3]) fB = b[3] + (fA - a[3]);
    else {
      for (let i = 0; i < 3; i++) if (fA <= a[i + 1]) { fB = b[i] + (fA - a[i]) * (b[i + 1] - b[i]) / Math.max(1, a[i + 1] - a[i]); break; }
    }
  } else fB = fA * B.fps / A.fps;
  return clamp(fB, 0, B.n - 1);
}

/* ------------------------------------------------------------------ panes */
class Pane {
  constructor(root) {
    this.root = root;
    this.stage = $(".stage", root);
    this.video = $("video", root);
    this.canvas = $("canvas", root);
    this.ctx = this.canvas.getContext("2d");
    this.badge = $(".phase-badge", root);
    this.readout = $(".readout", root);
    this.clip = null; this.shown = -1; this.req = -1; this.want = 0; this.url = null; this.gen = 0; this._settle = null;
    this.offset = 0; this.novideo = false; this.stills = null; // no-video mode: phase stills drawn behind the skeleton
    this.ann = []; this.draft = null; this.lastReadout = "";
    this.video.addEventListener("seeked", () => {
      this.shown = this.req;
      if (this.want !== this.shown) this.seek(this.want);
    });
    this.bindDrawing();
  }
  settle(v) { const s = this._settle; this._settle = null; if (s) s(v); }
  /* src: {url, offset} (clip frame i shows at video time (i + 0.5) / fps + offset), or null = no-video mode,
     where `stills` ({address, top, impact, finish} data URLs) are drawn dimmed behind the skeleton.
     Resolves true once loaded, false if superseded by another load()/unload(). */
  async load(clip, src, stills = null) {
    this.settle(false);
    this.clip = clip; this.shown = -1; this.req = -1; this.ann = [];
    revokeBlob(this.url);
    this.url = src ? src.url : null;
    this.offset = src ? src.offset || 0 : 0;
    this.novideo = !src;
    this.stills = null;
    if (!src && stills) {
      this.stills = {};
      for (const k of PH) if (stills[k]) { const im = new Image(); im.src = stills[k]; this.stills[k] = im; }
    }
    this.stage.classList.toggle("novideo", this.novideo);
    this.layout();
    if (this.novideo) {
      this.video.onloadeddata = this.video.onerror = null;
      this.video.removeAttribute("src"); this.video.load();
    } else {
      this.video.src = src.url;
      const ok = await new Promise((res, rej) => {
        this._settle = res;
        this.video.onloadeddata = () => this.settle(true);
        this.video.onerror = () => { this._settle = null; rej(new Error("video failed to load")); };
      });
      if (!ok) return false;
    }
    if (!clip.w) { clip.w = this.video.videoWidth; clip.h = this.video.videoHeight; }
    if (!clip.n) clip.n = Math.max(1, Math.floor(this.video.duration * clip.fps));
    $(".title", this.root).textContent = clip.name;
    $(".sub", this.root).textContent = clip.lm ? `${clip.club} · ${clip.view === "dtl" ? "down-the-line" : "face-on"} · ${clip.n} fr`
      : "video file · mark phases below to sync";
    this.layout();
    return true;
  }
  unload() {
    this.settle(false);
    this.clip = null; this.shown = -1; this.req = -1; this.ann = []; this.draft = null;
    this.novideo = false; this.stills = null; this.stage.classList.remove("novideo");
    this.video.onloadeddata = this.video.onerror = null;
    revokeBlob(this.url); this.url = null;
    this.video.removeAttribute("src"); this.video.load();
  }
  seek(i) {
    if (!this.clip || !Number.isFinite(i)) return;
    i = clamp(Math.round(i), 0, this.clip.n - 1);
    this.want = i;
    if (this.novideo) { this.shown = this.req = i; return; }
    if (this.video.seeking || i === this.shown || i === this.req) return;
    this.req = i;
    const d = this.video.duration;
    let t = (i + 0.5) / this.clip.fps + this.offset;
    if (Number.isFinite(d)) t = clamp(t, 0, Math.max(0, d - 0.001)); // gist videos only cover address-1s..finish+1s
    this.video.currentTime = t;
  }
  layout() {
    if (!this.clip || !this.clip.w) return;
    const wrap = this.stage.parentElement, W = wrap.clientWidth, H = wrap.clientHeight;
    const ar = this.clip.w / this.clip.h;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    w = Math.floor(w); h = Math.floor(h); // canvas and stage share one size, so the skeleton isn't stretched by a rounding pixel
    this.stage.style.width = `${Math.floor(w)}px`;
    this.stage.style.height = `${Math.floor(h)}px`;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = this.canvas.width / this.clip.w;
    this.dpr = dpr;
  }
  bindDrawing() {
    const norm = e => { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    this.canvas.addEventListener("pointerdown", e => {
      if (!state.tool) return;
      const p = norm(e);
      if (!this.draft) this.draft = { type: state.tool, pts: [p, p] };
      else if (this.draft.type === "angle" && this.draft.pts.length === 2) this.draft.pts.push(p);
      if (this.draft.type !== "angle" || this.draft.pts.length === 3) this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", e => {
      if (!this.draft) return;
      this.draft.pts[this.draft.pts.length - 1] = norm(e);
    });
    this.canvas.addEventListener("pointerup", e => {
      if (!this.draft) return;
      const d = this.draft;
      d.pts[d.pts.length - 1] = norm(e);
      if (d.type === "angle" && d.pts.length === 2) { d.pts.push(d.pts[1].slice()); return; } // 2nd leg follows mouse
      if (d.type === "angle" && d.pts.length === 3 && dist(d.pts[1], d.pts[2]) < 0.005) return;
      this.ann.push(d); this.draft = null;
    });
  }

  /* ---------------- drawing */
  draw() {
    const c = this.clip, g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!c) return;
    const t = this.shown < 0 ? this.want : this.shown;
    const L = state.layers, isA = this === paneA;
    const s = this.scale, lw = Math.max(2, 2.2 * this.dpr * (this.canvas.height / this.dpr) / 520);
    this.lw = lw;
    const X = p => [p[0] * s, p[1] * s];
    if (this.novideo) this.drawStill(c, t);
    if (c.lm) {
      const F = flags(c, t);
      if (L.path) this.drawPath(c, t, X, lw);
      if (L.guides) this.drawGuides(c, t, F, X, lw);
      if (isA && state.overlay && state.B && state.B.lm && state.B.view === c.view) {
        this.drawSkel(mappedPose(c, state.B, mapFrame(t)), X, lw, { color: COL.ref, alpha: 0.9 });
      }
      if (L.fix && c.faults.length) this.drawSkel(fixedPose(c, t), X, lw, { color: COL.fix, dash: true, alpha: 0.95 });
      if (L.skel) {
        const pts = []; for (let j = 0; j < 33; j++) pts.push(P(c, t, j));
        const red = new Set(L.guides && (F.spine || F.hip) ? TORSO_BONES : []);
        this.drawSkel(pts, X, lw, { color: COL.ok, red });
      }
      this.updateReadout(c, F);
    } else this.updateReadout(null);
    this.updateBadge(c, t);
    this.drawAnnotations(g, lw);
  }
  drawStill(c, t) {
    if (!this.stills || !c.phases) return;
    let best = null, bd = Infinity;
    for (const k of PH) {
      const im = this.stills[k];
      if (!im || !im.complete || !im.naturalWidth || !Number.isFinite(c.phases[k])) continue;
      const d = Math.abs(c.phases[k] - t);
      if (d < bd) { bd = d; best = im; }
    }
    if (!best) return;
    const g = this.ctx;
    g.save(); g.globalAlpha = 0.5; g.drawImage(best, 0, 0, this.canvas.width, this.canvas.height); g.restore();
  }
  drawSkel(pts, X, lw, o) {
    const g = this.ctx;
    g.save();
    g.globalAlpha = o.alpha ?? 1;
    g.lineCap = "round";
    for (const [a, b] of BONES) {
      const pa = X(pts[a]), pb = X(pts[b]);
      if (!o.dash) {
        g.strokeStyle = "rgba(0,0,0,.65)"; g.lineWidth = lw + 3;
        g.beginPath(); g.moveTo(...pa); g.lineTo(...pb); g.stroke();
      }
      g.setLineDash(o.dash ? [lw * 3, lw * 2.2] : []);
      g.strokeStyle = o.red && o.red.has(`${a}-${b}`) ? COL.bad : o.color;
      g.lineWidth = lw;
      g.beginPath(); g.moveTo(...pa); g.lineTo(...pb); g.stroke();
    }
    g.setLineDash([]);
    for (const j of DOTS) {
      const p = X(pts[j]);
      g.fillStyle = o.dash ? o.color : "#fff";
      g.beginPath(); g.arc(p[0], p[1], lw * (j < 11 ? 0.8 : 1.15), 0, 7); g.fill();
    }
    g.restore();
  }
  drawGuides(c, t, F, X, lw) {
    const g = this.ctx, K = c.K, f = c.facing;
    const tor = K.torsoPx;
    const dashed = (p1, p2, col = "rgba(244,239,226,.85)", w = lw * 0.8) => {
      g.save(); g.setLineDash([lw * 3.2, lw * 2.6]); g.strokeStyle = col; g.lineWidth = w;
      g.beginPath(); g.moveTo(...X(p1)); g.lineTo(...X(p2)); g.stroke(); g.restore();
    };
    // side < 0: text ends just left of p; side > 0: text starts just right of p (keeps labels off the body)
    const label = (txt, p, side = 1, col = "rgba(244,239,226,.9)") => {
      const q = X(p); g.save(); g.font = `${Math.round(lw * 4.6)}px "IBM Plex Mono", monospace`;
      g.fillStyle = "rgba(0,0,0,.55)"; const w = g.measureText(txt).width;
      const x = clamp(side < 0 ? q[0] - w - 3 * lw : q[0] + 3 * lw, 6, this.canvas.width - w - 6); // stay inside the frame
      g.fillRect(x - 4, q[1] - lw * 4.4, w + 8, lw * 5.8); g.fillStyle = col; g.fillText(txt, x, q[1]); g.restore();
    };
    const H = hipC(c, t), S = shC(c, t);
    if (c.view === "dtl") {
      const u = [(K.shA[0] - K.hipA[0]) / tor, (K.shA[1] - K.hipA[1]) / tor];
      dashed(K.hipA, [K.hipA[0] + u[0] * tor * 1.4, K.hipA[1] + u[1] * tor * 1.4]);
      dashed([K.hipA[0], K.hipA[1] - 0.7 * tor], [K.hipA[0], K.hipA[1] + 1.5 * tor]);
      label("address hip line", [K.hipA[0], K.hipA[1] - 0.6 * tor], -f); // behind the golfer, at the top of the line
      const v = [(S[0] - H[0]), (S[1] - H[1])], n = Math.hypot(...v);
      const end = [H[0] + v[0] / n * tor * 1.4, H[1] + v[1] / n * tor * 1.4];
      g.save(); g.lineCap = "round";
      g.strokeStyle = "rgba(0,0,0,.6)"; g.lineWidth = lw * 1.6 + 3; g.beginPath(); g.moveTo(...X(H)); g.lineTo(...X(end)); g.stroke();
      g.strokeStyle = F.spine ? COL.bad : COL.ok; g.lineWidth = lw * 1.6; g.beginPath(); g.moveTo(...X(H)); g.lineTo(...X(end)); g.stroke();
      g.restore();
    } else {
      dashed([K.hipA[0], K.hipA[1] - 1.7 * tor], [K.hipA[0], K.hipA[1] + 1.7 * tor]);
      label("address centre", [K.hipA[0], K.hipA[1] + 1.75 * tor]); // below the feet, beside the line
    }
    // hip marker
    g.save();
    g.strokeStyle = F.hip ? COL.bad : COL.ok; g.lineWidth = lw * 1.1;
    g.beginPath(); g.arc(...X(H), 0.11 * tor * this.scale, 0, 7); g.stroke();
    if (F.hip) this.arrow(X(K.hipA), X(H), COL.bad, lw * 1.1);
    // head box at address position
    const hb = 0.3 * tor, A0 = X([K.headA[0] - hb, K.headA[1] - hb]), A1 = X([K.headA[0] + hb, K.headA[1] + hb]);
    g.strokeStyle = F.head ? COL.bad : COL.ok; g.lineWidth = lw * 1.1;
    g.strokeRect(A0[0], A0[1], A1[0] - A0[0], A1[1] - A0[1]);
    if (F.head) this.arrow(X(K.headA), X(headC(c, t)), COL.bad, lw);
    g.restore();
  }
  arrow(p, q, col, w) {
    const g = this.ctx, L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 4) return;
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]), hl = Math.min(L * 0.45, w * 5);
    g.save(); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = w;
    g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke();
    g.beginPath(); g.moveTo(...q);
    g.lineTo(q[0] - hl * Math.cos(a - 0.45), q[1] - hl * Math.sin(a - 0.45));
    g.lineTo(q[0] - hl * Math.cos(a + 0.45), q[1] - hl * Math.sin(a + 0.45)); g.closePath(); g.fill();
    g.restore();
  }
  drawPath(c, t, X, lw) {
    const g = this.ctx, a = c.phases.address;
    if (t <= a) return;
    const hand = i => {
      const l = c.lm[i][15], r = c.lm[i][16], wl = Math.max(0.05, l[2]), wr = Math.max(0.05, r[2]);
      return [(l[0] * wl + r[0] * wr) / (wl + wr) * c.w, (l[1] * wl + r[1] * wr) / (wl + wr) * c.h];
    };
    g.save(); g.lineWidth = lw * 1.2; g.lineCap = "round"; g.lineJoin = "round";
    let prev = X(hand(a));
    for (let i = a + 1; i <= t; i++) {
      const q = X(hand(i));
      g.strokeStyle = i <= c.phases.top ? "rgba(242,179,61,.95)" : "rgba(111,216,255,.95)";
      g.beginPath(); g.moveTo(...prev); g.lineTo(...q); g.stroke(); prev = q;
    }
    g.restore();
  }
  drawAnnotations(g, lw) {
    const W = this.canvas.width, H = this.canvas.height;
    const list = this.draft ? [...this.ann, this.draft] : this.ann;
    g.save(); g.strokeStyle = COL.warn; g.fillStyle = COL.warn; g.lineWidth = lw; g.lineCap = "round";
    g.font = `600 ${Math.round(lw * 5.5)}px "IBM Plex Mono", monospace`;
    const px = p => [p[0] * W, p[1] * H];
    const tag = (txt, p) => {
      const w = g.measureText(txt).width;
      g.save(); g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(p[0] + 8, p[1] - lw * 6, w + 10, lw * 7.4); g.restore();
      g.fillText(txt, p[0] + 13, p[1]);
    };
    for (const d of list) {
      const P0 = d.pts.map(px);
      if (d.type === "line") {
        g.beginPath(); g.moveTo(...P0[0]); g.lineTo(...P0[1]); g.stroke();
        const ang = Math.abs(Math.atan2(P0[1][0] - P0[0][0], -(P0[1][1] - P0[0][1])) * 180 / Math.PI);
        if (dist(P0[0], P0[1]) > 10) tag(`${(ang > 90 ? 180 - ang : ang).toFixed(0)}° from vertical`, P0[1]);
      } else if (d.type === "circle") {
        g.beginPath(); g.arc(...P0[0], dist(P0[0], P0[1]), 0, 7); g.stroke();
      } else if (d.type === "angle") {
        g.beginPath(); g.moveTo(...P0[0]); g.lineTo(...P0[1]); if (P0[2]) g.lineTo(...P0[2]); g.stroke();
        if (P0[2] && dist(P0[1], P0[2]) > 6) {
          const a1 = Math.atan2(P0[0][1] - P0[1][1], P0[0][0] - P0[1][0]), a2 = Math.atan2(P0[2][1] - P0[1][1], P0[2][0] - P0[1][0]);
          let d = Math.abs(a2 - a1) * 180 / Math.PI; if (d > 180) d = 360 - d;
          tag(`${d.toFixed(0)}°`, P0[1]);
        }
      }
    }
    g.restore();
  }
  updateBadge(c, t) {
    let txt = "";
    if (c.phases) for (const k of PH) if (Number.isFinite(c.phases[k]) && Math.abs(t - c.phases[k]) <= 1) txt = k;
    this.badge.textContent = txt;
    this.badge.classList.toggle("show", !!txt);
  }
  updateReadout(c, F) {
    let html = "";
    if (c && state.layers.readout) {
      const m = F.m, cls = (bad, warn) => (bad ? "bad" : warn ? "warn" : "");
      const fmt = (v, u) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(u === "°" ? 0 : 1)}${u}`;
      if (c.view === "dtl") {
        html = `<div class="chip ${cls(F.spine, m.spineD <= -3)}">spine vs address<b>${fmt(m.spineD, "°")}</b></div>`
             + `<div class="chip ${cls(F.hip, m.hipD >= 1.5)}">hips → ball<b>${fmt(m.hipD, " cm")}</b></div>`
             + `<div class="chip ${cls(F.head, m.head >= 3.5)}">head moved<b>${m.head.toFixed(1)} cm</b></div>`;
      } else {
        html = `<div class="chip ${cls(F.head, m.headAway >= 6)}">head drift back<b>${fmt(m.headAway, " cm")}</b></div>`
             + `<div class="chip ${cls(F.hip, m.hipAway >= 3)}">hip slide back<b>${fmt(m.hipAway, " cm")}</b></div>`;
      }
    }
    if (html !== this.lastReadout) { this.readout.innerHTML = html; this.lastReadout = html; }
  }
}

const paneA = new Pane($("#paneA"));
const paneB = new Pane($("#paneB"));

/* ------------------------------------------------------------------ loading */
// Data files are plain scripts (window.LOWPOINT[key] = {...}) so the app also runs from file://.
function loadData(key, file) {
  window.LOWPOINT = window.LOWPOINT || {};
  if (window.LOWPOINT[key]) return Promise.resolve(window.LOWPOINT[key]);
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `data/${file}.js`;
    s.onload = () => (window.LOWPOINT[key] ? res(window.LOWPOINT[key]) : rej(new Error(`data/${file}.js has no data`)));
    s.onerror = () => rej(new Error(`data/${file}.js missing — run build_app.py`));
    document.head.appendChild(s);
  });
}
/* A clip comes from the local build (data/<id>.js), this device (IndexedDB) or the gist, in that order. */
async function getClip(id) {
  if (state.clips[id]) return state.clips[id];
  const it = state.index.find(i => i.id === id), srcs = it && it.srcs ? it.srcs : ["local"];
  let c, from;
  if (srcs.includes("local")) { c = structuredClone(await loadData(id, id)); from = "local"; }
  else if (srcs.includes("idb")) {
    const { C, D } = await mods(), r = await D.get("clips", id);
    if (!r) throw new Error(`clip ${id} is not on this device any more`);
    c = C.fromGistClip(r.clip); from = "idb";
  } else {
    const { C } = await mods(), g = await gistJSON(`clip-${id}.json`);
    if (!g) throw new Error(`clip ${id} is not in the gist`);
    c = C.fromGistClip(g); from = "gist";
  }
  c.srcs = srcs; c.from = from;
  state.clips[id] = prepare(c);
  return c;
}

/* Where to play a clip from: this device's video (IndexedDB) > local build media > gist low-res video >
   none (no-video mode with the phase stills). Returns {src: {url, offset} | null, stills}. */
async function openSource(c) {
  const m = await mods().catch(() => null);
  if (m) {
    const v = await m.D.get("videos", c.id).catch(() => null);
    if (v && v.blob) return { src: { url: URL.createObjectURL(v.blob), offset: v.offset ?? (c.videoStart || 0) } };
  }
  if (c.video) {
    try { return { src: { url: await videoUrl(c), offset: 0 } }; } catch (e) { if (!m) throw e; }
  }
  if (!m) return { src: null, stills: null };
  const gv = await gistJSON(`video-${c.id}.json`).catch(() => null);
  if (gv && gv.dataURL) {
    const blob = await (await fetch(gv.dataURL)).blob();
    return { src: { url: URL.createObjectURL(blob), offset: -(c.videoStartFrame || 0) / c.fps } };
  }
  const st = await m.D.get("stills", c.id).catch(() => null);
  const stills = st ? st.stills : await gistJSON(`stills-${c.id}.json`).catch(() => null);
  return { src: null, stills };
}

/* Gallery images of gist clips are separate img-*.json files: fetch them in the background. */
async function resolveImages(c) {
  const todo = (c.images || []).filter(im => !im.src && im.gist);
  if (!todo.length) return false;
  await Promise.all(todo.map(async im => {
    const d = await gistJSON(im.gist).catch(() => null);
    if (d && d.dataURL) im.src = d.dataURL; else im.missing = true;
  }));
  return true;
}
async function videoUrl(clip) {
  if (location.protocol === "file:") return clip.video;
  // over http, fetch as a blob: plain static servers (python -m http.server) lack Range support, which breaks seeking
  const r = await fetch(clip.video);
  if (!r.ok) throw new Error(`${clip.video}: ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

function revokeBlob(u) { if (u && u.startsWith("blob:")) URL.revokeObjectURL(u); }

/* Each pane has a generation token: a newer setA/setB call makes an in-flight one bail out after every await. */
async function setA(id) {
  if (state.review && !confirm("Leave the phase review? The new swing hasn't been saved.")) return;
  const tok = ++paneA.gen;
  const c = await getClip(id);
  const o = await openSource(c);
  if (tok !== paneA.gen) { revokeBlob(o.src && o.src.url); return; }
  state.playing = false;
  if (state.review) endReview();
  if (!(await paneA.load(c, o.src, o.stills)) || tok !== paneA.gen) return;
  state.A = c;
  resolveImages(c).then(ch => { if (ch && state.A === c) renderInsight(); }).catch(() => {});
  state.pos = Math.max(0, c.phases.address - 8);
  if (state.B && state.B.id === c.id) await setB(null);
  renderLibrary(); renderCompareSelect(); renderTimeline(); renderInsight(); relayout();
}

async function setB(sel) {
  const tok = ++paneB.gen;
  state.B = null;
  if (!sel) {
    paneB.unload(); $("#paneB").hidden = true; $("#stages").classList.remove("two");
  } else {
    let c, o;
    if (sel instanceof File) {
      const saved = JSON.parse(localStorage.getItem(`marks:${sel.name}`) || "{}");
      c = { id: `file:${sel.name}`, name: sel.name, kind: "file", fps: 30, lm: null, phases: saved };
      o = { src: { url: URL.createObjectURL(sel), offset: 0 } };
    } else {
      c = await getClip(sel);
      o = await openSource(c);
    }
    if (tok !== paneB.gen) { revokeBlob(o.src && o.src.url); return; }
    $("#paneB").hidden = false; $("#stages").classList.add("two");
    relayout();
    if (!(await paneB.load(c, o.src, o.stills)) || tok !== paneB.gen) return;
    state.B = c;
  }
  renderLibrary(); renderCompareSelect(); renderPaneFoot(); renderInsight(); relayout();
}

/* ------------------------------------------------------------------ UI: library / compare */
function renderLibrary() {
  const mk = item => {
    const b = document.createElement("button");
    b.className = "card" + (state.A && state.A.id === item.id ? " active" : "") + (state.B && state.B.id === item.id ? " inB" : "");
    const tags = item.faults.length ? item.faults.map(f => `<span class="tag bad">${esc(f)}</span>`).join("")
      : `<span class="tag ok">no major fault</span>`;
    b.innerHTML = `<div class="nm">${esc(item.name)}</div><div class="meta">${item.kind === "ref" ? "reference" : /^\d+$/.test(item.id) ? "IMG_" + esc(item.id) : esc(fmtDate(item.created))} · ${esc(item.club)}${srcBadge(item)}</div>`
      + `<div class="tags">${tags}</div><span class="vs" title="Open in the compare pane">+ compare</span>`;
    b.onclick = e => {
      if (e.target.classList.contains("vs")) { if (!state.A || state.A.id !== item.id) setB(item.id).catch(toastErr); }
      else setA(item.id).catch(toastErr);
    };
    return b;
  };
  const mine = $("#lib-mine"), ref = $("#lib-ref");
  const mineItems = state.index.filter(i => i.kind === "mine");
  if (mineItems.length) mine.replaceChildren(...mineItems.map(mk));
  else mine.innerHTML = `<p class="empty-lib">No swings yet — tap “+ New swing”.</p>`;
  const refs = state.index.filter(i => i.kind === "ref");
  if (refs.length) ref.replaceChildren(...refs.map(mk));
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "new swing";
}
function srcBadge(item) {
  const s = item.srcs || [];
  if (s.includes("idb")) return ` · <span class="src" title="Saved on this device${s.includes("gist") ? " and synced" : ""}">${s.includes("gist") ? "device ✓ synced" : "device"}</span>`;
  if (s.length === 1 && s[0] === "gist") return ` · <span class="src" title="From your gist library">cloud</span>`;
  return "";
}

function renderCompareSelect() {
  const sel = $("#cmp"), A = state.A;
  const opt = (v, t, s) => `<option value="${esc(v)}"${s ? " selected" : ""}>${esc(t)}</option>`;
  const cur = state.B ? state.B.id : "";
  let html = opt("", "— nothing (single view) —", !cur);
  const others = state.index.filter(i => !A || i.id !== A.id);
  const pri = i => (i.kind === "ref" && i.club === A.club ? 0 : 1); // same-club refs first
  const same = others.filter(i => A && i.view === A.view).sort((x, y) => pri(x) - pri(y)), diff = others.filter(i => !A || i.view !== A.view);
  if (same.length) html += `<optgroup label="Same camera angle">${same.map(i => opt(i.id, `${i.kind === "ref" ? "★ " : ""}${i.name}`, cur === i.id)).join("")}</optgroup>`;
  if (diff.length) html += `<optgroup label="Other angle (same swing session)">${diff.map(i => opt(i.id, i.name, cur === i.id)).join("")}</optgroup>`;
  if (state.B && state.B.kind === "file") html += opt(state.B.id, `📄 ${state.B.name}`, true);
  html += opt("__file", "Load a video file…", false);
  sel.innerHTML = html;
  document.body.classList.toggle("has-b", !!state.B);
  if (!state.B && state.ab && state.ab !== "both") setAB("both");
  const canOverlay = state.B && state.B.lm && A && state.B.view === A.view;
  $("#ovl-wrap").classList.toggle("disabled", !canOverlay);
  if (!canOverlay) { state.overlay = false; $("#ovl").checked = false; }
  const hasPh = !state.B || phaseList(state.B);
  $$("#sync button").forEach(b => { b.disabled = b.dataset.v === "phase" && !hasPh; });
  if (!hasPh && state.sync === "phase") setSync("time");
}

function renderPaneFoot() {
  const foot = $(".pane-foot", paneB.root), B = state.B;
  const range = $("input[type=range]", foot), marks = $(".mark-btns", foot);
  if (!B) return;
  range.max = B.n - 1;
  range.disabled = state.sync !== "off";
  range.oninput = () => paneB.seek(+range.value);
  marks.innerHTML = "";
  if (B.kind === "file") {
    for (const k of PH) {
      const b = document.createElement("button");
      b.textContent = `set ${k}`;
      b.className = Number.isFinite(B.phases[k]) ? "set" : "";
      b.title = "Mark the frame currently shown in this pane";
      b.onclick = () => {
        B.phases[k] = paneB.shown < 0 ? paneB.want : paneB.shown;
        localStorage.setItem(`marks:${B.name}`, JSON.stringify(B.phases));
        renderPaneFoot(); renderCompareSelect();
        toast(`${k} marked at frame ${B.phases[k] + 1}` + (phaseList(B) ? " — phase sync available" : ""));
      };
      marks.appendChild(b);
    }
  }
  foot.style.display = state.sync === "off" || B.kind === "file" ? "flex" : "none";
}

function setSync(v) {
  state.sync = v;
  $$("#sync button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  renderPaneFoot();
}

/* ------------------------------------------------------------------ timeline + transport */
function renderTimeline() {
  const tl = $("#timeline"), A = state.A;
  $$(".pin", tl).forEach(p => p.remove());
  if (!A) return;
  const faultPh = new Set(A.faults.map(f => f.phase));
  const W = tl.clientWidth || 600, xs = PH.map(k => A.phases[k] / (A.n - 1) * W);
  PH.forEach((k, i) => {
    const gap = Math.min(i > 0 ? xs[i] - xs[i - 1] : 1e9, i < 3 ? xs[i + 1] - xs[i] : 1e9);
    const p = document.createElement("div");
    p.className = "pin" + (faultPh.has(k) ? " fault" : "");
    p.textContent = gap > (W < 500 ? 86 : 62) ? k.toUpperCase() : PH_SHORT[k];
    p.title = `${k} — frame ${A.phases[k] + 1}`;
    p.dataset.ph = k;
    p.style.left = `${(A.phases[k] / (A.n - 1)) * 100}%`;
    p.onclick = e => { e.stopPropagation(); jump(A.phases[k]); };
    tl.appendChild(p);
  });
  const z = $(".swingzone", tl), a = A.phases.address, f = A.phases.finish;
  z.style.left = `${a / (A.n - 1) * 100}%`; z.style.width = `${(f - a) / (A.n - 1) * 100}%`;
}
function scrubAt(e) {
  const r = $("#timeline").getBoundingClientRect();
  jump(clamp((e.clientX - r.left) / r.width, 0, 1) * (state.A.n - 1));
}
function jump(f) { if (!state.A || !Number.isFinite(f)) return; state.playing = false; state.pos = clamp(f, 0, state.A.n - 1); }
function stepPhase(dir) {
  const A = state.A; if (!A) return;
  const cur = Math.round(state.pos), list = PH.map(k => A.phases[k]);
  const tgt = dir > 0 ? list.find(v => v > cur) : [...list].reverse().find(v => v < cur);
  jump(tgt ?? (dir > 0 ? A.n - 1 : 0));
}
function togglePlay() {
  const A = state.A; if (!A) return;
  if (!state.playing && !state.layers.loop && state.pos >= A.n - 1.5) state.pos = 0; // play at the end restarts
  state.playing = !state.playing;
}
function setRate(r) {
  state.rate = r;
  $$("#speed button").forEach(b => b.classList.toggle("on", +b.dataset.v === r));
}

function tick(ts) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (ts - (state.last || ts)) / 1000);
  state.last = ts;
  const A = state.A;
  if (A) {
    if (state.playing) {
      state.pos += dt * A.fps * state.rate;
      const lo = state.layers.loop ? Math.max(0, A.phases.address - 10) : 0;
      const hi = state.layers.loop ? Math.min(A.n - 1, A.phases.finish + 25) : A.n - 1;
      if (state.pos > hi) { if (state.layers.loop) state.pos = lo; else { state.pos = hi; state.playing = false; } }
    }
    paneA.seek(state.pos);
    if (state.B && state.sync !== "off") {
      const fB = mapFrame(state.pos);
      paneB.seek(fB);
      $("input[type=range]", paneB.root).value = Math.round(fB);
    }
    paneA.draw();
    if (state.B) paneB.draw();
    const f = Math.round(state.pos);
    $(".fill").style.width = `${(state.pos / (A.n - 1)) * 100}%`;
    $(".head", $("#timeline")).style.left = `${(state.pos / (A.n - 1)) * 100}%`;
    $("#clock").innerHTML = `<b>${String(f + 1).padStart(3, "0")}</b> / ${A.n}  ·  ${(f / A.fps).toFixed(2)}s`;
    $("#b-play").textContent = state.playing ? "❚❚" : "▶";
    $("#crumbs").innerHTML = `<b>${esc(A.name)}</b>${state.B ? `  vs  <b>${esc(state.B.name)}</b>` : ""}`;
  }
}

/* ------------------------------------------------------------------ insight panel */
const fmtV = (v, u) => `${Math.abs(v) < 10 && u !== "°" ? (+v).toFixed(1) : Math.round(v)}${u ? (u === "×" ? "×" : " " + u) : ""}`;

function renderInsight() {
  const A = state.A; if (!A) return;
  const d = $("#tab-diag");
  const goods = A.guides.filter(g => g.status === "good");
  const nF = A.faults.length;
  const refs = state.index.filter(x => x.kind === "ref" && x.view === A.view && x.id !== A.id); // never A itself
  const refFor = refs.find(x => x.club === A.club) || refs[0]; // prefer the same club
  let html = nF
    ? `<div class="verdict">${nF === 1 ? "One thing" : `${nF} things`} to fix: <em>${esc(A.faults.map(f => f.title).join(" & ").toLowerCase())}</em></div>`
    : `<div class="verdict">No major fault at the key checkpoints.</div>`;
  html += `<p class="lede">${A.view === "dtl"
    ? "Down-the-line shows posture: watch whether your spine and hips stay on their address lines through impact."
    : "Face-on shows weight shift: watch whether your head and hips stay centred while you turn back."}
    Green is you, red is where you leave the ideal position, the dashed lines are your own address set-up.</p>`;
  A.faults.forEach((f, i) => {
    html += `<div class="fault" style="animation-delay:${i * 0.08}s"><div class="ph">at ${esc(f.phase)}</div><h4>${esc(f.title)}</h4>`
      + `<p class="num">${esc(f.detail)}</p><p>${esc(f.why || "")}</p><p class="drill">${esc(f.fix)}</p>`
      + `<div class="acts"><button class="act primary" data-show="${i}">Show me ▸</button><button class="act" data-fix="${i}">Fix preview</button>`
      + `${refFor ? `<button class="act" data-ref="${i}">vs reference</button>` : ""}</div></div>`;
  });
  if (goods.length) html += `<h3>Working well</h3><ul class="strengths">${goods.map(g => `<li>${esc(g.label)} — ${fmtV(g.value, g.unit)}</li>`).join("")}</ul>`;
  html += `<div class="legend">
    <span><i style="border-color:${COL.ok}"></i> you (live skeleton & spine)</span>
    <span><i style="border-color:${COL.bad}"></i> fault — outside the ideal position</span>
    <span><i class="dash" style="border-color:${COL.fix}"></i> ideal guides / fix preview (your swing without the fault)</span>
    <span><i style="border-color:${COL.ref}"></i> reference swing overlay</span></div>`;
  html += `<ul class="caveat">${A.kind === "mine" && A.practice !== false ? `<li>These were slow practice swings without a ball — positions are meaningful, tempo is not, and speed-related faults can look different at full speed.</li>` : ""}`
    + A.notes.map(n => `<li>${esc(n)}</li>`).join("") + `</ul>`;
  d.innerHTML = html;
  $$("[data-show]", d).forEach(b => b.onclick = () => showFault(A.faults[+b.dataset.show], false));
  $$("[data-fix]", d).forEach(b => b.onclick = () => showFault(A.faults[+b.dataset.fix], true));
  $$("[data-ref]", d).forEach(b => b.onclick = async () => {
    await setB(refFor.id); setSync("phase"); state.overlay = true; $("#ovl").checked = true; showFault(A.faults[+b.dataset.ref], false);
  });

  // numbers
  const B = state.B && state.B.guides && state.B.view === A.view ? state.B : null;
  const bmap = B ? Object.fromEntries(B.guides.map(g => [g.key, g])) : {};
  let nh = B ? `<p class="lede">White marker = you, <span style="color:${COL.ref}">blue</span> = ${esc(B.name)}. Green band = guideline range, amber = borderline.</p>`
             : `<p class="lede">Green band = guideline range, amber = borderline, red = outside. Ranges are approximate coaching guidelines for phone video.</p>`;
  let lastPh = null;
  for (const g of A.guides) {
    if (g.phase !== lastPh) { nh += `<div class="phhead">${g.phase}</div>`; lastPh = g.phase; }
    const lo = Math.min(g.warn[0], g.value, bmap[g.key]?.value ?? Infinity), hi = Math.max(g.warn[1], g.value, bmap[g.key]?.value ?? -Infinity);
    const pad = (hi - lo) * 0.12 || 1, x0 = lo - pad, span = hi + pad - x0, pc = v => `${((v - x0) / span) * 100}%`;
    const wid = (a, b) => `${((b - a) / span) * 100}%`;
    const bv = bmap[g.key];
    nh += `<div class="mrow"><div class="t"><span>${esc(g.label)}</span><span class="v ${g.status}">${fmtV(g.value, g.unit)}${bv ? `<small>${fmtV(bv.value, bv.unit)}</small>` : ""}</span></div>`
      + `<div class="rbar"><div class="w" style="left:${pc(g.warn[0])};width:${wid(g.warn[0], g.warn[1])}"></div><div class="g" style="left:${pc(g.good[0])};width:${wid(g.good[0], g.good[1])}"></div>`
      + `${bv ? `<div class="m r" style="left:${pc(bv.value)}"></div>` : ""}<div class="m" style="left:${pc(g.value)}"></div></div>`
      + `<div class="note">${esc(g.note)} · guideline ${g.good[0]}…${g.good[1]}${g.unit === "×" ? "×" : " " + g.unit}</div></div>`;
  }
  $("#tab-nums").innerHTML = nh;

  // gallery
  const pending = (A.images || []).some(im => !im.src && im.gist && !im.missing);
  const gal = (A.images || []).filter(im => im.src).map(im => `<figure data-src="${esc(im.src)}"><img src="${esc(im.src)}" loading="lazy" alt=""><figcaption>${esc(im.label)}</figcaption></figure>`).join("");
  $("#tab-gal").innerHTML = gal ? `<div class="gal">${gal}</div>` : `<p class="lede">${pending ? "Loading images…" : "No images for this clip."}</p>`;
  $$("#tab-gal figure").forEach(f => f.onclick = () => { $("#lightbox img").src = f.dataset.src; $("#lightbox").classList.add("on"); });
}

function showFault(f, withFix) {
  setLayer("guides", true);
  setLayer("fix", withFix);
  jump(state.A.phases[f.phase]);
}
function setLayer(k, v) {
  state.layers[k] = v;
  const el = $(`[data-layer="${k}"]`); if (el) el.checked = v;
}

/* ------------------------------------------------------------------ misc */
let toastT;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), msg.startsWith("Error") ? 10000 : ms);
}
function toastErr(e) { console.error(e); toast(`Error: ${e.message || e}`); }
function relayout() { paneA.layout(); paneB.layout(); renderTimeline(); }

function bind() {
  $("#b-play").onclick = togglePlay;
  $("#b-back").onclick = () => jump(Math.round(state.pos) - 1);
  $("#b-fwd").onclick = () => jump(Math.round(state.pos) + 1);
  $("#b-prevph").onclick = () => stepPhase(-1);
  $("#b-nextph").onclick = () => stepPhase(1);
  $$("#speed button").forEach(b => b.onclick = () => setRate(+b.dataset.v));
  $$("#sync button").forEach(b => b.onclick = () => { if (!b.disabled) setSync(b.dataset.v); });
  $$("[data-layer]").forEach(el => el.onchange = () => { state.layers[el.dataset.layer] = el.checked; });
  $("#ovl").onchange = e => { state.overlay = e.target.checked; };
  $$(".tool[data-tool]").forEach(b => b.onclick = () => {
    state.tool = state.tool === b.dataset.tool ? null : b.dataset.tool;
    $$(".tool[data-tool]").forEach(x => x.classList.toggle("on", x.dataset.tool === state.tool));
    $$(".stage").forEach(s => s.classList.toggle("drawing", !!state.tool));
    paneA.draft = paneB.draft = null;
  });
  $("#t-clear").onclick = () => { paneA.ann = []; paneB.ann = []; paneA.draft = paneB.draft = null; };
  $("#cmp").onchange = e => {
    const v = e.target.value;
    if (v === "__file") { $("#file-in").click(); renderCompareSelect(); }
    else setB(v || null).catch(toastErr);
  };
  $("#file-in").onchange = e => { const f = e.target.files[0]; if (f) setB(f).then(() => setSync(phaseList(state.B) ? "phase" : "time")).catch(toastErr); e.target.value = ""; };
  const tl = $("#timeline");
  let dragPin = null;
  tl.onpointerdown = e => {
    if (!state.A) return;
    const pin = e.target.closest(".pin");
    if (pin && state.review) { // phase review: drag a pin to move that phase
      e.preventDefault();
      dragPin = pin; tl.setPointerCapture(e.pointerId);
      tl.onpointermove = ev => { scrubAt(ev); dragPin.style.left = `${(state.pos / (state.A.n - 1)) * 100}%`; };
      return;
    }
    // pins: jump straight to the phase (pointer capture below would retarget the pin's click to the timeline)
    if (pin) { pin.onclick(e); return; }
    tl.setPointerCapture(e.pointerId); scrubAt(e); tl.onpointermove = scrubAt;
  };
  tl.onpointerup = tl.onpointercancel = () => {
    tl.onpointermove = null;
    if (dragPin) { const k = dragPin.dataset.ph; dragPin = null; setReviewPhase(k, Math.round(state.pos)); }
  };
  $$(".tabs button").forEach(b => b.onclick = () => {
    $$(".tabs button").forEach(x => x.classList.toggle("on", x === b));
    $$(".tabpane").forEach(p => p.classList.toggle("on", p.id === `tab-${b.dataset.tab}`));
  });
  $("#lightbox").onclick = () => $("#lightbox").classList.remove("on");
  window.addEventListener("resize", relayout);
  new ResizeObserver(relayout).observe($("#stages"));
  window.addEventListener("keydown", e => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT" && e.target.type !== "checkbox") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === " ") { e.preventDefault(); togglePlay(); }
    else if (k === "ArrowLeft") { e.preventDefault(); jump(Math.round(state.pos) - (e.shiftKey ? 5 : 1)); }
    else if (k === "ArrowRight") { e.preventDefault(); jump(Math.round(state.pos) + (e.shiftKey ? 5 : 1)); }
    else if ("1234".includes(k) && k.length === 1 && state.A) jump(state.A.phases[PH[+k - 1]]);
    else if (k === "," || k === ".") {
      const rates = [0.125, 0.25, 0.5, 1], i = rates.indexOf(state.rate);
      setRate(rates[clamp(i + (k === "." ? 1 : -1), 0, 3)]);
    }
    else if (k === "f" || k === "F") setLayer("fix", !state.layers.fix);
    else if (k === "g" || k === "G") setLayer("guides", !state.layers.guides);
    else if (k === "Escape") { $("#lightbox").classList.remove("on"); paneA.draft = paneB.draft = null; }
  });
}

/* ================================================================== library sources, gist sync, new swing, phone UI */
// Pure logic lives in js/library.js, js/lpcodec.js, js/idb.js (ES modules, loaded lazily so the desktop viewer
// keeps working from file://, where module imports are blocked).
const lib = { mods: null, cfg: null, client: null, loadP: null, status: "" };

function mods() {
  if (!lib.mods) lib.mods = Promise.all([import("./js/library.js"), import("./js/lpcodec.js"), import("./js/idb.js")])
    .then(([L, C, D]) => ({ L, C, D }))
    .catch(e => { lib.mods = null; throw e; });
  return lib.mods;
}
function readConfig() {
  try { const c = JSON.parse(localStorage.getItem("lowpoint-sync") || "null"); return c && c.token ? c : null; }
  catch { return null; }
}
function writeConfig() { if (lib.cfg) localStorage.setItem("lowpoint-sync", JSON.stringify(lib.cfg)); }

/* Gist client with fresh (fresh=true) or already-loaded metadata; finds/creates the gist if needed. */
async function ensureGist(fresh = true, retried = false) {
  if (!lib.cfg) throw new Error("No GitHub token set (Settings)");
  const { L } = await mods();
  if (!lib.client || lib.client.token !== lib.cfg.token.trim()) { lib.client = new L.GistClient(lib.cfg.token); lib.loadP = null; }
  const cl = lib.client;
  if (!lib.cfg.gistId) {
    const r = await L.connect(cl);
    Object.assign(lib.cfg, { gistId: r.gistId, login: r.login, gistStatus: r.status }); writeConfig();
  }
  if (!fresh && cl.meta) return cl;
  if (fresh || !lib.loadP) lib.loadP = cl.load(lib.cfg.gistId);
  try { await lib.loadP; } catch (e) {
    lib.loadP = null;
    if (e.status === 404 && !retried) { lib.cfg.gistId = null; writeConfig(); return ensureGist(true, true); }
    throw e;
  }
  return cl;
}

/* Parsed gist file, cached in IndexedDB by raw_url (which pins the revision). null if the gist lacks it.
   Offline / not connected yet: the last cached copy. */
async function gistJSON(name) {
  const { D } = await mods();
  if (!lib.cfg) return null;
  if (!(lib.client && lib.client.meta)) await ensureGist(false).catch(() => {});
  const cl = lib.client;
  if (cl && cl.meta) {
    const url = cl.rawUrl(name);
    if (!url) return null;
    const hit = await D.cached(name, url);
    if (hit) return hit;
    const data = await cl.readJSON(name);
    D.putCache(name, url, data);
    return data;
  }
  return D.cached(name, null);
}

/* Library = local build (data/index.js) + this device (IndexedDB) + gist index, deduped by id. */
async function refreshLibrary() {
  const local = await loadData("__index", "index").catch(() => []);
  let m = null;
  try { m = await mods(); } catch { /* file:// — local build only */ }
  if (!m) state.index = local.map(i => ({ ...i, srcs: ["local"] }));
  else {
    const dev = await m.D.all("clips").catch(() => []);
    const gist = lib.cfg ? await gistJSON("index.json").catch(() => null) : null;
    state.index = m.L.mergeIndex([{ src: "local", items: local }, { src: "idb", items: dev.map(r => r.entry) },
                                  { src: "gist", items: Array.isArray(gist) ? gist : [] }]);
  }
  for (const it of state.index) if (state.clips[it.id]) state.clips[it.id].srcs = it.srcs;
  renderLibrary(); renderCompareSelect(); renderOnboarding();
  if (!$("#sheet-set").hidden) renderSettings();
}

function setSyncStatus(msg, err = false) {
  lib.status = msg;
  const el = $("#sync-status"); el.textContent = msg; el.classList.toggle("err", err);
}

async function uploadClip(id, { fresh = true } = {}) {
  const { L, D } = await mods();
  const cl = await ensureGist(fresh);
  const rec = await D.get("clips", id);
  if (!rec) return;
  const st = await D.get("stills", id);
  const remote = (await cl.readJSON("index.json")) || [];
  await cl.patch(lib.cfg.gistId, L.uploadFiles(rec.clip, st && st.stills, remote));
  rec.synced = true;
  await D.put("clips", rec);
}

let syncing = null;
function syncNow(opts) { return syncing || (syncing = doSync(opts).finally(() => { syncing = null; })); }
async function doSync({ quiet = false } = {}) {
  if (!lib.cfg) { if (!quiet) toast("Paste a GitHub token in Settings first"); return; }
  setSyncStatus("Syncing…");
  try {
    const cl = await ensureGist(true);
    const { D } = await mods();
    const pending = (await D.all("clips")).filter(r => !r.synced);
    for (const r of pending) await uploadClip(r.id, { fresh: false });
    await refreshLibrary();
    if (!state.A && !state.review && state.index.length) {
      const first = state.index.find(i => i.kind === "mine") || state.index[0];
      await setA(first.id);
    }
    const n = Object.keys(cl.meta.files || {}).filter(k => k.startsWith("clip-")).length;
    setSyncStatus(`Synced ${new Date().toLocaleTimeString()} · ${n} clip${n === 1 ? "" : "s"} in the gist` +
      (pending.length ? ` · uploaded ${pending.length}` : ""));
    if (!quiet) toast("Synced");
  } catch (e) {
    setSyncStatus(e.message || String(e), true);
    if (!quiet) toastErr(e);
  }
}

async function connectToken() {
  const t = $("#tok").value.trim();
  if (!t) { toast("Paste a token first"); return; }
  const { L } = await mods();
  setSyncStatus("Checking the token…");
  try {
    const cl = new L.GistClient(t);
    const r = await L.connect(cl);
    lib.cfg = { token: t, gistId: r.gistId, login: r.login, gistStatus: r.status };
    writeConfig(); lib.client = cl; lib.loadP = null;
    $("#tok").value = "";
    renderSettings();
    toast(`Connected as ${r.login} — library gist ${r.status}`);
    await syncNow();
    renderSettings();
  } catch (e) { setSyncStatus(e.message || String(e), true); }
}
async function clearToken() {
  if (!confirm("Remove the GitHub token from this device? Clips saved here stay here.")) return;
  localStorage.removeItem("lowpoint-sync");
  lib.cfg = null; lib.client = null; lib.loadP = null;
  setSyncStatus("Token removed.");
  await refreshLibrary();
  renderSettings();
}

async function deleteClip(id) {
  const it = state.index.find(i => i.id === id);
  if (!it) return;
  const inGist = it.srcs.includes("gist") && lib.cfg;
  const where = [it.srcs.includes("idb") || !inGist ? "this device" : null, inGist ? "your gist" : null].filter(Boolean).join(" and ");
  if (!confirm(`Delete “${it.name}” from ${where}?`)) return;
  const { L, D } = await mods();
  await D.deleteClip(id);
  if (inGist) {
    const cl = await ensureGist(true);
    const remote = (await cl.readJSON("index.json")) || [];
    await cl.patch(lib.cfg.gistId, L.deleteFiles(id, remote, n => cl.has(n)));
  }
  delete state.clips[id];
  if (state.B && state.B.id === id) await setB(null);
  await refreshLibrary();
  state.index = state.index.filter(i => i.id !== id); // even if a stale cached index still lists it
  renderLibrary(); renderCompareSelect();
  if (state.A && state.A.id === id) {
    const next = state.index.find(i => i.kind === "mine") || state.index[0];
    if (next) await setA(next.id);
    else { paneA.unload(); state.A = null; $$(".tabpane").forEach(p => { p.innerHTML = ""; }); renderOnboarding(); }
  }
  renderSettings();
  toast("Deleted");
}

const mb = b => (b == null ? "?" : b < 1e6 ? `${(b / 1e3).toFixed(0)} KB` : `${(b / 1e6).toFixed(b < 1e8 ? 1 : 0)} MB`);
async function renderSettings() {
  const c = lib.cfg;
  $("#tok").placeholder = c ? "token saved on this device" : "ghp_… (classic token, gist scope)";
  $("#tok-clear").disabled = !c; $("#sync-now").disabled = !c;
  $("#gist-status").innerHTML = c
    ? `GitHub <b>${esc(c.login || "?")}</b> · ${c.gistId ? `secret gist <code>${esc(c.gistId.slice(0, 8))}</code> ${esc(c.gistStatus || "found")}` : "gist not found yet"}`
    : "Not connected — swings stay on this device.";
  $("#sync-status").textContent = lib.status;
  let m;
  try { m = await mods(); } catch { $("#set-clips").innerHTML = `<p class="hint">Storage needs http(s).</p>`; return; }
  const vids = new Set(await m.D.keys("videos").catch(() => []));
  $("#set-clips").innerHTML = state.index.map(it => {
    const s = it.srcs || [];
    const where = [s.includes("local") && "Mac build", s.includes("idb") && "this device", vids.has(it.id) && "video here",
                   s.includes("gist") && "gist"].filter(Boolean).join(" · ");
    const can = s.includes("idb") || vids.has(it.id) || (s.includes("gist") && c);
    return `<div class="crow"><div><b>${esc(it.name)}</b><small>${esc(where)}</small></div>`
      + (can ? `<button class="act danger" data-del="${esc(it.id)}">Delete</button>` : `<small>local build</small>`) + `</div>`;
  }).join("") || `<p class="hint">No clips yet.</p>`;
  $$("#set-clips [data-del]").forEach(b => b.onclick = () => deleteClip(b.dataset.del).catch(toastErr));
  const u = await m.D.usage().catch(() => null);
  $("#set-usage").textContent = u ? `Storage: ${mb(u.usage)} used${u.quota ? ` of ${mb(u.quota)}` : ""} · ${u.nVideos} video${u.nVideos === 1 ? "" : "s"} on this device (${mb(u.videos)})` : "";
}

function renderOnboarding() {
  const empty = !state.index.length && !state.A;
  document.body.classList.toggle("empty", empty);
  $("#onboard").hidden = !empty;
  $("#ob-connect").hidden = !!lib.cfg;
}

/* ------------------------------------------------------------------ sheets */
function openSheet(name) {
  $$(".sheet").forEach(s => { s.hidden = s.id !== `sheet-${name}`; });
  document.body.classList.add("sheet-open");
  document.body.classList.remove("lib-open");
  if (name === "set") renderSettings().catch(toastErr);
}
function closeSheet() {
  if (nw.ctrl) nw.ctrl.abort();
  $$(".sheet").forEach(s => { s.hidden = true; });
  document.body.classList.remove("sheet-open");
  const v = $("#new-vid"); v.pause();
}
const closeLib = () => document.body.classList.remove("lib-open");

/* ------------------------------------------------------------------ new swing: pick → options/trim → pose → analyze */
const nw = { file: null, url: null, ctrl: null, view: "dtl", club: "driver", model: "full", maxS: 20 };

async function openNew(file) {
  nw.file = file;
  revokeBlob(nw.url); nw.url = URL.createObjectURL(file);
  const { L } = await mods();
  $("#new-name").value = L.defaultName();
  $("#new-err").textContent = "";
  newStep("form");
  const v = $("#new-vid");
  v.onloadedmetadata = () => {
    const d = v.duration || 0;
    for (const id of ["#trim-s", "#trim-e"]) { $(id).max = d.toFixed(2); }
    $("#trim-s").value = 0; $("#trim-e").value = Math.min(d, nw.maxS).toFixed(2);
    updateTrim(null);
  };
  v.src = nw.url;
  openSheet("new");
}
function newStep(s) { $("#new-form").hidden = s !== "form"; $("#new-run").hidden = s !== "run"; }
function updateTrim(which) {
  const S = $("#trim-s"), E = $("#trim-e"), v = $("#new-vid");
  let s = +S.value, e = +E.value;
  if (e - s < 0.5) { if (which === "s") S.value = s = Math.max(0, e - 0.5); else E.value = e = Math.min(+E.max, s + 0.5); }
  if (which) v.currentTime = which === "s" ? s : e;
  const len = e - s;
  $("#trim-v").textContent = `${s.toFixed(2)} s → ${e.toFixed(2)} s · ${len.toFixed(1)} s`
    + (len > nw.maxS ? ` (only the first ${nw.maxS} s are analyzed)` : "");
}

async function runNew() {
  if (!nw.file) return;
  const s = +$("#trim-s").value, e = +$("#trim-e").value;
  $("#new-err").textContent = "";
  newStep("run");
  $("#new-prog").value = 0; $("#new-stage").textContent = "Loading the pose model…";
  nw.ctrl = new AbortController();
  const signal = nw.ctrl.signal;
  try {
    const [{ extractPose }, An, { L }] = await Promise.all([import("./js/pose.js"), import("./js/analyzer.js"), mods()]);
    const label = { load: "Opening the video…", fps: "Measuring frame rate…", model: "Loading the pose model…", done: "Analyzing…" };
    const r = await extractPose(nw.file, {
      model: nw.model, start: s, end: e, signal,
      onProgress: p => {
        $("#new-prog").value = p.stage === "pose" ? p.frac : 0;
        $("#new-stage").textContent = p.stage === "pose"
          ? `Finding the body: frame ${p.i} / ${p.n}${p.msPerFrame ? ` · ${Math.round(p.msPerFrame)} ms/frame` : ""}`
          : label[p.stage] || p.stage;
      },
    });
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    if (r.detected < Math.min(10, r.n)) throw new Error(`Only ${r.detected} of ${r.n} frames had a body in view — film the whole body, well lit.`);
    const opts = { w: r.w, h: r.h, fps: r.fps, view: nw.view, club: nw.club };
    let clip, auto = true;
    try { clip = An.analyze(r.lm, opts); } catch (err) {
      console.warn("auto phases failed", err); auto = false; // start from evenly spaced guesses; the review step fixes them
      const f = x => Math.round(x * (r.n - 1));
      clip = An.analyze(r.lm, { ...opts, frames: { address: f(0.1), top: f(0.45), impact: f(0.6), finish: f(0.85) } });
    }
    const now = new Date();
    Object.assign(clip, { id: L.newClipId(now), name: $("#new-name").value.trim() || L.defaultName(now), kind: "mine",
                          practice: false, created: now.toISOString(), videoStart: r.start, srcFps: r.srcFps });
    nw.ctrl = null;
    closeSheet();
    await startReview(clip, nw.file, r, opts);
    toast(auto ? "Check the four phases, then Save" : "Couldn't find the phases automatically — set them, then Save", 4000);
  } catch (err) {
    newStep("form");
    if (err.name !== "AbortError") { console.error(err); $("#new-err").textContent = err.message || String(err); }
  } finally { nw.ctrl = null; }
}

/* ------------------------------------------------------------------ phase review (the draft clip lives in pane A) */
async function startReview(clip, file, r, opts) {
  if (state.B) await setB(null);
  const tok = ++paneA.gen;
  state.playing = false;
  prepare(clip);
  state.review = { clip, file, r, opts };
  if (!(await paneA.load(clip, { url: URL.createObjectURL(file), offset: r.start })) || tok !== paneA.gen) return;
  state.A = clip;
  state.pos = Math.max(0, clip.phases.address - 8);
  document.body.classList.add("reviewing");
  $("#review").hidden = false;
  renderReview(); renderLibrary(); renderCompareSelect(); renderTimeline(); renderInsight(); relayout(); renderOnboarding();
}
function renderReview() {
  const R = state.review; if (!R) return;
  $$("#review [data-ph]").forEach(b => { $("small", b).textContent = `#${R.clip.phases[b.dataset.ph] + 1}`; });
}
function endReview() {
  state.review = null;
  document.body.classList.remove("reviewing");
  $("#review").hidden = true;
}
async function setReviewPhase(k, f) {
  const R = state.review; if (!R || !PH.includes(k)) return;
  const ph = { ...R.clip.phases, [k]: clamp(Math.round(f), 0, R.clip.n - 1) };
  const v = PH.map(x => ph[x]);
  if (!v.every((x, i) => i === 0 || x > v[i - 1])) {
    toast("Phases must stay in order: address → top → impact → finish"); renderTimeline(); return;
  }
  const An = await import("./js/analyzer.js");
  const { id, name, kind, practice, created, videoStart, srcFps } = R.clip;
  const c = Object.assign(An.analyze(R.r.lm, { ...R.opts, frames: ph }), { id, name, kind, practice, created, videoStart, srcFps });
  prepare(c);
  if (state.review !== R) return;
  R.clip = c; state.A = c; paneA.clip = c;
  renderTimeline(); renderInsight(); renderReview();
  toast(`${k} set to frame ${ph[k] + 1} — re-analyzed`);
}
async function discardReview() {
  if (!confirm("Discard this swing?")) return;
  endReview(); paneA.unload(); state.A = null;
  const first = state.index.find(i => i.kind === "mine") || state.index[0];
  if (first) await setA(first.id);
  else { $$(".tabpane").forEach(p => { p.innerHTML = ""; }); renderTimeline(); renderOnboarding(); }
}

function seekVideo(v, t) {
  return new Promise(res => {
    let to = null;
    const done = () => { clearTimeout(to); v.removeEventListener("seeked", done); setTimeout(res, 80); };
    to = setTimeout(done, 3000);
    v.addEventListener("seeked", done);
    v.currentTime = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.001));
  });
}
/* JPEG stills (~540 px tall) at the four phases, for devices that don't have the video. */
async function captureStills(file, clip, start) {
  const url = URL.createObjectURL(file), v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.setAttribute("muted", ""); v.preload = "auto";
  Object.assign(v.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none", zIndex: "-1" });
  v.src = url; document.body.appendChild(v);
  try {
    await new Promise((res, rej) => {
      if (v.readyState >= 2) return res();
      v.onloadeddata = res; v.onerror = () => rej(new Error("could not read the video for stills"));
    });
    const H = Math.min(540, v.videoHeight), W = Math.round(H * v.videoWidth / v.videoHeight);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d"), out = {};
    for (const k of PH) {
      await seekVideo(v, (clip.phases[k] + 0.5) / clip.fps + start);
      g.drawImage(v, 0, 0, W, H);
      out[k] = cv.toDataURL("image/jpeg", 0.8);
    }
    return out;
  } finally { v.removeAttribute("src"); v.load(); v.remove(); URL.revokeObjectURL(url); }
}

async function saveReview() {
  const R = state.review; if (!R) return;
  const btn = $("#rv-save"); btn.disabled = true; btn.textContent = "Saving…";
  try {
    const { L, C, D } = await mods();
    const stills = await captureStills(R.file, R.clip, R.r.start);
    const { K, srcs, from, ...plain } = R.clip;
    const g = C.toGistClip(plain);
    await D.put("clips", { id: g.id, clip: g, entry: L.indexEntry(g), synced: false });
    await D.put("videos", { id: g.id, blob: R.file, offset: R.r.start });
    await D.put("stills", { id: g.id, stills });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    endReview();
    await refreshLibrary();
    await setA(g.id);
    toast(lib.cfg ? "Saved on this device — uploading to your gist…" : "Saved on this device");
    if (lib.cfg) uploadClip(g.id).then(refreshLibrary).then(() => toast("Uploaded to your gist"))
      .catch(e => { setSyncStatus(e.message, true); toast(`Saved here; upload failed (${e.message}) — Sync now retries`, 6000); });
  } catch (e) { toastErr(e); }
  finally { btn.disabled = false; btn.textContent = "Save swing"; }
}

/* ------------------------------------------------------------------ attach a video to a no-video clip */
let attachPane = null;
async function onAttach(file) {
  const pane = attachPane, c = pane && pane.clip;
  if (!c || !file) return;
  const { D } = await mods();
  await D.put("videos", { id: c.id, blob: file, offset: c.videoStart || 0 });
  toast("Video attached on this device");
  if (pane === paneA) await setA(c.id); else await setB(c.id);
}

/* ------------------------------------------------------------------ phone A/B toggle */
function setAB(v) {
  state.ab = v;
  $$("#ab button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  const st = $("#stages");
  st.classList.toggle("ab-a", v === "a"); st.classList.toggle("ab-b", v === "b");
  relayout();
}

function bindMobile() {
  const pick = () => $("#new-in").click();
  $("#h-new").onclick = pick; $("#lib-new").onclick = pick; $("#ob-add").onclick = pick;
  $("#h-set").onclick = () => openSheet("set"); $("#ob-connect").onclick = () => openSheet("set");
  $("#h-lib").onclick = () => document.body.classList.toggle("lib-open");
  $("#lib-close").onclick = closeLib;
  $(".library").addEventListener("click", e => { if (e.target.closest(".card")) closeLib(); });
  $("#scrim").onclick = () => { closeLib(); if (!nw.ctrl) closeSheet(); };
  $$("[data-close]").forEach(b => b.onclick = closeSheet);
  $("#new-in").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openNew(f).catch(toastErr); };
  $("#attach-in").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) onAttach(f).catch(toastErr); };
  $$(".attach").forEach(b => b.onclick = () => { attachPane = b.closest("#paneB") ? paneB : paneA; $("#attach-in").click(); });
  for (const [sel, key] of [["#new-view", "view"], ["#new-club", "club"], ["#new-model", "model"]]) {
    $$(`${sel} button`).forEach(b => b.onclick = () => {
      nw[key] = b.dataset.v; $$(`${sel} button`).forEach(x => x.classList.toggle("on", x === b));
    });
  }
  $("#trim-s").oninput = () => updateTrim("s");
  $("#trim-e").oninput = () => updateTrim("e");
  $("#new-go").onclick = () => runNew().catch(toastErr);
  $("#new-cancel").onclick = () => { if (nw.ctrl) nw.ctrl.abort(); };
  $$("#review [data-ph]").forEach(b => b.onclick = () => setReviewPhase(b.dataset.ph, Math.round(state.pos)).catch(toastErr));
  $("#rv-save").onclick = () => saveReview();
  $("#rv-discard").onclick = () => discardReview().catch(toastErr);
  $("#tok-save").onclick = () => connectToken().catch(toastErr);
  $("#tok-clear").onclick = () => clearToken().catch(toastErr);
  $("#sync-now").onclick = () => syncNow().then(renderSettings).catch(toastErr);
  $$("#ab button").forEach(b => b.onclick = () => setAB(b.dataset.v));
  window.addEventListener("keydown", e => { if (e.key === "Escape") { closeLib(); if (!nw.ctrl) closeSheet(); } });
}

function registerSW() {
  // Only on https (GitHub Pages) or with ?sw=1, so the Mac's local dev server never serves a stale app shell.
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && !/[?&]sw=1\b/.test(location.search)) return;
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker", e));
}

/* Deep links: #a=4582&b=4579&f=208&fix=1&path=1&ovl=1&sync=phase&tab=nums&rate=0.5 */
async function applyHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (![...h.keys()].length) return;
  const a = h.get("a"), b = h.get("b");
  if (a && a !== state.A?.id && state.index.some(i => i.id === a)) await setA(a);
  if (b && b !== state.B?.id && b !== state.A?.id && state.index.some(i => i.id === b)) await setB(b);
  if (["phase", "time", "off"].includes(h.get("sync"))) setSync(h.get("sync"));
  for (const k of Object.keys(state.layers)) if (h.has(k)) setLayer(k, h.get(k) === "1");
  if (h.get("ovl") === "1" && !$("#ovl-wrap").classList.contains("disabled")) { state.overlay = true; $("#ovl").checked = true; }
  if (h.get("rate") && +h.get("rate") > 0) setRate(+h.get("rate"));
  if (h.get("tab")) $(`.tabs button[data-tab="${h.get("tab")}"]`)?.click();
  if (h.get("f") && state.A) {
    const f = h.get("f"), ph = PH.includes(f) ? state.A.phases[f] : +f - 1;
    jump(ph); // jump() ignores non-numeric values
  }
  if (h.get("play") === "1") state.playing = true;
}

async function init() {
  bind();
  bindMobile();
  lib.cfg = readConfig();
  try {
    await refreshLibrary();
    const first = state.index.find(i => i.kind === "mine") || state.index[0];
    if (first) await setA(first.id);
    await applyHash();
  } catch (e) { toastErr(e); }
  renderOnboarding();
  requestAnimationFrame(tick);
  if (lib.cfg) syncNow({ quiet: true }).catch(() => {});
  registerSW();
}
window.addEventListener("error", e => toast(`Error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", e => toast(`Error: ${e.reason?.message || e.reason}`));
window.addEventListener("hashchange", () => applyHash().catch(toastErr));
init();
