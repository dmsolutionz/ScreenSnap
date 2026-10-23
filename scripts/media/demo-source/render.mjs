#!/usr/bin/env node
// Renders the "Pulse" demo footage: a 1920x1080, 30 fps, exactly 24.000 s fake screen recording of a dark
// analytics dashboard (index.html) with a moving cursor and a narration track.
//
//   node scripts/media/demo-source/render.mjs --out <dir>
//     [--workers 4]        parallel Chrome pages used to screenshot frames
//     [--times 0.5,3.5]    quick look: only screenshot these instants into <dir>/quick/ and exit
//     [--skip-frames]      reuse <dir>/frames from a previous run
//     [--skip-audio]       reuse <dir>/audio from a previous run
//
// Writes <dir>/frames/0001.png.., <dir>/audio/*.wav, <dir>/demo-source.mp4, <dir>/events.json,
// <dir>/preview/*.jpg, <dir>/waveform.png and <dir>/ebur128.txt.
// Zero npm dependencies: Chrome is driven over the DevTools Protocol with Node's built-in WebSocket;
// ffmpeg/ffprobe (and macOS `say`, see audio.mjs) do the rest.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { buildAudio } from "./audio.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS = resolve(HERE, "../../../src/popup/fonts");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const W = 1920, H = 1080, FPS = 30, SECONDS = 24, FRAMES = FPS * SECONDS;
// Decoded frames are limited-range BT.709; JPEG wants full-range, so convert explicitly for stills.
const JPG_VF = "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=yuvj420p";
const PREVIEW_TIMES = [0.5, 3.5, 7.0, 10.0, 13.5, 16.0, 18.0, 22.0, (FRAMES - 1) / FPS];

// ---- args -------------------------------------------------------------------------------------------------
const args = (() => {
  const a = process.argv.slice(2), o = { workers: 4 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--out") o.out = resolve(a[++i]);
    else if (k === "--workers") o.workers = Math.max(1, +a[++i] || 1);
    else if (k === "--times") o.times = a[++i].split(",").map(Number);
    else if (k === "--skip-frames") o.skipFrames = true;
    else if (k === "--skip-audio") o.skipAudio = true;
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  if (!o.out) { console.error("usage: render.mjs --out <dir> [--workers N] [--times t1,t2] [--skip-frames] [--skip-audio]"); process.exit(2); }
  return o;
})();
const log = (...m) => console.log(...m);
const sh = (cmd, a) => { const r = spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${cmd} failed:\n${r.stderr}`); return r.stdout; };

// ---- tiny static server: the page at / and the repo's Geist fonts at /fonts/ ---------------------------------
function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2" };
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = path === "/" ? join(HERE, "index.html") : path.startsWith("/fonts/") ? join(FONTS, path.slice(7).replace(/[^\w.-]/g, "")) : null;
    if (!file || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

// ---- minimal CDP client (flat sessions over the browser websocket) ------------------------------------------
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "pulse-demo-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars",
    "--force-color-profile=srgb", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--window-size=1920,1080", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((ok, no) => {
    let buf = "";
    const timer = setTimeout(() => no(new Error("Chrome did not report a debugging port:\n" + buf)), 20000);
    proc.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); ok(m[1]); } });
    proc.on("exit", (c) => no(new Error(`Chrome exited early (${c}):\n${buf}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("websocket error")); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.no(new Error(m.error.message)) : p.ok(m.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const i = ++id; pending.set(i, { ok, no });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  /** Open a 1920x1080 page on the demo and wait until its fonts are loaded and geometry measured. */
  async function openPage(url) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank", width: W, height: H, newWindow: true });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cmd = (m, p) => send(m, p, sessionId);
    await cmd("Page.enable"); await cmd("Runtime.enable");
    await cmd("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cmd("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cmd("Page.navigate", { url });
    const page = {
      async eval(expression) {
        const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error("page error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      },
      /** Put the page at time t, let two animation frames pass, return a PNG buffer. */
      async shot(t) {
        await page.eval(`(() => { window.__render(${t}); const raf2 = new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return Promise.race([raf2, new Promise((r) => setTimeout(r, 500))]).then(() => true); })()`);
        const { data } = await cmd("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
        return Buffer.from(data, "base64");
      },
    };
    for (let i = 0; i < 100; i++) { try { if (await page.eval("typeof window.__ready")) break; } catch {} await sleep(100); }
    await page.eval("window.__ready");
    return page;
  }
  return { openPage, close: () => { try { ws.close(); } catch {} proc.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} } };
}

// ---- frames -------------------------------------------------------------------------------------------------
async function renderFrames(pages, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".png")) rmSync(join(outDir, f));
  const queue = Array.from({ length: FRAMES }, (_, i) => i);
  let done = 0; const t0 = Date.now(), writes = [];
  await Promise.all(pages.map(async (page) => {
    for (let f; (f = queue.shift()) !== undefined;) {
      const png = await page.shot(f / FPS);
      writes.push(writeFile(join(outDir, String(f + 1).padStart(4, "0") + ".png"), png));
      if (++done % 60 === 0) log(`  frames ${done}/${FRAMES}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }));
  await Promise.all(writes);
}

// ---- facts for the editor scripts ---------------------------------------------------------------------------------
async function collectEvents(page) {
  const meta = await page.eval("window.__meta()");
  const at = (t) => page.eval(`window.__boxes(${t})`);
  // Boxes are read from the DOM at the instant each thing is fully visible / settled.
  const settled = await at(23.9), kpiHover = await at(3.6), tip = await at(8.2), btn = await at(14.9), modal = await at(16.2), toast = await at(19.5);
  const boxes = {
    revenueCard: kpiHover.revenueCard, deltaPill: settled.deltaPill, chartPanel: settled.chartPanel,
    peakPoint: tip.peakPoint, tooltip: tip.tooltip, regionsCard: settled.regionsCard, tableCard: settled.tableCard,
    exportButton: btn.exportButton,
    kpiCards: settled.kpiCards, modal: modal.modal, toast: toast.toast,
  };
  const peakCentre = tip.peakCentre;
  // Scan every frame for when hover-driven things are "on" (value > 0.5): a list of [from, to] spans per target,
  // so scripts know when e.g. a table row is highlighted or the tooltip is up.
  const spans = {}, open = {};
  for (let f = 0; f <= FRAMES; f++) {
    const p = f < FRAMES ? await page.eval(`window.__probe(${f / FPS})`) : {};
    for (const k of new Set([...Object.keys(p), ...Object.keys(open)])) {
      const on = (p[k] ?? 0) > 0.5, t = f / FPS;
      if (on && open[k] === undefined) open[k] = t;
      else if (!on && open[k] !== undefined) { if (t - open[k] > 0.1) (spans[k] ||= []).push([+open[k].toFixed(3), +t.toFixed(3)]); delete open[k]; }
    }
  }
  const cursor = meta.moves.map((m) => ({ moveStart: m.t0, moveEnd: m.t1, x: +m.x.toFixed(1), y: +m.y.toFixed(1) }));
  const clicks = [];
  for (const c of meta.TL.clicks) { const p = await page.eval(`window.__cursor(${c.t})`); clicks.push({ t: c.t, target: c.target, x: +p[0].toFixed(1), y: +p[1].toFixed(1) }); }
  return { meta, boxes, peakCentre, spans, cursor, clicks };
}

// ---- encode + verify ---------------------------------------------------------------------------------------------
function encode(out, framesDir, mixWav) {
  sh(FFMPEG, ["-v", "error", "-y", "-framerate", String(FPS), "-i", join(framesDir, "%04d.png"), "-i", mixWav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high", "-level:v", "4.2", "-g", "30", "-bf", "2",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-t", String(SECONDS), out]);
}
function probe(file) {
  const j = JSON.parse(sh(FFPROBE, ["-v", "error", "-count_packets", "-show_entries",
    "stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,duration,nb_read_packets,color_space,color_primaries,color_transfer,sample_rate,channels,bit_rate:format=duration,format_name", "-of", "json", file]));
  const pts = sh(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]).trim().split("\n").map(Number).sort((a, b) => a - b);
  const deltas = pts.slice(1).map((v, i) => v - pts[i]);
  const cfr = deltas.every((d) => Math.abs(d - 1 / FPS) < 1e-4);
  return { streams: j.streams, duration: +j.format.duration, cfr };
}

async function main() {
  mkdirSync(args.out, { recursive: true });
  const { server, url } = await serve();
  const chrome = await launchChrome();
  try {
    if (args.times) { // quick look at specific instants
      const page = await chrome.openPage(url), dir = join(args.out, "quick"); mkdirSync(dir, { recursive: true });
      for (const t of args.times) { writeFileSync(join(dir, `t_${t.toFixed(2)}.png`), await page.shot(t)); log("wrote", join(dir, `t_${t.toFixed(2)}.png`)); }
      return;
    }

    const framesDir = join(args.out, "frames");
    const pages = [];
    for (let i = 0; i < args.workers; i++) pages.push(await chrome.openPage(url));
    log(`Chrome ready, ${pages.length} page(s)`);

    // 1. facts (also the cursor click times the audio needs)
    const ev = await collectEvents(pages[0]);
    log("  events collected");

    // 2. frames
    if (!args.skipFrames) { log("Rendering frames..."); await renderFrames(pages, framesDir); }

    // 3. audio
    const audioDir = join(args.out, "audio");
    let audio;
    if (!args.skipAudio) { log("Building audio..."); audio = buildAudio({ dir: audioDir, seconds: SECONDS, clicks: ev.meta.TL.clicks, deadStart: ev.meta.TL.deadStart, deadEnd: ev.meta.TL.deadEnd }); }
    else audio = JSON.parse(readFileSync(join(audioDir, "audio.json"), "utf8"));
    writeFileSync(join(audioDir, "audio.json"), JSON.stringify(audio, null, 2));

    // 4. encode
    const mp4 = join(args.out, "demo-source.mp4");
    log("Encoding...");
    encode(mp4, framesDir, join(audioDir, "mix.wav"));
    const info = probe(mp4);

    // 5. previews, waveform, loudness
    const prev = join(args.out, "preview"); rmSync(prev, { recursive: true, force: true }); mkdirSync(prev, { recursive: true });
    for (const t of PREVIEW_TIMES) sh(FFMPEG, ["-v", "error", "-y", "-ss", (t - 0.01).toFixed(3), "-i", mp4, "-vf", JPG_VF, "-frames:v", "1", "-q:v", "2", join(prev, `t_${t.toFixed(3).padStart(6, "0")}.jpg`)]);
    const pick = PREVIEW_TIMES.slice(0, 8).map((t) => `eq(n,${Math.round(t * FPS)})`).join("+");
    sh(FFMPEG, ["-v", "error", "-y", "-i", mp4, "-vf", `select='${pick}',scale=640:-1,tile=4x2,${JPG_VF}`, "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "3", join(prev, "contact-sheet.jpg")]);
    sh(FFMPEG, ["-v", "error", "-y", "-i", mp4, "-filter_complex", "[0:a]aformat=channel_layouts=mono,showwavespic=s=1920x240:colors=0x22c55e:scale=lin,drawgrid=width=80:height=240:color=white@0.12", "-frames:v", "1", join(args.out, "waveform.png")]);
    writeFileSync(join(args.out, "ebur128.txt"), `narration track (voice only)\n${audio.narrationLoudness.summary}\n\nfinal mix (voice + room tone + clicks)\n${audio.mixLoudness.summary}\n`);

    // 6. events.json
    const TLm = ev.meta.TL;
    const events = {
      video: { file: "demo-source.mp4", width: W, height: H, fps: FPS, frames: FRAMES, duration: SECONDS },
      deadStretch: { start: TLm.deadStart, end: TLm.deadEnd, duration: +(TLm.deadEnd - TLm.deadStart).toFixed(3), note: "cursor clicks Export report; spinner modal; no narration; nothing else changes" },
      segments: [
        { name: "idle", start: 0, end: 1.0 }, { name: "kpi-count-up", start: 1.0, end: 4.0 }, { name: "revenue-chart-draw", start: 4.0, end: 8.5 },
        { name: "top-regions", start: 8.5, end: 12.0 }, { name: "recent-orders", start: 12.0, end: TLm.deadStart }, { name: "dead-stretch-export-modal", start: TLm.deadStart, end: TLm.deadEnd },
        { name: "modal-closes-toast", start: TLm.deadEnd, end: 19.0 }, { name: "calm-end-state", start: 19.0, end: SECONDS },
      ],
      boxes: ev.boxes,
      peak: { week: 11, value: 41380, centre: ev.peakCentre, tooltipText: "Week 11 · $41,380" },
      clicks: ev.clicks,
      cursorMoves: ev.cursor,
      visibleSpans: ev.spans,
      narration: audio.sentences,
      audio: { voice: audio.voice, narrationLUFS: audio.narrationLoudness.integratedLUFS, mixLUFS: audio.mixLoudness.integratedLUFS, truePeakDBTP: audio.mixLoudness.truePeakDBTP, roomToneRmsDb: audio.roomToneRmsDb, deadStretchRmsDb: audio.deadStretchRmsDb },
      data: { weeklyRevenue: ev.meta.WEEKS, previousPeriod: ev.meta.PREV },
    };
    writeFileSync(join(args.out, "events.json"), JSON.stringify(events, null, 2));

    const v = info.streams.find((s) => s.codec_name === "h264"), a = info.streams.find((s) => s.codec_name === "aac");
    log(`\n${mp4}`);
    log(`  video ${v.profile} ${v.pix_fmt} ${v.width}x${v.height} ${v.avg_frame_rate} packets=${v.nb_read_packets} cfr=${info.cfr} ${v.color_space}/${v.color_primaries}/${v.color_transfer}`);
    log(`  audio ${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch ${(a.bit_rate / 1000).toFixed(0)} kbps   container duration ${info.duration.toFixed(3)} s`);
    log(`  narration ${audio.narrationLoudness.integratedLUFS} LUFS, mix ${audio.mixLoudness.integratedLUFS} LUFS, true peak ${audio.mixLoudness.truePeakDBTP} dBTP`);
  } finally { chrome.close(); server.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
