// Recorder window — the separate floating window for SCREEN / WINDOW recording. It runs
// getDisplayMedia + MediaRecorder itself (a real button click gives the user gesture getDisplayMedia
// needs — which an offscreen document doesn't have). Saves native MP4. Reports start/stop to the
// service worker so the toolbar badge and popup stay in sync.
import { MSG, getSettings, stamp, fmtClock } from "../lib/messages.js";

const app = document.getElementById("app");
const send = (m) => chrome.runtime.sendMessage(m);
const MONO = "'Geist Mono',ui-monospace,monospace";

let view = "waiting"; // waiting | recording
let rec = null; // MediaRecorder
let chunks = [];
let stream = null;
let rawStreams = [];
let audioCtx = null;
let startedAt = 0;
let paused = false;
let pausedAt = null;
let pausedTotalMs = 0;
let mime = "";
let discardFlag = false;
let savedDuration = 0;
let timer = null;

const P = {
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  stop: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
};
const ico = (n, c, sz = 16, sw = 1.75) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="${n === "stop" ? c : "none"}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;
const elapsedMs = () => Math.max(0, (paused && pausedAt ? pausedAt : Date.now()) - startedAt - pausedTotalMs);

function header() {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0f0f0f;border-bottom:1px solid rgba(255,255,255,0.06)">
    <div style="display:flex;gap:6px">${["#ef4444", "#f59e0b", "#22c55e"].map((c) => `<div style="width:10px;height:10px;border-radius:50%;background:${c};opacity:0.85"></div>`).join("")}</div>
    <span style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.09em;color:#333">screensnap · recorder</span>
    <div style="width:46px"></div></div>`;
}
function pingDot() { return `<div style="position:relative;width:6px;height:6px;flex-shrink:0"><div style="position:absolute;inset:0;border-radius:50%;background:rgba(239,68,68,0.45);animation:pingRing 1.5s ease-out infinite"></div><div style="position:absolute;inset:0;border-radius:50%;background:#ef4444"></div></div>`; }

function render() {
  let body;
  if (view === "saving") {
    body = `<div style="padding:34px 24px;display:flex;flex-direction:column;align-items:center;gap:10px">
      <div style="font-family:${MONO};font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.09em">Saving · ${fmtClock(savedDuration / 1000)} recorded</div>
      <div style="font-family:${MONO};font-size:9px;color:#333;text-transform:uppercase;letter-spacing:0.06em">Writing native MP4 to Downloads…</div></div>`;
  } else if (view === "recording") {
    body = `<div style="padding:22px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div>
        <div id="timer" style="font-family:${MONO};font-size:36px;font-weight:500;letter-spacing:-0.03em;line-height:1;color:${paused ? "#555" : "#fff"}">${fmtClock(elapsedMs() / 1000)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:7px">
          ${paused ? `<span style="font-family:${MONO};font-size:9px;color:#555;text-transform:uppercase;letter-spacing:0.08em">Paused</span>` : `${pingDot()}<span style="font-family:${MONO};font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em">Screen · recording</span>`}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button data-act="pause" style="padding:11px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e5e7eb;font:500 12px 'Geist',sans-serif;cursor:pointer;display:flex;align-items:center;gap:7px">${paused ? `${ico("play", "#22c55e", 11)}Resume` : `${ico("pause", "currentColor", 11)}Pause`}</button>
        <button class="stop" data-act="stop" style="padding:11px 22px;background:#ef4444;border:none;border-radius:8px;color:#fff;font:600 13px 'Geist',sans-serif;cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap">${ico("stop", "#fff", 12)}Stop</button>
      </div></div>`;
  } else {
    body = `<div style="padding:30px 24px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div style="width:48px;height:48px;border-radius:12px;background:#161616;border:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center">${ico("monitor", "#333", 22)}</div>
      <button class="prim" data-act="choose" style="padding:11px 26px;background:#22c55e;border:none;border-radius:8px;color:#000;font:600 13px 'Geist',sans-serif;cursor:pointer">Choose screen to record</button>
      <span style="font-family:${MONO};font-size:9px;color:#333;text-transform:uppercase;letter-spacing:0.08em">Native system picker opens next</span>
    </div>`;
  }
  app.innerHTML = header() + body;
  manageTimer();
}
function manageTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (view === "recording" && !paused) timer = setInterval(() => { const t = document.getElementById("timer"); if (t) t.textContent = fmtClock(elapsedMs() / 1000); }, 500);
}

app.addEventListener("click", (e) => {
  const node = e.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;
  if (act === "choose") chooseAndRecord();
  else if (act === "stop") stop(false);
  else if (act === "pause") togglePause();
});

// popup-initiated controls routed through the service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== MSG.SCREEN_CONTROL) return;
  if (msg.action === "stop" || msg.action === "discard") stop(msg.action === "discard");
  else if (msg.action === "pause" && !paused) togglePause();
  else if (msg.action === "resume" && paused) togglePause();
});

async function chooseAndRecord() {
  const settings = await getSettings();
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: settings.videoFps || 30 }, audio: !!settings.withSystemAudio });
  } catch {
    return; // picker dismissed — stay in the waiting view
  }

  let mic = null;
  if (settings.withMic) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); } catch { mic = null; }
  }

  const videoTrack = display.getVideoTracks()[0];
  const displayAudio = display.getAudioTracks();
  const audioTracks = [];
  if (displayAudio.length || mic) {
    audioCtx = new AudioContext();
    await audioCtx.resume().catch(() => {});
    const dest = audioCtx.createMediaStreamDestination();
    if (displayAudio.length) audioCtx.createMediaStreamSource(new MediaStream(displayAudio)).connect(dest);
    if (mic) audioCtx.createMediaStreamSource(mic).connect(dest);
    audioTracks.push(...dest.stream.getAudioTracks());
  }
  rawStreams = [display, mic].filter(Boolean);
  stream = new MediaStream([videoTrack, ...audioTracks]);

  mime = pickMime(settings.videoFormat !== "webm");
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => finalize();
  rec.onerror = () => stop(false);

  videoTrack.addEventListener("ended", () => { if (rec && rec.state !== "inactive") stop(false); }); // native "Stop sharing"

  startedAt = Date.now(); paused = false; pausedAt = null; pausedTotalMs = 0; discardFlag = false;
  rec.start(1000);
  view = "recording";
  render();
  notifyStarted();
}

function togglePause() {
  if (!rec || rec.state === "inactive") return;
  if (paused) { rec.resume(); pausedTotalMs += Date.now() - (pausedAt || Date.now()); pausedAt = null; paused = false; }
  else { rec.pause(); pausedAt = Date.now(); paused = true; }
  render();
  notifyStarted(); // keep SW/popup timing in sync
}

function stop(discard) {
  discardFlag = !!discard;
  if (rec && rec.state !== "inactive") rec.stop();
  else finalize();
}

async function finalize() {
  savedDuration = elapsedMs();
  if (timer) clearInterval(timer);
  view = "saving";
  render();

  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { rawStreams.forEach((s) => s.getTracks().forEach((t) => t.stop())); } catch {}
  try { if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {}); } catch {}
  audioCtx = null;

  const durationMs = savedDuration;
  if (discardFlag || !chunks.length) {
    send({ type: MSG.SCREEN_STOPPED, filename: null, durationMs });
    window.close();
    return;
  }
  const baseType = (mime || "video/webm").split(";")[0];
  const blob = new Blob(chunks, { type: baseType });
  const ext = baseType.includes("mp4") ? "mp4" : "webm";
  const note = ext !== "mp4" ? "Saved as WebM — this browser can't record MP4 natively." : null;
  const filename = `screensnap/recording-${stamp()}.${ext}`;
  await downloadBlob(blob, filename);
  send({ type: MSG.SCREEN_STOPPED, filename, durationMs, note });
  window.close();
}

// Save the recording, waiting for completion before window.close() destroys the blob: URL.
// Falls back to an anchor-click download if chrome.downloads rejects the blob URL.
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await downloadViaApi(url, filename);
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 3500));
  } finally {
    URL.revokeObjectURL(url);
  }
}
function downloadViaApi(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id == null) return reject(new Error(err ? err.message : "no id"));
      const onChanged = (d) => {
        if (d.id === id && d.state && d.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
      setTimeout(resolve, 30000);
    });
  });
}

function notifyStarted() { send({ type: MSG.SCREEN_STARTED, startedAt, mime: mime || "video/mp4", paused, pausedAt, pausedTotalMs }); }
function pickMime(preferMp4) {
  const mp4 = ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
  const webm = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const t of preferMp4 ? [...mp4, ...webm] : webm) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

window.addEventListener("beforeunload", () => { if (rec && rec.state !== "inactive") { try { rec.stop(); } catch {} } });

render();
