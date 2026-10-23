#!/usr/bin/env node
// Builds every image the Chrome Web Store listing needs into dist/store-assets/, with zero
// npm dependencies: the promo tiles (screenshots/promo/) and store screenshots (screenshots/store/),
// both made from real UI by scripts/media/store-shots.mjs, are re-encoded as 24-bit PNG because the
// store rejects alpha. Also emits a padded
// store icon (96px mark centered on a 128px transparent canvas, per CWS image guidelines).
//
//   node scripts/make-store-assets.mjs
import { inflateSync, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "store-assets");

// --- tiny PNG codec (8-bit, non-interlaced, RGB/RGBA) ------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
};

function decodePNG(file) {
  const buf = readFileSync(file);
  let pos = 8; // skip signature
  let w, h, colorType, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error(`${file}: only 8-bit non-interlaced PNG supported`);
      colorType = data[9];
      if (colorType !== 2 && colorType !== 6) throw new Error(`${file}: unsupported color type ${colorType}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += left;
      else if (f === 2) v += up;
      else if (f === 3) v += (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { w, h, bpp, px };
}

function encodePNG(w, h, px, bpp) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Flatten to 24-bit RGB (the store rejects PNGs with an alpha channel).
function flatten(inFile, outFile) {
  const { w, h, bpp, px } = decodePNG(inFile);
  if (bpp === 3) { writeFileSync(outFile, encodePNG(w, h, px, 3)); return; }
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
    const a = px[i + 3] / 255; // composite over the brand background, not black
    rgb[o] = Math.round(px[i] * a + 11 * (1 - a));
    rgb[o + 1] = Math.round(px[i + 1] * a + 11 * (1 - a));
    rgb[o + 2] = Math.round(px[i + 2] * a + 13 * (1 - a));
  }
  writeFileSync(outFile, encodePNG(w, h, rgb, 3));
}

// --- promo tiles: made from real UI by scripts/media/store-shots.mjs into screenshots/promo/ ---------------
mkdirSync(OUT, { recursive: true });
const PROMO = join(ROOT, "screenshots", "promo");
for (const f of readdirSync(PROMO).filter((f) => f.endsWith(".png")).sort()) {
  flatten(join(PROMO, f), join(OUT, f));
  console.log(`  ✓ ${f}`);
}

// --- store screenshots: flatten any RGBA ones to 24-bit RGB -------------------
const SHOTS = join(ROOT, "screenshots", "store");
mkdirSync(join(OUT, "screenshots"), { recursive: true });
for (const f of readdirSync(SHOTS).filter((f) => f.endsWith(".png")).sort()) {
  flatten(join(SHOTS, f), join(OUT, "screenshots", f));
  console.log(`  ✓ screenshots/${f}`);
}

// --- store icon: the 128px mark scaled to 96px on a transparent 128 canvas ----
// (CWS image guidelines ask for a 96×96 icon with 16px of padding; alpha is allowed here.)
const icon = decodePNG(join(ROOT, "icons", "icon-128.png"));
const padded = Buffer.alloc(128 * 128 * 4);
for (let y = 0; y < 96; y++) {
  for (let x = 0; x < 96; x++) {
    // box-sample the 128px source down to 96px (4:3 ratio → 2×2 max taps is plenty here)
    const sx = (x * 128) / 96, sy = (y * 128) / 96;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (const oy of [0, 0.667]) for (const ox of [0, 0.667]) {
      const i = ((Math.min(127, sy + oy) | 0) * 128 + (Math.min(127, sx + ox) | 0)) * 4;
      r += icon.px[i]; g += icon.px[i + 1]; b += icon.px[i + 2]; a += icon.px[i + 3]; n++;
    }
    const o = ((y + 16) * 128 + (x + 16)) * 4;
    padded[o] = Math.round(r / n); padded[o + 1] = Math.round(g / n);
    padded[o + 2] = Math.round(b / n); padded[o + 3] = Math.round(a / n);
  }
}
writeFileSync(join(OUT, "store-icon-128.png"), encodePNG(128, 128, padded, 4));
console.log("  ✓ store-icon-128.png");
console.log(`\nDone → ${OUT}`);
