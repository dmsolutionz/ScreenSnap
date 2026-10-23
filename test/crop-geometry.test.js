// Unit tests for the video editor's crop frame geometry (src/editor/crop-geometry.js) — pure functions,
// zero deps, runs under `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxHit, resizeBox, dragRect, ratioFit, swapRect, sizeRect, intRect, MIN_CROP } from "../src/editor/crop-geometry.js";

const box = { x: 100, y: 100, w: 200, h: 100 };

test("boxHit: corners, edges, inside, outside", () => {
  assert.deepEqual(boxHit(box, { x: 100, y: 100 }, 8), { hx: -1, hy: -1 });
  assert.deepEqual(boxHit(box, { x: 305, y: 205 }, 8), { hx: 1, hy: 1 });   // just outside the corner
  assert.deepEqual(boxHit(box, { x: 200, y: 96 }, 8), { hx: 0, hy: -1 });   // anywhere along the top edge
  assert.deepEqual(boxHit(box, { x: 304, y: 150 }, 8), { hx: 1, hy: 0 });
  assert.equal(boxHit(box, { x: 200, y: 150 }, 8), "inside");
  assert.equal(boxHit(box, { x: 400, y: 150 }, 8), null);
});

test("boxHit: a small box keeps a movable middle", () => {
  const small = { x: 0, y: 0, w: 20, h: 20 };
  assert.equal(boxHit(small, { x: 10, y: 10 }, 8), "inside");
  assert.deepEqual(boxHit(small, { x: 3, y: 10 }, 8), { hx: -1, hy: 0 });
});

test("resizeBox: an edge moves only its side; the opposite side stays put", () => {
  assert.deepEqual(resizeBox(box, 1, 0, { x: 50, y: 30 }), { x: 100, y: 100, w: 250, h: 100 });
  assert.deepEqual(resizeBox(box, -1, 0, { x: 50, y: 0 }), { x: 150, y: 100, w: 150, h: 100 });
});

test("resizeBox: a ratio-locked corner follows the side stretched more", () => {
  assert.deepEqual(resizeBox(box, 1, 1, { x: 0, y: 50 }, { ratio: 2 }), { x: 100, y: 100, w: 300, h: 150 });
});

test("resizeBox: a ratio-locked edge drags the other side along about its centre line", () => {
  assert.deepEqual(resizeBox(box, 1, 0, { x: 100, y: 0 }, { ratio: 2 }), { x: 100, y: 75, w: 300, h: 150 });
});

test("resizeBox: alt resizes about the centre", () => {
  assert.deepEqual(resizeBox(box, 1, 0, { x: 20, y: 0 }, { alt: true }), { x: 80, y: 100, w: 240, h: 100 });
});

test("resizeBox: bounds shrink the box (ratio intact) instead of running off", () => {
  const r = resizeBox({ x: 0, y: 0, w: 160, h: 90 }, 1, 1, { x: 1000, y: 0 }, { ratio: 16 / 9, bounds: { w: 320, h: 400 } });
  assert.equal(Math.round(r.w), 320);
  assert.equal(Math.round(r.h), 180);
});

test("resizeBox: never collapses below the minimum or flips past the anchor", () => {
  const r = resizeBox(box, 1, 1, { x: -500, y: -500 });
  assert.equal(r.w, MIN_CROP);
  assert.equal(r.h, MIN_CROP);
  assert.equal(r.x, 100);
  assert.equal(r.y, 100);
});

test("dragRect: free drag normalizes direction and clamps to the frame", () => {
  assert.deepEqual(dragRect({ x1: 300, y1: 200, x2: 100, y2: 50 }, null, 1000, 500), { x: 100, y: 50, w: 200, h: 150 });
  assert.deepEqual(dragRect({ x1: 900, y1: 100, x2: 1400, y2: 600 }, null, 1000, 500), { x: 900, y: 100, w: 100, h: 400 });
});

test("dragRect: a ratio drag stays inside the frame in the drag direction", () => {
  const r = dragRect({ x1: 500, y1: 250, x2: 1200, y2: 260 }, 2, 1000, 500);
  assert.equal(r.w / r.h, 2);
  assert.ok(r.x + r.w <= 1000 && r.y + r.h <= 500);
});

test("ratioFit: the largest centred rect of the ratio, never adding area", () => {
  assert.deepEqual(ratioFit({ x: 0, y: 0, w: 1920, h: 1080 }, 1, 1920, 1080), { x: 420, y: 0, w: 1080, h: 1080 });
  assert.deepEqual(ratioFit({ x: 0, y: 0, w: 1920, h: 1080 }, 9 / 16, 1920, 1080), { x: 656, y: 0, w: 608, h: 1080 });
  const wide = ratioFit({ x: 100, y: 100, w: 400, h: 400 }, 2, 1920, 1080);
  assert.equal(wide.w, 400);
  assert.equal(wide.h, 200);
});

test("swapRect: landscape ⇄ portrait about the centre, shrunk to fit", () => {
  assert.deepEqual(swapRect({ x: 460, y: 340, w: 1000, h: 400 }, 1920, 1080), { x: 760, y: 40, w: 400, h: 1000 });
  const s = swapRect({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080);
  assert.ok(s.w <= 1920 && s.h <= 1080);
  assert.ok(Math.abs(s.w / s.h - 1080 / 1920) < 0.01);
});

test("sizeRect: typed sizes stay centred; a ratio makes the other side follow", () => {
  const f = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(sizeRect(f, 1000, 500, "w", null, 1920, 1080), { x: 460, y: 290, w: 1000, h: 500 });
  assert.deepEqual(sizeRect(f, 1280, 999, "w", 16 / 9, 1920, 1080), { x: 320, y: 180, w: 1280, h: 720 });
  assert.equal(sizeRect(f, 0, 500, "w", null, 1920, 1080), null);
  assert.equal(sizeRect(f, 5000, 500, "w", null, 1920, 1080).w, 1920);
});

test("intRect: whole pixels, at least the minimum, inside the frame", () => {
  assert.deepEqual(intRect({ x: -5.4, y: 10.6, w: 3000, h: 0.2 }, 1000, 500, 16), { x: 0, y: 11, w: 1000, h: 16 });
});
