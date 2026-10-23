#!/usr/bin/env node
// Builds the five Chrome Web Store screenshots (1280x800) from real UI stills: a brand frame (logo, mono
// eyebrow, headline with a green accent, one-line sub) around a framed capture of the actual extension.
// The stills come from capture-editor.mjs (editor/stills/*.png), capture-popup.mjs and capture-shots.mjs.
// make-store-assets.mjs flattens these to 24-bit PNG for upload, so alpha is fine here.
//
//   node scripts/media/store-shots.mjs --editor <editor/main/stills> --popup <png> --shots <png> --out screenshots/store
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./lib/chrome.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
for (const k of ["editor", "popup", "shots", "out"]) if (!argv[k]) { console.error(`missing --${k}`); process.exit(2); }
const ED = resolve(argv.editor), OUT = resolve(argv.out);
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { file: "01-record.png", eyebrow: "SCREEN RECORDER", h1: "Record your screen, *free*", sub: "A tab, a window or the whole screen, saved as native MP4. No time limit, no watermark.", img: resolve(argv.popup), kind: "popup" },
  { file: "02-video-editor.png", eyebrow: "BUILT-IN VIDEO EDITOR", h1: "A timeline that *makes sense*", sub: "Your clip as a filmstrip, colour-coded tracks, a big timecode, and snapping you can switch off.", img: join(ED, "backdrop.png") },
  { file: "03-crop-ratios.png", eyebrow: "CROP & RATIOS", h1: "Crop with real *handles*", sub: "Move it, pull any edge, lock 16:9, 9:16, 1:1, 4:3 or 4:5, or type an exact size.", img: join(ED, "crop-box.png") },
  { file: "04-screenshots.png", eyebrow: "SCREENSHOTS", h1: "Screenshot & *annotate*", sub: "Arrows, numbered steps, spotlight, text and blur. Everything stays movable and re-editable.", img: resolve(argv.shots) },
  { file: "05-private.png", eyebrow: "EXPORT · PRIVATE", h1: "Export MP4 or GIF, *on your device*", sub: "Every frame is encoded locally. No cloud, no telemetry, no sign-up.", img: join(ED, "export-menu.png") },
];

const font = (family, weight, file) => `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url("file://${REPO}/docs/fonts/${file}") format("woff2"); }`;
const html = (s) => `<!doctype html><meta charset="utf-8"><style>
  ${font("Archivo", 400, "archivo-400.woff2")} ${font("Archivo", 500, "archivo-500.woff2")} ${font("Archivo", 800, "archivo-800.woff2")} ${font("JetBrains Mono", 500, "jetbrains-mono-500.woff2")}
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 800px; overflow: hidden; }
  body { position: relative; font-family: Archivo, sans-serif; color: #17181a; background: #fbfbf9; -webkit-font-smoothing: antialiased; }
  .bg { position: absolute; inset: 0; background: radial-gradient(70% 60% at 92% -5%, rgba(34,197,94,.16), transparent 70%), radial-gradient(50% 40% at 0% 100%, rgba(34,197,94,.05), transparent 70%); }
  .logo { position: absolute; left: 44px; top: 34px; display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 19px; letter-spacing: -0.02em; }
  .logo i { width: 26px; height: 26px; border-radius: 7px; background: #17181a; display: flex; align-items: center; justify-content: center; }
  .logo i::after { content: ""; width: 12px; height: 9px; border: 1.6px solid #fbfbf9; border-radius: 2px; }
  .eyebrow { position: absolute; left: 0; right: 0; top: 70px; text-align: center; font-family: "JetBrains Mono", monospace; font-weight: 500; font-size: 13px; letter-spacing: .18em; color: #1b8e51; }
  h1 { position: absolute; left: 60px; right: 60px; top: 96px; text-align: center; font-weight: 800; font-size: 58px; line-height: 1.02; letter-spacing: -0.04em; }
  h1 b { color: #1b8e51; font-weight: 800; }
  .sub { position: absolute; left: 120px; right: 120px; top: ${s.twoLine ? 232 : 178}px; text-align: center; font-size: 20px; line-height: 1.4; color: #5c5f64; }
  .card { position: absolute; left: 50%; top: ${s.twoLine ? 306 : 236}px; transform: translateX(-50%); border: 1px solid rgba(23,24,26,.12); border-radius: 16px; overflow: hidden; background: #fff; box-shadow: 0 50px 90px -40px rgba(23,24,26,.38), 0 10px 30px -16px rgba(23,24,26,.25); }
  .card img { display: block; }
  .wide { width: 940px; } .wide img { width: 940px; }
  .tall { border-radius: 22px; } .tall img { height: ${s.twoLine ? 520 : 590}px; width: auto; }
</style><div class="bg"></div><div class="logo"><i></i>screensnap</div>
<div class="eyebrow">${s.eyebrow}</div><h1>${s.h1.replace(/\*([^*]+)\*/g, "<b>$1</b>")}</h1><div class="sub">${s.sub}</div>
<div class="card ${s.kind === "popup" ? "tall" : "wide"}"><img src="file://${s.img}"></div>`;

const chrome = await launchChrome();
try {
  const dir = mkdtempSync(join(tmpdir(), "store-shots-"));
  const page = await chrome.newPage("about:blank", { width: 1280, height: 800, dsf: 1 });
  for (const s of SHOTS) {
    s.twoLine = s.h1.length > 36; // a long headline wraps to two lines: push the rest down
    const file = join(dir, "page.html");
    writeFileSync(file, html(s));
    await page.navigate(`file://${file}`);
    await page.evaluate("Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)", true);
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(OUT, s.file), await page.screenshot({ optimizeForSpeed: false }));
    console.log("wrote", s.file);
  }
} finally { await chrome.close(); }
process.exit(0);
