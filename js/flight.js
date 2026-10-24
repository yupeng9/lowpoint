/* Ball-flight model for the face/path simulator (right-handed golfer, target straight ahead).
 *
 * Sign convention (degrees, relative to the target line):
 *   face  > 0 = open (points right of target)      path > 0 = in-to-out (swings to the right)
 *   face-to-path = face - path:  > 0 curves right (fade/slice), < 0 curves left (draw/hook)
 *
 * Coordinates: x = downrange, y = right of target, z = up (metres).
 * Physics: gravity + drag + Magnus lift from a tilted backspin axis, spin decays slowly.
 * The face/path -> start direction and spin-axis rules are simplified "new ball flight laws";
 * real numbers vary with strike point, loft and speed.
 */

export const CLUBS = {
  driver: { name: "Driver", speedMph: 145, launch: 12, spin: 2700, faceWeight: 0.85, tiltPerDeg: 2.4 },
  iron7:  { name: "7-iron", speedMph: 112, launch: 17, spin: 6800, faceWeight: 0.75, tiltPerDeg: 1.4 },
};

const G = 9.81, RHO = 1.2, R = 0.02135, M = 0.04593, A = Math.PI * R * R;
const deg = d => (d * Math.PI) / 180;

/** Start direction and spin-axis tilt from face/path (degrees). */
export function impact(face, path, club) {
  const c = CLUBS[club];
  const start = c.faceWeight * face + (1 - c.faceWeight) * path;
  const f2p = face - path;
  const tilt = Math.max(-45, Math.min(45, f2p * c.tiltPerDeg)); // + tilts right = fade spin
  return { start, f2p, tilt };
}

/** Integrate the flight. Returns {pts:[[x,y,z],...], carry, side, apex, time, ...} in metres. */
export function simulate({ face = 0, path = 0, club = "driver", speedMph, spin, launch } = {}) {
  const c = CLUBS[club];
  const { start, f2p, tilt } = impact(face, path, club);
  const v0 = (speedMph ?? c.speedMph) * 0.44704;
  let w = ((spin ?? c.spin) * 2 * Math.PI) / 60;
  const la = deg(launch ?? c.launch), az = deg(start), t = deg(tilt);
  let v = [v0 * Math.cos(la) * Math.cos(az), v0 * Math.cos(la) * Math.sin(az), v0 * Math.sin(la)];
  // backspin about the horizontal axis to the golfer's right of the start line, tilted by `t`
  const lat = [-Math.sin(az), Math.cos(az), 0];
  const axis = [-Math.cos(t) * lat[0], -Math.cos(t) * lat[1], Math.sin(t)];
  let p = [0, 0, 0], time = 0, apex = 0;
  const pts = [p.slice()], dt = 0.005;
  const accel = (vv, ww) => {
    const s = Math.hypot(...vv), S = (R * ww) / s;
    const cd = 0.21 + 0.2 * S, cl = Math.min(0.32, 1.75 * S);
    const ox = axis[0], oy = axis[1], oz = axis[2];
    const cr = [oy * vv[2] - oz * vv[1], oz * vv[0] - ox * vv[2], ox * vv[1] - oy * vv[0]]; // axis x v
    const crn = Math.hypot(...cr) || 1;
    const k = (0.5 * RHO * A) / M;
    return [0, 1, 2].map(i => -k * cd * s * vv[i] + k * cl * s * s * (cr[i] / crn) - (i === 2 ? G : 0));
  };
  while (time < 15) {
    const a1 = accel(v, w);                                    // midpoint (RK2) step
    const vm = v.map((x, i) => x + a1[i] * dt / 2);
    const a2 = accel(vm, w);
    p = p.map((x, i) => x + vm[i] * dt);
    v = v.map((x, i) => x + a2[i] * dt);
    w *= Math.exp(-dt / 25);                                   // ~4% spin loss per second
    time += dt;
    apex = Math.max(apex, p[2]);
    if (p[2] < 0) { pts.push([p[0], p[1], 0]); break; }
    if (pts.length < 2 || Math.round(time / dt) % 4 === 0) pts.push(p.slice());
  }
  const land = pts[pts.length - 1];
  return { pts, carry: land[0], side: land[1], apex, time, start, f2p, tilt, shape: shapeName(start, f2p), parts: shotParts(start, f2p) };
}

/** Golf terms for the two parts of a shot.
 *  start: "pull" (starts left) | "straight" | "push" (starts right)
 *  curve: "hook" (big curve left) | "draw" | "none" | "fade" | "slice" (big curve right) */
export function shotParts(start, f2p) {
  const s = start > 1.5 ? "push" : start < -1.5 ? "pull" : "straight";
  const a = Math.abs(f2p);
  const c = a < 1 ? "none" : f2p > 0 ? (a >= 4 ? "slice" : "fade") : (a >= 4 ? "hook" : "draw");
  return { start: s, curve: c };
}

/** e.g. "push-slice", "pull-hook", "fade", "push", "straight". */
export function shapeName(start, f2p) {
  const { start: s, curve: c } = shotParts(start, f2p);
  if (s === "straight") return c === "none" ? "straight" : c;
  return c === "none" ? s : `${s}-${c}`;
}

export const YD = 1.09361;
