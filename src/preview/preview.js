// Screen + Cam "set up your camera" window + floating camera (Document Picture-in-Picture).
//
// Why this window exists: a PiP window needs (a) a user gesture and (b) a top-level page as opener, and it dies when
// its opener closes. The action popup closes on blur and the offscreen doc has neither a gesture nor a top-level
// page — so the service worker opens THIS dedicated extension window, which stays alive for the whole recording and
// pops the camera out of a real click ("Start recording"). It doubles as a nice positioning step. If PiP isn't
// available (or there's no camera) the recording still proceeds — the offscreen compositor handles the camera.
import { MSG, getSettings, setSettings, elapsedMs, fmtClock } from "../lib/messages.js";

const send = (m) => { try { chrome.runtime.sendMessage(m); } catch {} };

const stage = document.getElementById("stage");
const camEl = document.getElementById("cam");
const startBtn = document.getElementById("start");
const mirrorBtn = document.getElementById("mirrorBtn");
const shapeChips = [...document.querySelectorAll("[data-shape]")];
const statusEl = document.getElementById("status");
const leadEl = document.getElementById("lead");

let camStream = null, pip = null, pipVideo = null, pipWrap = null, sentReady = false;
let shape = "circle", mirror = true;
// PiP recording-control strip (built in openPip; updated from STATE_CHANGED).
let recState = null, pipBar = null, pipTime = null, pipRec = null, pipPauseBtn = null;

const radius = (px) => (shape === "square" ? Math.round(px * 0.18) + "px" : "50%");

function applyLook() {
  stage.classList.toggle("square", shape === "square");
  camEl.classList.toggle("unmirror", !mirror);
  shapeChips.forEach((c) => c.classList.toggle("on", c.dataset.shape === shape));
  mirrorBtn.classList.toggle("on", mirror);
  if (pipWrap && pipVideo) {
    pipWrap.style.borderRadius = radius(Math.min(pip.innerWidth, pip.innerHeight));
    pipVideo.style.transform = mirror ? "scaleX(-1)" : "none";
  }
}

// Live tweaks persist (so the composite path uses the same look) and broadcast (so an active recording updates).
// We track the latest persist so onStart can await it before signaling ready — otherwise the SW's getSettings()
// (which feeds the composite) could read a stale shape/mirror if the user tweaks then immediately starts.
let pendingSave = Promise.resolve();
function setShape(s) { shape = s; applyLook(); pendingSave = setSettings({ bubbleShape: s }); send({ type: MSG.SET_BUBBLE, shape: s }); }
function setMirror(m) { mirror = m; applyLook(); pendingSave = setSettings({ camMirror: m }); send({ type: MSG.SET_BUBBLE, mirror: m }); }

shapeChips.forEach((c) => (c.onclick = () => setShape(c.dataset.shape)));
mirrorBtn.onclick = () => setMirror(!mirror);

// Inline SVGs for the PiP control strip (the PiP document has no stylesheet, so everything is inline).
const SVG_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const SVG_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><polygon points="6 4 20 12 6 20"/></svg>';
const SVG_STOP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#fff"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
const SVG_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
const SVG_FLIP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

function openPip() {
  // First statement MUST be requestWindow() — no await before it, or the click's transient activation is lost.
  // SQUARE window so a circle clip (border-radius:50% on the inset:0 wrap) is a true circle, not an ellipse.
  return documentPictureInPicture.requestWindow({ width: 280, height: 280, disallowReturnToOpener: true }).then((win) => {
    pip = win;
    const d = win.document;
    d.body.style.cssText = "margin:0;background:#000;overflow:hidden;width:100vw;height:100vh;position:relative;font-family:system-ui,-apple-system,sans-serif";
    pipWrap = d.createElement("div");
    pipWrap.style.cssText = "position:absolute;inset:0;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center";
    pipVideo = Object.assign(d.createElement("video"), { autoplay: true, muted: true, playsInline: true });
    pipVideo.srcObject = camStream;
    pipVideo.style.cssText = "width:100%;height:100%;object-fit:cover;background:#000";
    pipWrap.append(pipVideo);

    // Hover-reveal recording controls (hidden by default so an entire-screen capture — which DOES record this
    // window — stays clean; revealed when the user hovers the camera, like the on-page bar). All buttons are
    // closures here in the opener, so chrome.runtime is available even though the PiP document has limited APIs.
    const bar = d.createElement("div");
    bar.style.cssText = "position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:7px;padding:8px 10px 10px;background:linear-gradient(to top,rgba(0,0,0,0.82),rgba(0,0,0,0.45) 60%,transparent)";
    const rec = d.createElement("span");
    rec.style.cssText = "width:8px;height:8px;border-radius:50%;background:#dc2626;flex:none;box-shadow:0 0 6px rgba(220,38,38,0.6)";
    const time = d.createElement("span");
    time.style.cssText = "font:600 12px ui-monospace,monospace;color:#fff;min-width:38px";
    time.textContent = "00:00";
    const spacer = d.createElement("span"); spacer.style.cssText = "flex:1";
    const mk = (html, title, bg) => { const b = d.createElement("button"); b.innerHTML = html; b.title = title; b.style.cssText = `width:30px;height:30px;border:none;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:${bg || "rgba(255,255,255,0.16)"}`; return b; };
    const flipBtn = mk(SVG_FLIP, "Mirror"); flipBtn.onclick = () => setMirror(!mirror);
    const pauseBtn = mk(SVG_PAUSE, "Pause"); pauseBtn.onclick = () => send({ type: recState && recState.paused ? MSG.RESUME_RECORDING : MSG.PAUSE_RECORDING });
    const discardBtn = mk(SVG_TRASH, "Discard"); discardBtn.onclick = () => send({ type: MSG.CANCEL_RECORDING });
    const stopBtn = mk(SVG_STOP, "Stop & save", "#dc2626"); stopBtn.onclick = () => send({ type: MSG.STOP_RECORDING });
    bar.append(rec, time, spacer, flipBtn, pauseBtn, discardBtn, stopBtn);
    // Controls stay permanently visible (no hover-reveal), per preference.

    pipBar = bar; pipTime = time; pipRec = rec; pipPauseBtn = pauseBtn;
    d.body.append(pipWrap, bar);
    applyLook();
    // Seed the strip with the current recording state (the picker may not have started yet → 00:00).
    chrome.runtime.sendMessage({ type: MSG.GET_STATE }, (res) => { if (!chrome.runtime.lastError && res && res.state) { recState = res.state; updatePipBar(); } });
    updatePipBar();
    win.addEventListener("pagehide", () => { send({ type: MSG.PREVIEW_CLOSED }); });
  });
}

// Reflect the live recording state into the PiP control strip (paused look, stop hidden while finalizing).
function updatePipBar() {
  if (!pipBar) return;
  const s = recState, paused = !!(s && s.paused);
  const finalizing = s && (s.phase === "saving" || s.phase === "transcoding");
  if (pipPauseBtn) { pipPauseBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE; pipPauseBtn.title = paused ? "Resume" : "Pause"; pipPauseBtn.style.display = finalizing ? "none" : ""; }
  if (pipRec) { pipRec.style.background = paused ? "#d97706" : "#dc2626"; pipRec.style.animation = paused || finalizing ? "none" : ""; }
  if (pipTime) pipTime.textContent = finalizing ? "Saving…" : fmtClock(elapsedMs(s) / 1000);
}

async function minimizeSelf() {
  try { const w = await chrome.windows.getCurrent(); chrome.windows.update(w.id, { state: "minimized" }); } catch {}
}
function ready(pipOn) { if (sentReady) return; sentReady = true; send({ type: MSG.PREVIEW_READY, pip: !!pipOn }); }

// Keep the PiP control strip in sync with the recording, and tick the clock while running.
chrome.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== chrome.runtime.id || !m) return;
  if (m.type === MSG.STATE_CHANGED) { recState = m.state; updatePipBar(); }
});
setInterval(() => { if (recState && recState.phase === "recording" && !recState.paused) updatePipBar(); }, 500);

async function onStart() {
  startBtn.disabled = true;
  let pipOn = false;
  if (camStream && "documentPictureInPicture" in window) {
    try { await openPip(); pipOn = true; } catch { pipOn = false; } // requestWindow runs first in openPip (gesture kept)
  }
  await pendingSave;              // make sure the last shape/mirror tweak is committed before the SW reads settings
  ready(pipOn);
  if (pipOn) minimizeSelf();      // keep the opener alive (PiP dies with it) but out of sight
  else window.close();            // no floating preview → nothing to host; recording proceeds composited
}
startBtn.onclick = onStart;

async function init() {
  const s = await getSettings();
  shape = s.bubbleShape === "square" ? "square" : "circle";
  mirror = s.camMirror !== false;
  applyLook();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    camEl.srcObject = camStream;
  } catch {
    camStream = null;
    statusEl.textContent = "No camera available — recording will continue without it.";
    leadEl.classList.add("hide");
  }
  if (!("documentPictureInPicture" in window)) {
    leadEl.textContent = "Your camera will appear as a corner bubble in the recording.";
  }
  // If the user closes this window without starting, the service worker proceeds composited-only (it treats a
  // close-before-ready as pip:false via windows.onRemoved).
}
init();
