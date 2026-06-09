// Service worker — orchestrates everything. No DOM here: screenshots are stitched/cropped with
// OffscreenCanvas; recording happens in the offscreen document; overlays/windows are injected/opened
// on demand. Recordings are saved as native MP4 (no transcoding) — see offscreen.js.
import { MSG, TARGET, PHASE, SOURCE, getSettings, stamp, elapsedMs } from "../lib/messages.js";
import { preparePageForCapture, gotoTile, restorePageAfterCapture } from "../content/fullpage.js";
import { selectArea } from "../content/area-select.js";

const STATE_KEY = "recordingState";
const DL_DIR = "screensnap";
const MAX_CANVAS_SIDE = 16384;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Pending screenshot held in memory (NOT chrome.storage.session — a full-page PNG data URL can be
// tens of MB and blows past the session-storage quota). { tabId, dataUrl, filename }.
let pendingCapture = null;

// ── message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    case MSG.CAPTURE_AREA:
      return doScreenshot("area");

    case MSG.SHOT_ANNOTATE:
      return shotAnnotate();
    case MSG.SHOT_SAVE:
      return shotSave();
    case MSG.SHOT_COPY:
      return shotCopy();
    case MSG.SHOT_DISCARD:
      return shotClear();
    case MSG.EDITOR_GET_IMAGE:
      return editorGetImage(sender);
    case MSG.EDITOR_SAVE:
      return editorSave(msg);
    case MSG.EDITOR_CANCEL:
      return editorCancel(sender);

    case MSG.START_RECORDING:
      return startRecording(msg.options || {});
    case MSG.RW_CHOOSE:
      return recorderWindowChoose();
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

    // ── from the offscreen document ──
    case MSG.REC_STARTED: {
      const res = await setState({
        phase: PHASE.RECORDING,
        startedAt: Date.now(),
        mime: msg.mime,
        error: null,
        note: null,
        lastSaved: null,
        paused: false,
        pausedAt: null,
        pausedTotalMs: 0,
        recordedDurationMs: 0,
      });
      await injectOverlay();
      return res;
    }
    case MSG.REC_PHASE: {
      const st = await getState();
      const patch = { phase: msg.phase };
      if ((msg.phase === PHASE.SAVING || msg.phase === PHASE.TRANSCODING) && !st.recordedDurationMs) {
        patch.recordedDurationMs = elapsedMs(st);
      }
      return setState(patch);
    }
    case MSG.REC_PROGRESS:
      return setState({ phase: PHASE.TRANSCODING, progress: msg.progress });
    case MSG.REC_DONE:
      await setState({ phase: PHASE.IDLE, progress: 0, lastSaved: msg.filename || null, note: msg.note || null, error: null });
      await closeOffscreen();
      await closeRecorderWindow();
      return { ok: true };
    case MSG.REC_ERROR:
      await setState({ phase: PHASE.IDLE, progress: 0, error: msg.message || "Recording failed." });
      await closeOffscreen();
      await closeRecorderWindow();
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
  chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, state: next }).catch(() => {}); // popup + recorder window
  if (next.recordingTabId != null) {
    chrome.tabs.sendMessage(next.recordingTabId, { type: MSG.STATE_CHANGED, state: next }).catch(() => {}); // on-page overlay
  }
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

// If the user closes the recorder window mid-recording, stop gracefully.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { recorderWindowId } = await chrome.storage.session.get("recorderWindowId");
  if (recorderWindowId === windowId) {
    await chrome.storage.session.remove("recorderWindowId");
    const st = await getState();
    if (st.phase && st.phase !== PHASE.IDLE) await stopRecording(false);
  }
});

// ── screenshots ──────────────────────────────────────────────────────────────
async function doScreenshot(mode) {
  const tab = await getActiveTab();
  assertCapturable(tab);

  let dataUrl;
  let prefix;
  if (mode === "visible") {
    dataUrl = await captureWithRetry(tab.windowId);
    prefix = "screenshot";
  } else if (mode === "fullpage") {
    dataUrl = await captureFullPage(tab);
    prefix = "fullpage";
  } else {
    dataUrl = await captureArea(tab);
    if (!dataUrl) return { ok: true, cancelled: true };
    prefix = "area";
  }

  const filename = `${DL_DIR}/${prefix}-${stamp()}.png`;
  pendingCapture = { tabId: tab.id, dataUrl, filename };
  const { thumb, w, h } = await makeThumb(dataUrl, 320);
  return { ok: true, captured: true, thumb, filename, width: w, height: h };
}

async function shotAnnotate() {
  if (!pendingCapture) return { ok: false, error: "Nothing to annotate." };
  await chrome.scripting.executeScript({ target: { tabId: pendingCapture.tabId }, files: ["src/content/editor-overlay.js"] });
  return { ok: true }; // editor reads the image via EDITOR_GET_IMAGE
}
async function shotSave() {
  if (!pendingCapture) return { ok: false, error: "Nothing to save." };
  const { dataUrl, filename } = pendingCapture;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  pendingCapture = null;
  return { ok: true, filename };
}
async function shotCopy() {
  return pendingCapture ? { ok: true, dataUrl: pendingCapture.dataUrl } : { ok: false };
}
async function shotClear() {
  pendingCapture = null;
  return { ok: true };
}

async function editorGetImage() {
  if (!pendingCapture) return { ok: false, error: "no pending image" };
  return { ok: true, dataUrl: pendingCapture.dataUrl, filename: pendingCapture.filename };
}
async function editorSave(msg) {
  await chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename || `${DL_DIR}/screenshot-${stamp()}.png`, saveAs: false });
  pendingCapture = null;
  return { ok: true };
}
async function editorCancel() {
  pendingCapture = null;
  return { ok: true };
}

async function captureFullPage(tab) {
  const run = (func, args = []) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }).then((r) => r[0]?.result);

  const m = await run(preparePageForCapture);
  try {
    const { dpr } = m;
    const scale = Math.min(1, MAX_CANVAS_SIDE / (m.pageW * dpr), MAX_CANVAS_SIDE / (m.pageH * dpr));
    const canvas = new OffscreenCanvas(Math.round(m.pageW * dpr * scale), Math.round(m.pageH * dpr * scale));
    const ctx = canvas.getContext("2d");
    const maxX = Math.max(0, m.pageW - m.viewW);
    const maxY = Math.max(0, m.pageH - m.viewH);
    const seen = new Set();
    let tile = 0;
    for (let y = 0; y <= maxY; y += m.viewH) {
      for (let x = 0; x <= maxX; x += m.viewW) {
        const pos = await run(gotoTile, [Math.min(x, maxX), Math.min(y, maxY), tile > 0]);
        const key = `${pos.scrollX},${pos.scrollY}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await delay(tile === 0 ? 220 : 130);
        const bmp = await dataUrlToBitmap(await captureWithRetry(tab.windowId));
        ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, Math.round(pos.scrollX * dpr * scale), Math.round(pos.scrollY * dpr * scale), bmp.width * scale, bmp.height * scale);
        bmp.close?.();
        tile++;
      }
    }
    return canvasToPngDataUrl(canvas);
  } finally {
    await run(restorePageAfterCapture).catch(() => {});
  }
}

async function captureArea(tab) {
  const [{ result: rect } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectArea });
  if (!rect) return null;
  await delay(150);
  const bmp = await dataUrlToBitmap(await captureWithRetry(tab.windowId));
  const { dpr } = rect;
  const sw = Math.round(rect.w * dpr);
  const sh = Math.round(rect.h * dpr);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, Math.round(rect.x * dpr), Math.round(rect.y * dpr), sw, sh, 0, 0, sw, sh);
  bmp.close?.();
  return canvasToPngDataUrl(canvas);
}

let lastCaptureAt = 0;
async function captureWithRetry(windowId, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const wait = Math.max(0, 520 - (Date.now() - lastCaptureAt));
    if (wait) await delay(wait);
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureAt = Date.now();
      return url;
    } catch (e) {
      lastErr = e;
      lastCaptureAt = Date.now();
      if (i < attempts - 1) await delay(650);
    }
  }
  throw lastErr;
}

// ── recording ──────────────────────────────────────────────────────────────────
async function startRecording(options) {
  const opts = { ...(await getSettings()), ...options };

  if (opts.recordSource === SOURCE.SCREEN) {
    await openRecorderWindow();
    return { ok: true, recorderWindow: true };
  }

  // Current tab or Video Circle — both capture the current tab (the webcam bubble lives in the page).
  const tab = await getActiveTab();
  assertCapturable(tab);
  await setState({
    phase: PHASE.PREPARING,
    source: opts.recordSource,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    recordingTabId: tab.id,
    controlInjectable: isInjectable(tab.url),
    paused: false,
    pausedAt: null,
    pausedTotalMs: 0,
    recordedDurationMs: 0,
    error: null,
    note: null,
    lastSaved: null,
  });

  let streamId;
  try {
    streamId = await getTabMediaStreamId(tab.id);
  } catch (e) {
    await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) });
    throw e;
  }
  await ensureOffscreen();
  await sendOffscreen({
    type: MSG.OFFSCREEN_START,
    streamId,
    sourceKind: "tab",
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    videoFormat: opts.videoFormat,
    fps: opts.videoFps,
    maxHeight: opts.videoMaxHeight,
  });
  return { ok: true };
}

async function recorderWindowChoose() {
  const settings = await getSettings();
  const { streamId } = await chooseDesktopMedia();
  if (!streamId) return { ok: true, cancelled: true }; // picker dismissed; window stays in "waiting"

  await setState({
    phase: PHASE.PREPARING,
    source: SOURCE.SCREEN,
    withMic: settings.withMic,
    withSystemAudio: settings.withSystemAudio,
    recordingTabId: null,
    controlInjectable: false,
    paused: false,
    pausedAt: null,
    pausedTotalMs: 0,
    recordedDurationMs: 0,
    error: null,
    note: null,
    lastSaved: null,
  });
  await ensureOffscreen();
  await sendOffscreen({
    type: MSG.OFFSCREEN_START,
    streamId,
    sourceKind: "desktop",
    withMic: settings.withMic,
    withSystemAudio: settings.withSystemAudio,
    videoFormat: settings.videoFormat,
    fps: settings.videoFps,
    maxHeight: settings.videoMaxHeight,
  });
  return { ok: true };
}

async function stopRecording(discard) {
  const state = await getState();
  if (!state.phase || state.phase === PHASE.IDLE) return { ok: true };
  if (await chrome.offscreen.hasDocument()) {
    await sendOffscreen({ type: MSG.OFFSCREEN_STOP, discard });
  } else {
    await setState({ phase: PHASE.IDLE });
    await closeRecorderWindow();
  }
  return { ok: true };
}

async function pauseResume(pause) {
  const st = await getState();
  if (st.phase !== PHASE.RECORDING || !(await chrome.offscreen.hasDocument())) return { ok: true };
  if (pause && !st.paused) {
    await sendOffscreen({ type: MSG.OFFSCREEN_PAUSE });
    await setState({ paused: true, pausedAt: Date.now() });
  } else if (!pause && st.paused) {
    await sendOffscreen({ type: MSG.OFFSCREEN_RESUME });
    const pausedTotalMs = (st.pausedTotalMs || 0) + (Date.now() - (st.pausedAt || Date.now()));
    await setState({ paused: false, pausedAt: null, pausedTotalMs });
  }
  return { ok: true };
}

// inject the right on-page overlay for the recording source
async function injectOverlay() {
  const st = await getState();
  if (st.recordingTabId == null || !st.controlInjectable || st.source === SOURCE.SCREEN) return;
  const file = st.source === SOURCE.VIDEO_CIRCLE ? "src/content/webcam-bubble.js" : "src/content/recorder-control.js";
  try {
    await chrome.scripting.executeScript({ target: { tabId: st.recordingTabId }, files: [file] });
  } catch {
    /* tab not injectable / navigated away — badge still covers it */
  }
}

// ── recorder window (screen / window recording) ──────────────────────────────
async function openRecorderWindow() {
  const { recorderWindowId } = await chrome.storage.session.get("recorderWindowId");
  if (recorderWindowId != null) {
    try {
      await chrome.windows.update(recorderWindowId, { focused: true });
      return;
    } catch {
      /* stale id */
    }
  }
  const win = await chrome.windows.create({
    url: "src/recorder-window/recorder.html",
    type: "popup",
    width: 400,
    height: 184,
    focused: true,
  });
  await chrome.storage.session.set({ recorderWindowId: win.id });
}
async function closeRecorderWindow() {
  const { recorderWindowId } = await chrome.storage.session.get("recorderWindowId");
  if (recorderWindowId != null) {
    await chrome.storage.session.remove("recorderWindowId");
    try {
      await chrome.windows.remove(recorderWindowId);
    } catch {
      /* already closed */
    }
  }
}

// ── offscreen ──────────────────────────────────────────────────────────────────
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Record tab/screen audio & video to MP4 locally.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}
function sendOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: TARGET.OFFSCREEN });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function getTabMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      });
    } catch (e) {
      reject(e);
    }
  });
}
function chooseDesktopMedia() {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab", "audio"], (streamId, options) => {
      resolve({ streamId, options: options || {} });
    });
  });
}

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
  return !(
    /^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|data):/i.test(u) ||
    u.startsWith("https://chromewebstore.google.com") ||
    u.startsWith("https://chrome.google.com/webstore")
  );
}
function assertCapturable(tab) {
  if (!isInjectable(tab.url)) throw new Error("This browser page can't be captured — open a normal website tab and try again.");
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}
async function makeThumb(dataUrl, maxW) {
  const bmp = await dataUrlToBitmap(dataUrl);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(1, maxW / w);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return { thumb: await canvasToPngDataUrl(canvas), w, h };
}
async function canvasToPngDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return `data:image/png;base64,${btoa(binary)}`;
}
