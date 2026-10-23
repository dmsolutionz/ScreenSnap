#!/usr/bin/env node
// Films the real video editor. Loads a demo recording into the extension's editor (headless Chrome, this repo
// loaded unpacked) and plays a slow, scripted editing session — scrub, zoom the timeline, trim, split + delete,
// undo, marker, zoom block, crop with handles, annotate, mute a region, backdrop, a REAL export — as numbered PNG frames at 2x pixel
// density plus a manifest.json of timed marks and clicks the film compositor syncs captions and sounds to.
//
//   node scripts/media/capture-editor.mjs --source demo-source.mp4 --events events.json --out DIR
//        [--width 1440 --height 900 --dsf 2 --fps 30] [--speech vo-cues.json] [--only scrub,crop]
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
// --speech: the voiceover's durations per caption (narrate.mjs output), so steps wait for their narration
const speech = argv.speech && existsSync(argv.speech) ? Object.fromEntries(JSON.parse(readFileSync(argv.speech, "utf8")).map((c) => [c.text, c.dur * (c.pace || 1)])) : null;
const d = createDirector(page, { fps: FPS, outDir: OUT, start: [W * 0.62, H * 0.42], speech });
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

// ── segments ── Every step is slow on purpose: the cursor travels to the control, pauses so the viewer can see
// where it is, acts, then the result holds on screen. Each step says what it does (d.say → the film's captions).
const open = seg("open", async () => {
  await d.say("This is the screensnap video editor.");
  await d.hold(2.6);
  await d.say("Your recording is the clip on the timeline.");
  const v = await R(".ss-tl-vtime");
  await d.glide(v.l + v.w * 0.35, v.cy, 1.4);
  await d.hold(2.0);
});

const scrub = seg("scrub", async () => {
  await d.say("Drag the playhead to find a moment.");
  const flag = await R(".ss-tl-ph-grab");
  await d.glide(flag.cx, flag.cy, 1.2); await d.hold(0.6);
  await d.drag([[flag.cx, flag.cy], [await secX(4.0), flag.cy], [await secX(E.peakT), flag.cy]], 3.2);
  await d.hold(1.6);
  await d.say("Drag the ends of this bar to zoom the timeline.");
  const h = await R('.ss-tl-nav-h[data-edge="out"]');
  await d.glide(h.cx, h.cy, 1.3); await d.hold(0.6);
  await d.drag([[h.cx, h.cy], [h.cx - (await R(".ss-tl-ntime")).w * 0.6, h.cy]], 2.0);
  await d.hold(1.6);
  const th = await R(".ss-tl-nav-thumb");
  await d.drag([[th.cx, th.cy], [th.cx + 160, th.cy]], 1.6);
  await d.hold(1.2);
  await d.say("Fit brings the whole clip back.");
  await moveTo(".ss-tl-zfit", 1.0); await d.hold(0.4); await d.click({ settle: 0.3 });
  await d.hold(1.4);
});

const trim = seg("trim", async () => {
  await d.say("Drag the green handles to trim the start and the end.");
  const out = await R(".ss-tl-handle-out");
  await d.glide(out.cx, out.cy, 1.2); await d.hold(0.6);
  await d.drag([[out.cx, out.cy], [await secX(22.8), out.cy]], 2.0);
  await d.hold(1.2);
  const inn = await R(".ss-tl-handle-in");
  await d.glide(inn.cx, inn.cy, 1.4); await d.hold(0.5);
  await d.drag([[inn.cx, inn.cy], [await secX(0.6), inn.cy]], 1.6);
  await d.hold(1.4);
  await d.still("trim");
});

// The loading spinner in the recording is dead air: split around it, select it, delete it. The split points sit
// just inside the spinner's window and clear of whole seconds (a ruler click would snap onto those).
const cut = seg("cut", async () => {
  const r = await R(".ss-tl-rtime"), A = E.dead[0] + 0.3, B = E.dead[1] + 0.2;
  await d.say("Put the playhead where the boring part starts…");
  await d.glide(await secX(A), r.cy, 1.4); await d.hold(0.4); await d.click({ settle: 0.4 });
  await d.hold(0.8);
  await d.say("…and press S to split the clip there.", "S");
  await d.key("s"); await d.hold(1.6);
  await d.say("Split again where it ends.", "S");
  await d.glide(await secX(B), r.cy, 1.2); await d.hold(0.3); await d.click({ settle: 0.4 });
  await d.key("s"); await d.hold(1.6);
  const v = await R(".ss-tl-vtime");
  await d.say("Click the piece you don't want.");
  await d.glide(await secX((A + B) / 2), v.cy + 8, 1.4); await d.hold(0.4); await d.click({ settle: 0.4 });
  await d.hold(1.4);
  await d.say("Press Delete, and the rest closes up.", "⌫");
  await d.key("Backspace"); await d.hold(2.4);
});

const undo = seg("undo", async () => {
  await d.say("Every edit can be undone…", "⌘Z");
  await d.key("z", { meta: true }); await d.hold(1.8);
  await d.say("…and redone.", "⇧⌘Z");
  await d.key("z", { meta: true, shift: true }); await d.hold(1.8);
});

const zoom = seg("zoom", async () => {
  const r = await R(".ss-tl-rtime");
  await d.say("Press M to drop a marker at a moment you want to find again.", "M");
  await d.glide(await secX(E.peakT), r.cy, 1.4); await d.hold(0.3); await d.click({ settle: 0.3 });
  await d.key("m"); await d.hold(1.8);
  await d.say("Add a zoom at the playhead.", "Z");
  await moveTo("#ss-zoom-add", 1.2); await d.hold(0.4); await d.click({ settle: 0.4 });
  await d.hold(1.4);
  await d.say("Drag the box onto what matters.");
  const box = await R(".ss-zfocus");
  const [px, py] = await toClient(E.peak.x, E.peak.y);
  await d.glide(box.cx, box.cy, 1.0); await d.hold(0.3);
  await d.drag([[box.cx, box.cy], [px, py]], 2.0);
  await d.hold(1.0);
  await d.say("Pull its corner to zoom closer or wider.");
  const handle = await R(".ss-zfocus-handle");
  await d.glide(handle.cx, handle.cy, 0.9); await d.hold(0.3);
  await d.drag([[handle.cx, handle.cy], [handle.cx + 40, handle.cy + 14]], 1.4);
  await d.hold(1.2);
  await d.say("Stretch the zoom on the timeline to make it last longer.");
  const blk = await R(".ss-tl-zblock");
  await d.glide(blk.r - 2, blk.cy, 1.1); await d.hold(0.3);
  await d.drag([[blk.r - 2, blk.cy], [await secX(E.peakT + 3.2), blk.cy]], 1.6);
  await d.hold(1.0);
  await d.still("zoom");
  await d.say("Scrub through it: the zoom eases in and out.");
  const flag = await R(".ss-tl-ph-grab");
  await d.glide(flag.cx, flag.cy, 1.0); await d.hold(0.3);
  await d.drag([[flag.cx, flag.cy], [await secX(E.peakT + 2.4), flag.cy], [await secX(E.peakT + 5.2), flag.cy]], 3.6);
  await d.hold(1.2);
});

const crop = seg("crop", async () => {
  await d.say("Crop shows the whole frame with a box you can grab.", "C");
  await moveTo("#ss-crop-btn", 1.2); await d.hold(0.3); await d.click({ settle: 0.3 });
  await d.hold(2.0);
  const k = await scale();
  await d.say("Pull the left edge past the sidebar…");
  const L = await R('.ss-crop-h[data-h="-1,0"]');
  await d.glide(L.cx, L.cy, 1.2); await d.hold(0.4);
  await d.drag([[L.cx, L.cy], [L.cx + (E.kpi.x - 36) * k, L.cy]], 1.8);
  await d.hold(0.8);
  await d.say("…and the top edge below the header.");
  const T = await R('.ss-crop-h[data-h="0,-1"]');
  await d.glide(T.cx, T.cy, 1.1); await d.hold(0.4);
  await d.drag([[T.cx, T.cy], [T.cx, T.cy + (E.kpi.y - 36) * k]], 1.5);
  await d.hold(1.0);
  await d.say("Pick a ratio and the box keeps that shape.");
  await moveTo('.ss-crop-preset[data-ratio="16:9"]', 1.2); await d.hold(0.4); await d.click({ settle: 0.4 });
  await d.hold(1.4);
  await d.say("Drag inside the box to move it.");
  const f = await R(".ss-crop-frame");
  await d.glide(f.cx, f.cy, 1.1); await d.hold(0.3);
  await d.drag([[f.cx, f.cy], [f.cx - 18, f.cy + 8]], 1.2);
  await d.hold(1.0);
  const c = await R("#ss-canvas"), fr = await R(".ss-crop-frame");
  view = { x: ((fr.l - c.l) / c.w) * E.srcW, y: ((fr.t - c.t) / c.h) * E.srcH, w: (fr.w / c.w) * E.srcW, h: (fr.h / c.h) * E.srcH };
  await d.still("crop-box");
  await d.say("Press Enter to apply.", "↵");
  await d.key("Enter");
  await d.hold(2.2);
});

const annotate = seg("annotate", async () => {
  const [dx, dy] = await toClient(E.delta.x + E.delta.w / 2, E.delta.y + E.delta.h / 2);
  const k = await scale();
  await d.say("Draw an arrow…", "A");
  await d.key("a"); await d.hold(0.6);
  await d.glide(dx + 150 * k, dy + 120 * k, 1.0); await d.hold(0.3);
  await d.drag([[dx + 150 * k, dy + 120 * k], [dx + 14 * k, dy + 10 * k]], 1.6);
  await d.hold(1.0);
  await d.say("…and a box around what matters.", "R");
  await d.key("r"); await d.hold(0.5);
  const [bx, by] = await toClient(E.delta.x - 12, E.delta.y - 10);
  await d.glide(bx, by, 1.0); await d.hold(0.3);
  await d.drag([[bx, by], [bx + (E.delta.w + 24) * k, by + (E.delta.h + 20) * k]], 1.4);
  await d.hold(1.2);
  await d.say("Each one gets a track: drag its end to choose when it disappears.");
  const lb = await R(".ss-tl-lblock.on, .ss-tl-lblock");
  await d.glide(lb.r - 2, lb.cy, 1.3); await d.hold(0.4);
  await d.drag([[lb.r - 2, lb.cy], [await secX(14), lb.cy]], 1.8);
  await d.hold(1.6);
  await d.key("Escape");
  await d.still("annotated");
});

const audio = seg("audio", async () => {
  await d.say("Drag across the audio to mute a stretch, without cutting the picture.");
  const a = await R(".ss-tl-atime");
  await d.glide(await secX(20.8), a.cy, 1.3); await d.hold(0.4);
  await d.drag([[await secX(20.8), a.cy], [await secX(23.0), a.cy]], 1.6);
  await d.hold(2.0);
});

const backdrop = seg("backdrop", async () => {
  await d.say("Wrap it in a backdrop.");
  await clickOn("#ss-backdrop-pop", 1.1);
  await d.hold(0.8);
  await clickOn("#ss-bd-on", 0.9);
  await d.hold(0.4);
  await page.evaluate(`(() => { const s = document.getElementById('ss-bd-bg'); s.value = 'grad-violet'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await d.hold(1.8);
  await d.glide(W * 0.5, H * 0.5, 0.8); await d.click({ settle: 0.2 }); // click away to close the popover
  await d.hold(1.4);
  await d.still("backdrop");
});

const exportIt = seg("export", async () => {
  // headless has no save dialog: stand in for chrome.downloads so the real export runs to the end
  await page.evaluate(`(() => { try { chrome.downloads.download = (o, cb) => { cb(1); }; const add = chrome.downloads.onChanged.addListener.bind(chrome.downloads.onChanged); chrome.downloads.onChanged.addListener = (fn) => { setTimeout(() => fn({ id: 1, state: { current: 'complete' } }), 50); add(fn); }; } catch (e) { console.warn('downloads stub', e); } })()`);
  await d.say("Export as MP4 or GIF, or share it from your own Drive.");
  await clickOn("#ss-export-caret", 1.2); await d.hold(2.2); await d.still("export-menu");
  await d.glide(W * 0.5, H * 0.45, 0.8); await d.click({ settle: 0.2 }); // close the menu
  await d.hold(0.4);
  await d.say("Export: every frame is encoded on your device.");
  await clickOn("#ss-export", 1.1);
  d.mark("exporting");
  const ok = await d.fastForward(`document.getElementById('ss-export').textContent.includes('Saved')`, { maxSec: 90, holdSec: 0.22 });
  d.mark("saved");
  if (!ok) console.warn("export did not report Saved within the time limit");
  await d.hold(2.6);
});

const t0 = Date.now();
for (const s of [open, scrub, trim, cut, undo, zoom, crop, annotate, audio, backdrop, exportIt]) { await s(); console.log(`  ${d.t().toFixed(1)}s video · ${((Date.now() - t0) / 1000).toFixed(0)}s wall`); }
const m = await d.finish({ viewport: [W, H], dsf: DSF, errors: page.errors });
console.log(`frames: ${m.frames} (${m.duration.toFixed(1)}s @ ${FPS}fps) · editor errors: ${page.errors.length}`);
if (page.errors.length) console.log(page.errors.slice(0, 5).join("\n"));
await ed.close();
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
process.exit(0);
