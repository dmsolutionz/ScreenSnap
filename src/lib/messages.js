// Shared message/type constants + settings helpers.
// Imported by the service worker, offscreen document, popup, and recorder window (all ES modules).
// The injected page overlays in src/content/*.js can't import this; they hardcode the same strings.

export const MSG = Object.freeze({
  // popup -> service worker
  CAPTURE_VISIBLE: "capture-visible",
  CAPTURE_FULLPAGE: "capture-fullpage",
  START_RECORDING: "start-recording",
  STOP_RECORDING: "stop-recording",
  CANCEL_RECORDING: "cancel-recording",
  RESTART_RECORDING: "restart-recording", // discard the current take and re-run the countdown, same settings
  PAUSE_RECORDING: "pause-recording",
  RESUME_RECORDING: "resume-recording",
  SET_DRAW: "set-draw", // {on} toggle the on-page pen/draw overlay
  GET_STATE: "get-state",

  // captured-screenshot card actions (popup -> service worker)
  SHOT_ANNOTATE: "shot-annotate",
  SHOT_SAVE: "shot-save",
  SHOT_COPY: "shot-copy",
  SHOT_DISCARD: "shot-discard",

  // annotation editor overlay <-> service worker
  EDITOR_GET_IMAGE: "editor-get-image",
  EDITOR_SAVE: "editor-save",
  EDITOR_CANCEL: "editor-cancel",

  // on-page control / webcam bubble -> service worker: countdown finished, begin the actual capture
  VC_GO: "videocircle-go",
  REC_GO: "rec-go",

  // live recording controls (popup / on-page bar / bubble -> service worker)
  SET_MIC_MUTED: "set-mic-muted", // {muted} mute/unmute the mic mid-recording
  SET_BUBBLE: "set-bubble", // {shape?, size?, hidden?} change the Screen+Cam camera bubble live

  // service worker -> offscreen document
  OFFSCREEN_START: "offscreen-start",
  OFFSCREEN_STOP: "offscreen-stop",
  OFFSCREEN_PAUSE: "offscreen-pause",
  OFFSCREEN_RESUME: "offscreen-resume",
  OFFSCREEN_SET_MIC: "offscreen-set-mic", // {muted} toggle the mic track in the recorded mix
  OFFSCREEN_SET_BUBBLE: "offscreen-set-bubble", // {shape?,size?,mirror?,hidden?,corner?} live-tweak the composited camera

  // offscreen document -> service worker
  REC_STARTED: "rec-started",
  REC_PHASE: "rec-phase",
  REC_PROGRESS: "rec-progress",
  REC_DONE: "rec-done",
  REC_ERROR: "rec-error",
  REC_SURFACE: "rec-surface", // {displaySurface} which surface getDisplayMedia captured (monitor|window|browser)

  // Screen + Cam live preview window (src/preview/) -> service worker
  PREVIEW_READY: "preview-ready", // {pip} the floating camera preview is up (pip=true) or skipped (pip=false)
  PREVIEW_CLOSED: "preview-closed", // the user closed the floating preview — drop it, don't stop the take

  // service worker -> popup / recorder window / overlays (broadcast)
  STATE_CHANGED: "state-changed",

  // popup -> service worker: open the just-recorded clip in the video editor
  EDITOR_OPEN_CLIP: "editor-open-clip",
});

export const TARGET = Object.freeze({ SW: "sw", OFFSCREEN: "offscreen" });

export const PHASE = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  TRANSCODING: "transcoding",
  SAVING: "saving",
});

// Source kinds for recording. TAB / VIDEO_CIRCLE both capture the current tab (video-circle adds the
// on-page camera bubble); SCREEN captures a whole monitor or another window via getDisplayMedia (run in
// the offscreen document).
export const SOURCE = Object.freeze({ TAB: "tab", VIDEO_CIRCLE: "videocircle", SCREEN: "screen" });

export const DEFAULT_SETTINGS = Object.freeze({
  withMic: true,
  withSystemAudio: true,
  videoFormat: "mp4", // mp4 | webm (no UI toggle; MP4 by default per design)
  videoMaxHeight: 2160,
  videoFps: 30,
  countdownSec: 3, // 0 = start instantly; otherwise the 3-2-1 length before capture
  bubbleShape: "circle", // circle | square — Screen + Cam camera bubble
  bubbleSize: "md", // sm | md | lg
  bubbleCorner: "br", // tl | tr | bl | br — which corner the composited camera sits in
  camMirror: true, // mirror the camera (self-view); off = text behind you reads correctly
});

// Allowed values + pure normalizers for the new live controls, so the popup, overlays, and tests agree.
export const COUNTDOWN_OPTIONS = Object.freeze([0, 3, 5, 10]);
export const BUBBLE_SIZES = Object.freeze({ sm: 104, md: 140, lg: 184 }); // diameter in px
export const BUBBLE_SHAPES = Object.freeze(["circle", "square"]);

export function normalizeCountdown(sec) {
  const n = Math.round(Number(sec));
  return COUNTDOWN_OPTIONS.includes(n) ? n : 3;
}
export function bubbleSizePx(size) {
  return BUBBLE_SIZES[size] || BUBBLE_SIZES.md;
}
export function bubbleRadius(shape, sizePx) {
  return shape === "square" ? Math.round(sizePx * 0.18) : Math.round(sizePx / 2);
}
// Derive the options for a RESTARTED take from the current recording state: carry the user's choices
// (source, audio, video quality, countdown, bubble) + pin the original tab; drop all transient fields
// (startedAt, paused*, clipId, phase). Pure so it's unit-testable.
export function restartOptions(state) {
  const s = state || {};
  return {
    tabId: s.recordingTabId,
    recordSource: s.source,
    withMic: s.withMic,
    withSystemAudio: s.withSystemAudio,
    videoFormat: s.videoFormat,
    videoFps: s.videoFps,
    videoMaxHeight: s.videoMaxHeight,
    countdownSec: s.countdownSec,
    bubbleShape: s.bubbleShape,
    bubbleSize: s.bubbleSize,
    camMirror: s.camMirror,
  };
}

// Keep a draggable box fully inside the viewport (used by the webcam bubble drag + resize). Pure so the
// clamp math is unit-testable even though the content script that uses it can't import this module.
export function clampToViewport(x, y, w, h, vw, vh, margin = 4) {
  return {
    x: Math.max(margin, Math.min(vw - w - margin, x)),
    y: Math.max(margin, Math.min(vh - h - margin, y)),
  };
}

// Pure settings merge: defaults, then stored overrides, then a patch. Extracted so it can be unit-tested
// without chrome.storage (see test/messages.test.js).
export function mergeSettings(stored, patch) {
  return { ...DEFAULT_SETTINGS, ...(stored || {}), ...(patch || {}) };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return mergeSettings(settings);
}

export async function setSettings(patch) {
  const next = mergeSettings(await getSettings(), patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Elapsed recording time in ms, accounting for paused spans. Used by the popup, recorder window,
// and the on-page control overlays.
export function elapsedMs(state, now = Date.now()) {
  if (!state || !state.startedAt) return 0;
  const end = state.paused && state.pausedAt ? state.pausedAt : now;
  return Math.max(0, end - state.startedAt - (state.pausedTotalMs || 0));
}

// Filesystem-safe timestamp for download names, e.g. "2026-06-09_16-30-00".
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(
    d.getMinutes()
  )}-${p(d.getSeconds())}`;
}

// "HH:MM:SS" / "MM:SS" formatter shared by all timers.
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}
