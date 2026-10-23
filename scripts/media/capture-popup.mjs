#!/usr/bin/env node
// Films the REAL extension popup (src/popup/popup.html, this repo loaded unpacked in headless Chrome) as a
// scripted tour: Capture tab -> Record tab (sources, audio, quality, countdown, camera bubble) -> Settings
// (Google Drive backup). Output is numbered PNG frames at 3x pixel density (340x600 CSS px = a Chrome popup at its
// 600px height cap, so the Record tab scrolls inside it exactly as it does for a user) plus manifest.json with
// the timed marks + clicks the film compositor syncs to, and one clean still PNG (no cursor) per key state.
//
// Nothing here starts a recording or a capture: the Rec buttons are only hovered, never pressed. The popup is
// shown with the sheet filling the window (no outer rounding/shadow - the film adds the device frame), and the
// Settings tab is staged in its *connected* state (a sample account written to chrome.storage.local in the
// throwaway profile) so the auto-upload toggle is visible; the not-connected state is saved as a still too.
//
//   node scripts/media/capture-popup.mjs --out DIR [--fps 30] [--pace 1.6] [--dsf 3]
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome } from "./lib/chrome.mjs";
import { createDirector } from "./lib/director.mjs";
import { REPO } from "./lib/editor-session.mjs";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : a), []));
if (!argv.out) { console.error("usage: capture-popup.mjs --out DIR [--fps 30] [--dsf 3]"); process.exit(2); }
const OUT = argv.out;
const W = 340, H = 600, DSF = Number(argv.dsf || 3), FPS = Number(argv.fps || 30);
rmSync(join(OUT, "frames"), { recursive: true, force: true });
rmSync(join(OUT, "stills"), { recursive: true, force: true });
mkdirSync(join(OUT, "stills"), { recursive: true });

const tStart = Date.now();
const chrome = await launchChrome();
const ext = await chrome.loadExtension(REPO);
const page = await chrome.newPage(`chrome-extension://${ext.id}/src/popup/popup.html`, { width: W, height: H, dsf: DSF });
await sleep(900);
// A Chrome popup is a plain white window: let the sheet fill it edge to edge (no outer corners/shadow to crop away).
await page.evaluate(`(() => {
  const s = document.createElement('style');
  s.textContent = 'html,body{background:#fff} .sheet{min-height:100vh;border:none;border-radius:0;box-shadow:none}';
  document.head.appendChild(s);
})()`);
await page.evaluate(`document.fonts.ready.then(() => true)`, true);

// ── helpers ──
const R = async (sel) => {
  const r = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  if (!r) throw new Error("no element: " + sel);
  return { ...r, cx: r.l + r.w / 2, cy: r.t + r.h / 2, r: r.l + r.w, b: r.t + r.h };
};
const tab = (t) => `[data-act="tab"][data-tab="${t}"]`;
const recBtn = (i) => `.sheet [data-act="rec"][data-src="${["tab", "screen", "videocircle"][i]}"]`;
const seg = (key, val) => `[data-act="set"][data-key="${key}"][data-val="${val}"]`;
const tg = (key) => `.tg[data-key="${key}"]`;

// A clean still of the current state: cursor hidden, transitions settled. full = tall capture of the whole page.
async function still(name, { full = false } = {}) {
  await sleep(260);
  await page.evaluate(`document.getElementById('__cur') && (document.getElementById('__cur').style.visibility = 'hidden')`);
  let png;
  if (full) {
    const [h, y] = await page.evaluate(`[document.documentElement.scrollHeight, scrollY]`);
    await page.cmd("Emulation.setDeviceMetricsOverride", { width: W, height: h, deviceScaleFactor: DSF, mobile: false });
    await sleep(200);
    png = await page.screenshot();
    await page.cmd("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
    await page.evaluate(`scrollTo(0, ${y})`);
    await sleep(120);
  } else png = await page.screenshot();
  writeFileSync(join(OUT, "stills", name + ".png"), png);
  await page.evaluate(`document.getElementById('__cur') && (document.getElementById('__cur').style.visibility = '')`);
}

// Pre-pass (not filmed): the Settings tab as a first-time user sees it, then stage a connected Drive account.
await page.evaluate(`document.querySelector(${JSON.stringify(tab("settings"))}).click()`);
await sleep(400);
await still("settings-not-connected");
await page.evaluate(`document.querySelector(${JSON.stringify(tab("record"))}).click()`);
await sleep(300);
await still("record-full", { full: true });
await page.evaluate(`document.querySelector(${JSON.stringify(tab("capture"))}).click()`);
await page.evaluate(`chrome.storage.local.set({ driveAccount: 'dana@pulse.example' })`, true);
await sleep(500);

const d = createDirector(page, { fps: FPS, outDir: OUT, start: [250, 420], cursorScale: 0.62, pace: Number(argv.pace || 1) });
await d.install();

const moveTo = async (sel, sec = 0.5) => { const r = await R(sel); await d.glide(r.cx, r.cy, sec); return r; };
const clickOn = async (sel, sec = 0.5, settle = 0.2) => { const r = await moveTo(sel, sec); await d.click({ settle }); return r; };
const settle = () => d.act(() => sleep(230)); // one real-time beat so a hover transition lands before a held frame
const scrollTo = async (y, sec) => {
  const from = await page.evaluate(`scrollY`), n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) { const u = d.ease.inOut(i / n); await d.act((p) => p.evaluate(`scrollTo(0, ${(from + (y - from) * u).toFixed(2)})`)); }
};

// Chrome sizes a popup to its content (capped at 600px). The frames keep one fixed canvas, so record the popup's
// real height whenever it changes: manifest.windowHeights lets the film resize / crop the window like Chrome does.
const naturalH = () => page.evaluate(`(() => { const e = document.querySelector('.sheet'), m = e.style.minHeight; e.style.minHeight = '0'; const h = e.getBoundingClientRect().height; e.style.minHeight = m; return Math.min(${H}, h); })()`);
const windowHeights = [{ frame: 0, t: 0, h: Math.round(await naturalH()) }];
const clickTab = async (name, sec, settleSec) => {
  await clickOn(tab(name), sec, settleSec);
  const frame = d.frameCount() - Math.max(1, Math.round(settleSec * FPS)); // first frame after the release
  windowHeights.push({ frame, t: frame / FPS, h: Math.round(await naturalH()) });
};

// ── the tour ──
// 1. Capture tab, hover both capture modes (never clicked: that would screenshot the tab)
d.mark("capture-tab");
await d.hold(0.4);
await moveTo('[data-act="cap"][data-mode="visible"]', 0.5); await settle();
await still("capture-tab");
await moveTo('[data-act="cap"][data-mode="fullpage"]', 0.3); await settle();
await d.hold(0.1);

// 2. Record tab
d.mark("record-tab");
await clickTab("record", 0.45, 0.12);
await moveTo(recBtn(0), 0.35); await settle();
await still("record-tab");

// 3. the three sources: hover the Rec buttons (never pressed)
d.mark("sources");
await d.hold(0.1);
await moveTo(recBtn(1), 0.28); await settle();
await moveTo(recBtn(2), 0.28); await settle();
await still("sources");
await d.hold(0.15);

// 4. audio: both off, then both back on
d.mark("audio");
await clickOn(tg("withSystemAudio"), 0.4, 0.16);
await clickOn(tg("withMic"), 0.24, 0.16);
await still("audio");
await d.hold(0.1);
await clickOn(tg("withSystemAudio"), 0.24, 0.12);
await clickOn(tg("withMic"), 0.22, 0.12);

// 5. quality presets
d.mark("quality");
await clickOn(seg("videoQuality", "small"), 0.35, 0.2);
await clickOn(seg("videoQuality", "high"), 0.26, 0.2);
await still("quality");
await clickOn(seg("videoQuality", "standard"), 0.26, 0.15);

// 6. scroll the popup (it caps at 600px), countdown chips Off -> 3s -> 5s
await scrollTo(175, 0.5);
d.mark("countdown");
await clickOn(seg("countdownSec", "0"), 0.35, 0.18);
await clickOn(seg("countdownSec", "3"), 0.22, 0.12);
await clickOn(seg("countdownSec", "5"), 0.22, 0.18);
await still("countdown");

// 7. camera bubble options for Screen + Cam
d.mark("cam-options");
await clickOn(seg("bubbleShape", "square"), 0.35, 0.18);
await clickOn(seg("bubbleSize", "lg"), 0.26, 0.18);
await clickOn(tg("camMirror"), 0.26, 0.2);
await still("cam-options");

// 8. Settings: Google Drive backup + auto-upload
await scrollTo(0, 0.4);
d.mark("settings");
await clickTab("settings", 0.4, 0.15);
await moveTo('[data-act="drive-setup"]', 0.35); await settle();
await d.hold(0.1);
await clickOn(tg("driveAutoUpload"), 0.35, 0.3);
await d.glide(W * 0.62, H * 0.82, 0.35);
await still("settings");
await d.hold(0.7);

const m = await d.finish({ viewport: [W, H], dsf: DSF, size: [W * DSF, H * DSF], windowHeights, errors: page.errors });
console.log(`frames: ${m.frames} (${m.duration.toFixed(1)}s @ ${FPS}fps) · ${W * DSF}x${H * DSF} · popup errors: ${page.errors.length}`);
console.log(Object.entries(m.marks).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(" · "));
if (page.errors.length) console.log(page.errors.slice(0, 5).join("\n"));
await chrome.close();
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
process.exit(0);
