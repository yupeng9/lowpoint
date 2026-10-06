// Lowpoint landmark codec + gist clip form (browser and Node ES module).
// Format (matches tools/export_gist.py): clip.lmB64 = base64 of uint16 little-endian, frame-major
// [n][lmJoints.length][x, y, vis], value = round(clamp(v, 0, 1) * 65535). decodeLm -> [n][33][3];
// joints not in clip.lmJoints are [NaN, NaN, 0].

export const LM_JOINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

function b64ToBytes(b64) {
  if (typeof atob === "function") {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(globalThis.Buffer.from(b64, "base64"));
}

function bytesToB64(bytes) {
  if (typeof btoa !== "function") return globalThis.Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// numpy-compatible: np.round is half-to-even; null/NaN -> 0 (np.clip(NaN) stays NaN -> astype gives 0 on
// common platforms; app-produced lm never contains NaN for the encoded joints anyway).
function q16(v) {
  if (v == null || Number.isNaN(v)) return 0;
  const x = Math.min(1, Math.max(0, v)) * 65535;
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 === 1) r -= 1; // ties to even
  return r;
}

export function encodeLm(lm, joints = LM_JOINTS) {
  const n = lm.length, J = joints.length;
  const bytes = new Uint8Array(n * J * 6);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  for (let f = 0; f < n; f++) {
    for (const j of joints) {
      const p = lm[f][j] || [];
      dv.setUint16(o, q16(p[0]), true);
      dv.setUint16(o + 2, q16(p[1]), true);
      dv.setUint16(o + 4, q16(p[2]), true);
      o += 6;
    }
  }
  return bytesToB64(bytes);
}

export function decodeLm(clip) {
  if (clip.lm) return clip.lm; // already uncompressed (local data/ build)
  const joints = clip.lmJoints, n = clip.n, J = joints.length;
  const bytes = b64ToBytes(clip.lmB64);
  if (bytes.length !== n * J * 3 * 2) throw new Error(`lmB64 size ${bytes.length} != ${n * J * 6}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(n);
  let o = 0;
  for (let f = 0; f < n; f++) {
    const frame = new Array(33);
    for (let j = 0; j < 33; j++) frame[j] = [NaN, NaN, 0];
    for (let k = 0; k < J; k++) {
      frame[joints[k]] = [dv.getUint16(o, true) / 65535, dv.getUint16(o + 2, true) / 65535, dv.getUint16(o + 4, true) / 65535];
      o += 6;
    }
    out[f] = frame;
  }
  return out;
}

/** App clip (lm [n][33][3]) -> gist form (lm replaced by lmJoints/lmB64/n). Does not mutate the input. */
export function toGistClip(clip) {
  const { lm, ...rest } = clip;
  if (!lm) return { ...rest };
  return { ...rest, lmJoints: LM_JOINTS, lmB64: encodeLm(lm), n: lm.length };
}

/** Gist form -> app clip with lm decoded. Does not mutate the input. */
export function fromGistClip(g) {
  if (g.lm) return { ...g };
  const { lmJoints, lmB64, ...rest } = g;
  return { ...rest, lm: decodeLm(g) };
}
