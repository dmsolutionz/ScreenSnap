// Shared message/type constants + settings helpers.
// Imported by the service worker, offscreen document, and popup (all ES modules).
// NOTE: the injected page helpers in src/content/*.js cannot import this (they're serialized
// and run in the page), so they avoid these constants entirely.

export const MSG = Object.freeze({
  // popup -> service worker
  CAPTURE_VISIBLE: "capture-visible",
  CAPTURE_FULLPAGE: "capture-fullpage",
  CAPTURE_AREA: "capture-area",
  START_RECORDING: "start-recording",
  STOP_RECORDING: "stop-recording",
  CANCEL_RECORDING: "cancel-recording",
  GET_STATE: "get-state",

  // service worker -> offscreen document
  OFFSCREEN_START: "offscreen-start",
  OFFSCREEN_STOP: "offscreen-stop",

  // offscreen document -> service worker
  REC_STARTED: "rec-started",
  REC_PHASE: "rec-phase",
  REC_PROGRESS: "rec-progress",
  REC_DONE: "rec-done",
  REC_ERROR: "rec-error",

  // service worker -> popup (broadcast)
  STATE_CHANGED: "state-changed",
});

export const TARGET = Object.freeze({ SW: "sw", OFFSCREEN: "offscreen", POPUP: "popup" });

export const PHASE = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  TRANSCODING: "transcoding",
  SAVING: "saving",
});

export const DEFAULT_SETTINGS = Object.freeze({
  screenshotMode: "visible", // visible | fullpage | area
  videoFormat: "mp4", // mp4 | webm
  recordSource: "tab", // tab | screen
  withMic: false,
  withSystemAudio: true,
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

// Filesystem-safe timestamp for download names, e.g. "2026-06-09_16-30-00".
export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(
    d.getMinutes()
  )}-${p(d.getSeconds())}`;
}
