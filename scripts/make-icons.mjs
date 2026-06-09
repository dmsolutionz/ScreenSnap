#!/usr/bin/env node
// Generates the extension's PNG icons with zero dependencies (Node built-in zlib only).
// Placeholder branding: an indigo rounded square with a white camera aperture ring and a
// red record dot — reads as both "screenshot" and "record". Swap freely once real art lands.
//
//   node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor for anti-aliasing

// screensnap. mark: near-black rounded square with a green camera "lens" ring.
const ACCENT = [17, 17, 19]; // #111113 dark background
const WHITE = [34, 197, 94]; // #22c55e green lens ring
const RECORD = [5, 5, 6]; // #050506 dark pupil/center

// --- tiny PNG encoder (RGBA, 8-bit) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing ----------------------------------------------------------------
function over(dst, i, [r, g, b], a) {
  // alpha composite src(rgb,a) over dst at byte offset i
  const ia = 1 - a;
  dst[i] = Math.round(r * a + dst[i] * ia);
  dst[i + 1] = Math.round(g * a + dst[i + 1] * ia);
  dst[i + 2] = Math.round(b * a + dst[i + 2] * ia);
  dst[i + 3] = Math.round(255 * a + dst[i + 3] * ia);
}

function renderAt(size) {
  const buf = Buffer.alloc(size * size * 4); // transparent
  const r = size * 0.22; // corner radius
  const ringOuter = size * 0.33;
  const ringInner = size * 0.215;
  const dot = size * 0.125;
  const cx = size / 2;
  const cy = size / 2;

  const inRounded = (x, y) => {
    // distance into rounded rect (>=0 inside)
    const dx = Math.max(r - x, x - (size - r), 0);
    const dy = Math.max(r - y, y - (size - r), 0);
    if (x < r && y < r) return r - Math.hypot(r - x, r - y) >= 0;
    if (x > size - r && y < r) return r - Math.hypot(x - (size - r), r - y) >= 0;
    if (x < r && y > size - r) return r - Math.hypot(r - x, y - (size - r)) >= 0;
    if (x > size - r && y > size - r) return r - Math.hypot(x - (size - r), y - (size - r)) >= 0;
    return dx <= 0 || dy <= 0;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inRounded(px, py)) continue;
      over(buf, i, ACCENT, 1);
      const d = Math.hypot(px - cx, py - cy);
      if (d <= ringOuter && d >= ringInner) over(buf, i, WHITE, 1); // aperture ring
      if (d <= dot) over(buf, i, RECORD, 1); // record dot
    }
  }
  return buf;
}

function downscale(src, from, to) {
  const factor = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const i = (((y * factor + sy) | 0) * from + ((x * factor + sx) | 0)) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * to + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const hi = renderAt(size * SS);
  const px = downscale(hi, size * SS, size);
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), encodePNG(size, size, px));
  console.log(`  ✓ icons/icon-${size}.png`);
}
console.log("Done.");
