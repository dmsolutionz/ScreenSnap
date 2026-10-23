// Unit tests for the annotation editor's pure geometry (src/content/editor/geometry.js) — zero deps, runs
// under `node --test`. That file is a plain content script (executeScript can't load modules), so it is
// run in a node:vm sandbox with no DOM at all and read back from the namespace it registers — which also
// proves it stays DOM-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../src/content/editor/geometry.js", import.meta.url), "utf8"), sandbox);
const G = sandbox.__screensnapEditorNS;
// Objects built inside the sandbox have the sandbox's prototypes; compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const box = { x: 100, y: 100, w: 200, h: 100 };

test("boxHit: corners, edges, inside, outside", () => {
  assert.deepEqual(plain(G.boxHit(box, { x: 100, y: 100 }, 8)), { hx: -1, hy: -1 });
  assert.deepEqual(plain(G.boxHit(box, { x: 305, y: 205 }, 8)), { hx: 1, hy: 1 });   // just outside the corner
  assert.deepEqual(plain(G.boxHit(box, { x: 200, y: 96 }, 8)), { hx: 0, hy: -1 });   // anywhere along the top edge
  assert.deepEqual(plain(G.boxHit(box, { x: 304, y: 150 }, 8)), { hx: 1, hy: 0 });
  assert.equal(G.boxHit(box, { x: 200, y: 150 }, 8), "inside");
  assert.equal(G.boxHit(box, { x: 400, y: 150 }, 8), null);
});

test("boxHit: a small box keeps a movable middle (inner reach is a quarter of the side)", () => {
  const small = { x: 0, y: 0, w: 20, h: 20 };
  assert.equal(G.boxHit(small, { x: 10, y: 10 }, 8), "inside");
  assert.deepEqual(plain(G.boxHit(small, { x: 3, y: 10 }, 8)), { hx: -1, hy: 0 });
});

test("boxHit: edges=false (text) only grabs corners", () => {
  assert.equal(G.boxHit(box, { x: 200, y: 101 }, 8, false), "inside");
  assert.deepEqual(plain(G.boxHit(box, { x: 299, y: 199 }, 8, false)), { hx: 1, hy: 1 });
});

test("resizeBox: an edge moves only its side; the opposite side stays put", () => {
  assert.deepEqual(plain(G.resizeBox(box, 1, 0, { x: 50, y: 30 })), { x: 100, y: 100, w: 250, h: 100 });
  assert.deepEqual(plain(G.resizeBox(box, -1, 0, { x: 50, y: 0 })), { x: 150, y: 100, w: 150, h: 100 });
});

test("resizeBox: a ratio-locked corner follows the side stretched more", () => {
  const r = G.resizeBox(box, 1, 1, { x: 0, y: 50 }, { ratio: 2 });
  assert.deepEqual(plain(r), { x: 100, y: 100, w: 300, h: 150 });
});

test("resizeBox: a ratio-locked edge drags the other side along about its centre line", () => {
  const r = G.resizeBox(box, 1, 0, { x: 100, y: 0 }, { ratio: 2 });
  assert.deepEqual(plain(r), { x: 100, y: 75, w: 300, h: 150 });
});

test("resizeBox: alt resizes about the centre", () => {
  assert.deepEqual(plain(G.resizeBox(box, 1, 0, { x: 20, y: 0 }, { alt: true })), { x: 80, y: 100, w: 240, h: 100 });
});

test("resizeBox: bounds shrink the box (ratio intact) instead of letting it run off", () => {
  const r = G.resizeBox({ x: 0, y: 0, w: 160, h: 90 }, 1, 1, { x: 1000, y: 0 }, { ratio: 16 / 9, bounds: { w: 320, h: 400 } });
  near(r.w, 320); near(r.h, 180); near(r.x, 0); near(r.y, 0);
});

test("resizeBox: sides never go below min and never flip", () => {
  const r = G.resizeBox(box, 1, 0, { x: -500, y: 0 }, { min: 8 });
  assert.deepEqual(plain(r), { x: 100, y: 100, w: 8, h: 100 });
});

test("resizeShape: boxes take the new bounds, strokes scale their points, text scales its size", () => {
  const rect = { type: "rect", x: 0, y: 0, w: 10, h: 10, color: "#f00" };
  assert.deepEqual(plain(G.resizeShape(rect, { x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 20, h: 30 })), { type: "rect", x: 5, y: 5, w: 20, h: 30, color: "#f00" });
  const pen = { type: "pencil", points: [{ x: 0, y: 0 }, { x: 10, y: 20 }] };
  assert.deepEqual(plain(G.resizeShape(pen, { x: 0, y: 0, w: 10, h: 20 }, { x: 10, y: 10, w: 20, h: 40 }).points), [{ x: 10, y: 10 }, { x: 30, y: 50 }]);
  const text = { type: "text", x: 0, y: 0, size: 20, text: "hi" };
  const t2 = G.resizeShape(text, { x: 0, y: 0, w: 24, h: 20 }, { x: 4, y: 6, w: 48, h: 40 });
  assert.equal(t2.size, 40); assert.equal(t2.x, 4); assert.equal(t2.y, 6);
});

test("intRect: whole pixels, at least 1 px, kept inside the image", () => {
  assert.deepEqual(plain(G.intRect({ x: -3.4, y: 10.6, w: 50.5, h: 0.2 }, 100, 100)), { x: 0, y: 11, w: 51, h: 1 });
  assert.deepEqual(plain(G.intRect({ x: 90, y: 90, w: 50, h: 50 }, 100, 100)), { x: 50, y: 50, w: 50, h: 50 });
});

test("dragRect: free drags normalize in any direction and clamp to the image", () => {
  assert.deepEqual(plain(G.dragRect({ x1: 80, y1: 60, x2: 20, y2: 10 }, null, 100, 100)), { x: 20, y: 10, w: 60, h: 50 });
  assert.deepEqual(plain(G.dragRect({ x1: 50, y1: 50, x2: 500, y2: 90 }, null, 100, 100)), { x: 50, y: 50, w: 50, h: 40 });
  // dragged up past the top edge: the frame stops AT the edge, still anchored at the press
  assert.deepEqual(plain(G.dragRect({ x1: 50, y1: 50, x2: 500, y2: -40 }, null, 100, 100)), { x: 50, y: 0, w: 50, h: 50 });
});

test("dragRect: a ratio grows from the anchor and stays inside the image", () => {
  assert.deepEqual(plain(G.dragRect({ x1: 0, y1: 0, x2: 160, y2: 5 }, 16 / 9, 1000, 1000)), { x: 0, y: 0, w: 160, h: 90 });
  assert.deepEqual(plain(G.dragRect({ x1: 100, y1: 100, x2: 0, y2: 0 }, 1, 1000, 1000)), { x: 0, y: 0, w: 100, h: 100 });
  const capped = G.dragRect({ x1: 900, y1: 0, x2: 2000, y2: 50 }, 2, 1000, 1000);
  assert.deepEqual(plain(capped), { x: 900, y: 0, w: 100, h: 50 });
});

test("ratioFit: the largest rect of the ratio centred inside the frame — never adds area", () => {
  assert.deepEqual(plain(G.ratioFit({ x: 0, y: 0, w: 400, h: 100 }, 1, 1000, 1000)), { x: 150, y: 0, w: 100, h: 100 });
  const f = G.ratioFit({ x: 0, y: 0, w: 1600, h: 1000 }, 16 / 9, 1600, 1000);
  assert.deepEqual(plain(f), { x: 0, y: 50, w: 1600, h: 900 });
});

test("snapDelta: snaps the closest edge/centre within the threshold, per allowed axis", () => {
  const b = { x: 47, y: 10, w: 10, h: 10 };
  const r = G.snapDelta(b, [50, 200], [0], 5);
  near(r.x, -2); near(r.y, 0); // x: the centre (52) is closest to 50; y: top 10 is 10 from 0 (> thr) → no snap
  assert.deepEqual(plain(r.guides), [{ x: 50 }]);
  assert.equal(G.snapDelta(b, [50], [], 5, false).x, 0);
  assert.equal(G.snapDelta(b, [100], [], 5).guides.length, 0);
});

test("hit / bbox: arrows hit along the segment; text uses the width hook", () => {
  const arrow = { type: "arrow", x1: 0, y1: 0, x2: 100, y2: 0, width: 4 };
  assert.equal(G.hit(arrow, { x: 50, y: 5 }, 2), true);
  assert.equal(G.hit(arrow, { x: 50, y: 20 }, 2), false);
  const text = { type: "text", x: 10, y: 10, size: 20, text: "abcd" };
  assert.deepEqual(plain(G.bbox(text)), { x: 10, y: 10, w: 20 * 4 * 0.6, h: 20 * G.LH });
});

// A fixed-width "font" for the text-layout tests: every character is 10 px wide.
const withMeasure = (fn) => { const m = G.geo.measure; G.geo.measure = (size, str) => String(str).length * 10; try { fn(); } finally { G.geo.measure = m; } };

test("textLayout: point text breaks only at hard returns; offsets index s.text", () => withMeasure(() => {
  assert.deepEqual(plain(G.textLayout({ text: "one two\nthree", size: 10 })), [{ text: "one two", start: 0 }, { text: "three", start: 8 }]);
}));

test("textLayout: a box wraps words greedily, spaces hang at the line end", () => withMeasure(() => {
  assert.deepEqual(plain(G.textLayout({ text: "hello world foo", size: 10, w: 60 })), [
    { text: "hello ", start: 0 }, { text: "world ", start: 6 }, { text: "foo", start: 12 },
  ]);
}));

test("textLayout: a word wider than the box breaks between characters", () => withMeasure(() => {
  assert.deepEqual(plain(G.textLines({ text: "abcdefghijklmn", size: 10, w: 50 })), ["abcde", "fghij", "klmn"]);
}));

test("text bounds: a box is its wrap width wide, point text its longest line; height is lines × LH", () => withMeasure(() => {
  assert.deepEqual(plain(G.bbox({ type: "text", x: 0, y: 0, size: 10, text: "ab\nabcd" })), { x: 0, y: 0, w: 40, h: 2 * 10 * G.LH });
  assert.deepEqual(plain(G.bbox({ type: "text", x: 0, y: 0, size: 10, text: "hello world foo", w: 60 })), { x: 0, y: 0, w: 60, h: 3 * 10 * G.LH });
}));

test("textOffsetAt: the caret offset nearest a click, line by line", () => withMeasure(() => {
  const s = { text: "hello\nworld", size: 10, x: 0, y: 0 };
  assert.equal(G.textOffsetAt(s, { x: 31, y: 2 }), 3);   // "hel|lo"
  assert.equal(G.textOffsetAt(s, { x: 31, y: 14 }), 9);  // second line, "wor|ld"
  assert.equal(G.textOffsetAt(s, { x: 999, y: 99 }), 11); // past the end → end of the last line
}));

test("inkHit: a rectangle is only its outline (its inside is free to draw in); others hit as usual", () => {
  const rect = { type: "rect", x: 0, y: 0, w: 100, h: 100, width: 4 };
  assert.equal(G.inkHit(rect, { x: 1, y: 50 }, 3), true);
  assert.equal(G.inkHit(rect, { x: 50, y: 50 }, 3), false);
  assert.equal(G.hit(rect, { x: 50, y: 50 }, 3), true);
  assert.equal(G.inkHit({ type: "blur", x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }, 0), true);
});

test("resizeShape: scaling a text box scales its wrap width with the font", () => {
  const t = G.resizeShape({ type: "text", x: 0, y: 0, size: 10, w: 80, text: "x" }, { x: 0, y: 0, w: 80, h: 25 }, { x: 0, y: 0, w: 160, h: 50 });
  assert.equal(t.size, 20); assert.equal(t.w, 160);
});

test("translate: moves boxes, endpoints and points alike (and copies)", () => {
  const a = { type: "arrow", x1: 0, y1: 0, x2: 5, y2: 5 };
  const moved = G.translate(a, 3, -2);
  assert.deepEqual(plain(moved), { type: "arrow", x1: 3, y1: -2, x2: 8, y2: 3 });
  assert.equal(a.x1, 0);
  assert.deepEqual(plain(G.translate({ points: [{ x: 1, y: 1 }] }, 1, 1)), { points: [{ x: 2, y: 2 }] });
});

test("rotation: toLocal turns a point back into a turned item's frame; hit-tests follow the turn", () => {
  const r = { type: "rect", x: 0, y: 40, w: 100, h: 20, rot: Math.PI / 2 }; // a 100×20 bar turned upright about (50, 50)
  const q = G.toLocal(r, { x: 50, y: 10 });
  near(q.x, 10); near(q.y, 50);
  assert.equal(G.hit(r, { x: 50, y: 10 }, 0), true);   // inside the upright bar
  assert.equal(G.hit(r, { x: 10, y: 50 }, 0), false);  // where the unturned bar was
  assert.equal(G.rotOf({ type: "arrow", rot: 1 }), 0);   // only images, rects, text and steps turn
});

test("aabb: the drawn bounds of a turned item", () => {
  const b = G.aabb({ type: "rect", x: 0, y: 40, w: 100, h: 20, rot: Math.PI / 2 });
  near(b.x, 40); near(b.y, 0); near(b.w, 20); near(b.h, 100);
});

test("placeRotated: a resize in the item's own frame keeps the held side put on screen", () => {
  const a = Math.PI / 2, b0 = { x: 0, y: 40, w: 100, h: 20 };
  const local = G.resizeBox(b0, 1, 0, { x: 50, y: 0 });                // grow the right side by 50 (left side held)
  const placed = G.placeRotated(b0, local, a);
  const heldBefore = G.rotatePt({ x: 0, y: 50 }, { x: 50, y: 50 }, a);   // left-middle of the bar, on screen
  const c1 = { x: placed.x + placed.w / 2, y: placed.y + placed.h / 2 };
  const heldAfter = G.rotatePt({ x: placed.x, y: placed.y + placed.h / 2 }, c1, a);
  near(heldAfter.x, heldBefore.x); near(heldAfter.y, heldBefore.y); near(placed.w, 150);
});

test("snapAngle / normAngle: 15° steps, kept in (−π, π]", () => {
  near(G.snapAngle((22 * Math.PI) / 180, 15), (15 * Math.PI) / 180);
  near(G.snapAngle((23 * Math.PI) / 180, 15), (30 * Math.PI) / 180);
  near(G.normAngle(3 * Math.PI), Math.PI);
  near(G.normAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2);
});

test("stepNumbers: badges number 1… by stacking order, skipping hidden ones and other items", () => {
  const sh = [{ type: "step" }, { type: "rect" }, { type: "step", hidden: true }, { type: "step" }];
  assert.deepEqual(plain(G.stepNumbers(sh)), [1, null, null, 2]);
});
