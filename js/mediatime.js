/** When was this video recorded? Reads MP4/QuickTime metadata without loading the whole file.
 *  Prefers Apple's `com.apple.quicktime.creationdate` (local time with offset), then the movie
 *  header (mvhd) creation time, then File.lastModified. Returns an ISO string or null. */

const MAC_EPOCH = Date.UTC(1904, 0, 1) / 1000;          // QuickTime times count seconds from 1904
const td = new TextDecoder();

async function bytes(file, start, len) {
  return new DataView(await file.slice(start, start + len).arrayBuffer());
}

/** Top-level box scan: returns {start, size} of the first box of `type`, reading only headers. */
async function findTop(file, type) {
  let off = 0;
  for (let i = 0; i < 64 && off + 8 <= file.size; i++) {
    const v = await bytes(file, off, 16);
    let size = v.getUint32(0);
    const t = td.decode(new Uint8Array(v.buffer, 4, 4));
    if (size === 1) size = Number(v.getBigUint64(8));
    else if (size === 0) size = file.size - off;
    if (size < 8) return null;
    if (t === type) return { start: off, size };
    off += size;
  }
  return null;
}

/** Child boxes of a box payload (DataView over the parent's contents). */
function* children(v, from, to) {
  let off = from;
  while (off + 8 <= to) {
    const size = v.getUint32(off);
    const type = td.decode(new Uint8Array(v.buffer, v.byteOffset + off + 4, 4));
    if (size < 8 || off + size > to) return;
    yield { type, start: off, end: off + size };
    off += size;
  }
}

function mvhdTime(v, box) {
  const ver = v.getUint8(box.start + 8);
  const secs = ver === 1 ? Number(v.getBigUint64(box.start + 12)) : v.getUint32(box.start + 12);
  return secs > 0 ? new Date((secs + MAC_EPOCH) * 1000).toISOString() : null;
}

/** moov/meta with `keys` + `ilst` (Apple metadata): value for key `com.apple.quicktime.creationdate`. */
function appleCreationDate(v, meta) {
  let keys = null, ilst = null;
  for (const c of children(v, meta.start + 8, meta.end)) {
    if (c.type === "keys") keys = c;
    if (c.type === "ilst") ilst = c;
  }
  if (!keys || !ilst) return null;
  const names = [];
  for (const k of children(v, keys.start + 16, keys.end))           // keys: fullbox header + entry count
    names.push(td.decode(new Uint8Array(v.buffer, v.byteOffset + k.start + 8, k.end - k.start - 8)));
  const idx = names.indexOf("com.apple.quicktime.creationdate") + 1;  // ilst items are keyed 1-based
  if (!idx) return null;
  for (const item of children(v, ilst.start + 8, ilst.end)) {
    if (v.getUint32(item.start + 4) !== idx) continue;
    for (const d of children(v, item.start + 8, item.end))
      if (d.type === "data") return td.decode(new Uint8Array(v.buffer, v.byteOffset + d.start + 16, d.end - d.start - 16));
  }
  return null;
}

/** "2026-10-04T16:28:13-0700" -> ISO 8601 with a colon in the offset. */
const isoOffset = s => s.trim().replace(/([+-]\d\d)(\d\d)$/, "$1:$2");

export async function recordedTime(file) {
  try {
    const moov = await findTop(file, "moov");
    if (moov && moov.size < 64e6) {
      const v = await bytes(file, moov.start, moov.size);
      let mvhd = null;
      for (const c of children(v, 8, moov.size)) {
        if (c.type === "meta") {
          const s = appleCreationDate(v, c);
          if (s && !isNaN(Date.parse(isoOffset(s)))) return isoOffset(s);
        }
        if (c.type === "mvhd") mvhd = c;
      }
      const t = mvhd && mvhdTime(v, mvhd);
      if (t && Date.parse(t) > Date.UTC(2005, 0, 1)) return t;  // 0 / 1904 means "not set"
    }
  } catch (err) {
    console.warn("recordedTime: could not read metadata", err);
  }
  return file.lastModified ? new Date(file.lastModified).toISOString() : null;
}
