#!/usr/bin/env node
// Films the real video editor. Loads a demo recording into the extension's editor (headless Chrome, this repo
// loaded unpacked) and plays a scripted editing session — scrub, zoom the timeline, trim, cut, zoom block,
// crop with handles, annotate, mute a region, backdrop, a REAL export — as numbered PNG frames at 2x pixel
// density plus a manifest.json of timed marks and clicks the film compositor syncs captions and sounds to.
//
//   node scripts/media/capture-editor.mjs --source demo-source.mp4 --events events.json --out DIR
//        [--width 1440 --height 900 --dsf 2 --fps 30] [--only scrub,crop]   (--only = debugging a segment)
import { readFileSync, existsSync } from "node:fs";
import { openEditor } from "./lib/editor-session.mjs";
import { createDirector } from "./lib/director.mjs";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : a), []));
const OUT = argv.out, SOURCE = argv.source;
if (!OUT || !SOURCE) { console.error("usage: capture-editor.mjs --source clip.mp4 --out dir [--events events.json]"); process.exit(2); }
const W = Number(argv.width || 1440), H = Number(argv.height || 900), DSF = Number(argv.dsf || 2), FPS = Number(argv.fps || 30);
const only = argv.only ? new Set(argv.only.split(",")) : null;

// Facts about the demo recording (a 1920x1080 dashboard): where things are and when. Defaults suit any clip.
const E = { dur: 24, dead: [15.0, 17.4], peakT: 7.2, peak: { x: 1180, y: 600 }, kpi: { x: 300, y: 200, w: 380, h: 170 }, delta: { x: 560, y: 250, w: 110, h: 34 }, srcW: 1920, srcH: 1080 };
if (argv.events && existsSync(argv.events)) {
  const j = JSON.parse(readFileSync(argv.events, "utf8")); // the demo-source renderer's events.json
  Object.assign(E, {
    dur: j.video.duration, srcW: j.video.width, srcH: j.video.height,
    dead: [j.deadStretch.start, j.deadStretch.end],
    peak: j.peak.centre, peakT: (j.clicks.find((c) => c.target === "peak") || { t: 7.2 }).t + 0.05,
    kpi: j.boxes.revenueCard, delta: j.boxes.deltaPill,
  });
}

const tStart = Date.now();
const ed = await openEditor({ source: SOURCE, width: W, height: H, dsf: DSF });
console.log(`editor open in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
const { page } = ed;
const d = createDirector(page, { fps: FPS, outDir: OUT, start: [W * 0.62, H * 0.42] });
await d.install();

// ── helpers ──
const R = async (sel) => {
  const r = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  if (!r) throw new Error("no element: " + sel);
  return { ...r, cx: r.l + r.w / 2, cy: r.t + r.h / 2, r: r.l + r.w, b: r.t + r.h };
};
const secX = async (s) => { const r = await R(".ss-tl-rtime"); return r.l + (s / E.dur) * r.w; };
let view = { x: 0, y: 0, w: E.srcW, h: E.srcH }; // the part of the source the stage currently shows (changes with crop)
const toClient = async (sx, sy) => { const c = await R("#ss-canvas"); return [c.l + ((sx - view.x) / view.w) * c.w, c.t + ((sy - view.y) / view.h) * c.h]; };
const scale = async () => (await R("#ss-canvas")).w / view.w; // source px -> client px
const moveTo = async (sel, sec = 0.6) => { const r = await R(sel); await d.glide(r.cx, r.cy, sec); return r; };
const clickOn = async (sel, sec = 0.6) => { const r = await moveTo(sel, sec); await d.click(); return r; };
const seg = (name, fn) => async () => { if (only && !only.has(name)) return; d.mark(name); await fn(); };
const gone = (name) => `!document.querySelector(${JSON.stringify(name)})`;

// ── segments ──
const open = seg("open", async () => { await d.hold(1.4); });

// Scrub the playhead by its flag; then zoom the timeline with the navigator and fit again.
const scrub = seg("scrub", async () => {
  const flag = await R(".ss-tl-ph-grab");
  await d.drag([[flag.cx, flag.cy], [await secX(5.0), flag.cy], [await secX(9.4), flag.cy]], 1.7);
  await d.hold(0.2);
  const h = await R('.ss-tl-nav-h[data-edge="out"]');
  await d.drag([[h.cx, h.cy], [h.cx - (await R(".ss-tl-ntime")).w * 0.62, h.cy]], 0.9);
  await d.hold(0.5);
  const th = await R(".ss-tl-nav-thumb");
  await d.drag([[th.cx, th.cy], [th.cx + 170, th.cy]], 0.7);
  await d.hold(0.3);
  await clickOn(".ss-tl-zfit", 0.4);
  await d.hold(0.2);
});

const trim = seg("trim", async () => {
  const out = await R(".ss-tl-handle-out");
  await d.drag([[out.cx, out.cy], [await secX(22.8), out.cy]], 0.7);
  const inn = await R(".ss-tl-handle-in");
  await d.drag([[inn.cx, inn.cy], [await secX(0.6), inn.cy]], 0.6);
  await d.hold(0.6);
  await d.still("trim");
});

const cut = seg("cut", async () => {
  await moveTo("#ss-cut-btn", 0.45); await d.click({ settle: 0.2 });
  const v = await R(".ss-tl-vtime");
  await d.drag([[await secX(E.dead[0]), v.cy], [await secX(E.dead[1]), v.cy]], 0.9);
  await d.hold(0.2);
  await d.key("x"); // leave cut mode
  await d.hold(0.5);
});

const zoom = seg("zoom", async () => {
  const r = await R(".ss-tl-rtime");
  await d.glide(await secX(E.peakT), r.cy, 0.5); await d.click({ settle: 0.1 });
  await moveTo("#ss-zoom-add", 0.45); await d.click({ settle: 0.2 });
  await d.hold(0.4);
  // aim the focus box at the chart peak, then pull its corner to change the magnification
  const box = await R(".ss-zfocus");
  const [px, py] = await toClient(E.peak.x, E.peak.y);
  await d.drag([[box.cx, box.cy], [px, py]], 0.8);
  const handle = await R(".ss-zfocus-handle");
  await d.drag([[handle.cx, handle.cy], [handle.cx + 40, handle.cy + 14]], 0.6);
  await d.hold(0.4);
  // stretch the zoom block in the timeline, then scrub through it
  const blk = await R(".ss-tl-zblock");
  await d.drag([[blk.r - 2, blk.cy], [await secX(E.peakT + 3.2), blk.cy]], 0.7);
  const flag = await R(".ss-tl-ph-grab");
  // scrub through the zoom (it eases in and out) and on past it, so what follows is framed at 1x
  await d.drag([[flag.cx, flag.cy], [await secX(E.peakT + 2.4), flag.cy], [await secX(E.peakT + 5.2), flag.cy]], 1.5);
  await d.hold(0.3);
  await d.still("zoom");
});

const crop = seg("crop", async () => {
  await moveTo("#ss-crop-btn", 0.45); await d.click({ settle: 0.2 });
  await d.hold(0.6);
  const k = await scale();
  // pull the left edge in past the sidebar, the top edge down past the header
  const L = await R('.ss-crop-h[data-h="-1,0"]');
  await d.drag([[L.cx, L.cy], [L.cx + (E.kpi.x - 36) * k, L.cy]], 0.8);
  const T = await R('.ss-crop-h[data-h="0,-1"]');
  await d.drag([[T.cx, T.cy], [T.cx, T.cy + (E.kpi.y - 36) * k]], 0.6);
  await d.hold(0.2);
  // ratio chip: the box refits and keeps its shape from here on
  await clickOn('.ss-crop-preset[data-ratio="16:9"]', 0.5);
  await d.hold(0.3);
  // nudge it by hand
  const f = await R(".ss-crop-frame");
  await d.drag([[f.cx, f.cy], [f.cx - 18, f.cy + 8]], 0.5);
  await d.hold(0.3);
  // remember what the box covers so later annotations land on the right pixels
  const c = await R("#ss-canvas"), fr = await R(".ss-crop-frame");
  view = { x: ((fr.l - c.l) / c.w) * E.srcW, y: ((fr.t - c.t) / c.h) * E.srcH, w: (fr.w / c.w) * E.srcW, h: (fr.h / c.h) * E.srcH };
  await d.still("crop-box");
  await d.key("Enter");
  await d.hold(0.7);
});

const annotate = seg("annotate", async () => {
  const [dx, dy] = await toClient(E.delta.x + E.delta.w / 2, E.delta.y + E.delta.h / 2);
  const k = await scale();
  // an arrow that points at the delta pill
  await d.key("a");
  await d.drag([[dx + 150 * k, dy + 120 * k], [dx + 14 * k, dy + 10 * k]], 0.7);
  await d.hold(0.3);
  // a box around it
  await d.key("r");
  const [bx, by] = await toClient(E.delta.x - 12, E.delta.y - 10);
  await d.drag([[bx, by], [bx + (E.delta.w + 24) * k, by + (E.delta.h + 20) * k]], 0.6);
  await d.hold(0.3);
  // time-scope the box: drag its right edge in on the timeline
  const lb = await R(".ss-tl-lblock.on, .ss-tl-lblock");
  await d.drag([[lb.r - 2, lb.cy], [await secX(14), lb.cy]], 0.7);
  await d.hold(0.4);
  await d.key("Escape");
  await d.still("annotated");
});

const audio = seg("audio", async () => {
  const a = await R(".ss-tl-atime");
  await d.drag([[await secX(20.8), a.cy], [await secX(23.0), a.cy]], 0.8);
  await d.hold(1.3);
});

const backdrop = seg("backdrop", async () => {
  await clickOn("#ss-backdrop-pop", 0.5);
  await d.hold(0.2);
  await clickOn("#ss-bd-on", 0.4);
  await d.hold(0.2);
  await page.evaluate(`(() => { const s = document.getElementById('ss-bd-bg'); s.value = 'grad-violet'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await d.hold(0.6);
  await d.glide(W * 0.5, H * 0.5, 0.35); await d.click({ settle: 0.1 }); // click away to close the popover
  await d.hold(0.4);
  await d.still("backdrop");
});

const exportIt = seg("export", async () => {
  // headless has no save dialog: stand in for chrome.downloads so the real export runs to the end
  await page.evaluate(`(() => { try { chrome.downloads.download = (o, cb) => { cb(1); }; const add = chrome.downloads.onChanged.addListener.bind(chrome.downloads.onChanged); chrome.downloads.onChanged.addListener = (fn) => { setTimeout(() => fn({ id: 1, state: { current: 'complete' } }), 50); add(fn); }; } catch (e) { console.warn('downloads stub', e); } })()`);
  await clickOn("#ss-export-caret", 0.5); await d.hold(0.3); await d.still("export-menu");
  await d.glide(W * 0.5, H * 0.45, 0.3); await d.click({ settle: 0.1 }); // close the menu
  await clickOn("#ss-export", 0.55);
  await d.mark("exporting");
  const ok = await d.fastForward(`document.getElementById('ss-export').textContent.includes('Saved')`, { maxSec: 90 });
  d.mark("saved");
  if (!ok) console.warn("export did not report Saved within the time limit");
  await d.hold(1.8);
});

const t0 = Date.now();
for (const s of [open, scrub, trim, cut, zoom, crop, annotate, audio, backdrop, exportIt]) { await s(); console.log(`  ${d.t().toFixed(1)}s video · ${((Date.now() - t0) / 1000).toFixed(0)}s wall`); }
const m = await d.finish({ viewport: [W, H], dsf: DSF, errors: page.errors });
console.log(`frames: ${m.frames} (${m.duration.toFixed(1)}s @ ${FPS}fps) · editor errors: ${page.errors.length}`);
if (page.errors.length) console.log(page.errors.slice(0, 5).join("\n"));
await ed.close();
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
process.exit(0);
