// Tiny IndexedDB blob store, SHARED between the offscreen document (which saves the just-recorded
// clip) and the editor (which loads it). Deliberately dependency-free and import-free so it can be
// pulled into either context without dragging anything else along. One object store, keyPath 'id'.
export const DB = { name: "screensnap", store: "clips", version: 1 };

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB.name, DB.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB.store)) db.createObjectStore(DB.store, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(DB.store, mode).objectStore(DB.store);
}

export async function putBlob(id, blob, meta) {
  const db = await open();
  try {
    // Resolve on the TRANSACTION commit, not the request's onsuccess — onsuccess fires before the
    // write is durably committed, so resolving on it let the offscreen document (and its data) be
    // torn down before the flush, silently losing the clip.
    await new Promise((resolve, reject) => {
      const t = db.transaction(DB.store, "readwrite");
      t.objectStore(DB.store).put({ id, blob, meta: meta || {}, savedAt: Date.now() });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("put aborted"));
    });
    // Best-effort housekeeping AFTER the new clip is durably in: a failure here must never fail the save.
    try { await pruneOld(db, id); } catch { /* keep everything */ }
  } finally {
    db.close();
  }
  return id;
}

// Every finished recording is stashed here for the editor handoff and nothing else ever removes it, so
// a heavy user accumulated GBs (hundreds of MB per clip) indefinitely. Drop clips older than a week,
// but always keep the KEEP_RECENT newest (an editor tab may still be open on one) and never the one
// just written. A Blob an open editor already holds stays readable after its record is deleted.
const KEEP_RECENT = 3;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneOld(db, keepId) {
  const recs = await new Promise((resolve, reject) => {
    const out = [];
    const req = tx(db, "readonly").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      out.push({ id: c.value.id, savedAt: c.value.savedAt || 0 });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  recs.sort((a, b) => b.savedAt - a.savedAt);
  const now = Date.now();
  const doomed = recs.slice(KEEP_RECENT).filter((r) => r.id !== keepId && now - r.savedAt > MAX_AGE_MS);
  if (!doomed.length) return;
  await new Promise((resolve, reject) => {
    const t = db.transaction(DB.store, "readwrite");
    const s = t.objectStore(DB.store);
    for (const r of doomed) s.delete(r.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("prune aborted"));
  });
}

export async function getBlob(id) {
  const db = await open();
  try {
    const rec = await new Promise((resolve, reject) => {
      const req = tx(db, "readonly").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!rec) return null;
    return { blob: rec.blob, meta: rec.meta || {} };
  } finally {
    db.close();
  }
}

export async function delBlob(id) {
  const db = await open();
  try {
    await new Promise((resolve, reject) => {
      const t = db.transaction(DB.store, "readwrite");
      t.objectStore(DB.store).delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("delete aborted"));
    });
  } finally {
    db.close();
  }
}

export async function listIds() {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const req = tx(db, "readonly").getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
