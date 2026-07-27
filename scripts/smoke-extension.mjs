// Live smoke test for the editors. Launches Google Chrome, loads this unpacked extension over the
// DevTools Protocol (Extensions.loadUnpacked — the --load-extension switch is ignored in Chrome 137+),
// boots the VIDEO editor with a generated clip and exercises crop / zoom / backdrop, and builds the
// IMAGE editor's content script against a stubbed chrome + test image. It fails (exit 1) on any
// uncaught exception or console error in either editor — so it catches the class of bug that only
// shows at runtime (e.g. a render helper referenced but never declared → ReferenceError).
//
// Zero npm deps (Node's global WebSocket drives CDP). macOS/Linux; set CHROME_PATH to override the
// browser. Run: `npm run smoke` (add HEADFUL=1 to watch it). Screenshots are written to a temp dir.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = mkdtempSync(join(tmpdir(), "screensnap-smoke-"));
const SHOTS = join(OUT, "shots"); mkdirSync(SHOTS, { recursive: true });
const PROF = join(OUT, "profile");
const CHROME = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome found — set CHROME_PATH."); process.exit(2); }

const log = (...a) => console.log(...a);

// ── minimal CDP client over one browser WebSocket (flat sessions) ────────────────────────────────
let ws, nextId = 1;
const pending = new Map();
const listeners = [];
function cmd(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error("timeout " + method)); }, 30000);
    pending.set(id, { res: (r) => { clearTimeout(to); res(r); }, rej: (e) => { clearTimeout(to); rej(e); } });
  });
}
function on(method, sessionId, fn) { listeners.push({ method, sessionId, fn }); }
function connect(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error("ws error " + (e.message || "")));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method) for (const l of listeners) if (l.method === m.method && (!l.sessionId || l.sessionId === m.sessionId)) l.fn(m.params);
    };
  });
}
async function attach(targetId) {
  const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
  const errors = [], state = { loads: 0 };
  on("Page.loadEventFired", sessionId, () => state.loads++);
  on("Runtime.consoleAPICalled", sessionId, (p) => { if (p.type === "error") errors.push("[console.error] " + (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ")); });
  on("Runtime.exceptionThrown", sessionId, (p) => errors.push("[EXCEPTION] " + ((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0])));
  await cmd("Runtime.enable", {}, sessionId); await cmd("Page.enable", {}, sessionId);
  return { sessionId, errors, state };
}
async function evaluate(sessionId, expression, awaitPromise = false) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function shot(sessionId, name) {
  try { writeFileSync(join(SHOTS, name + ".png"), Buffer.from((await cmd("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64")); } catch {}
}

// ── launch ───────────────────────────────────────────────────────────────────────────────────────
const chrome = spawn(CHROME, [
  ...(process.env.HEADFUL ? [] : ["--headless=new"]),
  "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${PROF}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-features=Translate", "--window-size=1280,820", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeOut = "";
chrome.stdout.on("data", (d) => chromeOut += d);
chrome.stderr.on("data", (d) => chromeOut += d);

let failures = 0;
try {
  // wait for the debugging port
  const portFile = join(PROF, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 60 && !port; i++) { if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0].trim(); else await sleep(200); }
  if (!port) throw new Error("Chrome didn't expose a debugging port\n" + chromeOut.slice(0, 600));
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  log(`Chrome ${ver.Browser} · output → ${OUT}`);
  await connect(ver.webSocketDebuggerUrl);
  await cmd("Target.setDiscoverTargets", { discover: true });

  const { id: extId } = await cmd("Extensions.loadUnpacked", { path: REPO });
  log(`Loaded extension ${extId}`);
  let swSession = null;
  for (let i = 0; i < 50 && !swSession; i++) {
    const t = (await cmd("Target.getTargets")).targetInfos.find((x) => x.url.startsWith(`chrome-extension://${extId}`) && (x.type === "service_worker" || x.type === "background_page"));
    if (t) { const s = await cmd("Target.attachToTarget", { targetId: t.targetId, flatten: true }); await cmd("Runtime.enable", {}, s.sessionId); swSession = s.sessionId; } else await sleep(250);
  }
  if (!swSession) throw new Error("extension service worker never appeared");
  const swEval = async (e) => { const r = await cmd("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }, swSession); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };

  // ── video editor ──
  log("\nVIDEO EDITOR");
  const tab = await swEval(`(async()=>{const t=await chrome.tabs.create({url:chrome.runtime.getURL('src/editor/editor.html'),active:true});return {id:t.id};})()`);
  let edTid = null;
  for (let i = 0; i < 40 && !edTid; i++) { const p = (await cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.includes("/src/editor/editor.html")); if (p) edTid = p.targetId; else await sleep(200); }
  const ed = await attach(edTid);
  await sleep(800);
  const gen = await evaluate(ed.sessionId, `(async()=>{
    const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    const c=document.createElement('canvas'); c.width=960; c.height=540; const x=c.getContext('2d');
    const rec=new MediaRecorder(c.captureStream(30),{mimeType:mime}); const ch=[]; rec.ondataavailable=e=>e.data.size&&ch.push(e.data); rec.start();
    let f=0; const iv=setInterval(()=>{x.fillStyle='hsl('+(f*4%360)+',60%,45%)';x.fillRect(0,0,960,540);x.fillStyle='#fff';x.font='bold 64px sans-serif';x.fillText('screensnap '+f,80,290);f++;},33);
    await new Promise(r=>setTimeout(r,1400)); clearInterval(iv); rec.stop(); await new Promise(r=>rec.onstop=r);
    const blob=new Blob(ch,{type:mime});
    await new Promise((resolve,reject)=>{const o=indexedDB.open('screensnap',1);o.onupgradeneeded=()=>{const db=o.result;if(!db.objectStoreNames.contains('clips'))db.createObjectStore('clips',{keyPath:'id'});};o.onsuccess=()=>{const db=o.result;const t=db.transaction('clips','readwrite');t.objectStore('clips').put({id:'live',blob,meta:{fileName:'live.mp4'},savedAt:0});t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};o.onerror=()=>reject(o.error);});
    return {ok:true,mime,size:blob.size};
  })()`, true);
  if (!gen.ok) throw new Error("clip generation failed");
  const before = ed.state.loads;
  await swEval(`chrome.tabs.update(${tab.id},{url:chrome.runtime.getURL('src/editor/editor.html?clipId=live')})`);
  for (let i = 0; i < 40; i++) { if (ed.state.loads > before) break; await sleep(150); }
  await sleep(2200);
  const ui = await evaluate(ed.sessionId, `(()=>{const q=s=>!!document.querySelector(s);return {toolbar:q('#ss-toolbar'),crop:q('#ss-crop-btn'),zoomAdd:q('#ss-zoom-add'),backdrop:q('#ss-backdrop-pop'),exportGif:q('#ss-pop-export [data-exp=gif]'),zoomLane:q('.ss-tl-ztime')};})()`);
  log("  ui: " + JSON.stringify(ui));
  await shot(ed.sessionId, "video-loaded");
  // Backdrop moved into a popover: open it, then enable the backdrop to exercise that render path.
  await evaluate(ed.sessionId, `document.getElementById('ss-backdrop-pop').click()`); await sleep(150);
  await evaluate(ed.sessionId, `(()=>{const c=document.getElementById('ss-bd-on');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(300);
  await evaluate(ed.sessionId, `document.getElementById('ss-zoom-add').click()`); await sleep(300);
  const zoom = await evaluate(ed.sessionId, `({focusBox:!!document.querySelector('.ss-zfocus'),block:!!document.querySelector('.ss-tl-zblock')})`);
  log("  zoom: " + JSON.stringify(zoom));
  await shot(ed.sessionId, "video-zoom-backdrop");
  await evaluate(ed.sessionId, `document.getElementById('ss-crop-btn').click()`); await sleep(300);
  await evaluate(ed.sessionId, `(()=>{const b=[...document.querySelectorAll('.ss-crop-preset')].find(x=>x.textContent==='16:9');b&&b.click();})()`); await sleep(150);
  await evaluate(ed.sessionId, `(()=>{const a=document.getElementById('ss-crop-apply');a&&!a.disabled&&a.click();})()`); await sleep(400);
  await shot(ed.sessionId, "video-cropped");
  log("  console errors: " + (ed.errors.length ? "\n   " + ed.errors.join("\n   ") : "none"));
  failures += ed.errors.length + (ui.toolbar && ui.zoomLane ? 0 : 1) + (zoom.focusBox && zoom.block ? 0 : 1);

  // ── image editor (content script against a stub) ──
  log("\nIMAGE EDITOR");
  const blank = await attach((await cmd("Target.createTarget", { url: "about:blank" })).targetId);
  await sleep(200);
  await evaluate(blank.sessionId, `(()=>{const c=document.createElement('canvas');c.width=800;c.height=520;const x=c.getContext('2d');x.fillStyle='#0f172a';x.fillRect(0,0,800,520);x.fillStyle='#22c55e';x.fillRect(90,90,300,180);const url=c.toDataURL('image/png');window.chrome={runtime:{lastError:null,sendMessage:(m,cb)=>{m&&m.type==='editor-get-image'?cb({ok:true,dataUrl:url,filename:'test.png'}):cb&&cb({});}}};})()`);
  let injectErr = null;
  try { await evaluate(blank.sessionId, readFileSync(join(REPO, "src/content/editor-overlay.js"), "utf8")); } catch (e) { injectErr = e.message; }
  await sleep(600);
  const overlay = await evaluate(blank.sessionId, `(()=>{const h=document.getElementById('__screensnap_editor');if(!h||!h.shadowRoot)return {built:false};const r=h.shadowRoot;return {built:true,tools:[...r.querySelectorAll('[data-tool]')].length,layers:!!r.querySelector('[class*=layer],.ly-list'),canvas:!!r.querySelector('canvas')};})()`);
  log("  inject error: " + (injectErr || "none"));
  log("  overlay: " + JSON.stringify(overlay));
  await shot(blank.sessionId, "image-editor");
  log("  console errors: " + (blank.errors.length ? "\n   " + blank.errors.join("\n   ") : "none"));
  failures += blank.errors.length + (injectErr ? 1 : 0) + (overlay.built ? 0 : 1);

  log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL (" + failures + " issue(s))"} · screenshots in ${SHOTS}`);
} catch (e) {
  log("FATAL: " + e.message);
  failures = 1;
} finally {
  try { chrome.kill("SIGKILL"); } catch {}
  await sleep(200);
}
process.exit(failures ? 1 : 0);
