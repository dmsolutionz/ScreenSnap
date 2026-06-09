// Shared message/type constants + settings helpers.
// Imported by the service worker, offscreen document, popup, and recorder window (all ES modules).
// The injected page overlays in src/content/*.js can't import this; they hardcode the same strings.

export const MSG = Object.freeze({
  // popup -> service worker
  CAPTURE_VISIBLE: "capture-visible",
  CAPTURE_FULLPAGE: "capture-fullpage",
  CAPTURE_AREA: "capture-area",
  START_RECORDING: "start-recording",
  STOP_RECORDING: "stop-recording",
  CANCEL_RECORDING: "cancel-recording",
  PAUSE_RECORDING: "pause-recording",
  RESUME_RECORDING: "resume-recording",
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

  // recorder window <-> service worker (screen recording runs in the recorder window via
  // getDisplayMedia — it needs a real user gesture, which the offscreen doc doesn't have)
  SCREEN_STARTED: "screen-started",
  SCREEN_STOPPED: "screen-stopped",
  SCREEN_CONTROL: "screen-control", // SW -> recorder window: { action: 'stop'|'pause'|'resume' }

  // webcam bubble -> service worker: countdown finished, begin the actual recording
  VC_GO: "videocircle-go",

  // service worker -> offscreen document
  OFFSCREEN_START: "offscreen-start",
  OFFSCREEN_STOP: "offscreen-stop",
  OFFSCREEN_PAUSE: "offscreen-pause",
  OFFSCREEN_RESUME: "offscreen-resume",

  // offscreen document -> service worker
  REC_STARTED: "rec-started",
  REC_PHASE: "rec-phase",
  REC_PROGRESS: "rec-progress",
  REC_DONE: "rec-done",
  REC_ERROR: "rec-error",

  // service worker -> popup / recorder window / overlays (broadcast)
  STATE_CHANGED: "state-changed",
});

export const TARGET = Object.freeze({ SW: "sw", OFFSCREEN: "offscreen" });

export const PHASE = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  TRANSCODING: "transcoding",
  SAVING: "saving",
});

// Source kinds for recording.
export const SOURCE = Object.freeze({ TAB: "tab", SCREEN: "screen", VIDEO_CIRCLE: "videocircle" });

export const DEFAULT_SETTINGS = Object.freeze({
  withMic: false,
  withSystemAudio: true,
  videoFormat: "mp4", // mp4 | webm (no UI toggle; MP4 by default per design)
  videoMaxHeight: 2160,
  videoFps: 30,
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
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
