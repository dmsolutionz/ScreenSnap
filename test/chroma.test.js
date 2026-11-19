// Green / blue screen keying: detection of a keyable backdrop in a sampled frame, and the per-pixel key
// math the WebGL shader mirrors (the CPU fallback runs exactly this code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScreen, keyPixels, keyAlpha, keyUVFor, chromaConfig, screenHue, rgbToHex, hexToRgb, DEFAULT_CHROMA } from "../src/editor/chroma.js";

// A w×h RGBA frame: `bg` everywhere, `fg` in a centred box covering `frac` of each side.
function frame(w, h, bg, fg, frac = 0.5) {
  const d = new Uint8ClampedArray(w * h * 4);
  const x0 = Math.round(w * (1 - frac) / 2), x1 = w - x0, y0 = Math.round(h * (1 - frac) / 2), y1 = h - y0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = x >= x0 && x < x1 && y >= y0 && y < y1 ? fg : bg;
    d.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  return d;
}
const GREEN = [40, 180, 70], BLUE = [30, 70, 200], SKIN = [224, 172, 140], GREY = [128, 128, 128];

test("screenHue: dominant bright green / blue only", () => {
  assert.equal(screenHue(...GREEN), "green");
  assert.equal(screenHue(...BLUE), "blue");
  assert.equal(screenHue(...SKIN), null);
  assert.equal(screenHue(...GREY), null);
  assert.equal(screenHue(10, 40, 12), null); // a dark green shadow isn't a screen
});

test("detectScreen: a green border around a subject is detected, keyed at the screen colour", () => {
  const det = detectScreen(frame(96, 54, GREEN, SKIN), 96, 54);
  assert.ok(det);
  assert.equal(det.kind, "green");
  assert.deepEqual(det.key, GREEN);
  assert.ok(det.coverage > 0.7 && det.border === 1);
});

test("detectScreen: blue screens too", () => {
  const det = detectScreen(frame(96, 54, BLUE, SKIN), 96, 54);
  assert.equal(det && det.kind, "blue");
});

test("detectScreen: an ordinary frame, or a small green object, is not a screen", () => {
  assert.equal(detectScreen(frame(96, 54, GREY, SKIN), 96, 54), null);
  assert.equal(detectScreen(frame(96, 54, GREY, GREEN, 0.5), 96, 54), null); // green in the middle, not the border
  assert.equal(detectScreen(new Uint8ClampedArray(4), 96, 54), null);
});

test("detectScreen: the key is robust to a subject touching the border", () => {
  // Subject spans the full height (touches top + bottom edges) — still a screen, still the screen's colour.
  const det = detectScreen(frame(96, 54, GREEN, SKIN, 1).map((v, i) => {
    const x = (i >> 2) % 96;
    return x < 30 || x >= 66 ? [...GREEN, 255][i % 4] : [...SKIN, 255][i % 4];
  }), 96, 54);
  assert.ok(det);
  assert.deepEqual(det.key, GREEN);
});

test("keyAlpha: the key colour is transparent, skin and grey stay opaque", () => {
  const cfg = chromaConfig(GREEN);
  const k = keyUVFor(GREEN);
  const at = (c) => keyAlpha(c[0] / 255, c[1] / 255, c[2] / 255, k, cfg).a;
  assert.equal(at(GREEN), 0);
  assert.equal(at(SKIN), 1);
  assert.equal(at(GREY), 1);
  assert.equal(at([255, 255, 255]), 1);
});

test("keyAlpha: alpha ramps across the smoothness band rather than snapping", () => {
  const cfg = { ...DEFAULT_CHROMA, key: GREEN };
  const k = keyUVFor(GREEN);
  // Walk from the key colour toward grey; alpha must be non-decreasing and pass through partial values.
  const alphas = [];
  for (let i = 0; i <= 40; i++) {
    const f = i / 40;
    const c = GREEN.map((v, j) => v + (GREY[j] - v) * f);
    alphas.push(keyAlpha(c[0] / 255, c[1] / 255, c[2] / 255, k, cfg).a);
  }
  for (let i = 1; i < alphas.length; i++) assert.ok(alphas[i] >= alphas[i - 1] - 1e-9);
  assert.ok(alphas.some((a) => a > 0.05 && a < 0.95));
});

test("keyPixels: keys an RGBA buffer in place and desaturates green spill on the edge", () => {
  const cfg = chromaConfig(GREEN);
  const fringe = [110, 160, 110]; // a greenish edge pixel: keeps some alpha, loses its green cast
  const d = new Uint8ClampedArray([...GREEN, 255, ...SKIN, 255, ...fringe, 255]);
  keyPixels(d, cfg);
  assert.equal(d[3], 0);
  assert.deepEqual([...d.slice(4, 8)], [...SKIN, 255]);
  assert.ok(d[9] - d[8] < fringe[1] - fringe[0], "spill suppression should pull green toward the other channels");
});

test("keyAlpha: an unevenly lit screen keys out across its shades; neutrals and skin don't", () => {
  const cfg = chromaConfig(GREEN);
  const k = keyUVFor(GREEN);
  const at = (c) => keyAlpha(c[0] / 255, c[1] / 255, c[2] / 255, k, cfg).a;
  for (const shade of [[30, 140, 55], [60, 200, 90], [70, 170, 80], [20, 120, 40]]) assert.equal(at(shade), 0, `shade ${shade}`);
  for (const keep of [[40, 40, 40], [200, 200, 200], [90, 60, 50], [250, 220, 200], [30, 60, 120]]) assert.equal(at(keep), 1, `keep ${keep}`);
});

test("rgbToHex / hexToRgb round-trip; bad input is null", () => {
  assert.equal(rgbToHex([0, 177, 64]), "#00b140");
  assert.deepEqual(hexToRgb("#00b140"), [0, 177, 64]);
  assert.equal(hexToRgb("green"), null);
});
