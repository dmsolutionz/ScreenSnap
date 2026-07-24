// Service worker — orchestrates everything. No DOM: screenshots stitch with OffscreenCanvas; tab &
// video-circle recording run in the offscreen document. Recordings save as native MP4 (no transcoding).
import { MSG, TARGET, PHASE, SOURCE, getSettings, setSettings, restartOptions, stamp, elapsedMs } from "../lib/messages.js";
import { preparePageForCapture, gotoTile, restorePageAfterCapture } from "../content/fullpage.js";
import { driveConnect, driveDisconnect, driveStatus, uploadToDrive } from "../lib/drive.js";
import { getBlob } from "../editor/idb.js";

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
  // media-permission-result / preview-ready are consumed by one-shot listeners (ensureMediaPermission /
  // openPreviewWindow), not here.
  if (!msg || msg.target === TARGET.OFFSCREEN || msg.type === MSG.STATE_CHANGED || msg.type === "media-permission-result" || msg.type === MSG.PREVIEW_READY) return false;
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
    case MSG.EDITOR_OPEN_CLIP:
      return openEditor(msg.clipId);
    case MSG.EDITOR_GET_IMAGE:
      return editorGetImage();
    case MSG.EDITOR_SAVE:
      return editorSave(msg);
    case MSG.EDITOR_CANCEL:
      return editorCancel();

    // ── opt-in Google Drive backup ──
    case MSG.DRIVE_CONNECT: {
      // Runs here, not in the popup: the consent window steals focus and closes the popup, which
      // would kill an in-popup flow mid-dance. The next popup open reads the stored account.
      const account = await driveConnect();
      return { ok: true, account };
    }
    case MSG.DRIVE_DISCONNECT:
      await driveDisconnect();
      await setState({ drive: null });
      return { ok: true };
    case MSG.DRIVE_UPLOAD_CLIP:
      // Fire-and-forget: progress/result land in state.drive via setState, and the chunked fetches
      // inside uploadToDrive keep this worker alive for the duration.
      void uploadClip(msg.clipId, msg.fileName);
      return { ok: true };

    case MSG.START_RECORDING: {
      // Refuse to start over an active take: re-entering here mid-recording (a stale popup view, a
      // shortcut race) would flip state to PREPARING while the offscreen recorder is still live — its
      // idempotent-start guard then swallows the new OFFSCREEN_START, leaving a stuck timer and a
      // "recording" that never records. Stop the current take first, then start fresh.
      const cur = await getState();
      if (cur.phase === PHASE.RECORDING) return { ok: false, error: "Already recording — stop the current recording first." };
      return startRecording(msg.options || {});
    }
    case MSG.VC_GO:
    case MSG.REC_GO:
      return beginCapture();
    case MSG.STOP_RECORDING:
      return stopRecording(false);
    case MSG.CANCEL_RECORDING:
      return stopRecording(true);
    case MSG.RESTART_RECORDING:
      return restartRecording();
    case MSG.PAUSE_RECORDING:
      return pauseResume(true);
    case MSG.RESUME_RECORDING:
      return pauseResume(false);
    case MSG.SET_MIC_MUTED:
      return setMicMuted(!!msg.muted);
    case MSG.SET_BUBBLE:
      return setBubble(msg);
    case MSG.SET_DRAW:
      return setDraw(!!msg.on);
    case MSG.REC_SURFACE:
      // The offscreen doc learned which surface getDisplayMedia captured; mirror it into state so the popup can
      // adapt (camIsPip = the floating PiP IS the recorded camera, i.e. entire-screen + cam). We deliberately do
      // NOT close the PiP here — it stays floating as the live preview / controls HUD for the whole recording.
      // (For window/tab + cam the camera is also composited; converting that PiP to controls-only is the planned
      // HUD follow-up so the same camera isn't opened twice.)
      return setState({ displaySurface: msg.displaySurface || null, camIsPip: !!msg.camIsPip });

    case MSG.PREVIEW_CLOSED:
      // User closed the floating camera preview. Drop it — do NOT stop the take (shortcuts/badge/composite still
      // own the recording). On an entire-screen share this just removes the camera from here on.
      return { ok: true };

    // ── from the offscreen document (tab / screen / screen+cam) ──
    case MSG.REC_STARTED: {
      // Recording has begun in the offscreen doc; flip state to RECORDING. The on-page control bar
      // (recorder-control.js) was already injected by startRecording() and reacts to STATE_CHANGED.
      // Clearing startInFlight re-arms beginCapture.
      startInFlight = false;
      // If we already returned to IDLE, the user stopped/cancelled while the screen picker was still open
      // (then picked anyway). Don't resurrect a RECORDING UI — the offscreen's queued stop discards it.
      const st0 = await getState();
      if (!st0.phase || st0.phase === PHASE.IDLE) return { ok: true };
      return setState({
        phase: PHASE.RECORDING, startedAt: Date.now(), mime: msg.mime,
        paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null,
      });
    }
    case MSG.REC_PHASE: {
      const st = await getState();
      const patch = { phase: msg.phase };
      if ((msg.phase === PHASE.SAVING || msg.phase === PHASE.TRANSCODING) && !st.recordedDurationMs) patch.recordedDurationMs = elapsedMs(st);
      return setState(patch);
    }
    case MSG.REC_DONE:
      startInFlight = false;
      // Restart: the just-finished take was discarded on purpose; immediately re-prepare with the same
      // settings instead of going idle / opening the editor.
      if (pendingRestart) { pendingRestart = false; await closeOffscreen(); await startRecording(restartOpts || {}); return { ok: true }; }
      await setState({ phase: PHASE.IDLE, progress: 0, lastSaved: msg.filename || null, note: msg.note || null, error: null, clipId: msg.clipId || null });
      await closeOffscreen();
      await closePreviewWindow();
      // Land the finished recording in the editor, where the user can Download it as-is or edit it.
      if (msg.clipId) await openEditor(msg.clipId);
      // Opt-in cloud backup: push the finished take to the user's Google Drive in the background.
      // Not awaited — the editor/popup follow along via state.drive, and a failure only marks state.
      if (msg.clipId) void maybeAutoUpload(msg.clipId, msg.filename);
      return { ok: true };
    case MSG.REC_ERROR:
      startInFlight = false;
      pendingRestart = false; restartOpts = null; // abandon any in-flight restart; a stale flag would later eat a good take
      await setState({ phase: PHASE.IDLE, progress: 0, error: msg.message || "Recording failed." });
      await closeOffscreen();
      await closePreviewWindow();
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

// First run: open a welcome page that explains screensnap and lets the user grant "all sites" access up
// front (with a click — the gesture chrome.permissions.request needs), so recordings never hit a
// mid-flow permission prompt. Optional: declining just falls back to the at-record-start request.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/onboarding.html") }).catch(() => {});
});

// On-page control overlays (Loom-style): the recorder-control bar and the draw-overlay pen are content
// scripts, so a reload/navigation of the recorded tab tears them down. Re-inject them when the tab finishes
// loading while a recording is active so they reappear. This works across *any* site
// only when the user granted the optional <all_urls> host permission (requested at record-start); without
// it executeScript is denied cross-origin and the overlays reappear on same-origin reloads only. The
// overlays skip their countdown on re-entry (state is already past "preparing"). The control bar is
// collapsed/auto-hidden during recording so it stays out of the capture (like Loom) — see recorder-control.js.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const st = await getState();
  if (st.recordingTabId !== tabId) return;
  if (st.phase !== PHASE.PREPARING && st.phase !== PHASE.RECORDING) return;
  if (st.drawActive) injectFile(tabId, "src/content/draw-overlay.js").catch(() => {}); // pen follows navigation
  injectFile(tabId, "src/content/recorder-control.js").catch(() => {});
});

// Global keyboard shortcuts (manifest "commands"): stop / pause-resume the active recording from anywhere
// in Chrome — so the recording is fully operable even with the on-page control bar collapsed/hidden (which
// keeps it out of the capture). This is how Loom keeps recordings clean: hidden controls + shortcuts.
chrome.commands.onCommand.addListener(async (command) => {
  const st = await getState();
  if (!st.phase || st.phase === PHASE.IDLE) return;
  if (command === "stop-recording") return void stopRecording(false);
  if (command === "cancel-recording") return void stopRecording(true);
  if (command === "restart-recording") return void restartRecording();
  if (command === "pause-recording") return void pauseResume(!st.paused);
});

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
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  pendingCapture = null;
  return { ok: true, filename };
}
async function shotCopy() { return pendingCapture ? { ok: true, dataUrl: pendingCapture.dataUrl } : { ok: false }; }
async function shotClear() { pendingCapture = null; return { ok: true }; }
// Open the video editor on a previously-recorded clip (persisted in IndexedDB by the offscreen
// document). This is the ONLY place that opens the editor tab.
async function openEditor(clipId) {
  if (!clipId) return { ok: false, error: "No clip to edit." };
  const url = chrome.runtime.getURL("src/editor/editor.html") + "?clipId=" + encodeURIComponent(clipId);
  await chrome.tabs.create({ url });
  return { ok: true };
}
async function editorGetImage() { return pendingCapture ? { ok: true, dataUrl: pendingCapture.dataUrl, filename: pendingCapture.filename } : { ok: false, error: "no pending image" }; }
async function editorSave(msg) {
  // The payload arrives from the injected editor overlay. Constrain it so this can only ever write a
  // PNG into the screensnap/ download folder — never an arbitrary URL or path-shaped filename.
  if (typeof msg.dataUrl !== "string" || !msg.dataUrl.startsWith("data:image/png;base64,")) {
    return { ok: false, error: "Invalid image data." };
  }
  const filename = typeof msg.filename === "string" && /^screensnap\/[\w.-]+\.png$/.test(msg.filename)
    ? msg.filename
    : `${DL_DIR}/screenshot-${stamp()}.png`;
  await chrome.downloads.download({ url: msg.dataUrl, filename, saveAs: true });
  pendingCapture = null;
  return { ok: true };
}
async function editorCancel() { pendingCapture = null; return { ok: true }; }

// ── Google Drive backup (opt-in) ─────────────────────────────────────────────
// Auto-upload gate for a just-finished recording: only when the user flipped the setting on AND
// connected an account. Everything else is a silent no-op — the default build never touches the network.
async function maybeAutoUpload(clipId, fileName) {
  try {
    const [settings, status] = await Promise.all([getSettings(), driveStatus()]);
    if (!settings.driveAutoUpload || !status.connected || !status.configured) return;
    await uploadClip(clipId, fileName);
  } catch {}
}

// Read the stashed clip back out of IndexedDB and push it to Drive, mirroring progress into
// state.drive ({ status: uploading|done|error, pct, fileName, link?, error? }) so the popup and
// done-card can render it live. Progress ticks arrive per 8 MiB chunk, so setState stays cheap.
async function uploadClip(clipId, fileName) {
  if (!clipId) return;
  const name = (fileName || "recording.mp4").split("/").pop();
  try {
    const clip = await getBlob(clipId);
    if (!clip || !clip.blob) throw new Error("Recording not found — it may have been cleared.");
    await setState({ drive: { status: "uploading", pct: 0, fileName: name } });
    let lastPct = -1;
    const res = await uploadToDrive(clip.blob, name, {
      onProgress: (done, total) => {
        // Clamp to 99: the final tick's setState is fire-and-forget and could land AFTER the
        // "done" write below, leaving state stuck on "uploading 100%". Done is the done-write's job.
        const pct = Math.min(99, total ? Math.round((done / total) * 100) : 0);
        if (pct === lastPct) return;
        lastPct = pct;
        void setState({ drive: { status: "uploading", pct, fileName: name } });
      },
    });
    await setState({ drive: { status: "done", pct: 100, fileName: name, link: res.webViewLink || null } });
  } catch (e) {
    await setState({ drive: { status: "error", fileName: name, error: String((e && e.message) || e) } });
  }
}

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
  startInFlight = false; pendingRestart = false; // fresh recording — clear any stale in-flight/restart guards
  const opts = { ...(await getSettings()), ...options };

  // Screen-based capture (whole screen / window, with or without a composited camera) takes a separate
  // path: the offscreen doc opens Chrome's native picker (getDisplayMedia), not a tab, so it works even when
  // the active tab is a chrome:// page. Screen + Cam (VIDEO_CIRCLE) composites the webcam in a corner there.
  if (opts.recordSource === SOURCE.SCREEN || opts.recordSource === SOURCE.VIDEO_CIRCLE) return startScreenRecording(opts);

  // ── Current Tab capture (tabCapture) ──
  // On restart we pin the ORIGINAL recording tab (options.tabId) so a tab switch can't redirect the take;
  // fall back to the active tab if we can't read it (e.g. no host permission for that tab's url).
  let tab = null;
  if (options.tabId != null) { tab = await chrome.tabs.get(options.tabId).catch(() => null); if (tab && tab.url === undefined) tab = null; }
  if (!tab) tab = await getActiveTab();
  assertCapturable(tab);

  // The mic is captured in the offscreen document, which can't show a permission prompt. Grant it
  // here (a dedicated extension page can prompt) before we start; if denied, record without it.
  let withMic = !!opts.withMic;
  if (withMic) withMic = await ensureMediaPermission("mic");

  // Two-phase: a 3-2-1 countdown first, then REC_GO begins the actual capture. The control is a Loom-style
  // on-page bar (recorder-control.js), bottom-left, collapsed/auto-hidden during recording so it stays out
  // of the capture — and re-injected on navigation (see tabs.onUpdated). The bar owns the countdown.
  await setState({
    phase: PHASE.PREPARING, source: SOURCE.TAB,
    withMic, withSystemAudio: opts.withSystemAudio, micMuted: false,
    videoFormat: opts.videoFormat, videoFps: opts.videoFps, videoMaxHeight: opts.videoMaxHeight,
    countdownSec: opts.countdownSec, camHidden: false, drawActive: false,
    recordingTabId: tab.id, controlInjectable: isInjectable(tab.url),
    // startedAt is cleared here (it's only set on REC_STARTED): a previous take's value leaking into
    // this one made every timer surface show already-elapsed time before recording even began.
    startedAt: null, paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null, drive: null,
  });
  await injectFile(tab.id, "src/content/recorder-control.js");
  return { ok: true };
}

// Whole-screen / window recording. The picker runs in the OFFSCREEN document via getDisplayMedia(), NOT
// here: a chrome.desktopCapture stream id obtained in the service worker can't be redeemed by an offscreen
// page (it's scoped to a tab's secure origin — and the SW form requires a targetTab anyway), so we let the
// offscreen doc — which has the DISPLAY_MEDIA reason for exactly this — open the picker and consume the
// stream in one context. Unlike tab capture there's no on-page countdown (the native picker is the "get
// ready" beat). The picker can record any monitor or any app window — including non-Chrome apps — so the
// on-page control bar (which can only live in a web page) is best-effort: injected into the active tab,
// visible only while that tab is foreground. The primary controls are the toolbar REC badge, the popup,
// and the keyboard shortcuts.
async function startScreenRecording(opts) {
  // Anchor tab: only used to host the (best-effort) on-page control bar. Capture does NOT depend on it,
  // so a chrome:// active tab — or none at all — is fine.
  const tab = await getActiveTab().catch(() => null);

  // Mic is captured in the offscreen doc, which can't prompt; grant here (a dedicated page can). Camera
  // permission is handled contextually by the Screen + Cam setup window below (it shows the camera, which
  // grants the extension origin so the offscreen composite works too). System audio rides the desktop stream.
  const withCam = opts.recordSource === SOURCE.VIDEO_CIRCLE;
  let withMic = !!opts.withMic;
  if (withMic) withMic = await ensureMediaPermission("mic");

  await setState({
    phase: PHASE.PREPARING, source: withCam ? SOURCE.VIDEO_CIRCLE : SOURCE.SCREEN,
    withMic, withSystemAudio: opts.withSystemAudio, micMuted: false,
    videoFormat: opts.videoFormat, videoFps: opts.videoFps, videoMaxHeight: opts.videoMaxHeight,
    countdownSec: 0, camHidden: false, drawActive: false, displaySurface: null, camIsPip: false, previewWinId: null,
    bubbleShape: opts.bubbleShape, bubbleSize: opts.bubbleSize, bubbleCorner: opts.bubbleCorner, camMirror: opts.camMirror,
    recordingTabId: tab ? tab.id : null, controlInjectable: tab ? isInjectable(tab.url) : false,
    // startedAt cleared for the same reason as the tab path: a stale value from the previous take made
    // the PiP strip / popup timers show elapsed time while this take was still setting up.
    startedAt: null, paused: false, pausedAt: null, pausedTotalMs: 0, recordedDurationMs: 0, error: null, note: null, lastSaved: null, drive: null,
  });

  // Screen + Cam: open the "set up your camera" window first. Its "Start recording" click pops the floating
  // camera (Document PiP — which needs a gesture + a long-lived top-level opener the popup/offscreen can't
  // provide) and signals us to proceed. Closing it without starting cancels. Falls back to composited-only
  // when PiP/camera aren't available.
  let pipActive = false;
  if (withCam) {
    const pv = await openPreviewWindow();
    if (!pv.ready) {
      // User closed the setup window, or it timed out — cancel. Close it if it's somehow still open (timeout
      // path) so its live camera preview doesn't linger with the light on.
      if (pv.winId != null) await chrome.windows.remove(pv.winId).catch(() => {});
      await setState({ phase: PHASE.IDLE });
      return { ok: true };
    }
    pipActive = pv.pip;
    // Track the window for teardown in BOTH cases (pip: it stays minimized hosting the PiP; no-pip: it closes
    // itself, but tracking is a safety net if that self-close ever fails).
    if (pv.winId != null) await setState({ previewWinId: pv.winId });
  }

  // The setup window may have tweaked shape/mirror — re-read so the composite uses the latest.
  const cur = await getSettings();

  // No stream id. The offscreen doc opens the native picker (getDisplayMedia), composites the camera (unless the
  // PiP is the camera on an entire-screen share), and starts the recorder. A dismissed picker → REC_DONE{cancelled}.
  // If creating/messaging the offscreen doc fails, no REC_ERROR comes back, so reset here or it sticks at PREPARING.
  try {
    // A leftover offscreen doc (an abandoned picker, a dead recorder) silently swallows
    // OFFSCREEN_START via its idempotent-start guard — a new take always gets a fresh document.
    await closeOffscreen();
    await ensureOffscreen();
    await sendOffscreen({
      type: MSG.OFFSCREEN_START, sourceKind: "screen", withCam, pipActive,
      withMic, withSystemAudio: opts.withSystemAudio,
      videoFormat: opts.videoFormat || "mp4", fps: opts.videoFps || 30, maxHeight: opts.videoMaxHeight || 2160,
      bubbleShape: cur.bubbleShape, bubbleSize: cur.bubbleSize, bubbleCorner: cur.bubbleCorner, camMirror: cur.camMirror,
    });
  } catch (e) {
    await closePreviewWindow();
    await closeOffscreen();
    await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) });
    return { ok: false };
  }

  // Best-effort on-page controls on the active tab (only visible when that tab is foreground). If the user
  // cancelled the picker, state is already idle and the bar self-destroys on its first state read.
  if (tab && isInjectable(tab.url)) injectFile(tab.id, "src/content/recorder-control.js").catch(() => {});
  return { ok: true };
}

// Countdown finished on the page (VC_GO / REC_GO): begin the actual tab capture now. Single-flight: phase
// stays PREPARING until the offscreen doc replies REC_STARTED, so a second go (e.g. an overlay re-injected
// by a navigation that completes inside this window, or the instant countdownSec=0 path) could otherwise
// pass the phase guard and double-start the recorder. startInFlight closes that window synchronously; it's
// cleared on REC_STARTED / REC_ERROR / REC_DONE / stop. (offscreen.startRecording is also idempotent.)
let startInFlight = false;
async function beginCapture() {
  const st = await getState();
  if (st.phase !== PHASE.PREPARING || st.recordingTabId == null) return { ok: true };
  if (st.source !== SOURCE.TAB) return { ok: true }; // screen / screen+cam start themselves (no on-page countdown/REC_GO)
  if (startInFlight) return { ok: true };
  startInFlight = true;
  let streamId;
  try { streamId = await getTabMediaStreamId(st.recordingTabId); }
  catch (e) { startInFlight = false; await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) }); return { ok: false }; }
  // Measure the tab so the capture can be pinned to a FIXED frame size (min == max constraints). A tab
  // that resizes mid-recording — entering fullscreen, a window resize — otherwise changes the stream's
  // frame dimensions, which Chrome's MP4 muxer can't represent: the recorder errors and the take dies.
  // With a fixed size Chrome scales (letterboxing on aspect change) instead, so fullscreen just works.
  // Best-effort: if the measurement fails the offscreen doc falls back to max-only constraints.
  let fixed = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: st.recordingTabId },
      func: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    });
    const v = res && res.result;
    if (v && v.w > 0 && v.h > 0) {
      const even = (n) => Math.max(2, Math.round(n / 2) * 2); // H.264 wants even dimensions
      const scale = Math.min(1, (st.videoMaxHeight || 2160) / (v.h * v.dpr), 3840 / (v.w * v.dpr));
      fixed = { width: even(v.w * v.dpr * scale), height: even(v.h * v.dpr * scale) };
    }
  } catch {}
  // Reset to idle if the offscreen doc can't be created/messaged — otherwise no REC_ERROR comes back and the
  // state stays stuck at PREPARING.
  try {
    await closeOffscreen(); // a leftover doc would swallow OFFSCREEN_START — new take, fresh document
    await ensureOffscreen();
    await sendOffscreen({ type: MSG.OFFSCREEN_START, streamId, sourceKind: "tab", withMic: st.withMic, withSystemAudio: st.withSystemAudio, videoFormat: st.videoFormat || "mp4", fps: st.videoFps || 30, maxHeight: st.videoMaxHeight || 2160, fixedWidth: fixed ? fixed.width : null, fixedHeight: fixed ? fixed.height : null });
  } catch (e) {
    startInFlight = false; await closeOffscreen(); await setState({ phase: PHASE.IDLE, error: String((e && e.message) || e) }); return { ok: false };
  }
  return { ok: true };
}

// Get microphone or camera access for the extension origin (shared by the offscreen document). An
// extension popup can't reliably prompt — it closes when the prompt steals focus — so we open a small
// extension page that prompts and reports back. Cached per-kind once granted so we only prompt the first
// time. kind is "mic" | "cam".
async function ensureMediaPermission(kind) {
  const flagKey = kind + "PermissionGranted";
  const cached = await chrome.storage.local.get(flagKey);
  if (cached[flagKey]) return true;
  return new Promise((resolve) => {
    let settled = false;
    let winId = null;
    const finish = (granted) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.windows.onRemoved.removeListener(onClosed);
      if (granted) chrome.storage.local.set({ [flagKey]: true });
      resolve(!!granted);
    };
    const onMsg = (m, sender) => {
      if (sender.id === chrome.runtime.id && m && m.type === "media-permission-result" && m.kind === kind) finish(m.granted);
    };
    // If the user dismisses the permission window without answering, proceed without it immediately
    // instead of stalling the recording until the 30s backstop.
    const onClosed = (id) => { if (id === winId) finish(false); };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.windows.onRemoved.addListener(onClosed);
    chrome.windows.create({ url: chrome.runtime.getURL("src/permission/media.html?kind=" + kind), type: "popup", width: 460, height: 280, focused: true })
      .then((w) => { winId = w && w.id; })
      .catch(() => finish(false));
    setTimeout(() => finish(false), 30000); // ultimate backstop
  });
}

// Screen + Cam: open the "set up your camera" window and wait for it to report ready (its "Start recording" click,
// which also pops the floating PiP). Resolves { ready, pip, winId } — ready:false means the user closed the setup
// window without starting (treated as cancel). When pip is true the setup window stays alive (minimized) to host the
// PiP, so we track winId to close it at teardown; when pip is false it closes itself (composited-only).
function openPreviewWindow() {
  return new Promise((resolve) => {
    let winId = null, settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.windows.onRemoved.removeListener(onClosed);
      resolve(v);
    };
    const onMsg = (m, sender) => {
      if (sender.id === chrome.runtime.id && m && m.type === MSG.PREVIEW_READY) done({ ready: true, pip: !!m.pip, winId });
    };
    const onClosed = (id) => { if (id === winId) done({ ready: false, winId: null }); }; // user closed it → already gone
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.windows.onRemoved.addListener(onClosed);
    chrome.windows.create({ url: chrome.runtime.getURL("src/preview/preview.html"), type: "popup", width: 390, height: 560, focused: true })
      .then((w) => { winId = w && w.id; })
      .catch(() => done({ ready: false, winId: null }));
    setTimeout(() => done({ ready: false, winId }), 120000); // backstop: window may still be open → caller closes it
  });
}

// Close the Screen + Cam setup/preview window (which auto-closes its floating PiP). Idempotent.
async function closePreviewWindow() {
  const st = await getState();
  if (st.previewWinId != null) {
    await chrome.windows.remove(st.previewWinId).catch(() => {});
    await setState({ previewWinId: null });
  }
}

async function stopRecording(discard) {
  const st = await getState();
  if (!st.phase || st.phase === PHASE.IDLE) return { ok: true };
  pendingRestart = false; restartOpts = null; // a real stop/cancel supersedes any queued restart
  if (await chrome.offscreen.hasDocument()) {
    // During PREPARING nothing has been recorded yet (e.g. the screen picker is still open), so a "stop"
    // there means discard — otherwise picking a source afterward would save a ~0-length clip. And because
    // OFFSCREEN_STOP can't produce a REC_DONE while the picker blocks, clear state now so the REC badge
    // doesn't stay stuck mid-picker; the offscreen still tears down (its later REC_DONE is idempotent here).
    const preparing = st.phase === PHASE.PREPARING;
    await sendOffscreen({ type: MSG.OFFSCREEN_STOP, discard: discard || preparing });
    // …and during PREPARING also tear the document down: if the screen picker is still open, closing
    // the doc dismisses it — otherwise the picker floats on, and picking later starts a doomed take.
    if (preparing) { startInFlight = false; await closeOffscreen(); await setState({ phase: PHASE.IDLE }); await closePreviewWindow(); }
  } else { startInFlight = false; await setState({ phase: PHASE.IDLE }); await closePreviewWindow(); }
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

// Mute/unmute the mic mid-recording: tell the offscreen doc to toggle the mic track, and mirror it in
// state so the control bar/popup show the right icon (and a re-injected bar restores it).
async function setMicMuted(muted) {
  const st = await getState();
  if (!st.phase || st.phase === PHASE.IDLE) return { ok: true };
  if (await chrome.offscreen.hasDocument()) await sendOffscreen({ type: MSG.OFFSCREEN_SET_MIC, muted });
  await setState({ micMuted: muted });
  return { ok: true };
}

// Change the Screen + Cam camera bubble live (shape / size / corner / mirror / hidden). The bubble is
// composited in the offscreen document, so forward the change there (it reads the values per frame, no
// rebuild). Also mirror into state (so the popup/bar icons reflect it) and persist the layout choices as
// defaults; hidden is per-recording only. `pos` is the corner (tl|tr|bl|br).
async function setBubble(msg) {
  const patch = {};
  if (msg.shape != null) patch.bubbleShape = msg.shape;
  if (msg.size != null) patch.bubbleSize = msg.size;
  if (msg.pos != null) patch.bubbleCorner = msg.pos;
  if (msg.mirror != null) patch.camMirror = !!msg.mirror;
  if (msg.hidden != null) patch.camHidden = !!msg.hidden;
  if (!Object.keys(patch).length) return { ok: true };
  await setState(patch);
  if (await chrome.offscreen.hasDocument()) {
    await sendOffscreen({ type: MSG.OFFSCREEN_SET_BUBBLE, shape: msg.shape, size: msg.size, corner: msg.pos, mirror: msg.mirror, hidden: msg.hidden });
  }
  const persist = {};
  if (msg.shape != null) persist.bubbleShape = msg.shape;
  if (msg.size != null) persist.bubbleSize = msg.size;
  if (msg.pos != null) persist.bubbleCorner = msg.pos;
  if (msg.mirror != null) persist.camMirror = !!msg.mirror;
  if (Object.keys(persist).length) await setSettings(persist);
  return { ok: true };
}

// Restart: discard the current take and re-record with the SAME settings (the Loom "flubbed the intro"
// flow). We tear the recorder down, then re-prepare in the REC_DONE handler (which fires after the
// discard finalizes) so there's no race between teardown and a fresh getTabMediaStreamId.
let pendingRestart = false, restartOpts = null;
async function restartRecording() {
  const st = await getState();
  if (st.phase !== PHASE.RECORDING && st.phase !== PHASE.PREPARING) return { ok: true };
  if (st.source !== SOURCE.TAB) return { ok: true }; // screen / screen+cam restart needs a fresh picker — not supported (bar hides the button)
  restartOpts = restartOptions(st); // carry settings + pin the original tab; drop transient fields
  if (await chrome.offscreen.hasDocument()) {
    pendingRestart = true; // REC_DONE will re-prepare once the discard finalizes
    await sendOffscreen({ type: MSG.OFFSCREEN_STOP, discard: true });
  } else {
    // Still preparing (no capture yet) — just re-prepare immediately.
    startInFlight = false;
    await startRecording(restartOpts);
  }
  return { ok: true };
}

// Toggle the on-page pen/draw overlay. Inject it on first activation; it reads drawActive from state and
// is re-injected on navigation (see tabs.onUpdated). Strokes auto-fade so they don't clutter the capture.
async function setDraw(on) {
  const st = await getState();
  if (!st.phase || st.phase === PHASE.IDLE) return { ok: true };
  await setState({ drawActive: on });
  if (on && st.recordingTabId != null) await injectFile(st.recordingTabId, "src/content/draw-overlay.js").catch(() => {});
  return { ok: true };
}

// ── offscreen (tab / video circle) ────────────────────────────────────────────
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({ url: "src/offscreen/offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA], justification: "Record tab, screen, or camera audio & video to MP4 locally." }).finally(() => { creatingOffscreen = null; });
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
