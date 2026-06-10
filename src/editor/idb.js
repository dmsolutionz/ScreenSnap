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
  } finally {
    db.close();
  }
  return id;
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
