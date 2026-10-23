// Pure geometry for the video editor's crop frame — NO DOM, so test/crop-geometry.test.js can import it
// straight under `node --test`. Everything is in SOURCE pixels. The frame is a persistent box you can move
// and resize (8 handles), the way a design app's crop tool works: boxHit says what a pointer is on,
// resizeBox turns a handle drag into a new box (ratio lock / resize about the centre / stay inside the
// frame), ratioFit refits a box to an aspect ratio, dragRect draws a fresh one.

export const MIN_CROP = 16; // smallest crop frame (source px)

export const RATIOS = [
  ["Free", null],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["4:5", 4 / 5],
];

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// Whole-pixel copy of r, at least `min` px and kept inside a W × H frame.
export function intRect(r, W, H, min = 1) {
  const w = clamp(Math.round(r.w), Math.min(min, W), W), h = clamp(Math.round(r.h), Math.min(min, H), H);
  return { x: clamp(Math.round(r.x), 0, W - w), y: clamp(Math.round(r.y), 0, H - h), w, h };
}

// What part of box b point p is on: { hx, hy } for an edge or corner (-1 left/top, 1 right/bottom, 0 not
// that axis), "inside", or null. Edges grab along their whole length within `tol` px; on the inner side the
// reach shrinks to a quarter of the side so a small box still has a middle to move it by.
export function boxHit(b, p, tol) {
  const axis = (lo, hi, v, near) => {
    if (!near) return 0;
    const t = Math.max(0, Math.min(tol, (hi - lo) / 4));
    const atLo = v >= lo - tol && v <= lo + t, atHi = v <= hi + tol && v >= hi - t;
    if (atLo && atHi) return Math.abs(v - lo) <= Math.abs(v - hi) ? -1 : 1;
    return atLo ? -1 : atHi ? 1 : 0;
  };
  const nearX = p.x >= b.x - tol && p.x <= b.x + b.w + tol, nearY = p.y >= b.y - tol && p.y <= b.y + b.h + tol;
  const hx = axis(b.x, b.x + b.w, p.x, nearY), hy = axis(b.y, b.y + b.h, p.y, nearX);
  if (hx || hy) return { hx, hy };
  return p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h ? "inside" : null;
}

// Box b with handle (hx, hy) dragged by d. `ratio` (w / h) locks the proportions — a corner follows whichever
// side was stretched more, an edge drags the other side along about its centre line; `alt` resizes about the
// centre; `bounds` ({ w, h }) keeps the result inside the frame by shrinking it (ratio intact) instead of
// letting a side run off. Sides never go below `min`; no flipping past the anchor.
export function resizeBox(b, hx, hy, d, { ratio = null, alt = false, bounds = null, min = MIN_CROP } = {}) {
  // Per axis: the fixed coordinate, which way the side grows (1 / -1, or 0 = centred) and the new length.
  const axis = (lo, len, h, dv) => {
    if (h === 0) return { fix: lo + len / 2, dir: 0, len };
    if (alt) return { fix: lo + len / 2, dir: 0, len: Math.max(min, len + 2 * h * dv) };
    return h > 0 ? { fix: lo, dir: 1, len: Math.max(min, len + dv) } : { fix: lo + len, dir: -1, len: Math.max(min, len - dv) };
  };
  const ax = axis(b.x, b.w, hx, d.x), ay = axis(b.y, b.h, hy, d.y);
  let w = ax.len, h = ay.len;
  if (ratio) {
    if (hx && hy) { const s = Math.max(w / ratio, h); w = s * ratio; h = s; }
    else if (hx) h = w / ratio;
    else w = h * ratio;
  }
  if (bounds) {
    // Room from the fixed point in the growth direction (centred: twice the nearer side).
    const room = (a, total) => (a.dir > 0 ? total - a.fix : a.dir < 0 ? a.fix : 2 * Math.min(a.fix, total - a.fix));
    const mw = room(ax, bounds.w), mh = room(ay, bounds.h);
    if (ratio) { const s = Math.min(1, mw / w, mh / h); w *= s; h *= s; }
    else { w = Math.min(w, mw); h = Math.min(h, mh); }
  }
  const place = (a, len) => (a.dir > 0 ? a.fix : a.dir < 0 ? a.fix - len : a.fix - len / 2);
  return { x: place(ax, w), y: place(ay, h), w, h };
}

// Normalize a drag (anchor x1,y1 → pointer x2,y2) into {x,y,w,h}, clamped to the W × H frame. With a ratio
// (w/h) the rect grows from the anchor corner toward the pointer: width from the drag, height derived (or
// vice-versa, whichever stays in bounds), so a ratio-locked rect never leaves the frame.
export function dragRect(d, ratio, W, H) {
  if (ratio) {
    const ax = d.x1, ay = d.y1;
    const dirX = d.x2 >= ax ? 1 : -1, dirY = d.y2 >= ay ? 1 : -1;
    let w = Math.abs(d.x2 - ax), h = w / ratio;
    const maxW = dirX > 0 ? W - ax : ax, maxH = dirY > 0 ? H - ay : ay;
    if (w > maxW) { w = maxW; h = w / ratio; }
    if (h > maxH) { h = maxH; w = h * ratio; }
    return { x: Math.round(dirX > 0 ? ax : ax - w), y: Math.round(dirY > 0 ? ay : ay - h), w: Math.round(w), h: Math.round(h) };
  }
  const x = clamp(Math.min(d.x1, d.x2), 0, W), x2 = clamp(Math.max(d.x1, d.x2), 0, W);
  const y = clamp(Math.min(d.y1, d.y2), 0, H), y2 = clamp(Math.max(d.y1, d.y2), 0, H);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
}

// Largest rect of ratio r (w/h) centred in frame f — never adds area.
export function ratioFit(f, r, W, H) {
  let w = f.w, h = w / r;
  if (h > f.h) { h = f.h; w = h * r; }
  return intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, W, H);
}

// Portrait ⇄ landscape about the frame's centre; a frame that wouldn't fit turned is scaled down to fit.
export function swapRect(f, W, H) {
  let w = f.h, h = f.w;
  const k = Math.min(1, W / w, H / h);
  w *= k; h *= k;
  return intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, W, H);
}

// An exact size typed into the W / H fields: kept centred on the frame, clamped to the W × H source, and
// with a ratio in force the other side follows the one typed (`changed` = "w" | "h"). null when invalid.
export function sizeRect(f, w, h, changed, ratio, W, H) {
  if (!(w > 0) || !(h > 0)) return null;
  w = Math.min(Math.round(w), W); h = Math.min(Math.round(h), H);
  if (ratio) {
    if (changed === "w") h = Math.round(w / ratio); else w = Math.round(h * ratio);
    if (h > H) { h = H; w = Math.round(h * ratio); }
    if (w > W) { w = W; h = Math.round(w / ratio); }
  }
  return intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, W, H);
}
