// Service worker — orchestrates everything. No DOM here: screenshots are stitched/cropped with
// OffscreenCanvas, and all recording + transcoding happens in the offscreen document.
import { MSG, TARGET, PHASE, getSettings, stamp } from "../lib/messages.js";
import { preparePageForCapture, gotoTile, restorePageAfterCapture } from "../content/fullpage.js";
import { selectArea } from "../content/area-select.js";

const STATE_KEY = "recordingState";
const MAX_CANVAS_SIDE = 16384; // safe OffscreenCanvas dimension ceiling
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Broadcasts not addressed to us — let the intended context handle them.
  if (!msg || msg.target === TARGET.OFFSCREEN || msg.type === MSG.STATE_CHANGED) return false;
  handle(msg)
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});

async function handle(msg) {
  switch (msg.type) {
    case MSG.GET_STATE:
      return { ok: true, state: await getState(), settings: await getSettings() };
    case MSG.CAPTURE_VISIBLE:
      return doScreenshot("visible");
    case MSG.CAPTURE_FULLPAGE:
      return doScreenshot("fullpage");
    case MSG.CAPTURE_AREA:
      return doScreenshot("area");
    case MSG.START_RECORDING:
      return startRecording(msg.options || {});
    case MSG.STOP_RECORDING:
      return stopRecording(false);
    case MSG.CANCEL_RECORDING:
      return stopRecording(true);
    // ── from the offscreen document ──
    case MSG.REC_STARTED:
      return setState({
        phase: PHASE.RECORDING,
        startedAt: Date.now(),
        source: msg.source,
        mime: msg.mime,
        willTranscode: !!msg.willTranscode,
        error: null,
        note: null,
        lastSaved: null,
      });
    case MSG.REC_PHASE:
      return setState({ phase: msg.phase });
    case MSG.REC_PROGRESS:
      return setState({ phase: PHASE.TRANSCODING, progress: msg.progress });
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

// ---------------------------------------------------------------------------
// State (persisted in session storage so it survives SW restarts mid-recording)
// ---------------------------------------------------------------------------
async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.session.get(STATE_KEY);
  return s || { phase: PHASE.IDLE };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, state: next }).catch(() => {});
  await reflectBadge(next);
  return { ok: true, state: next };
}

async function reflectBadge(state) {
  const active = state.phase && state.phase !== PHASE.IDLE;
  await chrome.action.setBadgeText({ text: active ? "REC" : "" });
  if (active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" }).catch(() => {});
    await chrome.action.setTitle({ title: "Clippy — recording (click to stop)" });
  } else {
    await chrome.action.setTitle({ title: "Clippy — capture & record" });
  }
}

// Re-sync the badge if the SW was torn down and respawned while recording.
chrome.runtime.onStartup.addListener(() => getState().then(reflectBadge));
getState().then(reflectBadge);

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
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

  const filename = `Clippy/${prefix}-${stamp()}.png`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { ok: true, filename };
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

        await delay(tile === 0 ? 220 : 130); // settle layout / sticky toggling
        const bmp = await dataUrlToBitmap(await captureWithRetry(tab.windowId));
        ctx.drawImage(
          bmp,
          0,
          0,
          bmp.width,
          bmp.height,
          Math.round(pos.scrollX * dpr * scale),
          Math.round(pos.scrollY * dpr * scale),
          bmp.width * scale,
          bmp.height * scale
        );
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
  const [{ result: rect } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: selectArea,
  });
  if (!rect) return null; // cancelled

  await delay(150); // let the overlay removal repaint before we capture
  const bmp = await dataUrlToBitmap(await captureWithRetry(tab.windowId));
  const { dpr } = rect;
  const sw = Math.round(rect.w * dpr);
  const sh = Math.round(rect.h * dpr);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bmp, Math.round(rect.x * dpr), Math.round(rect.y * dpr), sw, sh, 0, 0, sw, sh);
  bmp.close?.();
  return canvasToPngDataUrl(canvas);
}

// captureVisibleTab is rate-limited (~2/sec). Space calls out and retry on quota errors.
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

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------
async function startRecording(options) {
  const opts = { ...(await getSettings()), ...options };
  const tab = await getActiveTab();
  await setState({
    phase: PHASE.PREPARING,
    source: opts.recordSource,
    videoFormat: opts.videoFormat,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    error: null,
  });

  let streamId;
  let sourceKind;
  try {
    if (opts.recordSource === "tab") {
      assertCapturable(tab);
      streamId = await getTabMediaStreamId(tab.id);
      sourceKind = "tab";
    } else {
      const { streamId: id } = await chooseDesktopMedia(tab);
      if (!id) {
        await setState({ phase: PHASE.IDLE });
        return { ok: true, cancelled: true };
      }
      streamId = id;
      sourceKind = "desktop";
    }
  } catch (e) {
    await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) });
    throw e;
  }

  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: TARGET.OFFSCREEN,
    type: MSG.OFFSCREEN_START,
    streamId,
    sourceKind,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    videoFormat: opts.videoFormat,
    fps: opts.videoFps,
    maxHeight: opts.videoMaxHeight,
  });
  return { ok: true };
}

async function stopRecording(discard) {
  const state = await getState();
  if (!state.phase || state.phase === PHASE.IDLE) return { ok: true };
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, type: MSG.OFFSCREEN_STOP, discard });
  } else {
    await setState({ phase: PHASE.IDLE });
  }
  return { ok: true };
}

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

function chooseDesktopMedia(tab) {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab", "audio"], tab, (streamId, options) => {
      resolve({ streamId, options: options || {} });
    });
  });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Record tab/screen audio & video and transcode to MP4 locally.",
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function getActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");
  return tab;
}

function assertCapturable(tab) {
  const url = tab.url || "";
  if (
    /^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|data):/i.test(url) ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("https://chrome.google.com/webstore")
  ) {
    throw new Error("This browser page can't be captured — open a normal website tab and try again.");
  }
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function canvasToPngDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
