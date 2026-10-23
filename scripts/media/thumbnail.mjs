#!/usr/bin/env node
// YouTube thumbnail for the launch film: a huge "FREE", the promise in one line, the three things it doesn't do
// struck out, and the real editor (a still from capture-editor.mjs) tilted in from the right. Rendered by headless
// Chrome at 2560x1440 and saved as a JPEG under YouTube's 2 MB limit.
//
//   node scripts/media/thumbnail.mjs --still <editor stills/backdrop.png> --out thumbnail.jpg
import { writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { launchChrome } from "./lib/chrome.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!argv.still || !argv.out) { console.error("usage: thumbnail.mjs --still editor.png --out thumbnail.jpg"); process.exit(2); }
const font = (w, f) => `@font-face { font-family: Archivo; font-weight: ${w}; src: url("file://${REPO}/docs/fonts/${f}") format("woff2"); }`;

const html = `<!doctype html><meta charset="utf-8"><style>
  ${font(700, "archivo-700.woff2")} ${font(800, "archivo-800.woff2")}
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 720px; overflow: hidden; background: #050707; font-family: Archivo, sans-serif; }
  .glow { position: absolute; inset: 0; background: radial-gradient(60% 75% at 82% 45%, rgba(34,197,94,.42), transparent 70%), radial-gradient(40% 50% at 10% 100%, rgba(20,184,166,.18), transparent 70%); }
  .grid { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.08) 1.2px, transparent 1.6px); background-size: 30px 30px; -webkit-mask-image: linear-gradient(90deg, #000 0%, transparent 55%); }
  .shot { position: absolute; left: 600px; top: 128px; width: 860px; border-radius: 18px; overflow: hidden;
    transform: perspective(1600px) rotateY(-16deg) rotateX(4deg) rotateZ(1.5deg); transform-origin: 0 50%;
    box-shadow: 0 50px 120px rgba(0,0,0,.8), 0 0 0 3px rgba(34,197,94,.65), 0 0 90px rgba(34,197,94,.55); }
  .shot img { display: block; width: 100%; }
  .brand { position: absolute; left: 54px; top: 42px; color: #fff; font-weight: 800; font-size: 40px; letter-spacing: -0.03em; }
  .brand b { color: #22c55e; }
  .free { position: absolute; left: 44px; top: 100px; font-weight: 800; font-size: 228px; line-height: .9; letter-spacing: -0.06em; color: #2ee07a;
    text-shadow: 0 -2px 0 #9dffc3, 0 8px 0 #0a4a24, 0 0 60px rgba(34,197,94,.55); z-index: 2; }
  .what { position: absolute; left: 54px; top: 340px; color: #fff; font-weight: 800; font-size: 60px; line-height: 1.02; letter-spacing: -0.035em; text-shadow: 0 6px 24px rgba(0,0,0,.7); }
  .nos { position: absolute; left: 54px; top: 500px; display: flex; flex-direction: column; gap: 14px; }
  .no { position: relative; align-self: flex-start; font-weight: 800; font-size: 40px; letter-spacing: -0.02em; color: #fff; background: #1b1f1e; border: 3px solid #f0524f; border-radius: 14px; padding: 4px 18px 6px; }
  .no::after { content: ""; position: absolute; left: 8px; right: 8px; top: 50%; height: 7px; margin-top: -3px; background: #f0524f; border-radius: 4px; transform: rotate(-4deg); box-shadow: 0 0 12px rgba(240,82,79,.8); }
</style>
<div class="glow"></div><div class="grid"></div>
<div class="shot"><img src="file://${resolve(argv.still)}"></div>
<div class="brand">screensnap<b>.</b></div>
<div class="free">FREE</div>
<div class="what">screen recorder<br>+ video editor</div>
<div class="nos"><div class="no">watermarks</div><div class="no">sign-ups</div><div class="no">subscriptions</div></div>`;

const dir = mkdtempSync(join(tmpdir(), "thumb-"));
writeFileSync(join(dir, "t.html"), html);
const chrome = await launchChrome();
try {
  const page = await chrome.newPage(`file://${join(dir, "t.html")}`, { width: 1280, height: 720, dsf: 2 });
  await page.evaluate("Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode())]).then(() => true)", true);
  await new Promise((r) => setTimeout(r, 300));
  const png = join(dir, "t.png");
  writeFileSync(png, await page.screenshot({ optimizeForSpeed: false }));
  // JPEG: the best quality that stays under YouTube's 2 MB cap
  for (const q of [2, 3, 4, 5, 6]) {
    spawnSync("ffmpeg", ["-y", "-v", "error", "-i", png, "-q:v", String(q), argv.out]);
    if (statSync(argv.out).size < 1.95e6) break;
  }
  console.log(`${argv.out} · ${(statSync(argv.out).size / 1e6).toFixed(2)} MB`);
} finally { await chrome.close(); }
process.exit(0);
