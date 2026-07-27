// Live smoke test for the share player (docs/v/). Serves docs/ over a tiny zero-dep static server,
// launches Google Chrome, and drives it over the DevTools Protocol to exercise every player control
// in the NATIVE path (play/pause, seek, speed, mute, copy, timestamp copy, fullscreen, auto-hide)
// against the repo's own demo clip, checks the EMBED path wires up correctly for a real Drive id, and
// checks the EMPTY state. It fails (exit 1) on any wrong result or any uncaught exception / console
// error on our own page.
//
// Zero npm deps (Node's global WebSocket drives CDP, node:http serves the files). macOS/Linux; set
// CHROME_PATH to override the browser. Run: `npm run smoke:share` (add HEADFUL=1 to watch it).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(REPO, "docs");
const OUT = mkdtempSync(join(tmpdir(), "screensnap-share-"));
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const PROF = join(OUT, "profile");

// A real Drive file id to exercise the embed wiring (playback depends on it being public).
const REAL_ID = process.env.SHARE_ID || "1O_xBc2zmVtXzIwOZLB3fsCJ59istLl0y";

const CHROME =
  process.env.CHROME_PATH ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => existsSync(p));
if (!CHROME) {
  console.error("No Chrome found — set CHROME_PATH.");
  process.exit(2);
}

const log = (...a) => console.log(...a);

// ── tiny static server for docs/ (with Range support so <video> streams cleanly) ──────────────────
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
  ".gif": "image/gif",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = join(DOCS, path);
    if (!file.startsWith(DOCS)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    const type = MIME[extname(path)] || "application/octet-stream";
    const range = req.headers.range;
    if (range && !process.env.NO_RANGE) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "content-type": type, "content-length": body.length });
      res.end(body);
    }
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

// ── minimal CDP client over one browser WebSocket (flat sessions) ─────────────────────────────────
let ws;
let nextId = 1;
const pending = new Map();
const listeners = [];
function cmd(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => {
      pending.delete(id);
      rej(new Error("timeout " + method));
    }, 30000);
    pending.set(id, {
      res: (r) => {
        clearTimeout(to);
        res(r);
      },
      rej: (e) => {
        clearTimeout(to);
        rej(e);
      },
    });
  });
}
function on(method, sessionId, fn) {
  listeners.push({ method, sessionId, fn });
}
function connect(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error("ws error " + (e.message || "")));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method) {
        for (const l of listeners)
          if (l.method === m.method && (!l.sessionId || l.sessionId === m.sessionId)) l.fn(m.params);
      }
    };
  });
}
async function attach(targetId) {
  const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  on("Runtime.consoleAPICalled", sessionId, (p) => {
    if (p.type === "error")
      errors.push("[console.error] " + (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  });
  on("Runtime.exceptionThrown", sessionId, (p) =>
    errors.push(
      "[EXCEPTION] " + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0],
    ),
  );
  await cmd("Runtime.enable", {}, sessionId);
  await cmd("Page.enable", {}, sessionId);
  return { sessionId, errors, targetId };
}
async function evaluate(sessionId, expression, awaitPromise = false) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails)
    throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(sessionId, expr, tries = 50, gap = 150) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(sessionId, `!!(${expr})`)) return true;
    await sleep(gap);
  }
  return false;
}
async function openPage(url) {
  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
  const page = await attach(targetId);
  await cmd("Page.navigate", { url }, page.sessionId);
  await waitFor(
    page.sessionId,
    "document.readyState==='complete' && (!document.getElementById('card').hidden || !document.getElementById('empty').hidden)",
  );
  return page;
}
async function closePage(targetId) {
  await cmd("Target.closeTarget", { targetId });
}
async function shot(sessionId, name) {
  try {
    writeFileSync(
      join(SHOTS, name + ".png"),
      Buffer.from((await cmd("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64"),
    );
  } catch {}
}

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) log(`  [ok]   ${label}`);
  else {
    log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

// ── launch ────────────────────────────────────────────────────────────────────────────────────────
const chrome = spawn(
  CHROME,
  [
    ...(process.env.HEADFUL ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${PROF}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=Translate",
    "--window-size=1280,820",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let chromeOut = "";
chrome.stdout.on("data", (d) => (chromeOut += d));
chrome.stderr.on("data", (d) => (chromeOut += d));

try {
  const portFile = join(PROF, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 60 && !port; i++) {
    if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0].trim();
    else await sleep(200);
  }
  if (!port) throw new Error("Chrome didn't expose a debugging port\n" + chromeOut.slice(0, 600));
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  log(`Chrome ${ver.Browser} · docs at ${base} · output → ${OUT}`);
  await connect(ver.webSocketDebuggerUrl);
  await cmd("Target.setDiscoverTargets", { discover: true });
  try {
    await cmd("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  } catch (e) {
    log("  (clipboard permission grant unavailable: " + e.message + ")");
  }

  // ── NATIVE PLAYER ──
  log("\nNATIVE PLAYER (demo clip)");
  const videoUrl = `${base}/media/screensnap-demo.mp4`;
  const nativeUrl = `${base}/v/#src=${encodeURIComponent(videoUrl)}&title=${encodeURIComponent("Checkout flow bug")}`;
  const p = await openPage(nativeUrl);
  await cmd("Page.bringToFront", {}, p.sessionId);

  check("card visible", await evaluate(p.sessionId, `!document.getElementById('card').hidden`));
  check("video element present", await evaluate(p.sessionId, `!!document.querySelector('video.media')`));
  check("title from &title", await evaluate(p.sessionId, `document.getElementById('vtitle').textContent==='Checkout flow bug'`));

  const played = await evaluate(
    p.sessionId,
    `(async()=>{const v=document.querySelector('video.media');try{await v.play();}catch(e){return {ok:false,err:String(e)};}return {ok:!v.paused};})()`,
    true,
  );
  check("video plays", played && played.ok, played && played.err);
  await sleep(900);

  const s1 = await evaluate(
    p.sessionId,
    `(()=>{const shown=el=>getComputedStyle(el).display!=='none';const v=document.querySelector('video.media');return {ct:v.currentTime,fill:parseFloat(document.getElementById('fill').style.width)||0,dur:document.getElementById('dur').textContent,meta:document.getElementById('vmeta').textContent.trim(),pauseShown:shown(document.getElementById('ic-pause')),bigHidden:!shown(document.getElementById('bigplay'))};})()`,
  );
  check("playback time advances", s1.ct > 0);
  check("progress fill grows", s1.fill > 0);
  check("duration shown", !!s1.dur && s1.dur !== "0:00");
  check("metadata row populated (duration + resolution)", /\d.+×.+\d/.test(s1.meta), s1.meta);
  check("pause icon shown while playing", s1.pauseShown);
  check("big-play hidden while playing", s1.bigHidden);

  const seek = await evaluate(
    p.sessionId,
    `(()=>{const s=document.getElementById('scrub');const r=s.getBoundingClientRect();const x=r.left+r.width*0.5;s.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,bubbles:true,pointerId:1}));const v=document.querySelector('video.media');return {ct:v.currentTime,dur:v.duration};})()`,
  );
  check("scrubber seeks to mid", seek.ct > seek.dur * 0.3 && seek.ct < seek.dur * 0.7, `ct=${seek.ct} dur=${seek.dur}`);

  const sp = await evaluate(
    p.sessionId,
    `(()=>{const b=document.getElementById('speed');b.click();const v=document.querySelector('video.media');return {rate:v.playbackRate,label:b.textContent};})()`,
  );
  check("speed cycles to 1.25×", sp.rate === 1.25 && sp.label === "1.25×", JSON.stringify(sp));

  const mu = await evaluate(
    p.sessionId,
    `(()=>{const m=document.getElementById('mute');const v=document.querySelector('video.media');const before=v.muted;m.click();return {before,after:v.muted,op:m.style.opacity};})()`,
  );
  check("mute toggles + dims", mu.before === false && mu.after === true && mu.op === "0.3", JSON.stringify(mu));

  await evaluate(p.sessionId, `document.getElementById('copy').click()`);
  await sleep(150);
  const cp = await evaluate(
    p.sessionId,
    `(()=>{const b=document.getElementById('copy');return {copied:b.classList.contains('copied'),text:b.textContent.trim(),toast:!!document.querySelector('.toast.show')};})()`,
  );
  check("copy link shows copied state", cp.copied && /Copied/.test(cp.text), JSON.stringify(cp));
  check("copy link shows toast", cp.toast);

  await evaluate(p.sessionId, `document.getElementById('stamp').click()`);
  await sleep(150);
  const st = await evaluate(
    p.sessionId,
    `(()=>{const b=document.getElementById('stamp');return {copied:b.classList.contains('copied'),text:b.textContent.trim()};})()`,
  );
  check("timestamp copy shows copied state", st.copied && st.text === "copied", JSON.stringify(st));

  await evaluate(p.sessionId, `document.getElementById('fs').click()`); // must not throw

  // auto-hide: keep it playing (loop), wait past the idle window, then reveal on move
  await evaluate(
    p.sessionId,
    `(()=>{const v=document.querySelector('video.media');v.loop=true;v.muted=true;if(v.paused)v.play().catch(()=>{});return true;})()`,
  );
  await sleep(2900);
  const hidden = await evaluate(p.sessionId, `document.getElementById('stage').classList.contains('hide-ui')`);
  check("controls auto-hide while playing", hidden === true);
  const revealed = await evaluate(
    p.sessionId,
    `(()=>{document.getElementById('stage').dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));return document.getElementById('stage').classList.contains('hide-ui');})()`,
  );
  check("mouse move reveals controls", revealed === false);

  const kb = await evaluate(
    p.sessionId,
    `(()=>{const v=document.querySelector('video.media');const was=v.paused;document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));return {was,now:v.paused};})()`,
  );
  check("spacebar toggles play/pause", kb.was !== kb.now, JSON.stringify(kb));

  await shot(p.sessionId, "native");
  check("no console errors (native)", p.errors.length === 0, p.errors.join(" | "));
  await closePage(p.targetId);

  // ── EMBED FALLBACK (real Drive id) ──
  log("\nEMBED FALLBACK (real id " + REAL_ID + ")");
  const e = await openPage(`${base}/v/#id=${REAL_ID}`);
  const emb = await evaluate(
    e.sessionId,
    `(()=>{const hidden=el=>getComputedStyle(el).display==='none';const f=document.querySelector('iframe.media');return {iframe:!!f,src:f?f.src:'',controls:hidden(document.getElementById('controls')),big:hidden(document.getElementById('bigplay')),click:hidden(document.getElementById('clicklayer')),top:hidden(document.querySelector('.ovl-top')),card:!document.getElementById('card').hidden};})()`,
  );
  check("iframe present", emb.iframe);
  check("iframe uses Drive preview for the id", emb.src.includes("/preview") && emb.src.includes(REAL_ID), emb.src);
  check("custom controls not painted over iframe in embed mode", emb.controls && emb.big && emb.click);
  check("title overlay not painted over iframe in embed mode", emb.top);
  check("card shown", emb.card);
  await shot(e.sessionId, "embed");
  check("no console errors on our page (embed)", e.errors.length === 0, e.errors.join(" | "));
  await closePage(e.targetId);

  // ── EMPTY STATE ──
  log("\nEMPTY STATE (no id)");
  const em = await openPage(`${base}/v/`);
  const empty = await evaluate(
    em.sessionId,
    `(()=>({empty:!document.getElementById('empty').hidden,cardHidden:document.getElementById('card').hidden}))()`,
  );
  check("empty state shown, player hidden", empty.empty && empty.cardHidden);
  check("no console errors (empty)", em.errors.length === 0, em.errors.join(" | "));
  await closePage(em.targetId);

  log(`\n${failures === 0 ? "PASS" : "FAIL (" + failures + " issue(s))"} · screenshots in ${SHOTS}`);
} catch (e) {
  log("FATAL: " + e.message);
  failures = 1;
} finally {
  try {
    chrome.kill("SIGKILL");
  } catch {}
  try {
    server.close();
  } catch {}
  await sleep(150);
}
process.exit(failures ? 1 : 0);
