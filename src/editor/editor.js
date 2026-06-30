// Editor boot / controller. Loads a clip (from ?clipId= or a file pick), builds the shell, wires the
// preview / timeline / layers / annotation modules, owns the transforms state, and drives export.
// FOUNDATION-OWNED and final — feature work happens inside the modules this orchestrates.
import { loadClip, pickFile, toInput } from "./source.js";
import { listIds } from "./idb.js";
import { defaultTransforms, composeDims, outDuration } from "./transforms.js";
import { createLayerStore, newImageLayer } from "./layers-model.js";
import { buildShell } from "./ui-shell.js";
import { createPreview } from "./preview.js";
import { createTimeline } from "./timeline.js";
import { createLayersPanel } from "./layers-ui.js";
import { createAnnotator } from "./annotate.js";
import { runExport, runGifExport } from "./export.js";
import { createCropOverlay } from "./crop-overlay.js";
import { decodeGif } from "./gif-decode.js";

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
const TOOLS = [
  ["select", "Select"],
  ["rect", "Rectangle"],
  ["arrow", "Arrow"],
  ["text", "Text"],
  ["blur", "Blur"],
  ["zoom", "Zoom"],
];

const root = document.getElementById("root");
const empty = document.getElementById("empty");
const openBtn = document.getElementById("open-btn");

let session = null; // { input, meta, transforms, store, preview, timeline, annotator, layersPanel, shell, fileName }
let tool = "select";
let color = "#22c55e";
let lastTime = 0;    // latest preview playhead (source seconds) — anchor for zoom keyframes
let zoomScale = 2;   // default magnification for an added zoom pulse

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
    onAddCut: (i, o) => {
      transforms.cuts = (transforms.cuts || []).concat([{ in: i, out: o }]);
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
      preview.redraw();
    },
    onRemoveCut: (idx) => {
      transforms.cuts = (transforms.cuts || []).filter((_, k) => k !== idx);
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
      preview.redraw();
    },
    getCuts: () => transforms.cuts || [],
    getZoom: () => transforms.zoom || [],
  });

  const layersPanel = createLayersPanel({
    el: shell.sidebarEl,
    store,
    onAddImage: async () => {
      const file = await pickImageFile();
      if (!file) return;
      await addImageLayer(file, store, width);
    },
  });

  // Crop overlay: a "Crop" toolbar toggle enters it; Apply sets transforms.crop (source px) and the
  // preview/export recompute from there. The annotator's canvas is covered while it's active.
  const cropOverlay = createCropOverlay({
    stageEl: shell.stageCanvas.parentElement,
    canvas: shell.stageCanvas,
    getTransforms: () => transforms,
    srcW: width,
    srcH: height,
    onApply: (crop) => {
      transforms.crop = crop; // null clears
      setStatus(shell.statusEl, meta, transforms);
      preview.redraw();
      markCropBtn(false);
    },
    onExit: () => markCropBtn(false),
  });

  // Zoom tool: clicking the stage drops a self-contained zoom pulse (in → hold → out) focused on the
  // click point at the current playhead. Captured before the annotator so it never draws a shape.
  shell.stageCanvas.addEventListener("pointerdown", (e) => {
    if (tool !== "zoom") return;
    e.preventDefault();
    e.stopPropagation();
    const r = shell.stageCanvas.getBoundingClientRect();
    const cx = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    const cy = Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)));
    addZoomPulse(lastTime, cx, cy);
    setStatus(shell.statusEl, meta, transforms);
    timeline.refresh();
    preview.redraw();
  }, true);

  // Note: preview.js already subscribes to the store and re-composites on every layer change
  // (add/remove/move/opacity/visibility), so annotations show live without a second subscription
  // here — adding one would double-composite each edit.

  session = { input, meta, transforms, store, preview, timeline, annotator, layersPanel, cropOverlay, shell, fileName, blob };

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
      <button class="ss-tool" id="ss-crop-btn" title="Crop the frame">Crop</button>
      <button class="ss-tool" id="ss-cut-btn" title="Cut mode: drag on the timeline to remove a section">Cut</button>
      <label class="ss-tb-label">Zoom
        <select id="ss-zoom-scale" class="ss-select" title="Magnification for a new zoom mark (then click the video with the Zoom tool)">
          <option value="1.5">1.5x</option>
          <option value="2" selected>2x</option>
          <option value="3">3x</option>
          <option value="4">4x</option>
        </select>
      </label>
      <button class="ss-tool" id="ss-zoom-clear" title="Remove all zoom keyframes">Clear zoom</button>
    </div>
    <div class="ss-tb-group">
      <button class="ss-tool" id="ss-bd-btn" title="Wrap the video in a padded background">Backdrop</button>
      <select id="ss-bd-bg" class="ss-select" title="Backdrop background">
        <option value="grad-violet">Violet</option>
        <option value="grad-ocean">Ocean</option>
        <option value="grad-sunset">Sunset</option>
        <option value="grad-mint">Mint</option>
        <option value="grad-slate">Slate</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="white">White</option>
      </select>
      <label class="ss-tb-label">Pad
        <input type="range" id="ss-bd-pad" class="ss-bd-range" min="0" max="0.2" step="0.01" value="0.07" />
      </label>
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
      <button class="ss-btn ss-btn-ghost" id="ss-export">Export MP4</button>
      <button class="ss-btn ss-btn-ghost" id="ss-export-gif">Export GIF</button>
      <button class="ss-btn ss-btn-ghost" id="ss-close">Close</button>
    </div>`;

  el.querySelector("#ss-tools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    tool = b.dataset.tool;
    session?.annotator.setTool(tool);
    if (session?.cropOverlay?.isActive()) session.cropOverlay.exit(); // leave crop when picking a tool
    el.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x.dataset.tool === tool));
  });

  el.querySelector("#ss-crop-btn").addEventListener("click", () => {
    if (!session?.cropOverlay) return;
    if (session.cropOverlay.isActive()) { session.cropOverlay.exit(); markCropBtn(false); }
    else { session.preview.pause(); updateTransport(); session.cropOverlay.enter(); markCropBtn(true); }
  });
  el.querySelector("#ss-cut-btn").addEventListener("click", (e) => {
    if (!session?.timeline) return;
    const on = !session.timeline.isCutMode();
    session.timeline.setCutMode(on);
    e.currentTarget.classList.toggle("on", on);
  });
  el.querySelector("#ss-zoom-scale").addEventListener("change", (e) => { zoomScale = Number(e.target.value) || 2; });
  el.querySelector("#ss-zoom-clear").addEventListener("click", () => {
    if (!session) return;
    transforms.zoom = [];
    setStatus(session.shell.statusEl, session.meta, transforms);
    session.timeline.refresh();
    session.preview.redraw();
  });
  el.querySelector("#ss-bd-btn").addEventListener("click", (e) => {
    if (!session) return;
    if (transforms.backdrop) transforms.backdrop = null;
    else transforms.backdrop = { pad: Number(el.querySelector("#ss-bd-pad").value) || 0.07, radius: 0.03, shadow: true, bg: el.querySelector("#ss-bd-bg").value || "grad-violet" };
    e.currentTarget.classList.toggle("on", !!transforms.backdrop);
    setStatus(session.shell.statusEl, session.meta, transforms);
    session.preview.redraw();
  });
  el.querySelector("#ss-bd-bg").addEventListener("change", (e) => {
    if (!session || !transforms.backdrop) return;
    transforms.backdrop.bg = e.target.value;
    session.preview.redraw();
  });
  el.querySelector("#ss-bd-pad").addEventListener("input", (e) => {
    if (!session || !transforms.backdrop) return;
    transforms.backdrop.pad = Number(e.target.value) || 0;
    session.preview.redraw();
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
  el.querySelector("#ss-export-gif").addEventListener("click", () => doExport(el.querySelector("#ss-export-gif"), "gif"));
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
  lastTime = sec || 0;
  if (!session) return;
  session.timeline.setPlayhead(sec);
  const time = document.getElementById("ss-time");
  if (time) time.textContent = `${fmtTime(sec)} / ${fmtTime(session.meta.durationSec)}`;
}

// Scale a source image so it spans at most ~40% of the video width, never upscaling. Defensive against
// zero/NaN dimensions (a broken decode or audio-only source) — always returns a finite positive scale.
function fitScale(imgW, videoW) {
  if (!(imgW > 0)) return 1;
  const target = videoW > 0 ? videoW * 0.4 : imgW;
  return Math.min(1, target / imgW) || 1;
}

// Add an image (or animated GIF) as an overlay layer. GIFs are decoded to frames so they animate;
// if decode fails we fall back to the first frame as a static image.
async function addImageLayer(file, store, width) {
  try {
    if (file.type === "image/gif") {
      try {
        const g = await decodeGif(file);
        const scale = fitScale(g.width, width);
        store.add(newImageLayer({
          bitmap: g.frames[0].bitmap, x: 24, y: 24, w: g.width * scale, h: g.height * scale,
          frames: g.frames, totalMs: g.totalMs,
        }));
        return;
      } catch (err) {
        console.warn("[screensnap] GIF decode failed — adding first frame as static image:", err);
      }
    }
    const bitmap = await createImageBitmap(file);
    const scale = fitScale(bitmap.width, width);
    store.add(newImageLayer({ bitmap, x: 24, y: 24, w: bitmap.width * scale, h: bitmap.height * scale }));
  } catch (err) {
    console.warn("[screensnap] couldn't add image layer:", err);
    alert("Sorry — that image couldn't be added.");
  }
}

// Drop a self-contained zoom pulse (ease in → hold → ease out) at source time `t`, focused on the
// fractional point (cx, cy) of the cropped frame. Keyframes are interpolated in transforms.zoomAt.
function addZoomPulse(t, cx, cy) {
  if (!session) return;
  const dur = session.meta.durationSec || 0;
  const s = Math.max(1.1, zoomScale);
  const c = (v) => Math.max(0, Math.min(dur, v));
  session.transforms.zoom = (session.transforms.zoom || []).concat([
    { t: c(t - 0.3), cx, cy, scale: 1 },
    { t: c(t), cx, cy, scale: s },
    { t: c(t + 1.2), cx, cy, scale: s },
    { t: c(t + 1.5), cx, cy, scale: 1 },
  ]);
}

function markCropBtn(on) {
  const b = document.getElementById("ss-crop-btn");
  if (b) b.classList.toggle("on", !!on);
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
  const name = session.fileName || "recording.mp4";
  const url = URL.createObjectURL(session.blob);
  // Prefer the downloads API so the browser prompts for a save location (saveAs); fall back to an
  // anchor click on builds that reject blob: URLs (it saves to the default folder without a prompt).
  if (chrome && chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({ url, filename: `screensnap/${name}`, saveAs: true }, () => {
      if (chrome.runtime.lastError) anchorDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    return;
  }
  anchorDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function anchorDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function togglePlay() {
  if (!session) return;
  if (session.preview.isPlaying()) session.preview.pause();
  else await session.preview.play(); // play() is async (awaits the <video>); await so the icon flips
  updateTransport();
}

async function doExport(btn, format) {
  if (!session) return;
  const orig = btn.textContent;
  btn.disabled = true;
  session.preview.pause();
  updateTransport();
  const args = {
    input: session.input,
    transforms: session.transforms,
    store: session.store,
    fileName: session.fileName,
    onProgress: (frac) => { btn.textContent = `Exporting ${Math.round(frac * 100)}%`; },
  };
  try {
    if (format === "gif") await runGifExport(args);
    else await runExport(args);
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
  const d = composeDims(t, meta.width || 2, meta.height || 2);
  const res = `${d.outW}×${d.outH}${t.crop ? " cropped" : ""}`;
  const cuts = Array.isArray(t.cuts) && t.cuts.length ? ` · ${t.cuts.length} cut${t.cuts.length > 1 ? "s" : ""}` : "";
  const zoom = Array.isArray(t.zoom) && t.zoom.length ? " · zoom" : "";
  const bd = t.backdrop ? " · backdrop" : "";
  const audio = (t.speed || 1) === 1 ? "audio on" : "audio off (speed ≠ 1x)";
  el.textContent = `${res} · ${t.speed}x · ${outDuration(t).toFixed(1)}s out${cuts}${zoom}${bd} · ${audio}`;
}

// Raster formats only — SVG is excluded deliberately (scriptable XML, and it has no intrinsic
// pixel size for the bitmap pipeline). `accept` is only a hint, so the type is re-checked on change.
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ALLOWED_IMAGE_TYPES.join(",");
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.remove();
      if (f && !ALLOWED_IMAGE_TYPES.includes(f.type)) {
        alert("Unsupported image type. Please choose a PNG, JPEG, or GIF.");
        return resolve(null);
      }
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
