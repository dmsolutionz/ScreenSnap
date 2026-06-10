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

export function newImageLayer({ bitmap, x, y, w, h }) {
  return { id: uid(), kind: "image", visible: true, opacity: 1, range: null, image: { bitmap, x, y, w, h } };
}

export function newShapeLayer(shape) {
  return { id: uid(), kind: "shape", visible: true, opacity: 1, range: null, shape };
}
