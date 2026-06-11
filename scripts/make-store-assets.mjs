#!/usr/bin/env node
// Builds every image the Chrome Web Store listing needs into dist/store-assets/, with zero
// npm dependencies: promo tiles are HTML rendered by headless Chrome (so the real Geist fonts
// and brand styles are used), then re-encoded as 24-bit PNG because the store rejects alpha.
// Store screenshots in screenshots/store/ are flattened the same way. Also emits a padded
// store icon (96px mark centered on a 128px transparent canvas, per CWS image guidelines).
//
//   node scripts/make-store-assets.mjs
import { execFileSync } from "node:child_process";
import { inflateSync, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "store-assets");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

// --- promo tiles: brand HTML rendered by headless Chrome ----------------------
const FONTS = join(ROOT, "src", "popup", "fonts");
// The tile is laid out inside a fixed-size .stage pinned to the top-left corner: headless
// Chrome clamps the window to a 500px minimum width, so viewport-relative centering drifts
// on small canvases (the screenshot is cropped from a wider layout). The stage matches the
// screenshot crop exactly, so centering inside it is exact.
const tileHTML = (variant, w, h) => `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: Geist; font-weight: 400; src: url("file://${FONTS}/geist-400.woff2") format("woff2"); }
  @font-face { font-family: Geist; font-weight: 500; src: url("file://${FONTS}/geist-500.woff2") format("woff2"); }
  @font-face { font-family: Geist; font-weight: 600; src: url("file://${FONTS}/geist-600.woff2") format("woff2"); }
  @font-face { font-family: "Geist Mono"; font-weight: 500; src: url("file://${FONTS}/geist-mono-500.woff2") format("woff2"); }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0b0b0d; }
  body { font-family: Geist, system-ui, sans-serif; color: #fafafa; }
  .stage {
    position: fixed; left: 0; top: 0; width: ${w}px; height: ${h}px;
    background: radial-gradient(120% 140% at 78% 18%, rgba(34,197,94,.13), transparent 55%), #0b0b0d;
    display: flex; align-items: center; justify-content: center;
  }
  .lens { border-radius: 24%; background: #111113; border: 1px solid #232328;
          display: flex; align-items: center; justify-content: center; }
  .ring { border-radius: 50%; border-style: solid; border-color: #22c55e;
          display: flex; align-items: center; justify-content: center; }
  .pupil { border-radius: 50%; background: #050506; }
  .word { font-weight: 600; letter-spacing: -0.03em; }
  .word .dot { color: #22c55e; }
  .tag { color: #a1a1aa; font-weight: 400; letter-spacing: -0.01em; }
  .chips { display: flex; gap: 10px; }
  .chip { border: 1px solid #26262b; background: rgba(255,255,255,.03); border-radius: 999px;
          color: #d4d4d8; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .chip i { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; }
  .pill { background: #161618; border: 1px solid #2a2a30; border-radius: 999px;
          display: flex; align-items: center; box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  .rec { width: 11px; height: 11px; border-radius: 50%; background: #ef4444;
         box-shadow: 0 0 14px rgba(239,68,68,.8); }
  .time { font-family: "Geist Mono", monospace; font-weight: 500; color: #fafafa; }
  .ctl { color: #71717a; font-size: 13px; letter-spacing: 2px; }
</style>
${variant === "small" ? `
<body><div class="stage">
  <div style="display:flex; flex-direction:column; align-items:center; gap:16px">
    <div style="display:flex; align-items:center; gap:13px">
      <div class="lens" style="width:50px;height:50px"><div class="ring" style="width:26px;height:26px;border-width:6px"><div class="pupil" style="width:11px;height:11px"></div></div></div>
      <div class="word" style="font-size:36px">screensnap<span class="dot">.</span></div>
    </div>
    <div class="tag" style="font-size:14.5px">Free screen recording. No watermark. No catch.</div>
  </div>
</div></body>` : `
<body><div class="stage" style="justify-content:space-between; padding: 0 96px">
  <div style="display:flex; flex-direction:column; gap:26px">
    <div class="word" style="font-size:84px">screensnap<span class="dot">.</span></div>
    <div class="tag" style="font-size:29px">Free, unlimited screen recording &amp; screenshots —<br>everything stays on your machine.</div>
    <div class="chips" style="font-size:17px">
      <div class="chip" style="padding:10px 18px"><i></i>No watermark</div>
      <div class="chip" style="padding:10px 18px"><i></i>No sign-up</div>
      <div class="chip" style="padding:10px 18px"><i></i>No cloud</div>
      <div class="chip" style="padding:10px 18px"><i></i>Built-in editor</div>
    </div>
  </div>
  <div style="display:flex; flex-direction:column; align-items:center; gap:40px">
    <div class="lens" style="width:200px;height:200px"><div class="ring" style="width:104px;height:104px;border-width:22px"><div class="pupil" style="width:46px;height:46px"></div></div></div>
    <div class="pill" style="padding:14px 26px; gap:16px">
      <div class="rec"></div><div class="time" style="font-size:21px">12:34</div><div class="ctl">❚❚&nbsp;&nbsp;■</div>
    </div>
  </div>
</div></body>`}`;

mkdirSync(OUT, { recursive: true });
const TILES = [
  { name: "promo-small-440x280.png", w: 440, h: 280, variant: "small" },
  { name: "promo-marquee-1400x560.png", w: 1400, h: 560, variant: "marquee" },
];
for (const t of TILES) {
  const htmlFile = join(OUT, `_${t.variant}.html`);
  writeFileSync(htmlFile, tileHTML(t.variant, t.w, t.h));
  const shot = join(OUT, `_${t.variant}-raw.png`);
  execFileSync(CHROME, [
    "--headless=new", `--screenshot=${shot}`, `--window-size=${t.w},${t.h}`,
    "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
    "--disable-gpu", `file://${htmlFile}`,
  ], { stdio: "pipe" });
  flatten(shot, join(OUT, t.name));
  rmSync(htmlFile); rmSync(shot);
  console.log(`  ✓ ${t.name}`);
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
