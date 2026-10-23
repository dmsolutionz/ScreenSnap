#!/usr/bin/env node
// Renders the launch film (scripts/media/film/) to numbered PNG frames: a small pool of headless Chrome
// instances each loads the page, then for every assigned frame calls window.__render(t) and screenshots the
// stage at 2x (3840x2160 from the 1920x1080 layout). Frame t = n / fps, so the result is exact regardless of
// how long any one capture takes.
//
//   node scripts/media/render-film.mjs --work <media-work dir> --out <dir> [--dsf 2] [--fps 30] [--workers 6]
//        [--from 0 --to 88]            seconds range to render
//        [--at 2.0,12.5,30]            stills only (design review) → <out>/still-<t>.png
//        [--captions]                  also write <out>/captions.srt
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { launchChrome } from "./lib/chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : a), []));
const WORK = resolve(argv.work || ""), OUT = resolve(argv.out || "");
if (!argv.work || !argv.out) { console.error("usage: render-film.mjs --work <media-work> --out <dir> [--at t,t] [--from s --to s]"); process.exit(2); }
const DSF = Number(argv.dsf || 2), FPS = Number(argv.fps || 30), WORKERS = Number(argv.workers || 6);
const FROM = Number(argv.from || 0), TO = Number(argv.to || 88);

const ROOTS = { "/film/": join(HERE, "film"), "/work/": WORK, "/fonts/": join(REPO, "src", "popup", "fonts"), "/site/": join(REPO, "docs") };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const root = Object.keys(ROOTS).find((r) => url.startsWith(r));
  const file = root && join(ROOTS[root], url.slice(root.length));
  if (!file || !file.startsWith(ROOTS[root]) || !existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("Content-Type", MIME[extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "max-age=3600");
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${server.address().port}/film/film.html`;

mkdirSync(OUT, { recursive: true });
const pad = (n) => String(n).padStart(6, "0");

async function worker(jobs, label) {
  const chrome = await launchChrome();
  try {
    const page = await chrome.newPage(PAGE, { width: 1920, height: 1080, dsf: DSF });
    for (let i = 0; i < 400 && !(await page.evaluate("window.__ready === true").catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
    if (!(await page.evaluate("window.__ready === true"))) throw new Error(`film page never became ready\n${page.errors.join("\n")}`);
    for (const job of jobs) {
      await page.evaluate(`__render(${job.t})`, true);
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
      writeFileSync(job.file, png);
      job.done?.();
    }
    if (page.errors.length) console.warn(`[${label}] page errors:\n  ${[...new Set(page.errors)].slice(0, 5).join("\n  ")}`);
    return page;
  } finally { await chrome.close(); }
}

if (argv.at) {
  const ts = argv.at.split(",").map(Number);
  await worker(ts.map((t) => ({ t, file: join(OUT, `still-${String(t).replace(".", "_")}.png`) })), "stills");
  console.log(`wrote ${ts.length} stills to ${OUT}`);
} else {
  mkdirSync(join(OUT, "frames"), { recursive: true });
  const first = Math.round(FROM * FPS), last = Math.min(Math.round(TO * FPS), Math.round(88 * FPS)) - 1;
  const total = last - first + 1;
  const per = Math.ceil(total / WORKERS);
  let done = 0; const t0 = Date.now();
  const tick = setInterval(() => { const r = done / ((Date.now() - t0) / 1000); process.stdout.write(`\r  ${done}/${total} frames · ${r.toFixed(1)} fps · eta ${(((total - done) / Math.max(r, 0.01)) / 60).toFixed(1)} min   `); }, 3000);
  const jobsFor = (w) => Array.from({ length: Math.max(0, Math.min(per, total - w * per)) }, (_, k) => { const n = first + w * per + k; return { t: n / FPS, file: join(OUT, "frames", `${pad(n)}.png`), done: () => done++ }; });
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(jobsFor(w), `w${w}`)));
  clearInterval(tick);
  console.log(`\nrendered ${total} frames in ${((Date.now() - t0) / 60000).toFixed(1)} min → ${OUT}/frames`);
}

if (argv.captions) {
  const chrome = await launchChrome();
  const page = await chrome.newPage(PAGE, { width: 1920, height: 1080, dsf: 1 });
  for (let i = 0; i < 200 && !(await page.evaluate("window.__ready === true").catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
  const caps = await page.evaluate("window.__captions()");
  const ts = (s) => { const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
  const srt = caps.map((c, i) => `${i + 1}\n${ts(c.t0)} --> ${ts(c.t1)}\n${c.text.replace(/\*/g, "")}\n`).join("\n");
  writeFileSync(join(OUT, "captions.srt"), srt);
  writeFileSync(join(OUT, "sfx-cues.json"), JSON.stringify(await page.evaluate("window.__sfx()"), null, 1));
  await chrome.close();
  console.log(`wrote ${caps.length} captions → ${OUT}/captions.srt + sfx-cues.json`);
}
server.close();
process.exit(0);
