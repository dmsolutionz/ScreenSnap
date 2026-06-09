// Popup: UI + message dispatch only. All capture/record work happens in the service worker
// and offscreen document, so the popup closing (e.g. when the screen picker steals focus) never
// interrupts anything — reopening reflects live state via GET_STATE / STATE_CHANGED.
import { MSG, PHASE, getSettings, setSettings } from "../lib/messages.js";

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let timer = null;
let prevPhase = null;

async function init() {
  applySettings(await getSettings());
  wire();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.STATE_CHANGED) handleState(msg.state);
  });
  try {
    const res = await send({ type: MSG.GET_STATE });
    handleState(res?.state || { phase: PHASE.IDLE });
  } catch {
    handleState({ phase: PHASE.IDLE });
  }
}

// ── settings <-> controls ──────────────────────────────────────────────────
function applySettings(s) {
  setSeg("seg-shot", "mode", s.screenshotMode);
  setSeg("seg-source", "source", s.recordSource);
  setSeg("seg-format", "format", s.videoFormat);
  $("opt-mic").checked = !!s.withMic;
  $("opt-sys").checked = !!s.withSystemAudio;
  updateFormatHint(s.videoFormat);
}

function setSeg(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll(".seg")) b.classList.toggle("active", b.dataset[attr] === value);
}
function activeSeg(groupId, attr) {
  return $(groupId).querySelector(".seg.active")?.dataset[attr];
}

function wire() {
  segHandler("seg-shot", "mode", (v) => setSettings({ screenshotMode: v }));
  segHandler("seg-source", "source", (v) => setSettings({ recordSource: v }));
  segHandler("seg-format", "format", (v) => {
    setSettings({ videoFormat: v });
    updateFormatHint(v);
  });
  $("opt-mic").addEventListener("change", (e) => setSettings({ withMic: e.target.checked }));
  $("opt-sys").addEventListener("change", (e) => setSettings({ withSystemAudio: e.target.checked }));

  $("btn-shot").addEventListener("click", onShot);
  $("btn-record").addEventListener("click", onRecord);
  $("btn-stop").addEventListener("click", () => send({ type: MSG.STOP_RECORDING }));
  $("btn-discard").addEventListener("click", () => send({ type: MSG.CANCEL_RECORDING }));
}

function segHandler(groupId, attr, onPick) {
  $(groupId).addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    setSeg(groupId, attr, btn.dataset[attr]);
    onPick(btn.dataset[attr]);
  });
}

// ── actions ─────────────────────────────────────────────────────────────────
async function onShot() {
  const mode = activeSeg("seg-shot", "mode");
  const map = { visible: MSG.CAPTURE_VISIBLE, fullpage: MSG.CAPTURE_FULLPAGE, area: MSG.CAPTURE_AREA };
  setBusy("btn-shot", true, mode === "fullpage" ? "Capturing page…" : mode === "area" ? "Select an area…" : "Capturing…");
  try {
    const res = await send({ type: map[mode] });
    if (res?.cancelled) toast("Cancelled");
    else if (res?.ok) toast("Screenshot saved ✓");
    else toast(res?.error || "Capture failed", true);
  } catch (e) {
    toast(String((e && e.message) || e), true);
  } finally {
    setBusy("btn-shot", false, "Capture screenshot");
  }
}

async function onRecord() {
  const options = {
    recordSource: activeSeg("seg-source", "source"),
    videoFormat: activeSeg("seg-format", "format"),
    withMic: $("opt-mic").checked,
    withSystemAudio: $("opt-sys").checked,
  };
  setBusy("btn-record", true, "Starting…");
  try {
    const res = await send({ type: MSG.START_RECORDING, options });
    if (res?.cancelled) {
      toast("Cancelled");
      setBusy("btn-record", false, "Start recording");
    } else if (res && res.ok === false) {
      toast(res.error || "Couldn't start recording", true);
      setBusy("btn-record", false, "Start recording");
    }
    // success → STATE_CHANGED switches the view (or the popup has already closed for the picker)
  } catch (e) {
    toast(String((e && e.message) || e), true);
    setBusy("btn-record", false, "Start recording");
  }
}

// ── state rendering ──────────────────────────────────────────────────────────
function handleState(state) {
  const phase = (state && state.phase) || PHASE.IDLE;
  renderView(state, phase);

  // Toast only on genuine transitions back to idle (not on initial popup open).
  if (prevPhase && prevPhase !== PHASE.IDLE && phase === PHASE.IDLE) {
    if (state?.error) toast(state.error, true);
    else if (state?.note) toast(state.note, true);
    else if (state?.lastSaved) toast("Saved ✓");
    else toast("Stopped");
    setBusy("btn-record", false, "Start recording");
  }
  prevPhase = phase;
}

function renderView(state, phase) {
  const recording = phase !== PHASE.IDLE;
  $("idle-view").hidden = recording;
  $("rec-view").hidden = !recording;
  stopTimer();
  if (!recording) return;

  const labels = {
    [PHASE.PREPARING]: "Preparing…",
    [PHASE.RECORDING]: `Recording ${state.source || ""}`.trim() + "…",
    [PHASE.TRANSCODING]: "Converting to MP4…",
    [PHASE.SAVING]: "Saving…",
  };
  $("rec-label").textContent = labels[phase] || "Recording…";

  const transcoding = phase === PHASE.TRANSCODING;
  $("progress-wrap").hidden = !transcoding;
  if (transcoding) {
    const pct = Math.round((state.progress || 0) * 100);
    $("progress-bar").style.width = pct + "%";
    $("progress-text").textContent = `Converting to MP4… ${pct}%`;
  }

  const finalizing = phase === PHASE.TRANSCODING || phase === PHASE.SAVING;
  $("btn-stop").disabled = finalizing;
  $("btn-discard").disabled = finalizing;
  $("rec-timer").hidden = finalizing;

  if (phase === PHASE.RECORDING && state.startedAt) startTimer(state.startedAt);
  else $("rec-timer").textContent = "";
}

function startTimer(startedAt) {
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("rec-timer").textContent = `${mm}:${ss}`;
  };
  tick();
  timer = setInterval(tick, 500);
}
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── misc UI ──────────────────────────────────────────────────────────────────
function setBusy(id, busy, label) {
  const btn = $(id);
  btn.disabled = busy;
  btn.textContent = label;
}

let toastTimer = null;
function toast(text, isError = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function updateFormatHint(v) {
  $("format-hint").textContent =
    v === "webm" ? "WebM · fastest, no conversion" : "MP4 · falls back to WebM if unsupported";
}

init();
