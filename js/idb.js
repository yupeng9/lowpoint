// Lowpoint on-device storage (IndexedDB).
//   clips:  {id, clip (gist form: compact lm), entry (index entry), synced: bool}
//   videos: {id, blob, offset}           offset = seconds added to (i + 0.5) / fps when seeking
//   stills: {id, stills: {address, top, impact, finish: dataURL}}
//   cache:  {name, raw_url, data}        gist file cache (offline viewing of synced clips)

const DB = "lowpoint", VER = 1, STORES = { clips: "id", videos: "id", stills: "id", cache: "name" };
let dbP = null;

function open() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      for (const [s, key] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: key });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbP = null; rej(r.error); };
  });
  return dbP;
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(t.objectStore(store));
  if (mode === "readwrite") await done; else done.catch(() => {});
  return out;
}

export const get = (store, key) => tx(store, "readonly", s => wrap(s.get(key)));
export const put = (store, val) => tx(store, "readwrite", s => wrap(s.put(val)));
export const del = (store, key) => tx(store, "readwrite", s => wrap(s.delete(key)));
export const all = store => tx(store, "readonly", s => wrap(s.getAll()));
export const keys = store => tx(store, "readonly", s => wrap(s.getAllKeys()));

export async function deleteClip(id) {
  await Promise.all(["clips", "videos", "stills"].map(s => del(s, id)));
}

/** Cached gist file (keyed by name, valid while raw_url — which contains the revision — matches). */
export async function cached(name, rawUrl) {
  const r = await get("cache", name).catch(() => null);
  return r && (!rawUrl || r.raw_url === rawUrl) ? r.data : null;
}
export const putCache = (name, rawUrl, data) => put("cache", { name, raw_url: rawUrl, data }).catch(() => {});

export async function usage() {
  let videos = 0, n = 0;
  for (const v of await all("videos")) { videos += v.blob ? v.blob.size : 0; n++; }
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  return { videos, nVideos: n, usage: est ? est.usage : null, quota: est ? est.quota : null };
}
