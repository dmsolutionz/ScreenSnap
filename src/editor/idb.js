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
    await new Promise((resolve, reject) => {
      const req = tx(db, "readwrite").put({ id, blob, meta: meta || {}, savedAt: Date.now() });
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
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
      const req = tx(db, "readwrite").delete(id);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
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
