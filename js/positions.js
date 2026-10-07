"use strict";
/* Golf's P1–P10 positions, defined by hand height (classic script: sets globalThis.LPPositions, so it also
   loads from file:// and can be imported by Node for tests). Python twin: tools/positions.py — keep them identical.

   pPositions(clip) -> [{p: 1..10, label, short, frame}], frames strictly increasing (unless the phases are
   too close together to fit one frame in between).
   clip.lm: [n][33][>=2] normalized x, y (y grows downward); clip.phases: {address, top, impact, finish} (0-based).
   Hands = mean of wrists 15/16, smoothed over ±2 frames. Levels come from the address
   frame: "hip height" is halfway between the address hands and the address shoulders, "shoulder height" is the
   address shoulder y. Each in-between P is the first frame inside its phase segment where
   the hands cross that level in the expected direction; with no crossing, the segment's time midpoint. */
(function (root) {
  const LABELS = [
    "address", "hands hip-high back", "hands shoulder-high back", "top", "hands shoulder-high down",
    "hands hip-high down", "impact", "hands hip-high through", "hands shoulder-high through", "finish",
  ];
  const PHASE_P = { address: 1, top: 4, impact: 7, finish: 10 };

  function yAt(lm, i, joints, s) {
    const n = lm.length;
    let sum = 0, k = 0;
    for (let t = i - s; t <= i + s; t++) {
      if (t < 0 || t >= n) continue;
      let y = 0;
      for (const j of joints) y += lm[t][j][1];
      sum += y / joints.length; k++;
    }
    return sum / k;
  }

  /* first i in (lo, hi) where cond(i) is true and cond(i-1) false; else the midpoint of (lo, hi) */
  function firstCross(lo, hi, cond) {
    for (let i = lo + 1; i < hi; i++) if (cond(i) && !cond(i - 1)) return i;
    return Math.floor((lo + hi) / 2);
  }

  function pPositions(clip) {
    const lm = clip.lm, ph = clip.phases;
    if (!lm || !lm.length || !ph) return [];
    const a = ph.address, tp = ph.top, im = ph.impact, fi = ph.finish;
    if (![a, tp, im, fi].every(Number.isFinite)) return [];
    const n = lm.length;
    const hand = new Array(n);
    for (let i = 0; i < n; i++) hand[i] = yAt(lm, i, [15, 16], 2);
    // In 2D the address hands hang only ~1-3 % of the frame below the hip line, so a crossing of the hip line
    // itself fires a few frames into the takeaway; halfway from the address hands to the shoulders is P2/P6/P8.
    const shY = yAt(lm, a, [11, 12], 2), handA = hand[a];
    const hipT = (handA + shY) / 2;
    const shT = shY;
    const up = T => i => hand[i] <= T, down = T => i => hand[i] >= T;
    const f = [a];
    f.push(firstCross(a, tp, up(hipT)));          // P2
    f.push(firstCross(f[1], tp, up(shT)));        // P3
    f.push(tp);                                   // P4
    f.push(firstCross(tp, im, down(shT)));        // P5
    f.push(firstCross(f[4], im, down(hipT)));     // P6
    f.push(im);                                   // P7
    f.push(firstCross(im, fi, up(hipT)));         // P8
    f.push(firstCross(f[7], fi, up(shT)));        // P9
    f.push(fi);                                   // P10
    return f.map((frame, i) => ({ p: i + 1, label: `P${i + 1} · ${LABELS[i]}`, short: `P${i + 1}`, frame }));
  }

  /* All stills of a clip as [[frame, dataURL]] sorted by frame: the named phase keys plus the `frames` map. */
  function stillList(stills, phases) {
    if (!stills) return [];
    const m = new Map();
    if (stills.frames) for (const [k, v] of Object.entries(stills.frames)) if (v && Number.isFinite(+k)) m.set(+k, v);
    if (phases) for (const k of Object.keys(PHASE_P)) if (stills[k] && Number.isFinite(phases[k])) m.set(phases[k], stills[k]);
    return [...m.entries()].sort((x, y) => x[0] - y[0]);
  }

  /* index of the entry in `frames` (sorted numbers) nearest to t */
  function nearestIndex(frames, t) {
    let best = -1, bd = Infinity;
    frames.forEach((f, i) => { const d = Math.abs(f - t); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  root.LPPositions = { pPositions, stillList, nearestIndex, LABELS, PHASE_P };
})(typeof globalThis !== "undefined" ? globalThis : window);
