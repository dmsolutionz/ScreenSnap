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
import { createAnnotator } from "./annotate.js";
import { runExport, runGifExport } from "./export.js";
import { createCropOverlay } from "./crop-overlay.js";
import { createZoomOverlay } from "./zoom-overlay.js";
import { createSelectionOverlay } from "./selection-overlay.js";
import { decodeGif } from "./gif-decode.js";
import { computeWaveformPeaks } from "./audio-waveform.js";

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
let lastTime = 0;        // latest preview playhead (source seconds) — anchor for a new zoom block
let selectedZoomId = null; // id of the zoom block currently being edited (focus box shown)
let selectedLayerId = null; // id of the layer currently selected on the stage (resize box shown for images)
let audioPeaks = null; // { peaks, buckets } from computeWaveformPeaks(), or null (no track / not decoded yet)
const NEW_ZOOM_SCALE = 2;  // default magnification for a freshly-added zoom block

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
  const annotator = createAnnotator({
    canvas: shell.stageCanvas,
    store,
    getTool: () => tool,
    getColor: () => color,
    getTransforms: () => transforms,
    onSelectionChange: (id) => selectLayer(id),
    onDraft: (rect) => session && session.selectionOverlay.setDraft(rect),
  });

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
    getZoomBlocks: () => transforms.zoom || [],
    getSelectedZoom: () => selectedZoomId,
    onZoomSelect: (id) => selectZoom(id),
    onZoomChange: (id, patch) => changeZoom(id, patch),
    getAudioPeaks: () => audioPeaks,
    getAudioCuts: () => transforms.audio.cuts || [],
    onAddAudioCut: (i, o) => {
      transforms.audio.cuts = (transforms.audio.cuts || []).concat([{ in: i, out: o }]);
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
      preview.redraw();
    },
    onRemoveAudioCut: (idx) => {
      transforms.audio.cuts = (transforms.audio.cuts || []).filter((_, k) => k !== idx);
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
      preview.redraw();
    },
    onAudioMuteChange: (idx, r) => {
      const arr = (transforms.audio.cuts || []).slice();
      if (idx < 0 || idx >= arr.length) return;
      arr[idx] = { in: r.tIn, out: r.tOut };
      transforms.audio.cuts = arr;
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
      preview.redraw();
    },
    getAudioEnabled: () => transforms.speed === 1,
    // Overlay layer tracks (one row per layer): the range block, plus the header controls the Layers
    // sidebar used to own (eye / opacity / reorder = z-order / delete).
    store,
    getSelectedLayer: () => selectedLayerId,
    onLayerSelect: (id) => selectLayer(id),
    onLayerRangeChange: (id, r) => {
      store.update(id, { range: { inSec: r.tIn, outSec: r.tOut } });
      setStatus(shell.statusEl, meta, transforms);
      if (id === selectedLayerId) updateInspector(); // keep the inspector's timing readout live
    },
    onLayerVisible: (id, visible) => store.update(id, { visible }),
    onLayerOpacity: (id, opacity) => store.update(id, { opacity }),
    onLayerReorder: (id, beforeId) => {
      // Drop `id` at the row currently occupied by `beforeId` (both are store indices in draw order).
      const from = store.layers.findIndex((l) => l.id === id);
      const to = store.layers.findIndex((l) => l.id === beforeId);
      if (from === -1 || to === -1) return;
      store.move(id, to);
      timeline.refresh();
    },
    onLayerDelete: (id) => { store.remove(id); if (selectedLayerId === id) selectLayer(null); timeline.refresh(); },
    // Imported-audio track.
    getExtraAudio: () => transforms.extraAudio,
    onExtraAudioChange: (r, mode) => changeExtraAudio(r, mode),
    onExtraMute: () => {
      if (!transforms.extraAudio) return;
      transforms.extraAudio.muted = !transforms.extraAudio.muted;
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
    },
    onExtraVolume: (v) => {
      if (!transforms.extraAudio) return;
      transforms.extraAudio.volume = v;
      if (v > 0) transforms.extraAudio.muted = false;
      setStatus(shell.statusEl, meta, transforms);
      timeline.refresh();
    },
    onExtraRemove: () => removeExtraAudio(),
  });

  // Waveform decode is fire-and-forget — a long recording can take real time to fully decode, and the
  // timeline/lane render fine in a "no data yet" state until this resolves and calls refresh().
  audioPeaks = null;
  computeWaveformPeaks({ input, durationSec })
    .then((peaks) => { audioPeaks = peaks; timeline.refresh(); })
    .catch((err) => console.warn("[screensnap] waveform decode failed:", err));

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
      zoomOverlay.refresh(); // crop changes the content rect — re-place the focus box if shown
      selectionOverlay.refresh();
      markCropBtn(false);
    },
    onExit: () => markCropBtn(false),
  });

  // Zoom focus overlay: shown over the stage while a zoom block is selected. Drag the box to move the
  // focus point; drag its corner to change the magnification. The host is pointer-transparent except
  // for the box, so annotation still works around it.
  const zoomOverlay = createZoomOverlay({
    stageEl: shell.stageCanvas.parentElement,
    canvas: shell.stageCanvas,
    getTransforms: () => transforms,
    srcW: width,
    srcH: height,
    getBlock: () => (transforms.zoom || []).find((b) => b.id === selectedZoomId) || null,
    onChange: ({ cx, cy, scale }) => {
      const b = (transforms.zoom || []).find((x) => x.id === selectedZoomId);
      if (!b) return;
      b.cx = cx; b.cy = cy; b.scale = scale;
      timeline.refresh();
      zoomOverlay.refresh();
      preview.redraw();
    },
  });

  // Selection / resize overlay: draws a dashed box while you drag out a new rect/blur/arrow, and a box
  // with 8 resize handles around the selected layer (image OR any shape). Box bodies are
  // pointer-events:none so annotate.js keeps owning click-to-select and drag-to-move; only the handles
  // resize. It writes size changes straight to the store.
  const selectionOverlay = createSelectionOverlay({
    stageEl: shell.stageCanvas.parentElement,
    canvas: shell.stageCanvas,
    store,
    getTransforms: () => transforms,
    srcW: width,
    srcH: height,
    getLayer: () => (selectedLayerId ? store.get(selectedLayerId) : null),
  });

  // Note: preview.js already subscribes to the store and re-composites on every layer change
  // (add/remove/move/opacity/visibility), so annotations show live without a second subscription
  // here — adding one would double-composite each edit.

  session = { input, meta, transforms, store, preview, timeline, annotator, cropOverlay, zoomOverlay, selectionOverlay, shell, fileName, blob, extraAudioInput: null, extraAudioBlob: null };

  // Prominent transport: a play/pause button + time readout, plus a click-to-play overlay centred on
  // the stage (hidden while playing and while a drawing tool is active so it never blocks annotation).
  buildTransport(shell.transportEl, durationSec);
  updateTransport();

  // Render the first frame.
  preview.seekTo(0);
}

const BD_OPTS = [["grad-violet", "Violet"], ["grad-ocean", "Ocean"], ["grad-sunset", "Sunset"], ["grad-mint", "Mint"], ["grad-slate", "Slate"], ["dark", "Dark"], ["light", "Light"], ["white", "White"]];

function buildToolbar(el, transforms) {
  el.innerHTML = `
    <div class="ss-tb-group" id="ss-tools">
      ${TOOLS.map(([id, label]) => `<button class="ss-tool ${id === tool ? "on" : ""}" data-tool="${id}">${label}</button>`).join("")}
      <button class="ss-tool" id="ss-add-image" title="Add an image / logo overlay">+ Image</button>
    </div>
    <span class="ss-tb-sep"></span>
    <div class="ss-tb-group">
      <button class="ss-tool" id="ss-crop-btn" title="Crop the frame">Crop</button>
      <button class="ss-tool" id="ss-cut-btn" title="Cut mode: drag on the Video track to remove a section">Cut</button>
      <button class="ss-tool" id="ss-zoom-add" title="Add a zoom at the playhead">+ Zoom</button>
      <button class="ss-tool" id="ss-zoom-remove" title="Remove the selected zoom" disabled>Remove zoom</button>
    </div>
    <span class="ss-tb-sep"></span>
    <div class="ss-tb-group">
      <button class="ss-tool" data-pop="backdrop" id="ss-backdrop-pop" title="Padded background">Backdrop ▾</button>
      <button class="ss-tool" data-pop="project" id="ss-project-pop" title="Resolution, speed, audio">Project ▾</button>
    </div>
    <div class="ss-tb-group ss-tb-right">
      <span class="ss-export-split">
        <button class="ss-btn ss-btn-primary" id="ss-export" title="Export MP4">Export</button>
        <button class="ss-btn ss-btn-primary ss-export-caret" data-pop="export" id="ss-export-caret" title="Export options">▾</button>
      </span>
      <button class="ss-btn ss-btn-ghost" id="ss-close">Close</button>
    </div>

    <div class="ss-pop" id="ss-pop-backdrop" data-popbody hidden>
      <label class="ss-pop-row"><input type="checkbox" id="ss-bd-on" /><span>Enable backdrop</span></label>
      <label class="ss-pop-row"><span>Background</span><select id="ss-bd-bg" class="ss-select">${BD_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      <label class="ss-pop-row"><span>Padding</span><input type="range" id="ss-bd-pad" min="0" max="0.2" step="0.01" value="0.07" /></label>
    </div>
    <div class="ss-pop" id="ss-pop-project" data-popbody hidden>
      <label class="ss-pop-row"><span>Resolution</span><select id="ss-res" class="ss-select"><option value="">Original</option><option value="1080">1080p</option><option value="720">720p</option></select></label>
      <label class="ss-pop-row"><span>Speed</span><select id="ss-speed" class="ss-select"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="1.5">1.5x</option><option value="2">2x</option></select></label>
      <label class="ss-pop-row"><span>Volume</span><input type="range" id="ss-audio-vol" min="0" max="1" step="0.05" value="1" /></label>
      <label class="ss-pop-row"><input type="checkbox" id="ss-audio-mute-cb" /><span>Mute all audio</span></label>
      <div class="ss-pop-row ss-pop-actions"><button class="ss-btn ss-btn-ghost" id="ss-add-audio">+ Add audio track</button><button class="ss-btn ss-btn-ghost" id="ss-remove-audio" disabled>Remove</button></div>
    </div>
    <div class="ss-pop ss-pop-menu" id="ss-pop-export" data-popbody hidden>
      <button data-exp="mp4">Export MP4</button>
      <button data-exp="gif">Export GIF</button>
      <button data-exp="orig">Download original</button>
    </div>`;

  // ── popovers ──────────────────────────────────────────────────────────────────────────────────
  const closePopovers = (except) => {
    el.querySelectorAll("[data-popbody]").forEach((p) => { if (p !== except) p.hidden = true; });
    el.querySelectorAll("[data-pop]").forEach((b) => b.classList.remove("on"));
  };
  el.querySelectorAll("[data-pop]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = el.querySelector(`#ss-pop-${btn.dataset.pop}`);
      const opening = pop.hidden;
      closePopovers();
      if (!opening) return;
      pop.hidden = false; btn.classList.add("on");
      const br = btn.getBoundingClientRect(), er = el.getBoundingClientRect();
      pop.style.top = `${br.bottom - er.top + 5}px`;
      if (btn.dataset.pop === "export") { pop.style.left = "auto"; pop.style.right = `${er.right - br.right}px`; }
      else { pop.style.right = "auto"; pop.style.left = `${br.left - er.left}px`; }
    });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("[data-pop],[data-popbody]")) closePopovers(); });

  // ── tools + clip actions ──────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-tools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    setActiveTool(b.dataset.tool);
  });
  el.querySelector("#ss-add-image").addEventListener("click", async () => {
    if (!session) return;
    const file = await pickImageFile();
    if (!file) return;
    await addImageLayer(file, session.store, session.meta.width);
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
  el.querySelector("#ss-zoom-add").addEventListener("click", () => addZoom());
  el.querySelector("#ss-zoom-remove").addEventListener("click", () => removeSelectedZoom());

  // ── Backdrop popover ──────────────────────────────────────────────────────────────────────────
  const applyBackdrop = () => {
    setStatus(session.shell.statusEl, session.meta, transforms);
    session.preview.redraw();
    session.zoomOverlay.refresh();
    session.selectionOverlay.refresh();
  };
  el.querySelector("#ss-bd-on").addEventListener("change", (e) => {
    if (!session) return;
    if (e.target.checked) transforms.backdrop = { pad: Number(el.querySelector("#ss-bd-pad").value) || 0.07, radius: 0.03, shadow: true, bg: el.querySelector("#ss-bd-bg").value || "grad-violet" };
    else transforms.backdrop = null;
    applyBackdrop();
  });
  el.querySelector("#ss-bd-bg").addEventListener("change", (e) => { if (session && transforms.backdrop) { transforms.backdrop.bg = e.target.value; session.preview.redraw(); } });
  el.querySelector("#ss-bd-pad").addEventListener("input", (e) => { if (session && transforms.backdrop) { transforms.backdrop.pad = Number(e.target.value) || 0; applyBackdrop(); } });

  // ── Project popover ───────────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-res").addEventListener("change", (e) => {
    transforms.outScale = e.target.value ? { maxHeight: Number(e.target.value) } : null;
    setStatus(session.shell.statusEl, session.meta, transforms);
    session?.preview.redraw();
    session?.zoomOverlay?.refresh();
    session?.selectionOverlay?.refresh();
  });
  el.querySelector("#ss-speed").addEventListener("change", (e) => {
    transforms.speed = Number(e.target.value) || 1;
    setStatus(session.shell.statusEl, session.meta, transforms);
    session?.timeline?.refresh(); // audio track dims/enables on speed !== 1
  });
  const muteCb = el.querySelector("#ss-audio-mute-cb");
  muteCb.addEventListener("change", (e) => {
    transforms.audio.muted = e.target.checked;
    setStatus(session.shell.statusEl, session.meta, transforms);
    session?.preview.redraw();
  });
  el.querySelector("#ss-audio-vol").addEventListener("input", (e) => {
    transforms.audio.volume = Number(e.target.value);
    if (transforms.audio.volume > 0 && transforms.audio.muted) { transforms.audio.muted = false; muteCb.checked = false; }
    setStatus(session.shell.statusEl, session.meta, transforms);
    session?.preview.redraw();
  });
  el.querySelector("#ss-add-audio").addEventListener("click", () => onAddAudioClick());
  el.querySelector("#ss-remove-audio").addEventListener("click", () => removeExtraAudio());

  // ── Export split + menu ───────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-export").addEventListener("click", () => doExport(el.querySelector("#ss-export")));
  el.querySelector("#ss-pop-export").addEventListener("click", (e) => {
    const b = e.target.closest("[data-exp]"); if (!b) return;
    closePopovers();
    if (b.dataset.exp === "orig") downloadOriginal();
    else doExport(el.querySelector("#ss-export"), b.dataset.exp === "gif" ? "gif" : undefined);
  });
  el.querySelector("#ss-close").addEventListener("click", () => closeEditor());
}

// Switch the active drawing tool, updating the toolbar (Phase 2) / rail (Phase 3) highlight.
function setActiveTool(t) {
  tool = t;
  session?.annotator.setTool(tool);
  if (session?.cropOverlay?.isActive()) session.cropOverlay.exit();
  selectZoom(null);
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x.dataset.tool === tool));
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
    <span class="ss-time" id="ss-time">00:00 / ${fmtTime(durationSec)}</span>
    <div class="ss-tb-spacer"></div>
    <div class="ss-tlzoom">
      <span class="ss-tlzoom-label">tl zoom</span>
      <button class="ss-tlzoom-btn" id="ss-tlz-out" title="Zoom out" type="button">−</button>
      <input type="range" id="ss-tlz-slider" class="ss-tlzoom-slider" min="0" max="1" step="0.01" value="0" title="Timeline zoom" />
      <button class="ss-tlzoom-btn" id="ss-tlz-in" title="Zoom in" type="button">+</button>
      <button class="ss-tlzoom-fit" id="ss-tlz-fit" title="Fit the whole clip" type="button">Fit</button>
    </div>`;
  el.querySelector("#ss-pp").addEventListener("click", () => togglePlay());
  const slider = el.querySelector("#ss-tlz-slider");
  const syncSlider = () => { if (session?.timeline) slider.value = String(session.timeline.getZoomNorm()); };
  el.querySelector("#ss-tlz-out").addEventListener("click", () => { session?.timeline.zoomBy(1 / 1.4); syncSlider(); });
  el.querySelector("#ss-tlz-in").addEventListener("click", () => { session?.timeline.zoomBy(1.4); syncSlider(); });
  el.querySelector("#ss-tlz-fit").addEventListener("click", () => { session?.timeline.fit(); syncSlider(); });
  slider.addEventListener("input", () => session?.timeline.setZoomNorm(Number(slider.value)));
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

// ── Imported audio track (voiceover / music) ─────────────────────────────────────────────────────
// Import a file → probe it → stash the Input on `session` and the plain positional state on
// transforms.extraAudio. Scoped to exactly one imported track in v1; re-importing replaces (behind a
// confirm). Fully independent of whether the recording has audio of its own.
async function onAddAudioClick() {
  if (!session) return;
  if (session.transforms.extraAudio && !confirm("Replace the current imported audio track?")) return;
  const file = await pickAudioFile();
  if (!file) return;
  await addExtraAudio(file);
}

async function addExtraAudio(file) {
  if (!session) return;
  let input, durationSec;
  try {
    input = toInput(file);
    const aTrack = await input.getPrimaryAudioTrack();
    if (!aTrack) { alert("That file doesn’t have an audio track we can use."); return; }
    durationSec = await aTrack.computeDuration();
    if (!(durationSec > 0)) { alert("That audio file appears to be empty."); return; }
  } catch (err) {
    console.warn("[screensnap] couldn't load imported audio:", err);
    alert("Sorry — that audio file couldn’t be added.");
    return;
  }
  session.extraAudioInput = input;
  session.extraAudioBlob = file;
  session.transforms.extraAudio = {
    name: file.name || "audio", durationSec,
    trimIn: 0, trimOut: durationSec, offsetSec: 0, volume: 1, muted: false,
  };
  session.preview.setExtraAudio(file);
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.timeline.refresh();
  const rm = document.getElementById("ss-remove-audio");
  if (rm) rm.disabled = false;
}

function removeExtraAudio() {
  if (!session) return;
  session.extraAudioInput = null;
  session.extraAudioBlob = null;
  session.transforms.extraAudio = null;
  session.preview.setExtraAudio(null);
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.timeline.refresh();
  const rm = document.getElementById("ss-remove-audio");
  if (rm) rm.disabled = true;
}

function pickAudioFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*"; // broad hint; the real gate is the getPrimaryAudioTrack() probe on import
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

// ── Zoom blocks ────────────────────────────────────────────────────────────────────────────────
// Add a ~2s zoom block at the current playhead, centered at 2x, and select it so the focus box shows.
function addZoom() {
  if (!session) return;
  const dur = session.meta.durationSec || 0;
  const tIn = Math.max(0, Math.min(lastTime, Math.max(0, dur - 0.5)));
  const tOut = Math.min(dur, tIn + 2);
  const id = (crypto.randomUUID ? crypto.randomUUID() : `z${session.transforms.zoom.length}-${Math.round(lastTime * 1000)}`).slice(0, 8);
  const block = { id, tIn, tOut: Math.max(tOut, tIn + 0.5), cx: 0.5, cy: 0.5, scale: NEW_ZOOM_SCALE };
  session.transforms.zoom = (session.transforms.zoom || []).concat([block]);
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  selectZoom(id);          // shows the focus overlay + refreshes the timeline
  session.preview.redraw();
}

function removeSelectedZoom() {
  if (!session || !selectedZoomId) return;
  session.transforms.zoom = (session.transforms.zoom || []).filter((b) => b.id !== selectedZoomId);
  selectZoom(null);
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.preview.redraw();
}

// Select (or deselect with null) a zoom block: toggles the focus overlay + the Remove button + the
// timeline highlight.
function selectZoom(id) {
  if (!session) return;
  selectedZoomId = id || null;
  session.timeline.refresh();
  if (selectedZoomId) session.zoomOverlay.show();
  else session.zoomOverlay.hide();
  const rm = document.getElementById("ss-zoom-remove");
  if (rm) rm.disabled = !selectedZoomId;
}

// Persist a timeline edit to a block's time range, then refresh the overlay + preview.
function changeZoom(id, patch) {
  if (!session) return;
  const b = (session.transforms.zoom || []).find((x) => x.id === id);
  if (!b) return;
  if (patch.tIn != null) b.tIn = patch.tIn;
  if (patch.tOut != null) b.tOut = patch.tOut;
  session.timeline.refresh();
  session.zoomOverlay.refresh();
  session.preview.redraw();
}

// Single funnel for "which layer is selected", driven from a canvas click (via annotate.js's
// onSelectionChange) OR a timeline-block click (via onLayerSelect). The guard makes it idempotent: a
// timeline click calls annotator.setSelectedId(), which re-fires onSelectionChange → selectLayer again;
// the second pass sees the same id and returns, so the two-way sync settles instead of looping.
function selectLayer(id) {
  const next = id || null;
  if (next === selectedLayerId) return;
  selectedLayerId = next;
  if (!session) return;
  session.annotator.setSelectedId(selectedLayerId); // keep canvas Delete-key / hit-test in sync
  session.timeline.refresh();                        // update the layer lane's selected-block highlight
  session.selectionOverlay.refresh();                // show/hide the resize box for the new selection
  updateInspector();                                 // show/hide the contextual inspector row
}

// The contextual inspector row (under the toolbar) — visible only while a layer is selected. Shows the
// selected shape's color (shapes only), opacity, and time-range controls; replaces the last job the
// Layers sidebar did. Rebuilt whenever the selection changes.
function updateInspector() {
  if (!session) return;
  const el = session.shell.inspectorEl;
  const store = session.store;
  const l = selectedLayerId ? store.get(selectedLayerId) : null;
  if (!l) { el.innerHTML = ""; return; }
  const typeName = l.kind === "image" ? (l.image && l.image.frames ? "GIF" : "Image") : (((l.shape && l.shape.type) || "Shape").replace(/^./, (c) => c.toUpperCase()));
  const hasColor = l.kind === "shape" && l.shape && l.shape.color != null;
  const opacity = typeof l.opacity === "number" ? l.opacity : 1;
  const range = l.range;
  const fmtT = (s) => `${String(Math.floor((s || 0) / 60)).padStart(2, "0")}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
  el.innerHTML = `<div class="ss-insp">
    <span class="ss-insp-title">${typeName} selected</span>
    ${hasColor ? `<div class="ss-insp-colors">${COLORS.map((c) => `<button class="ss-sw ${l.shape.color === c ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}</div><span class="ss-insp-sep"></span>` : ""}
    <span class="ss-insp-ctl">opacity <input type="range" id="ss-insp-op" min="0" max="1" step="0.05" value="${opacity}" /></span>
    <span class="ss-insp-sep"></span>
    <span class="ss-insp-ctl">timing <span class="ss-insp-range">${range ? `${fmtT(range.inSec)} – ${fmtT(range.outSec)}` : "always visible"}</span>
      <button class="ss-insp-btn" data-timing="in">Set in</button>
      <button class="ss-insp-btn" data-timing="out">Set out</button>
      <button class="ss-insp-btn" data-timing="all">Always visible</button></span>
    <span class="ss-insp-spacer"></span>
    <span class="ss-insp-hint">⌫ delete · ⌘D duplicate · esc deselect</span>
  </div>`;

  const colorsEl = el.querySelector(".ss-insp-colors");
  if (colorsEl) colorsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]"); if (!b) return;
    color = b.dataset.color;
    session.annotator.setColor(color); // recolors the selected shape + arms the next one
    updateInspector();
  });
  el.querySelector("#ss-insp-op").addEventListener("input", (e) => store.update(selectedLayerId, { opacity: Number(e.target.value) }));
  const MINR = 0.1;
  el.querySelector(".ss-insp").addEventListener("click", (e) => {
    const b = e.target.closest("[data-timing]"); if (!b) return;
    const cur = store.get(selectedLayerId); if (!cur) return;
    const r = cur.range;
    if (b.dataset.timing === "all") store.update(selectedLayerId, { range: null });
    else if (b.dataset.timing === "in") {
      const outSec = r ? r.outSec : session.meta.durationSec;
      store.update(selectedLayerId, { range: { inSec: Math.max(0, Math.min(lastTime, outSec - MINR)), outSec } });
    } else {
      const inSec = r ? r.inSec : 0;
      store.update(selectedLayerId, { range: { inSec, outSec: Math.max(inSec + MINR, lastTime) } });
    }
    session.timeline.refresh();
    updateInspector();
  });
}

// Translate a drag on the imported-audio block (reported in OUTPUT seconds) into edits on
// transforms.extraAudio. Body-drag moves it; the left edge trims the file's start (moving offset and
// trimIn together so the untouched part doesn't shift); the right edge trims the file's end.
function changeExtraAudio(r, mode) {
  if (!session) return;
  const ea = session.transforms.extraAudio;
  if (!ea) return;
  if (mode === "move") {
    ea.offsetSec = Math.max(0, r.tIn);
  } else if (mode === "in") {
    let delta = r.tIn - ea.offsetSec;          // how far the left edge moved (output seconds)
    if (ea.trimIn + delta < 0) delta = -ea.trimIn; // can't use audio from before the file's start
    ea.trimIn += delta;
    ea.offsetSec += delta;
  } else if (mode === "out") {
    const newLen = r.tOut - ea.offsetSec;
    ea.trimOut = Math.min(ea.durationSec, ea.trimIn + Math.max(0, newLen));
  }
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.timeline.refresh();
  session.preview.redraw();
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
    extraAudioInput: session.extraAudioInput, // ignored by the GIF path
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
  const zoom = Array.isArray(t.zoom) && t.zoom.length ? ` · ${t.zoom.length} zoom` : "";
  const bd = t.backdrop ? " · backdrop" : "";
  const a = t.audio || {};
  let audio;
  if ((t.speed || 1) !== 1) audio = "audio off (speed ≠ 1x)";
  else if (a.muted) audio = "audio muted";
  else {
    const mutes = Array.isArray(a.cuts) && a.cuts.length ? `, ${a.cuts.length} muted region${a.cuts.length > 1 ? "s" : ""}` : "";
    const vol = typeof a.volume === "number" && a.volume !== 1 ? `, ${Math.round(a.volume * 100)}%` : "";
    audio = `audio on${vol}${mutes}`;
  }
  const extra = t.extraAudio ? ` · + ${t.extraAudio.name || "audio"}${t.extraAudio.muted ? " (muted)" : ""}` : "";
  el.textContent = `${res} · ${t.speed}x · ${outDuration(t).toFixed(1)}s out${cuts}${zoom}${bd} · ${audio}${extra}`;
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
