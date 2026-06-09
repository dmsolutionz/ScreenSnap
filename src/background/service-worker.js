// Service worker — orchestrates everything. No DOM: screenshots stitch with OffscreenCanvas; tab &
// video-circle recording run in the offscreen document. Recordings save as native MP4 (no transcoding).
import { MSG, TARGET, PHASE, SOURCE, getSettings, stamp, elapsedMs } from "../lib/messages.js";
import { preparePageForCapture, gotoTile, restorePageAfterCapture } from "../content/fullpage.js";

const STATE_KEY = "recordingState";
const DL_DIR = "screensnap";
const MAX_CANVAS_SIDE = 16384;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Pending screenshot, in memory (NOT chrome.storage.session — a full-page PNG can be tens of MB and
// blows past the session-storage quota). { tabId, dataUrl, filename }.
let pendingCapture = null;

// ── routing ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only ever act on messages from this extension's own contexts (content scripts, popup, offscreen,
  // recorder window). There is no externally_connectable, so this is defence-in-depth: it ensures a
  // future/co-installed sender can't drive downloads, capture, or recording.
  if (sender.id !== chrome.runtime.id) return false;
  if (!msg || msg.target === TARGET.OFFSCREEN || msg.type === MSG.STATE_CHANGED) return false;
  handle(msg, sender)
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case MSG.GET_STATE:
      return { ok: true, state: await getState(), settings: await getSettings() };
    case MSG.CAPTURE_VISIBLE:
      return doScreenshot("visible");
    case MSG.CAPTURE_FULLPAGE:
      return doScreenshot("fullpage");

    case MSG.SHOT_ANNOTATE:
      return shotAnnotate();
    case MSG.SHOT_SAVE:
      return shotSave();
    case MSG.SHOT_COPY:
      return shotCopy();
    case MSG.SHOT_DISCARD:
      return shotClear();
    case MSG.EDITOR_GET_IMAGE:
      return editorGetImage();
    case MSG.EDITOR_SAVE:
      return editorSave(msg);
    case MSG.EDITOR_CANCEL:
      return editorCancel();

    case MSG.START_RECORDING:
      return startRecording(msg.options || {});
    case MSG.VC_GO:
      return videoCircleGo();
    case MSG.STOP_RECORDING:
      return stopRecording(false);
    case MSG.CANCEL_RECORDING:
      return stopRecording(true);
    case MSG.PAUSE_RECORDING:
      return pauseResume(true);
    case MSG.RESUME_RECORDING:
      return pauseResume(false);
    case "bubble-pos": {
      const st = await getState();
      if (st.recordingTabId != null) chrome.tabs.sendMessage(st.recordingTabId, { type: "bubble-pos", pos: msg.pos }).catch(() => {});
      return { ok: true };
    }

    // ── from the offscreen document (tab / video circle) ──
    case MSG.REC_STARTED:
      // No on-page control for tab recording (it appears in the capture and is redundant with the
      // toolbar badge + popup). Video Circle injects its own bubble at start.
      return setState({
        phase: PHASE.RECORDING, startedAt: Date.now(), mime: msg.mime,
        paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null,
      });
    case MSG.REC_PHASE: {
      const st = await getState();
      const patch = { phase: msg.phase };
      if ((msg.phase === PHASE.SAVING || msg.phase === PHASE.TRANSCODING) && !st.recordedDurationMs) patch.recordedDurationMs = elapsedMs(st);
      return setState(patch);
    }
    case MSG.REC_DONE:
      await setState({ phase: PHASE.IDLE, progress: 0, lastSaved: msg.filename || null, note: msg.note || null, error: null });
      await closeOffscreen();
      return { ok: true };
    case MSG.REC_ERROR:
      await setState({ phase: PHASE.IDLE, progress: 0, error: msg.message || "Recording failed." });
      await closeOffscreen();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

// ── state ────────────────────────────────────────────────────────────────────
async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.session.get(STATE_KEY);
  return s || { phase: PHASE.IDLE };
}
async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, state: next }).catch(() => {});
  if (next.recordingTabId != null) chrome.tabs.sendMessage(next.recordingTabId, { type: MSG.STATE_CHANGED, state: next }).catch(() => {});
  await reflectBadge(next);
  return { ok: true, state: next };
}
async function reflectBadge(state) {
  const active = state.phase && state.phase !== PHASE.IDLE;
  await chrome.action.setBadgeText({ text: active ? "REC" : "" });
  if (active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" }).catch(() => {});
    await chrome.action.setTitle({ title: "screensnap — recording (click to stop)" });
  } else {
    await chrome.action.setTitle({ title: "screensnap — capture & record" });
  }
}
chrome.runtime.onStartup.addListener(() => getState().then(reflectBadge));
getState().then(reflectBadge);

// ── screenshots ──────────────────────────────────────────────────────────────
async function doScreenshot(mode) {
  const tab = await getActiveTab();
  assertCapturable(tab);

  let canvas = null;
  let fullDataUrl = null;
  let prefix;
  if (mode === "visible") { fullDataUrl = await captureWithRetry(tab.windowId); prefix = "screenshot"; }
  else { canvas = await captureFullPage(tab); prefix = "fullpage"; }

  const filename = `${DL_DIR}/${prefix}-${stamp()}.png`;
  let thumb, w, h;
  if (canvas) {
    w = canvas.width; h = canvas.height;
    thumb = await makeThumbDataUrl(canvas, w, h, 320); // from the canvas — no re-decode of the big PNG
    fullDataUrl = await canvasToPngDataUrl(canvas);
  } else {
    const bmp = await dataUrlToBitmap(fullDataUrl);
    w = bmp.width; h = bmp.height;
    thumb = await makeThumbDataUrl(bmp, w, h, 320);
    bmp.close?.();
  }
  pendingCapture = { tabId: tab.id, dataUrl: fullDataUrl, filename };
  return { ok: true, captured: true, thumb, filename, width: w, height: h };
}

async function shotAnnotate() {
  if (!pendingCapture) return { ok: false, error: "Nothing to annotate." };
  await injectFile(pendingCapture.tabId, "src/content/editor-overlay.js");
  return { ok: true };
}
async function shotSave() {
  if (!pendingCapture) return { ok: false, error: "Nothing to save." };
  const { dataUrl, filename } = pendingCapture;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  pendingCapture = null;
  return { ok: true, filename };
}
async function shotCopy() { return pendingCapture ? { ok: true, dataUrl: pendingCapture.dataUrl } : { ok: false }; }
async function shotClear() { pendingCapture = null; return { ok: true }; }
async function editorGetImage() { return pendingCapture ? { ok: true, dataUrl: pendingCapture.dataUrl, filename: pendingCapture.filename } : { ok: false, error: "no pending image" }; }
async function editorSave(msg) {
  await chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename || `${DL_DIR}/screenshot-${stamp()}.png`, saveAs: false });
  pendingCapture = null;
  return { ok: true };
}
async function editorCancel() { pendingCapture = null; return { ok: true }; }

async function captureFullPage(tab) {
  const run = (func, args = []) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }).then((r) => r[0]?.result);
  const m = await run(preparePageForCapture);
  try {
    const { dpr } = m;
    const scale = Math.min(1, MAX_CANVAS_SIDE / (m.pageW * dpr), MAX_CANVAS_SIDE / (m.pageH * dpr));
    const canvas = new OffscreenCanvas(Math.round(m.pageW * dpr * scale), Math.round(m.pageH * dpr * scale));
    const ctx = canvas.getContext("2d");
    const maxX = Math.max(0, m.pageW - m.viewW);
    const maxY = Math.max(0, m.pageH - m.viewH);
    // Explicit tile positions that ALWAYS include the bottom-/right-aligned edge. A plain
    // `y += viewH` loop skips the final strip whenever the page isn't an exact multiple of the
    // viewport, which cut the bottom off.
    const xs = [];
    for (let x = 0; x < maxX; x += m.viewW) xs.push(x);
    xs.push(maxX);
    const ys = [];
    for (let y = 0; y < maxY; y += m.viewH) ys.push(y);
    ys.push(maxY);

    const seen = new Set();
    let tile = 0;
    for (const y of ys) {
      for (const x of xs) {
        const pos = await run(gotoTile, [x, y, tile > 0]);
        const key = `${pos.scrollX},${pos.scrollY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (tile === 0) await delay(200); // first tile: let layout settle (later tiles use the capture spacing)
        const bmp = await dataUrlToBitmap(await captureWithRetry(tab.windowId));
        ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, Math.round(pos.scrollX * dpr * scale), Math.round(pos.scrollY * dpr * scale), bmp.width * scale, bmp.height * scale);
        bmp.close?.();
        tile++;
      }
    }
    return canvas;
  } finally {
    await run(restorePageAfterCapture).catch(() => {});
  }
}

let lastCaptureAt = 0;
async function captureWithRetry(windowId, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const wait = Math.max(0, 510 - (Date.now() - lastCaptureAt)); // captureVisibleTab is rate-limited (~2/sec)
    if (wait) await delay(wait);
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureAt = Date.now();
      return url;
    } catch (e) {
      lastErr = e; lastCaptureAt = Date.now();
      if (i < attempts - 1) await delay(650);
    }
  }
  throw lastErr;
}

// ── recording ──────────────────────────────────────────────────────────────────
async function startRecording(options) {
  const opts = { ...(await getSettings()), ...options };
  const tab = await getActiveTab();
  assertCapturable(tab);

  if (opts.recordSource === SOURCE.VIDEO_CIRCLE) {
    // Two-phase: show the webcam bubble + 3-2-1 countdown first, then VC_GO begins the actual capture.
    await setState({
      phase: PHASE.PREPARING, source: SOURCE.VIDEO_CIRCLE, withMic: opts.withMic, withSystemAudio: opts.withSystemAudio,
      videoFormat: opts.videoFormat, videoFps: opts.videoFps, videoMaxHeight: opts.videoMaxHeight,
      recordingTabId: tab.id, controlInjectable: isInjectable(tab.url),
      paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null,
    });
    await injectFile(tab.id, "src/content/webcam-bubble.js");
    return { ok: true };
  }

  // Current tab
  await setState({
    phase: PHASE.PREPARING, source: SOURCE.TAB, withMic: opts.withMic, withSystemAudio: opts.withSystemAudio,
    recordingTabId: tab.id, controlInjectable: isInjectable(tab.url),
    paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null,
  });
  let streamId;
  try { streamId = await getTabMediaStreamId(tab.id); }
  catch (e) { await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) }); throw e; }
  await ensureOffscreen();
  await sendOffscreen({ type: MSG.OFFSCREEN_START, streamId, sourceKind: "tab", withMic: opts.withMic, withSystemAudio: opts.withSystemAudio, videoFormat: opts.videoFormat, fps: opts.videoFps, maxHeight: opts.videoMaxHeight });
  return { ok: true };
}

async function videoCircleGo() {
  const st = await getState();
  if (st.source !== SOURCE.VIDEO_CIRCLE || st.phase !== PHASE.PREPARING || st.recordingTabId == null) return { ok: true };
  let streamId;
  try { streamId = await getTabMediaStreamId(st.recordingTabId); }
  catch (e) { await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) }); return { ok: false }; }
  await ensureOffscreen();
  await sendOffscreen({ type: MSG.OFFSCREEN_START, streamId, sourceKind: "tab", withMic: st.withMic, withSystemAudio: st.withSystemAudio, videoFormat: st.videoFormat || "mp4", fps: st.videoFps || 30, maxHeight: st.videoMaxHeight || 2160 });
  return { ok: true };
}

async function stopRecording(discard) {
  const st = await getState();
  if (!st.phase || st.phase === PHASE.IDLE) return { ok: true };
  if (await chrome.offscreen.hasDocument()) await sendOffscreen({ type: MSG.OFFSCREEN_STOP, discard });
  else await setState({ phase: PHASE.IDLE });
  return { ok: true };
}

async function pauseResume(pause) {
  const st = await getState();
  if (st.phase !== PHASE.RECORDING) return { ok: true };
  if (!(await chrome.offscreen.hasDocument())) return { ok: true };
  if (pause && !st.paused) { await sendOffscreen({ type: MSG.OFFSCREEN_PAUSE }); await setState({ paused: true, pausedAt: Date.now() }); }
  else if (!pause && st.paused) { await sendOffscreen({ type: MSG.OFFSCREEN_RESUME }); await setState({ paused: false, pausedAt: null, pausedTotalMs: (st.pausedTotalMs || 0) + (Date.now() - (st.pausedAt || Date.now())) }); }
  return { ok: true };
}

// ── offscreen (tab / video circle) ────────────────────────────────────────────
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({ url: "src/offscreen/offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: "Record tab audio & video to MP4 locally." }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}
async function closeOffscreen() { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {}); }
function sendOffscreen(message) { return chrome.runtime.sendMessage({ ...message, target: TARGET.OFFSCREEN }); }

// ── helpers ──────────────────────────────────────────────────────────────────
function getTabMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try { chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => { const err = chrome.runtime.lastError; err ? reject(new Error(err.message)) : resolve(id); }); }
    catch (e) { reject(e); }
  });
}
function injectFile(tabId, file) { return chrome.scripting.executeScript({ target: { tabId }, files: [file] }); }

async function getActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.url === undefined) {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const win = wins.find((w) => w.focused) || wins[0];
    tab = win?.tabs?.find((t) => t.active) || tab;
  }
  if (!tab) throw new Error("No active tab found.");
  return tab;
}
function isInjectable(url) {
  const u = url || "";
  if (!u) return false;
  return !(/^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|data):/i.test(u) || u.startsWith("https://chromewebstore.google.com") || u.startsWith("https://chrome.google.com/webstore"));
}
function assertCapturable(tab) { if (!isInjectable(tab.url)) throw new Error("This browser page can't be captured — open a normal website tab and try again."); }

async function dataUrlToBitmap(dataUrl) { return createImageBitmap(await (await fetch(dataUrl)).blob()); }
async function makeThumbDataUrl(source, w, h, maxW) {
  const scale = Math.min(1, maxW / w);
  const c = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return canvasToPngDataUrl(c);
}
async function canvasToPngDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return `data:image/png;base64,${btoa(binary)}`;
}
