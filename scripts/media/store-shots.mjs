#!/usr/bin/env node
// Chrome Web Store artwork from real UI stills, in the launch film's look (near-black, green glow, bold type):
//   screenshots/store/01..05-*.png   the five 1280x800 listing screenshots
//   screenshots/promo/promo-small-440x280.png, promo-marquee-1400x560.png   the promo tiles
// Rendered by headless Chrome at 2x and scaled down (crisp type), opaque 24-bit (the store rejects alpha);
// make-store-assets.mjs copies them into dist/store-assets for upload. The stills come from capture-editor.mjs,
// capture-popup.mjs and capture-shots.mjs.
//
//   node scripts/media/store-shots.mjs --editor <editor stills dir> --popup <popup record-full.png> --shots <shots annotated.png>
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { launchChrome } from "./lib/chrome.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
for (const k of ["editor", "popup", "shots"]) if (!argv[k]) { console.error(`missing --${k}`); process.exit(2); }
const ED = resolve(argv.editor);
const img = (p) => `file://${resolve(p)}`;
const SHOTS_DIR = join(REPO, "screenshots", "store"), PROMO_DIR = join(REPO, "screenshots", "promo");

const font = (fam, w, f) => `@font-face { font-family: "${fam}"; font-weight: ${w}; src: url("file://${REPO}/docs/fonts/${f}") format("woff2"); }`;
const BASE = `
  ${font("Archivo", 500, "archivo-500.woff2")} ${font("Archivo", 700, "archivo-700.woff2")} ${font("Archivo", 800, "archivo-800.woff2")} ${font("JetBrains Mono", 600, "jetbrains-mono-600.woff2")}
  * { margin: 0; box-sizing: border-box; }
  html, body { overflow: hidden; background: #060808; font-family: Archivo, sans-serif; color: #fff; -webkit-font-smoothing: antialiased; }
  .bg { position: absolute; inset: 0; background: radial-gradient(70% 70% at 85% 0%, rgba(34,197,94,.30), transparent 70%), radial-gradient(50% 60% at 0% 100%, rgba(20,184,166,.14), transparent 70%), #060808; }
  .dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.07) 1.2px, transparent 1.6px); background-size: 28px 28px; -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000, transparent 80%); }
  .logo { position: absolute; display: flex; align-items: center; gap: 12px; font-weight: 800; letter-spacing: -0.03em; }
  .logo img { border-radius: 22%; } .logo b { color: #22c55e; }
  .eyebrow { font-family: "JetBrains Mono", monospace; font-weight: 600; letter-spacing: .2em; color: #4ade80; }
  h1 { font-weight: 800; letter-spacing: -0.045em; line-height: 1.0; }
  h1 em { font-style: normal; color: #2ee07a; text-shadow: 0 0 40px rgba(34,197,94,.45); }
  .sub { color: #a6aeaa; font-weight: 500; line-height: 1.4; }
  .card { position: absolute; border-radius: 16px; overflow: hidden; background: #fff;
    box-shadow: 0 0 0 2px rgba(46,224,122,.75), 0 0 70px rgba(34,197,94,.35), 0 40px 90px rgba(0,0,0,.7); }
  .card img { display: block; width: 100%; }
  .chips { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { display: flex; align-items: center; gap: 9px; border: 1.5px solid rgba(46,224,122,.45); background: rgba(34,197,94,.10); border-radius: 999px; color: #e7f7ee; font-weight: 700; }
  .chip i { width: 8px; height: 8px; border-radius: 50%; background: #2ee07a; box-shadow: 0 0 10px #2ee07a; }
`;
const ICON = img(join(REPO, "icons", "icon-128.png"));
const hl = (s) => s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

// ── the five listing screenshots: headline on top, the real UI large and glowing, bleeding off the bottom ──
const SHOTS = [
  { file: "01-record.png", eyebrow: "SCREEN RECORDER", h1: "Record your screen, *free*", sub: "A tab, a window or your whole screen, with your mic and camera. Saved as MP4. No time limit, no watermark.", img: argv.popup, tall: true },
  { file: "02-video-editor.png", eyebrow: "BUILT-IN VIDEO EDITOR", h1: "A timeline that *makes sense*", sub: "Split, trim, zoom and undo anything. Your clip shows as a filmstrip on colour-coded tracks.", img: join(ED, "backdrop.png") },
  { file: "03-crop-ratios.png", eyebrow: "CROP & RATIOS", h1: "Crop with *real handles*", sub: "Drag the box, pull any edge, lock 16:9, 9:16, 1:1 or 4:5, or type an exact size.", img: join(ED, "crop-box.png") },
  { file: "04-screenshots.png", eyebrow: "SCREENSHOTS", h1: "Screenshot & *annotate*", sub: "Arrows, numbered steps, spotlight, text and blur. Everything stays movable.", img: argv.shots },
  { file: "05-private.png", eyebrow: "EXPORT · PRIVATE", h1: "Export MP4 or GIF, *on your device*", sub: "Every frame is encoded locally. No servers, no tracking, no account.", img: join(ED, "export-menu.png") },
];
const shotHTML = (s) => `<!doctype html><meta charset="utf-8"><style>${BASE}
  html, body { width: 1280px; height: 800px; }
  .logo { left: 44px; top: 34px; font-size: 24px; } .logo img { width: 34px; height: 34px; }
  .eyebrow { position: absolute; left: 0; right: 0; top: 62px; text-align: center; font-size: 14px; }
  h1 { position: absolute; left: 40px; right: 40px; top: 90px; text-align: center; font-size: 64px; }
  .sub { position: absolute; left: 150px; right: 150px; top: 172px; text-align: center; font-size: 20px; }
  .card.wide { left: 50%; top: 252px; width: 980px; margin-left: -490px; }
  .card.tall { left: 50%; top: 248px; height: 620px; transform: translateX(-50%); border-radius: 22px; }
  .card.tall img { height: 100%; width: auto; }
</style><div class="bg"></div><div class="dots"></div>
<div class="logo"><img src="${ICON}"><span>screensnap<b>.</b></span></div>
<div class="eyebrow">${s.eyebrow}</div><h1>${hl(s.h1)}</h1><div class="sub">${s.sub}</div>
<div class="card ${s.tall ? "tall" : "wide"}"><img src="${img(s.img)}"></div>`;

// ── promo tiles ──
const small = `<!doctype html><meta charset="utf-8"><style>${BASE}
  html, body { width: 440px; height: 280px; }
  .logo { left: 22px; top: 20px; font-size: 21px; gap: 9px; } .logo img { width: 28px; height: 28px; }
  h1 { position: absolute; left: 22px; top: 66px; font-size: 40px; line-height: .98; }
  .chips { position: absolute; left: 22px; bottom: 22px; } .chip { font-size: 12.5px; padding: 6px 11px; gap: 7px; } .chip i { width: 6px; height: 6px; }
  .card { left: 284px; top: 54px; width: 300px; border-radius: 10px; transform: perspective(900px) rotateY(-18deg); transform-origin: 0 50%; }
</style><div class="bg"></div><div class="dots"></div>
<div class="card"><img src="${img(join(ED, "backdrop.png"))}"></div>
<div class="logo"><img src="${ICON}"><span>screensnap<b>.</b></span></div>
<h1><em>Free</em> screen<br>recorder<br>+ editor</h1>
<div class="chips"><div class="chip"><i></i>No watermark</div><div class="chip"><i></i>No sign-up</div></div>`;

const marquee = `<!doctype html><meta charset="utf-8"><style>${BASE}
  html, body { width: 1400px; height: 560px; }
  .logo { left: 72px; top: 60px; font-size: 34px; gap: 14px; } .logo img { width: 46px; height: 46px; }
  h1 { position: absolute; left: 72px; top: 140px; font-size: 92px; line-height: .95; }
  .sub { position: absolute; left: 74px; top: 344px; width: 560px; font-size: 22px; }
  .chips { position: absolute; left: 72px; top: 430px; width: 600px; } .chip { font-size: 17px; padding: 10px 18px; }
  .card { left: 700px; top: 70px; width: 860px; transform: perspective(1800px) rotateY(-14deg) rotateX(3deg); transform-origin: 0 50%; }
</style><div class="bg"></div><div class="dots"></div>
<div class="card"><img src="${img(join(ED, "backdrop.png"))}"></div>
<div class="logo"><img src="${ICON}"><span>screensnap<b>.</b></span></div>
<h1>Record. Edit.<br><em>Free.</em></h1>
<div class="sub">Screen recorder, timeline editor and screenshots in one Chrome extension. Everything stays on your machine.</div>
<div class="chips"><div class="chip"><i></i>No watermark</div><div class="chip"><i></i>No sign-up</div><div class="chip"><i></i>No time limit</div><div class="chip"><i></i>Open source</div></div>`;

const JOBS = [
  ...SHOTS.map((s) => ({ out: join(SHOTS_DIR, s.file), w: 1280, h: 800, html: shotHTML(s) })),
  { out: join(PROMO_DIR, "promo-small-440x280.png"), w: 440, h: 280, html: small },
  { out: join(PROMO_DIR, "promo-marquee-1400x560.png"), w: 1400, h: 560, html: marquee },
];
mkdirSync(SHOTS_DIR, { recursive: true }); mkdirSync(PROMO_DIR, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "store-art-"));
const chrome = await launchChrome();
try {
  for (const j of JOBS) {
    const page = await chrome.newPage("about:blank", { width: j.w, height: j.h, dsf: 2 });
    writeFileSync(join(dir, "p.html"), j.html);
    await page.navigate(`file://${join(dir, "p.html")}`);
    await page.evaluate("Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)", true);
    await new Promise((r) => setTimeout(r, 250));
    const raw = join(dir, "raw.png");
    writeFileSync(raw, await page.screenshot({ optimizeForSpeed: false }));
    // 2x → exact store size, opaque RGB
    spawnSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-vf", `scale=${j.w}:${j.h}:flags=lanczos,format=rgb24`, j.out]);
    console.log("wrote", j.out.replace(REPO + "/", ""));
  }
} finally { await chrome.close(); }
process.exit(0);
