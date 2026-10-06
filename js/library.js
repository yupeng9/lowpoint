// Lowpoint library + gist sync logic (no DOM, no IndexedDB: unit-tested in Node by tools/mobile_test.mjs).
// Gist layout matches tools/export_gist.py: index.json, clip-<id>.json, stills-<id>.json, img-<name>.json,
// video-<id>.json. The gist is SECRET (public:false) and found by its description.

export const GIST_DESC = "lowpoint-library";
export const CONFIG_KEY = "lowpoint-sync";
const API = "https://api.github.com";
const BATCH_BYTES = 8 * 1024 * 1024;
export const PHASES = ["address", "top", "impact", "finish"];

/* ------------------------------------------------------------------ config (localStorage, per device) */
export function loadConfig(storage) {
  try {
    const c = JSON.parse(storage.getItem(CONFIG_KEY) || "null");
    if (c && typeof c.token === "string" && c.token) return c;
  } catch { /* fallthrough */ }
  return null;
}
export const saveConfig = (storage, c) => storage.setItem(CONFIG_KEY, JSON.stringify(c));
export const clearConfig = storage => storage.removeItem(CONFIG_KEY);

/* ------------------------------------------------------------------ library index */
export const gistFiles = id => ({ clip: `clip-${id}.json`, stills: `stills-${id}.json`, video: `video-${id}.json` });

/** Index entry for a clip (same fields as export_gist.py's index.json). */
export function indexEntry(clip, files) {
  return {
    id: clip.id, name: clip.name, kind: clip.kind || "mine", view: clip.view, club: clip.club,
    faults: (clip.faults || []).map(f => (typeof f === "string" ? f : f.title)),
    created: clip.created || new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    files: files || { clip: gistFiles(clip.id).clip, stills: gistFiles(clip.id).stills, images: [] },
  };
}

/**
 * Merge library sources, deduped by id. Each source: {src: "local"|"idb"|"gist", items: [...]}.
 * The first source that has an id provides its fields; every entry records all sources in `srcs`.
 * Order: device clips (idb) newest first, then local build order, then gist-only clips newest first;
 * kind "ref" entries keep the same relative order.
 */
export function mergeIndex(sources) {
  const byId = new Map();
  const rank = { idb: 0, local: 1, gist: 2 };
  const ordered = [...sources].sort((a, b) => rank[a.src] - rank[b.src]);
  for (const { src, items } of ordered) {
    const list = src === "local" ? items || [] : [...(items || [])].sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    for (const it of list) {
      if (!it || !it.id) continue;
      const cur = byId.get(it.id);
      if (cur) { if (!cur.srcs.includes(src)) cur.srcs.push(src); continue; }
      byId.set(it.id, { ...it, faults: it.faults || [], srcs: [src] });
    }
  }
  return [...byId.values()];
}

/** Replace or add `entry` in a gist index list (returns a new list), or drop `removeId`. */
export function updateIndex(list, { entry, removeId } = {}) {
  const out = (Array.isArray(list) ? list : []).filter(e => e && e.id !== (entry ? entry.id : removeId));
  if (entry) out.unshift(entry);
  return out;
}

/** Phase whose frame is closest to t (for the no-video still). */
export function nearestPhase(phases, t, have = PHASES) {
  let best = null, bd = Infinity;
  for (const k of have) {
    if (!Number.isFinite(phases[k])) continue;
    const d = Math.abs(phases[k] - t);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** Video timing: clip frame i is shown at video time (i + 0.5) / fps + offset seconds. */
export function videoOffset(clip, from) {
  if (from === "gist-video") return -(clip.videoStartFrame || 0) / clip.fps;
  return clip.videoStart || 0; // original file (IndexedDB / attached / local media): trim start in seconds
}
export const frameTime = (i, fps, offset) => (i + 0.5) / fps + offset;

/** "Oct 6, 14:05" style default name. */
export function defaultName(d = new Date()) {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${m} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export const newClipId = (d = new Date()) => `m${d.getTime().toString(36)}`;

/** Split {name: content|null} into PATCH batches of at most BATCH_BYTES (deletions are tiny). */
export function batchFiles(files, limit = BATCH_BYTES) {
  const batches = [];
  let cur = {}, size = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = text == null ? 0 : text.length;
    if (Object.keys(cur).length && size + n > limit) { batches.push(cur); cur = {}; size = 0; }
    cur[name] = text == null ? null : { content: text };
    size += n;
  }
  if (Object.keys(cur).length) batches.push(cur);
  return batches;
}

/* ------------------------------------------------------------------ GitHub gist client */
export class SyncError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const MESSAGES = {
  401: "GitHub rejected the token (wrong or expired). Clear it and paste a new one.",
  403: "This token can't access gists. Create a classic token with the gist scope.",
  404: "The library gist was not found. Sync now will look for it again.",
};

export class GistClient {
  constructor(token, fetchFn = (...a) => globalThis.fetch(...a)) {
    this.token = String(token || "").trim();
    this.fetch = fetchFn;
    this.meta = null; // last GET /gists/:id  ({files: {name: {raw_url, size, truncated, content}}})
  }
  async request(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await this.fetch(API + path, {
        method, cache: "no-store",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
                   ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new SyncError("You're offline.", 0); }
    if (!res.ok) throw new SyncError(MESSAGES[res.status] || `GitHub returned ${res.status}.`, res.status);
    return res.json();
  }
  user() { return this.request("/user"); }
  async findGist() {
    for (let page = 1; page <= 10; page++) {
      const gists = await this.request(`/gists?per_page=100&page=${page}`);
      const hit = gists.find(g => g.description === GIST_DESC && g.public === false);
      if (hit) return hit.id;
      if (gists.length < 100) break;
    }
    return null;
  }
  async createGist() {
    const g = await this.request("/gists", { method: "POST",
      body: { description: GIST_DESC, public: false, files: { "index.json": { content: "[]" } } } });
    return g.id;
  }
  async load(gistId) {
    const g = await this.request(`/gists/${gistId}`);
    if (g.public !== false) throw new SyncError("Refusing: the lowpoint-library gist is public.", -1);
    this.meta = g;
    return g;
  }
  has(name) { return !!(this.meta && this.meta.files && this.meta.files[name]); }
  rawUrl(name) { return this.has(name) ? this.meta.files[name].raw_url : null; }
  /** Parsed JSON of a gist file; truncated (>1 MB) files come from raw_url (no auth header: CORS simple GET). */
  async readJSON(name) {
    const f = this.meta && this.meta.files && this.meta.files[name];
    if (!f) return null;
    let text = f.content;
    if (f.truncated || text == null) {
      let r;
      try { r = await this.fetch(f.raw_url, { cache: "force-cache" }); } catch { throw new SyncError("You're offline.", 0); }
      if (!r.ok) throw new SyncError(`raw ${name}: ${r.status}`, r.status);
      text = await r.text();
    }
    try { return JSON.parse(text); } catch { throw new SyncError(`${name} in the gist is not valid JSON.`, -1); }
  }
  /** files: {name: text | null(delete)}. Sent in batches; refreshes meta from the last response. */
  async patch(gistId, files) {
    let g = null;
    for (const batch of batchFiles(files)) g = await this.request(`/gists/${gistId}`, { method: "PATCH", body: { files: batch } });
    if (g) this.meta = g;
    return g;
  }
}

/** Check the token, find the library gist or create it. Returns {login, gistId, status: "found"|"created"}. */
export async function connect(client) {
  let login;
  try { ({ login } = await client.user()); } catch (e) {
    if (e.status === 401) throw new SyncError("GitHub rejected this token. Check it and try again.", 401);
    throw e;
  }
  let gistId = await client.findGist(), status = "found";
  if (!gistId) { gistId = await client.createGist(); status = "created"; }
  return { login, gistId, status };
}

/** Files to upload for a device clip (no video). gistClip is the compact form (toGistClip). */
export function uploadFiles(gistClip, stills, remoteIndex) {
  const f = gistFiles(gistClip.id);
  const entry = indexEntry(gistClip, { clip: f.clip, stills: f.stills, images: [] });
  return {
    [f.clip]: JSON.stringify(gistClip),
    ...(stills ? { [f.stills]: JSON.stringify(stills) } : {}),
    "index.json": JSON.stringify(updateIndex(remoteIndex, { entry }), null, 1),
  };
}

/** Files to delete for a clip (only those present in the gist) + the updated index. */
export function deleteFiles(id, remoteIndex, has) {
  const f = gistFiles(id), out = {};
  for (const n of [f.clip, f.stills, f.video]) if (has(n)) out[n] = null;
  out["index.json"] = JSON.stringify(updateIndex(remoteIndex, { removeId: id }), null, 1);
  return out;
}
