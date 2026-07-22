// Layer store: an ordered list of annotation/image layers with a tiny pub/sub. Drawing order is
// array order (index 0 = bottom). range:null means "show for the whole clip"; the feature phase can
// set {inSec,outSec}. Kept deliberately small and framework-free.

export const LAYER = Object.freeze({ SHAPE: "shape", IMAGE: "image" });

const uid = () => crypto.randomUUID().slice(0, 8);

export function createLayerStore() {
  const layers = [];
  const subs = new Set();
  const notify = () => subs.forEach((fn) => { try { fn(layers); } catch {} });

  return {
    layers,
    add(l) {
      layers.push(l);
      notify();
      return l;
    },
    remove(id) {
      const i = layers.findIndex((l) => l.id === id);
      if (i === -1) return false;
      layers.splice(i, 1);
      notify();
      return true;
    },
    update(id, patch) {
      const l = layers.find((x) => x.id === id);
      if (!l) return null;
      Object.assign(l, patch);
      notify();
      return l;
    },
    replace(next) {
      // Swap the whole list in place (undo/redo restore). In-place because `layers` is shared by
      // reference with every consumer (timeline, annotator, compositor).
      layers.splice(0, layers.length, ...next);
      notify();
      return layers;
    },
    move(id, toIdx) {
      const i = layers.findIndex((l) => l.id === id);
      if (i === -1) return false;
      const [l] = layers.splice(i, 1);
      const clamped = Math.max(0, Math.min(layers.length, toIdx));
      layers.splice(clamped, 0, l);
      notify();
      return true;
    },
    get(id) {
      return layers.find((l) => l.id === id) || null;
    },
    visibleOrdered() {
      return layers.filter((l) => l.visible !== false);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

// Snapshot-based undo/redo over a layer store (⌘Z / ctrl+Z in the video editor). A continuous update
// stream — drag-to-move, handle-resize, the opacity slider — coalesces into ONE step: the first change
// of a gesture pushes the pre-change snapshot, and the gesture closes on pointer-up (or after a quiet
// spell, for changes that aren't pointer-driven). Bitmaps/GIF frames are shared by reference across
// snapshots — only the positional/style data is copied, so history is cheap even with big images.
export function createLayerHistory(store, { limit = 50 } = {}) {
  const clone = (ls) => ls.map((l) => ({
    ...l,
    shape: l.shape ? JSON.parse(JSON.stringify(l.shape)) : l.shape,
    image: l.image ? { ...l.image } : l.image,
    range: l.range ? { ...l.range } : l.range,
  }));
  const undoStack = [];
  let redoStack = [];
  let live = clone(store.layers); // the state BEFORE the in-flight gesture — what undo restores
  let restoring = false;
  let gestureOpen = false;
  let pointerDown = false;
  let quietTimer = null;

  const closeGesture = () => {
    clearTimeout(quietTimer);
    quietTimer = null;
    gestureOpen = false;
    live = clone(store.layers);
  };
  const onPointerDown = () => { pointerDown = true; };
  const onPointerUp = () => {
    pointerDown = false;
    // setTimeout(0): the release itself can commit a store change (a shape is added on pointer-up) —
    // let it join this gesture before the gesture closes.
    if (gestureOpen) { clearTimeout(quietTimer); quietTimer = setTimeout(closeGesture, 0); }
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  const unsub = store.subscribe(() => {
    if (restoring) return;
    if (!gestureOpen) {
      undoStack.push(live);
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
      gestureOpen = true;
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(closeGesture, pointerDown ? 4000 : 400); // long backstop while dragging
  });

  const restore = (snapshot) => {
    restoring = true;
    try { store.replace(clone(snapshot)); } finally { restoring = false; }
    live = snapshot;
  };
  return {
    undo() {
      if (gestureOpen) closeGesture(); // sync `live` to the current state first
      if (!undoStack.length) return false;
      redoStack.push(live);
      restore(undoStack.pop());
      return true;
    },
    redo() {
      if (gestureOpen) closeGesture();
      if (!redoStack.length) return false;
      undoStack.push(live);
      restore(redoStack.pop());
      return true;
    },
    destroy() {
      if (unsub) unsub();
      clearTimeout(quietTimer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
    },
  };
}

// A static image layer; or, when `frames`/`totalMs` are supplied, an animated GIF layer. For GIFs,
// `bitmap` is the poster (first frame) used when no time is available, and `frames`
// (= [{ bitmap, delayMs }]) + `totalMs` (loop period) drive the compositor's per-frame selection.
export function newImageLayer({ bitmap, x, y, w, h, frames = null, totalMs = 0 }) {
  return { id: uid(), kind: "image", visible: true, opacity: 1, range: null, image: { bitmap, x, y, w, h, frames, totalMs } };
}

export function newShapeLayer(shape) {
  return { id: uid(), kind: "shape", visible: true, opacity: 1, range: null, shape };
}
