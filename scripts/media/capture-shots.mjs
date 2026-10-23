#!/usr/bin/env node
// Films the REAL screenshot (annotation) editor annotating a real-looking page. The editor is a content script,
// so it is injected exactly as the service worker does (the ordered file list is parsed from service-worker.js)
// into a blank page whose `chrome.runtime.sendMessage` is stubbed to hand it the "captured" screenshot: a clean
// 1920x1080 frame of the Pulse demo dashboard (rendered from scripts/media/demo-source/index.html at t = 23.5 s with
// the cursor and hover states removed; or pass --source with any 1920x1080 PNG).
//
// A scripted ~15 s session is filmed as numbered PNG frames at 2x (1440x900 viewport -> 2880x1800) plus
// manifest.json (marks, clicks, size) for the film compositor, and clean cursor-less 2x stills of the best states:
//   arrow  ->  steps (1, 2, 3)  ->  spotlight (+ dim slider)  ->  text label  ->  crop (pull a corner)  ->  done
//   (backdrop on the cropped, annotated result)
//
//   node scripts/media/capture-shots.mjs --out DIR [--fps 30] [--pace 1.6] [--time 23.5] [--source frame.png]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome } from "./lib/chrome.mjs";
import { createDirector } from "./lib/director.mjs";
import { REPO } from "./lib/editor-session.mjs";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : a), []));
if (!argv.out) { console.error("usage: capture-shots.mjs --out DIR [--fps 30] [--time 23.5] [--source frame.png]"); process.exit(2); }
const OUT = resolve(argv.out);
const W = 1440, H = 900, DSF = 2, FPS = Number(argv.fps || 30), SRC_T = Number(argv.time || 23.5);
const HERE = dirname(fileURLToPath(import.meta.url));
rmSync(join(OUT, "frames"), { recursive: true, force: true });
rmSync(join(OUT, "stills"), { recursive: true, force: true });
mkdirSync(join(OUT, "stills"), { recursive: true });

const tStart = Date.now();
const chrome = await launchChrome();

// ── 1. the "captured" screenshot ─────────────────────────────────────────────────────────────────
// Render the Pulse dashboard at its calm end state, minus the synthetic cursor / hover highlights, so the
// capture looks like what captureVisibleTab really returns (it never includes the pointer).
async function renderSource() {
  const demo = join(HERE, "demo-source");
  const fonts = resolve(HERE, "../../src/popup/fonts");
  const types = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2" };
  const srv = createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = p === "/" ? join(demo, "index.html") : p.startsWith("/fonts/") ? join(fonts, p.slice(7).replace(/[^\w.-]/g, "")) : null;
    if (!file || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  let targetId;
  try {
    ({ targetId } = await chrome.cmd("Target.createTarget", { url: `http://127.0.0.1:${srv.address().port}/` }));
    const pg = await chrome.attach(targetId, { width: 1920, height: 1080, dsf: 1 });
    for (let i = 0; i < 100; i++) { try { if (await pg.evaluate("typeof window.__ready")) break; } catch {} await sleep(100); }
    await pg.evaluate("window.__ready", true);
    await pg.evaluate(`(async () => {
      window.__render(${SRC_T});
      for (const e of document.querySelectorAll('[style*="--h"]')) e.style.setProperty('--h', '0');
      for (const id of ['cursor', 'ripple']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`, true);
    await sleep(250);
    return await pg.screenshot();
  } finally {
    if (targetId) await chrome.cmd("Target.closeTarget", { targetId }).catch(() => {});
    srv.close();
  }
}
let png;
if (argv.source) png = readFileSync(argv.source);
else png = await renderSource();
writeFileSync(join(OUT, "source.png"), png);
const dataUrl = "data:image/png;base64," + png.toString("base64");

// ── 2. the editor, injected as the service worker does ────────────────────────────────────────────
const page = await chrome.newPage("about:blank", { width: W, height: H, dsf: DSF });
await sleep(300);
const swSrc = readFileSync(join(REPO, "src/background/service-worker.js"), "utf8");
const files = [...((swSrc.match(/files: \[([^\]]*editor-overlay\.js[^\]]*)\]/) || [])[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!files.length) throw new Error("annotation editor file list not found in service-worker.js");
await page.evaluate(`(() => {
  document.body.style.cssText = 'margin:0;background:#fff';
  const url = ${JSON.stringify(dataUrl)};
  window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { if (m && m.type === 'editor-get-image') cb({ ok: true, dataUrl: url, filename: 'screensnap/screenshot-2026-10-23_09-41-12.png' }); else if (cb) cb({}); } } };
})()`);
for (const f of files) await page.evaluate(readFileSync(join(REPO, f), "utf8"));
for (let i = 0; i < 80; i++) { if (await page.evaluate("!!(window.__screensnapEditor && window.__screensnapEditor.canvas && window.__screensnapEditor.canvas.width > 100)").catch(() => false)) break; await sleep(100); }
await sleep(500);
console.log(`editor open in ${((Date.now() - tStart) / 1000).toFixed(1)}s · image ${await page.evaluate("window.__screensnapEditor.iw + 'x' + window.__screensnapEditor.ih")} · scale ${(await page.evaluate("window.__screensnapEditor.scale")).toFixed(3)}`);

const d = createDirector(page, { fps: FPS, outDir: OUT, start: [W * 0.52, H * 0.5], pace: Number(argv.pace || 1) });
await d.install();

// ── helpers ──
const SR = `document.getElementById('__screensnap_editor').shadowRoot`;
const R = async (sel) => { // viewport rect of an element inside the editor's shadow root
  const r = await page.evaluate(`(() => { const e = ${SR}.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  if (!r) throw new Error("no element: " + sel);
  return { ...r, cx: r.l + r.w / 2, cy: r.t + r.h / 2, r: r.l + r.w, b: r.t + r.h };
};
// source-image px -> viewport px (the inverse of the editor's own toImg: canvas rect, backdrop padding, crop origin)
const P = (sx, sy) => page.evaluate(`(() => { const e = window.__screensnapEditor, r = e.canvas.getBoundingClientRect(), pad = e.bdPadPx();
  return [r.left + ((${sx} - e.cropOx() + pad) / e.fullW()) * r.width, r.top + ((${sy} - e.cropOy() + pad) / e.fullH()) * r.height]; })()`);
const E = (expr) => page.evaluate(`(() => { const e = window.__screensnapEditor; return ${expr}; })()`);
const moveTo = async (sel, sec = 0.5) => { const r = await R(sel); await d.glide(r.cx, r.cy, sec); return r; };
const clickOn = async (sel, sec = 0.5, settle = 0.2) => { const r = await moveTo(sel, sec); await d.click({ settle }); return r; };
const deselect = async () => { if (await E("e.selected != null")) await d.key("Escape"); }; // (Esc with nothing selected would close the editor)
const tool = (id) => `[data-tool="${id}"]`;
// A clean still of the current state: cursor hidden, no stray hover.
async function still(name) {
  await sleep(200);
  await page.evaluate(`document.getElementById('__cur').style.visibility = 'hidden'`);
  writeFileSync(join(OUT, "stills", name + ".png"), await page.screenshot());
  await page.evaluate(`document.getElementById('__cur').style.visibility = ''`);
}

// Annotation geometry in SOURCE px (the Pulse dashboard, 1920x1080).
const G = {
  delta: { x: 321, y: 221, w: 83, h: 26 },          // Revenue card's "+40.2%" pill
  kpi: { x: 296, y: 108, w: 380, h: 160 },
  chart: { x: 296, y: 292, w: 1008, h: 372 },
  regions: { x: 1328, y: 292, w: 560, h: 372 },
  peak: { x: 1165, y: 457 },
};

// ── segments ──
// 0. the editor has just opened
d.mark("open");
await d.hold(0.6);

// 1. arrow: pick it from the tool rail, draw from open space to the delta pill
d.mark("arrow");
await clickOn(tool("arrow"), 0.45, 0.12);
{
  const from = await P(G.delta.x + G.delta.w + 156, G.delta.y + G.delta.h + 78), to = await P(G.delta.x + G.delta.w + 8, G.delta.y + G.delta.h / 2 + 6);
  await d.drag([from, to], 0.6);
}
await d.hold(0.25);
await still("arrow");

// 2. numbered steps: N, pick the small size in the options bar, then three clicks (1 on the KPI card, 2 on the
//    chart peak, 3 on Top regions) - each badge renumbers itself by stacking order
d.mark("steps");
await deselect(); // (a size change would otherwise also restyle the selected arrow)
await d.key("n");
await clickOn('[data-weight="sm"]', 0.4, 0.12);
for (const [sx, sy] of [[G.kpi.x + G.kpi.w / 2, G.kpi.y], [G.peak.x, G.peak.y - 64], [G.regions.x + G.regions.w / 2, G.regions.y]]) {
  const [x, y] = await P(sx, sy);
  await d.glide(x, y, 0.32);
  await d.click({ settle: 0.14 });
}
await d.hold(0.12);
await deselect();
await d.hold(0.12);
await still("steps");

// 3. spotlight: S, drag a rectangle round the chart panel - everything else dims; then deepen the dim from the bar
d.mark("spotlight");
await d.key("s");
{
  const a = await P(G.chart.x - 8, G.chart.y - 8), b = await P(G.chart.x + G.chart.w + 8, G.chart.y + G.chart.h + 8);
  await d.drag([a, b], 0.8);
}
await d.hold(0.2);
{
  const s = await R("#optDim"), at = (f) => s.l + 8 + f * (s.w - 16);
  await d.glide(at(0.533), s.cy, 0.32);
  await d.drag([[at(0.533), s.cy], [at(0.68), s.cy]], 0.4);
}
await d.hold(0.2);
await still("spotlight");

// 4. text: the Text tool, amber from the options bar, click beside the arrow's tail, type a short label, Esc commits
d.mark("text");
await clickOn(tool("text"), 0.4, 0.1);
await deselect(); // (the spotlight is selected: a click inside it with a drawing tool would move it)
await clickOn('[data-color="#f59e0b"]', 0.4, 0.1);
{
  const [x, y] = await P(G.delta.x + G.delta.w + 176, G.delta.y + G.delta.h + 78);
  await d.glide(x, y, 0.45);
}
await d.click({ settle: 0.08 });
await page.evaluate("new Promise((r) => setTimeout(r, 120))", true);
await d.type("Best quarter yet", 0.035);
await d.hold(0.15);
await d.key("Escape"); // commits the text (it stays selected with its handles)
await d.hold(0.25);
await deselect();
await d.hold(0.2);
await still("annotated"); // the finished composition: options bar + layers panel + every mark

// 5. crop: the frame wraps the whole image; pull its bottom-right corner in, dropping the orders table
d.mark("crop");
await clickOn(tool("crop"), 0.45, 0.12);
await d.hold(0.3);
{
  const [cx, cy] = await P(1920, 1080), [tx, ty] = await P(1900, 690);
  await d.drag([[cx - 3, cy - 3], [tx, ty]], 0.8);
}
await d.hold(0.3);
await still("crop");
await d.key("Enter"); // Apply
await d.hold(0.5);

// 6. done: wrap the cropped, annotated result in a backdrop
d.mark("done");
await clickOn("#bdToggle", 0.5, 0.3);
await d.glide(W * 0.62, H * 0.88, 0.35);
await d.hold(0.9);
await still("final");

const m = await d.finish({ viewport: [W, H], dsf: DSF, size: [W * DSF, H * DSF], source: "pulse-dashboard 1920x1080", errors: page.errors });
console.log(`frames: ${m.frames} (${m.duration.toFixed(1)}s @ ${FPS}fps) · ${W * DSF}x${H * DSF} · editor errors: ${page.errors.length}`);
console.log(Object.entries(m.marks).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(" · "));
if (page.errors.length) console.log(page.errors.slice(0, 5).join("\n"));
await chrome.close();
console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
process.exit(0);
