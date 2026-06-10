// Editor boot / controller. Loads a clip (from ?clipId= or a file pick), builds the shell, wires the
// preview / timeline / layers / annotation modules, owns the transforms state, and drives export.
// FOUNDATION-OWNED and final — feature work happens inside the modules this orchestrates.
import { loadClip, pickFile, toInput } from "./source.js";
import { listIds } from "./idb.js";
import { defaultTransforms } from "./transforms.js";
import { createLayerStore, newImageLayer } from "./layers-model.js";
import { buildShell } from "./ui-shell.js";
import { createPreview } from "./preview.js";
import { createTimeline } from "./timeline.js";
import { createLayersPanel } from "./layers-ui.js";
import { createAnnotator } from "./annotate.js";
import { runExport } from "./export.js";

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
const TOOLS = [
  ["select", "Select"],
  ["rect", "Rectangle"],
  ["arrow", "Arrow"],
  ["text", "Text"],
  ["blur", "Blur"],
];

const root = document.getElementById("root");
const empty = document.getElementById("empty");
const openBtn = document.getElementById("open-btn");

let session = null; // { input, meta, transforms, store, preview, timeline, annotator, layersPanel, shell, fileName }
let tool = "select";
let color = "#22c55e";

async function boot() {
  const params = new URLSearchParams(location.search);
  const clipId = params.get("clipId");
  if (clipId) {
    const clip = await loadClip(clipId);
    if (clip && clip.blob) return start(clip.blob, (clip.meta && clip.meta.fileName) || "recording.mp4");
    // A clip was handed off (?clipId=) but isn't in IndexedDB — the recording didn't finish stashing,
    // or it was cleared. Log what IS in the store to aid diagnosis, then surface the failure.
    try { console.warn("[screensnap] clip not found:", clipId, "— stored ids:", await listIds()); } catch {}
    return showEmpty("That recording couldn’t be loaded — it may not have finished saving. You can still open an MP4 below.");
  }
  showEmpty();
}

function showEmpty(msg) {
  if (empty) empty.style.display = "flex";
  const text = document.getElementById("empty-text");
  if (text && msg) text.textContent = msg;
  root.style.display = "none";
}

openBtn?.addEventListener("click", async () => {
  const picked = await pickFile();
  if (picked && picked.blob) start(picked.blob, picked.fileName);
});

async function start(blob, fileName) {
  if (empty) empty.style.display = "none";
  root.style.display = "block";

  const input = toInput(blob);
  const vTrack = await input.getPrimaryVideoTrack();
  const width = vTrack ? await vTrack.getDisplayWidth() : 0;
  const height = vTrack ? await vTrack.getDisplayHeight() : 0;
  const durationSec = vTrack ? await vTrack.computeDuration() : 0;
  const meta = { durationSec, width, height };
  const transforms = defaultTransforms(meta);

  const store = createLayerStore();
  const shell = buildShell(root);

  buildToolbar(shell.toolbarEl, transforms);
  setStatus(shell.statusEl, meta, transforms);

  const preview = createPreview({
    canvas: shell.stageCanvas,
    blob,
    getTransforms: () => transforms,
    store,
    onTime: (sec) => onPreviewTime(sec),
    onStop: (err) => onPreviewStop(err),
  });
  const annotator = createAnnotator({ canvas: shell.stageCanvas, store, getTool: () => tool, getColor: () => color, getTransforms: () => transforms });

  const timeline = createTimeline({
    el: shell.timelineEl,
    durationSec,
    onTrimChange: (inSec, outSec) => {
      transforms.trimIn = inSec;
      transforms.trimOut = outSec;
      setStatus(shell.statusEl, meta, transforms);
    },
    onSeek: (sec) => preview.seekTo(sec),
  });

  const layersPanel = createLayersPanel({
    el: shell.sidebarEl,
    store,
    onAddImage: async () => {
      const file = await pickImageFile();
      if (!file) return;
      const bitmap = await createImageBitmap(file);
      const maxW = Math.min(bitmap.width, width * 0.4 || bitmap.width);
      const scale = maxW / bitmap.width;
      store.add(newImageLayer({ bitmap, x: 24, y: 24, w: bitmap.width * scale, h: bitmap.height * scale }));
    },
  });

  // Note: preview.js already subscribes to the store and re-composites on every layer change
  // (add/remove/move/opacity/visibility), so annotations show live without a second subscription
  // here — adding one would double-composite each edit.

  session = { input, meta, transforms, store, preview, timeline, annotator, layersPanel, shell, fileName, blob };

  // Prominent transport: a play/pause button + time readout, plus a click-to-play overlay centred on
  // the stage (hidden while playing and while a drawing tool is active so it never blocks annotation).
  buildTransport(shell.transportEl, durationSec);
  updateTransport();

  // Render the first frame.
  preview.seekTo(0);
}

function buildToolbar(el, transforms) {
  el.innerHTML = `
    <div class="ss-tb-group" id="ss-tools">
      ${TOOLS.map(([id, label]) => `<button class="ss-tool ${id === tool ? "on" : ""}" data-tool="${id}">${label}</button>`).join("")}
    </div>
    <div class="ss-tb-group" id="ss-colors">
      ${COLORS.map((c) => `<button class="ss-sw ${c === color ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
    </div>
    <div class="ss-tb-group">
      <label class="ss-tb-label">Resolution
        <select id="ss-res" class="ss-select">
          <option value="">Original</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
        </select>
      </label>
      <label class="ss-tb-label">Speed
        <select id="ss-speed" class="ss-select">
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
      </label>
    </div>
    <div class="ss-tb-group ss-tb-right">
      <button class="ss-btn ss-btn-primary" id="ss-download">Download original</button>
      <button class="ss-btn ss-btn-ghost" id="ss-export">Export edited MP4</button>
      <button class="ss-btn ss-btn-ghost" id="ss-close">Close</button>
    </div>`;

  el.querySelector("#ss-tools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    tool = b.dataset.tool;
    session?.annotator.setTool(tool);
    el.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x.dataset.tool === tool));
  });
  el.querySelector("#ss-colors").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    color = b.dataset.color;
    session?.annotator.setColor(color);
    el.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x.dataset.color === color));
  });
  el.querySelector("#ss-res").addEventListener("change", (e) => {
    const v = e.target.value;
    transforms.outScale = v ? { maxHeight: Number(v) } : null;
    setStatus(session.shell.statusEl, session.meta, transforms);
    // Resolution drives the preview canvas size (preview.composite reads getTransforms().outScale),
    // so re-composite the cached frame at the new output dims immediately.
    session?.preview.redraw();
  });
  el.querySelector("#ss-speed").addEventListener("change", (e) => {
    transforms.speed = Number(e.target.value) || 1;
    setStatus(session.shell.statusEl, session.meta, transforms);
    // The preview's <video> picks up playbackRate live on the next frame — no re-anchor needed.
  });
  el.querySelector("#ss-download").addEventListener("click", () => downloadOriginal());
  el.querySelector("#ss-export").addEventListener("click", () => doExport(el.querySelector("#ss-export")));
  el.querySelector("#ss-close").addEventListener("click", () => closeEditor());
}

// Close the editor tab. The page was opened via chrome.tabs.create, so window.close() isn't reliable;
// remove the current tab through the tabs API (needs no extra permission) and fall back to close().
function closeEditor() {
  if (session && session.preview) session.preview.pause();
  try {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id != null) chrome.tabs.remove(tab.id);
      else window.close();
    });
  } catch {
    window.close();
  }
}

const PLAY_SVG = '<svg viewBox="0 0 100 100" width="16" height="16" aria-hidden="true"><polygon points="30,20 30,80 82,50" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 100 100" width="16" height="16" aria-hidden="true"><rect x="28" y="22" width="16" height="56" fill="currentColor"/><rect x="56" y="22" width="16" height="56" fill="currentColor"/></svg>';
function buildTransport(el, durationSec) {
  if (!el) return;
  el.innerHTML = `
    <button class="ss-pp" id="ss-pp" type="button" aria-label="Play">${PLAY_SVG}</button>
    <span class="ss-time" id="ss-time">00:00 / ${fmtTime(durationSec)}</span>`;
  el.querySelector("#ss-pp").addEventListener("click", () => togglePlay());
}

// Reflect play state across the transport button + the centre stage overlay.
function updateTransport() {
  if (!session) return;
  const playing = session.preview.isPlaying();
  const pp = document.getElementById("ss-pp");
  if (pp) {
    pp.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    pp.setAttribute("aria-label", playing ? "Pause" : "Play");
    pp.classList.toggle("on", playing);
  }
}

function onPreviewTime(sec) {
  if (!session) return;
  session.timeline.setPlayhead(sec);
  const time = document.getElementById("ss-time");
  if (time) time.textContent = `${fmtTime(sec)} / ${fmtTime(session.meta.durationSec)}`;
}

function onPreviewStop(err) {
  updateTransport();
  if (session) setStatus(session.shell.statusEl, session.meta, session.transforms, "Playback stopped — " + ((err && err.message) || "decode error"));
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Save the recording exactly as captured — no transcode, instant. This is the robust "just download
// it" path: it works even if the WebCodecs export pipeline can't run, because it just saves the
// original blob. Editing + Export edited MP4 is the separate, value-add path.
function downloadOriginal() {
  if (!session || !session.blob) return;
  const url = URL.createObjectURL(session.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = session.fileName || "recording.mp4";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function togglePlay() {
  if (!session) return;
  if (session.preview.isPlaying()) session.preview.pause();
  else await session.preview.play(); // play() is async (awaits the <video>); await so the icon flips
  updateTransport();
}

async function doExport(btn) {
  if (!session) return;
  const orig = btn.textContent;
  btn.disabled = true;
  session.preview.pause();
  updateTransport();
  try {
    await runExport({
      input: session.input,
      transforms: session.transforms,
      store: session.store,
      fileName: session.fileName,
      onProgress: (frac) => { btn.textContent = `Exporting ${Math.round(frac * 100)}%`; },
    });
    btn.textContent = "Saved ✓";
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  } catch (err) {
    btn.textContent = "Export failed";
    setStatus(session.shell.statusEl, session.meta, session.transforms, String((err && err.message) || err));
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2600);
  }
}

function setStatus(el, meta, t, errMsg) {
  if (!el) return;
  if (errMsg) { el.textContent = errMsg; el.classList.add("ss-status-err"); return; }
  el.classList.remove("ss-status-err");
  const trim = `${t.trimIn.toFixed(1)}s – ${t.trimOut.toFixed(1)}s`;
  const res = t.outScale ? `${t.outScale.maxHeight}p` : `${meta.width}×${meta.height}`;
  const audio = (t.speed || 1) === 1 ? "audio on" : "audio off (speed ≠ 1x)";
  el.textContent = `${res} · ${t.speed}x · trim ${trim} · ${audio}`;
}

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.remove();
      resolve(f || null);
    });
    window.addEventListener("focus", () => setTimeout(() => { input.remove(); resolve(null); }, 400), { once: true });
    input.click();
  });
}

// Spacebar toggles play/pause — unless you're typing in a field (e.g. the text-annotation input).
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const el = document.activeElement;
  const tag = el && el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable)) return;
  if (!session) return;
  e.preventDefault();
  togglePlay();
});

boot();
