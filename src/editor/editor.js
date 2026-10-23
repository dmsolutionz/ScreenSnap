// Editor boot / controller. Loads a clip (from ?clipId= or a file pick), builds the shell, wires the
// preview / timeline / layers / annotation modules, owns the transforms state, and drives export.
// FOUNDATION-OWNED and final — feature work happens inside the modules this orchestrates.
import { loadClip, pickFile, toInput } from "./source.js";
import { listIds } from "./idb.js";
import { defaultTransforms, composeDims, cropRect, outDuration, segmentsOf, piecesOf, outTimestamp, srcTimestamp } from "./transforms.js";
import { createLayerStore, createLayerHistory, newImageLayer, newShapeLayer } from "./layers-model.js";
import { translate } from "./shapes.js";
import { buildShell } from "./ui-shell.js";
import { createPreview } from "./preview.js";
import { createTimeline } from "./timeline.js";
import { createFilmstrip } from "./filmstrip.js";
import { createAnnotator } from "./annotate.js";
import { runExport, runGifExport } from "./export.js";
import { driveStatus, uploadToDrive, makeShareable, shareUrl } from "../lib/drive.js";
import { MSG } from "../lib/messages.js";
import { createCropOverlay } from "./crop-overlay.js";
import { createZoomOverlay } from "./zoom-overlay.js";
import { createSelectionOverlay } from "./selection-overlay.js";
import { decodeGif } from "./gif-decode.js";
import { computeWaveformPeaks } from "./audio-waveform.js";

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
// Left tool rail: [id, label, keyboard shortcut, svg icon]. "image" is an action (file picker), not a
// mode. Icons are inline SVG lifted from the design handoff.
const RAIL_TOOLS = [
  ["select", "Select", "V", '<svg viewBox="0 0 24 24" width="17" height="17"><polygon points="7,4 7,17.5 10.5,14 13,19.5 15.2,18.5 12.7,13 17.5,12.5" fill="currentColor"/></svg>'],
  ["rect", "Rectangle", "R", '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="4.5" y="7" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'],
  ["arrow", "Arrow", "A", '<svg viewBox="0 0 24 24" width="17" height="17"><line x1="6" y1="18" x2="17" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><polyline points="11,6.5 17.5,6.5 17.5,13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
  ["text", "Text", "T", '<svg viewBox="0 0 24 24" width="17" height="17"><line x1="5.5" y1="6.5" x2="18.5" y2="6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="6.5" x2="12" y2="18.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'],
  ["blur", "Blur", "B", '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.4"/><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.4"/></svg>'],
  ["image", "Add image", "I", '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="4.5" y="5.5" width="15" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><polyline points="6,17 11,12.5 14,15 16.5,13 19,15.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'],
];

const root = document.getElementById("root");
const empty = document.getElementById("empty");
const openBtn = document.getElementById("open-btn");

let session = null; // { input, meta, transforms, store, preview, timeline, annotator, cropOverlay, zoomOverlay, selectionOverlay, shell, fileName, blob, extraAudioInput, extraAudioBlob }
let stageResizeObserver = null; // re-places the stage overlays when the stage's box changes
let tool = "select";
let toolLocked = false; // double-click a rail tool to keep drawing with it (draw-once otherwise)
let color = "#22c55e";
let lastTime = 0;        // latest preview playhead (source seconds) — anchor for a new zoom block
let selectedZoomId = null; // id of the zoom block currently being edited (focus box shown)
let selectedLayerId = null; // id of the layer currently selected on the stage (resize box shown for images)
let audioPeaks = null; // { peaks, buckets } from computeWaveformPeaks(), or null (no track / not decoded yet)
let cropMode = false;
let selectedPiece = null; // {in,out} of the clip piece selected on the timeline (Delete removes it), or null  // the crop tool is open: the stage shows the WHOLE frame (no crop, no zoom) under the crop box
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
  // Probe the file BEFORE building any UI: an unreadable / non-video file (Mediabunny throws
  // UnsupportedInputFormatError) must land back on the open screen with a reason, not a blank page.
  let input, width, height, durationSec;
  try {
    input = toInput(blob);
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error("no video track");
    width = await vTrack.getDisplayWidth();
    height = await vTrack.getDisplayHeight();
    // Screen capture is variable-frame-rate: a static ending leaves the video track ending at its last
    // frame while the audio (narration) runs on. Use the longer track so that tail isn't silently
    // trimmed off — the export's frame clock holds the last frame across it.
    const aTrack = await input.getPrimaryAudioTrack().catch(() => null);
    const aDur = aTrack ? await aTrack.computeDuration().catch(() => 0) : 0;
    durationSec = Math.max(await vTrack.computeDuration(), aDur || 0);
    if (!(width > 0 && height > 0 && durationSec > 0)) throw new Error("empty video track");
  } catch (err) {
    console.warn("[screensnap] couldn't open clip:", err);
    return showEmpty(`“${fileName || "That file"}” couldn’t be opened — it isn’t a video this editor can read. Try an MP4 or WebM recording.`);
  }
  if (empty) empty.style.display = "none";
  root.style.display = "block";
  const meta = { durationSec, width, height };
  const transforms = defaultTransforms(meta);

  const store = createLayerStore();
  // ⌘Z/ctrl+Z over every edit, one step per gesture: overlay layers (move, resize, add, delete…) AND the
  // timeline / crop state (trims, splits, cuts, zooms, crop, backdrop…). The imported audio track is left
  // out: its decoded file lives on the session, so restoring only its numbers could point at nothing.
  const history = createLayerHistory(store, {
    extra: {
      get: () => { const { extraAudio, ...rest } = transforms; return structuredClone(rest); },
      set: (snap) => restoreEdits(snap),
    },
  });
  const shell = buildShell(root);

  buildToolbar(shell.toolbarEl, transforms);
  buildRail(shell.railEl);
  setStatus(shell.statusEl, meta, transforms);

  const preview = createPreview({
    canvas: shell.stageCanvas,
    blob,
    getTransforms: () => (cropMode ? stageTransforms(transforms) : transforms),
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
    srcW: width,
    srcH: height,
    onSelectionChange: (id) => selectLayer(id),
    onDraft: (rect) => session && session.selectionOverlay.setDraft(rect),
    // Draw-once: after a shape is committed, return to Select with the new shape selected — the very
    // next drag moves it. Holding ⇧ or double-click-locking the rail tool keeps drawing instead.
    onCreate: (id, shiftHeld) => {
      if (toolLocked || shiftHeld) return;
      setActiveTool("select");
      selectLayer(id);
    },
  });

  // Filmstrip: small frames tiled across the Video clip, decoded in the background (the clip is a flat
  // bar until they land).
  const film = createFilmstrip({ blob, durationSec, onUpdate: () => session?.timeline.redrawFilm() });

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
    // The Audio track header's own mute + volume (the same master state as Project ▾ → Volume / Mute all).
    getAudioState: () => ({ muted: !!transforms.audio.muted, volume: typeof transforms.audio.volume === "number" ? transforms.audio.volume : 1 }),
    onAudioMute: () => {
      transforms.audio.muted = !transforms.audio.muted;
      if (!transforms.audio.muted && !(transforms.audio.volume > 0)) transforms.audio.volume = 1;
      audioStateChanged();
    },
    onAudioVolume: (v) => {
      transforms.audio.volume = v;
      transforms.audio.muted = v === 0 ? transforms.audio.muted : false; // dragging the slider up un-mutes
      audioStateChanged();
    },
    getFilmstrip: () => film,
    getClipName: () => fileName,
    // Pieces / splits / markers: click a piece of the clip to select it, Delete removes it (a ripple delete).
    getPieces: () => piecesOf(transforms),
    getSplits: () => transforms.splits || [],
    getMarkers: () => transforms.markers || [],
    onPieceSelect: (p) => { selectedPiece = p; if (p) { selectLayer(null); selectZoom(null); } },
    onMarkerRemove: (id) => { transforms.markers = (transforms.markers || []).filter((m) => m.id !== id); edited(); },
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
    // Imported-audio track. extraAudio.offsetSec lives on the OUTPUT timeline (post trim/cuts/speed),
    // but the timeline ruler is SOURCE seconds — getExtraBlock converts so the block visually sticks
    // to the frame the user aligned it with under any trim/cuts/speed (and stretches across cut gaps).
    getExtraAudio: () => transforms.extraAudio,
    getExtraBlock: () => {
      const ea = transforms.extraAudio;
      if (!ea) return null;
      const len = Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0));
      return { tIn: srcTimestamp(ea.offsetSec || 0, transforms), tOut: srcTimestamp((ea.offsetSec || 0) + len, transforms) };
    },
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

  // Crop overlay: the "Crop" toolbar button (or C) opens it. It edits a persistent box over the WHOLE frame
  // (the preview draws the uncropped, unzoomed frame while it is open); Apply sets transforms.crop in source
  // px (null clears) and the preview/export recompute from there. Its options row lives in the inspector slot.
  const cropOverlay = createCropOverlay({
    stageEl: shell.stageCanvas.parentElement,
    canvas: shell.stageCanvas,
    inspectorEl: shell.inspectorEl,
    getTransforms: () => (cropMode ? stageTransforms(transforms) : transforms),
    getCrop: () => transforms.crop,
    srcW: width,
    srcH: height,
    onEnter: () => {
      selectZoom(null);
      selectLayer(null);
      preview.pause();
      updateTransport();
      cropMode = true;
      preview.redraw();
      markCropBtn(true);
    },
    onApply: (crop) => {
      transforms.crop = crop; // null clears
      setStatus(shell.statusEl, meta, transforms);
    },
    onExit: () => {
      cropMode = false;
      preview.redraw();
      zoomOverlay.refresh(); // crop changes the content rect — re-place the focus box if shown
      selectionOverlay.refresh();
      markCropBtn(false);
    },
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
      history.change();
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

  session = { input, meta, transforms, store, history, preview, timeline, film, annotator, cropOverlay, zoomOverlay, selectionOverlay, shell, fileName, blob, extraAudioInput: null, extraAudioBlob: null };

  // The stage overlays position from the canvas rect, but the stage reflows when the chrome around it
  // changes size (inspector row appearing on selection, window resize) — re-place them when that happens.
  if (stageResizeObserver) stageResizeObserver.disconnect();
  stageResizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    if (!session) return;
    session.zoomOverlay.refresh();
    session.selectionOverlay.refresh();
    session.cropOverlay.refresh();
  }) : null;
  if (stageResizeObserver) {
    stageResizeObserver.observe(shell.stageCanvas.parentElement);
    stageResizeObserver.observe(shell.stageCanvas);
  }

  // Prominent transport: a play/pause button + time readout, plus a click-to-play overlay centred on
  // the stage (hidden while playing and while a drawing tool is active so it never blocks annotation).
  buildTransport(shell.transportEl);
  updateTransport();

  // Render the first frame.
  preview.seekTo(0);
}

const BD_OPTS = [["grad-violet", "Violet"], ["grad-ocean", "Ocean"], ["grad-sunset", "Sunset"], ["grad-mint", "Mint"], ["grad-slate", "Slate"], ["dark", "Dark"], ["light", "Light"], ["white", "White"]];

function buildToolbar(el, transforms) {
  el.innerHTML = `
    <div class="ss-tb-group">
      <button class="ss-tool" id="ss-crop-btn" title="Crop the frame (C)">Crop</button>
      <button class="ss-tool" id="ss-split-btn" title="Split the clip at the playhead (S), then click a piece and press Delete">Split</button>
      <button class="ss-tool" id="ss-cut-btn" title="Cut mode (X): drag on the Video track to remove a section">Cut</button>
      <button class="ss-tool" id="ss-zoom-add" title="Add a zoom at the playhead (Z)">+ Zoom</button>
      <button class="ss-tool" id="ss-zoom-remove" title="Remove the selected zoom" disabled>Remove zoom</button>
    </div>
    <span class="ss-tb-sep"></span>
    <div class="ss-tb-group">
      <button class="ss-tool" data-pop="backdrop" id="ss-backdrop-pop" title="Padded background">Backdrop ▾</button>
      <button class="ss-tool" data-pop="project" id="ss-project-pop" title="Resolution, speed, audio">Project ▾</button>
    </div>
    <div class="ss-tb-group ss-tb-right">
      <button class="ss-btn ss-btn-ghost" id="ss-share-btn" title="Upload to Drive and copy a share link" hidden>Share</button>
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
      <button data-exp="drive" id="ss-exp-drive" hidden>Upload MP4 to Drive</button>
      <button data-exp="share" id="ss-exp-share" hidden>Get share link</button>
    </div>`;

  refreshDriveMenuItem();

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

  // ── clip actions (tools live in the left rail now) ────────────────────────────────────────────
  el.querySelector("#ss-crop-btn").addEventListener("click", () => toggleCrop());
  el.querySelector("#ss-cut-btn").addEventListener("click", () => toggleCut());
  el.querySelector("#ss-split-btn").addEventListener("click", () => splitAtPlayhead());
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
    audioStateChanged();
  });
  el.querySelector("#ss-audio-vol").addEventListener("input", (e) => {
    transforms.audio.volume = Number(e.target.value);
    if (transforms.audio.volume > 0 && transforms.audio.muted) transforms.audio.muted = false;
    audioStateChanged();
  });
  el.querySelector("#ss-add-audio").addEventListener("click", () => onAddAudioClick());
  el.querySelector("#ss-remove-audio").addEventListener("click", () => removeExtraAudio());

  // ── Export split + menu ───────────────────────────────────────────────────────────────────────
  el.querySelector("#ss-export").addEventListener("click", () => doExport(el.querySelector("#ss-export")));
  el.querySelector("#ss-pop-export").addEventListener("click", (e) => {
    const b = e.target.closest("[data-exp]"); if (!b) return;
    closePopovers();
    if (b.dataset.exp === "orig") downloadOriginal();
    else if (b.dataset.exp === "drive") {
      // Not connected yet: the item reads "Set up Drive upload" and opens the Cloud setup window
      // (storage.onChanged flips it to the real upload action once connected).
      if (b.dataset.connected) driveExport(el.querySelector("#ss-export"));
      else chrome.runtime.sendMessage({ type: MSG.DRIVE_OPEN_SETUP }).catch(() => {});
    }
    else if (b.dataset.exp === "share") shareExport(el.querySelector("#ss-export"));
    else doExport(el.querySelector("#ss-export"), b.dataset.exp === "gif" ? "gif" : undefined);
  });
  el.querySelector("#ss-close").addEventListener("click", () => closeEditor());
  const shareBtn = el.querySelector("#ss-share-btn");
  if (shareBtn)
    shareBtn.addEventListener("click", () => {
      if (shareBtn.dataset.connected) shareExport(shareBtn);
      else chrome.runtime.sendMessage({ type: MSG.DRIVE_OPEN_SETUP }).catch(() => {});
    });
}

// The recording's master audio changed (from the timeline's Audio header or Project ▾): keep the status line,
// the preview, the popover's controls and the timeline header all saying the same thing.
function audioStateChanged() {
  if (!session) return;
  const a = session.transforms.audio;
  const cb = document.getElementById("ss-audio-mute-cb"), vol = document.getElementById("ss-audio-vol");
  if (cb) cb.checked = !!a.muted;
  if (vol && document.activeElement !== vol) vol.value = String(typeof a.volume === "number" ? a.volume : 1);
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.preview.redraw();
  session.timeline.refresh();
}

// Switch the active drawing tool, updating the rail highlight. `lock` keeps the tool armed after a
// shape is drawn (double-click / ⇧); otherwise drawing auto-returns to Select (draw-once).
function setActiveTool(t, lock = false) {
  tool = t;
  toolLocked = lock && t !== "select";
  session?.annotator.setTool(tool);
  if (session?.cropOverlay?.isActive()) session.cropOverlay.commit(); // switching tools keeps an edited box
  selectZoom(null);
  document.querySelectorAll("[data-tool]").forEach((x) => {
    x.classList.toggle("on", x.dataset.tool === tool);
    x.classList.toggle("locked", x.dataset.tool === tool && toolLocked);
  });
}

// The 52px left icon rail: single click arms a tool (draw-once), double-click locks it for repeated
// shapes; "image" is a one-shot file-picker action. Tooltips show name + shortcut + lock hint.
function buildRail(el) {
  el.innerHTML = RAIL_TOOLS.map(([id, label, key]) => `
    <button class="ss-rail-btn ${id === tool ? "on" : ""}" data-tool="${id}" aria-label="${label}">
      ${RAIL_TOOLS.find((t) => t[0] === id)[3]}
      <span class="ss-rail-tip">${label} <kbd>${key}</kbd>${id !== "select" && id !== "image" ? '<span class="ss-rail-tip-hint">2× click = lock</span>' : ""}</span>
    </button>`).join("");
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    if (b.dataset.tool === "image") { await addImageFromPicker(); return; }
    setActiveTool(b.dataset.tool, false);
  });
  el.addEventListener("dblclick", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b || b.dataset.tool === "image" || b.dataset.tool === "select") return;
    setActiveTool(b.dataset.tool, true);
  });
}

async function addImageFromPicker() {
  if (!session) return;
  const file = await pickImageFile();
  if (!file) return;
  // Place it inside the visible content (the crop rect, or the full frame): a fixed source-px spot
  // like (24,24) is off-canvas once a crop excludes the top-left.
  await addImageLayer(file, session.store, cropRect(session.transforms, session.meta.width, session.meta.height));
}

// ⌘D: duplicate the selected layer, offset slightly, and select the copy.
function duplicateSelected() {
  if (!session || !selectedLayerId) return;
  const l = session.store.get(selectedLayerId);
  if (!l) return;
  const OFF = Math.max(12, Math.round((session.meta.width || 900) / 80));
  let copy = null;
  if (l.kind === "image" && l.image) {
    copy = session.store.add(newImageLayer({ ...l.image, x: l.image.x + OFF, y: l.image.y + OFF }));
  } else if (l.kind === "shape" && l.shape) {
    copy = session.store.add(newShapeLayer(translate(l.shape, OFF, OFF)));
  }
  if (!copy) return;
  session.store.update(copy.id, { visible: l.visible, opacity: l.opacity, range: l.range ? { ...l.range } : null });
  selectLayer(copy.id);
}

// Close the editor tab. The page was opened via chrome.tabs.create, so window.close() isn't reliable;
// remove the current tab through the tabs API (needs no extra permission) and fall back to close().
function closeEditor() {
  // tabs.remove skips the beforeunload prompt, so ask here too rather than silently killing an export.
  if (exportBusy && !confirm("An export is still running. Close the editor and cancel it?")) return;
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
function buildTransport(el) {
  if (!el) return;
  el.innerHTML = `
    <button class="ss-step" id="ss-prev-edge" type="button" title="Previous clip edge or cut">⏮</button>
    <button class="ss-pp" id="ss-pp" type="button" aria-label="Play">${PLAY_SVG}</button>
    <button class="ss-step" id="ss-next-edge" type="button" title="Next clip edge or cut">⏭</button>
    <span class="ss-key-hint"><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> play · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>↑</kbd><kbd>↓</kbd> edits · <kbd>S</kbd> split · <kbd>Q</kbd><kbd>W</kbd> trim to playhead · <kbd>M</kbd> marker · <kbd>⌘Z</kbd> undo</span>
    <div class="ss-tb-spacer"></div>
    <span class="ss-key-hint">⌘ scroll or pinch to zoom the timeline</span>`;
  el.querySelector("#ss-pp").addEventListener("click", () => togglePlay());
  el.querySelector("#ss-prev-edge").addEventListener("click", () => jumpEdge(-1));
  el.querySelector("#ss-next-edge").addEventListener("click", () => jumpEdge(1));
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
  session.timeline.setPlayhead(sec, session.preview.isPlaying()); // the readout lives in the timeline's ruler header
}

// Scale a source image so it spans at most ~40% of the video width, never upscaling. Defensive against
// zero/NaN dimensions (a broken decode or audio-only source) — always returns a finite positive scale.
function fitScale(imgW, videoW) {
  if (!(imgW > 0)) return 1;
  const target = videoW > 0 ? videoW * 0.4 : imgW;
  return Math.min(1, target / imgW) || 1;
}

// Add an image (or animated GIF) as an overlay layer. GIFs are decoded to frames so they animate;
// if decode fails we fall back to the first frame as a static image. `base` is the visible content
// rect in source px ({x,y,w,h}); the image is sized to it and inset from its top-left corner.
async function addImageLayer(file, store, base) {
  const inset = Math.max(24, Math.round(base.w / 40));
  try {
    if (file.type === "image/gif") {
      try {
        const g = await decodeGif(file);
        const scale = fitScale(g.width, base.w);
        store.add(newImageLayer({
          bitmap: g.frames[0].bitmap, x: base.x + inset, y: base.y + inset, w: g.width * scale, h: g.height * scale,
          frames: g.frames, totalMs: g.totalMs,
        }));
        return;
      } catch (err) {
        console.warn("[screensnap] GIF decode failed — adding first frame as static image:", err);
      }
    }
    const bitmap = await createImageBitmap(file);
    const scale = fitScale(bitmap.width, base.w);
    store.add(newImageLayer({ bitmap, x: base.x + inset, y: base.y + inset, w: bitmap.width * scale, h: bitmap.height * scale }));
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
  if (session.cropOverlay.isActive()) session.cropOverlay.commit(); // one overlay on the stage at a time
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
  session.history.change();
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
  updateInspector();                                 // show/hide the inspector row FIRST — it reflows the stage…
  session.selectionOverlay.refresh();                // …then place the resize box from the settled canvas rect
}

// The contextual inspector row (under the toolbar) — visible only while a layer is selected. Shows the
// selected shape's color (shapes only), opacity, and time-range controls; replaces the last job the
// Layers sidebar did. Rebuilt whenever the selection changes.
function updateInspector() {
  if (!session || session.cropOverlay.isActive()) return; // the crop options own the row while the tool is open
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

// Translate a drag on the imported-audio block into edits on transforms.extraAudio. The timeline
// reports SOURCE seconds (its ruler); extraAudio.offsetSec lives on the OUTPUT timeline, so drag
// results convert through outTimestamp() first. Body-drag moves it; the left edge trims the file's
// start (moving offset and trimIn together so the untouched part doesn't shift); the right edge
// trims the file's end.
function changeExtraAudio(r, mode) {
  if (!session) return;
  const t = session.transforms;
  const ea = t.extraAudio;
  if (!ea) return;
  if (mode === "move") {
    ea.offsetSec = Math.max(0, outTimestamp(r.tIn, t));
  } else if (mode === "in") {
    let delta = outTimestamp(r.tIn, t) - ea.offsetSec; // how far the left edge moved (output seconds)
    if (ea.trimIn + delta < 0) delta = -ea.trimIn;     // can't use audio from before the file's start
    ea.trimIn += delta;
    ea.offsetSec += delta;
  } else if (mode === "out") {
    const newLen = outTimestamp(r.tOut, t) - ea.offsetSec;
    ea.trimOut = Math.min(ea.durationSec, ea.trimIn + Math.max(0, newLen));
  }
  setStatus(session.shell.statusEl, session.meta, t);
  session.timeline.refresh();
  session.preview.redraw();
}

// Any edit that doesn't already go through setStatus (markers, splits): refresh and record an undo step.
function edited() {
  if (!session) return;
  setStatus(session.shell.statusEl, session.meta, session.transforms);
  session.timeline.refresh();
}

// S / Split: divide the clip at the playhead. The pieces can then be selected and deleted one by one.
function splitAtPlayhead() {
  if (!session) return;
  const t = session.transforms, at = Math.round(lastTime * 1000) / 1000;
  const inKept = piecesOf(t).some((p) => at > p.in + 0.05 && at < p.out - 0.05);
  if (!inKept || (t.splits || []).some((x) => Math.abs(x - at) < 0.05)) return;
  t.splits = [...(t.splits || []), at].sort((a, b) => a - b);
  edited();
}

// Delete / Backspace on a selected piece: cut exactly that piece out (later video closes the gap). The
// last remaining piece can't go — there would be nothing left to export.
function deleteSelectedPiece() {
  if (!session || !selectedPiece) return false;
  const t = session.transforms;
  if (piecesOf(t).length < 2) return false;
  t.cuts = [...(t.cuts || []), { in: selectedPiece.in, out: selectedPiece.out }];
  selectedPiece = null;
  session.timeline.clearPiece();
  session.preview.seekTo(lastTime); // off a removed frame
  edited();
  session.preview.redraw();
  return true;
}

// M: drop a marker at the playhead (a jump target for ↑/↓ and a snap point); again on one removes it.
function toggleMarker() {
  if (!session) return;
  const t = session.transforms, at = Math.round(lastTime * 1000) / 1000;
  const hit = (t.markers || []).find((m) => Math.abs(m.t - at) < 0.05);
  t.markers = hit ? t.markers.filter((m) => m !== hit) : [...(t.markers || []), { id: Math.random().toString(36).slice(2, 9), t: at }];
  edited();
}

// Q / W: trim the start / end of the clip to the playhead (the playhead stays on the new edge).
function trimToPlayhead(which) {
  if (!session) return;
  const t = session.transforms, at = lastTime;
  if (which === "in" && at < t.trimOut - 0.05) t.trimIn = at;
  else if (which === "out" && at > t.trimIn + 0.05) t.trimOut = at;
  else return;
  session.timeline.setTrim(t.trimIn, t.trimOut);
  edited();
}

// J / K / L: the editor's shuttle. L plays, K stops, J steps back a second at a time.
function shuttle(k) {
  if (!session) return;
  if (k === "l") { if (!session.preview.isPlaying()) togglePlay(); }
  else if (k === "k") { if (session.preview.isPlaying()) togglePlay(); }
  else stepBy(-1);
}

// Undo / redo put the edit state back: copy it into the live transforms (closures hold that object) and
// bring every view of it up to date.
function restoreEdits(snap) {
  if (!session) return;
  const t = session.transforms;
  Object.assign(t, structuredClone(snap));
  session.timeline.setTrim(t.trimIn, t.trimOut);
  if (selectedZoomId && !(t.zoom || []).some((b) => b.id === selectedZoomId)) selectZoom(null);
  syncProjectControls();
  setStatus(session.shell.statusEl, session.meta, t);
  session.timeline.refresh();
  session.preview.redraw();
  session.zoomOverlay.refresh();
  session.selectionOverlay.refresh();
  markCropBtn(false);
}

// The Backdrop / Project popovers' controls, from the transforms (after an undo).
function syncProjectControls() {
  const t = session.transforms, $ = (id) => document.getElementById(id);
  if ($("ss-bd-on")) $("ss-bd-on").checked = !!t.backdrop;
  if (t.backdrop && $("ss-bd-bg")) $("ss-bd-bg").value = t.backdrop.bg;
  if (t.backdrop && $("ss-bd-pad")) $("ss-bd-pad").value = String(t.backdrop.pad);
  if ($("ss-res")) $("ss-res").value = t.outScale ? String(t.outScale.maxHeight) : "";
  if ($("ss-speed")) $("ss-speed").value = String(t.speed || 1);
  if ($("ss-audio-mute-cb")) $("ss-audio-mute-cb").checked = !!t.audio.muted;
  if ($("ss-audio-vol")) $("ss-audio-vol").value = String(typeof t.audio.volume === "number" ? t.audio.volume : 1);
}

// Cut toolbar button / X: while on, dragging across the Video track removes that section.
function toggleCut() {
  if (!session?.timeline) return;
  const on = !session.timeline.isCutMode();
  session.timeline.setCutMode(on);
  document.getElementById("ss-cut-btn")?.classList.toggle("on", on);
}

// What the stage draws while the crop tool is open: the whole frame, so the box can grow back out of an
// applied crop, with no zoom block moving the picture under it.
function stageTransforms(t) { return { ...t, crop: null, zoom: [] }; }

// Crop toolbar button / C: open the tool; pressing it again applies an edited box (or just closes).
function toggleCrop() {
  if (!session?.cropOverlay) return;
  if (session.cropOverlay.isActive()) session.cropOverlay.commit();
  else session.cropOverlay.enter();
}

function markCropBtn(on) {
  const b = document.getElementById("ss-crop-btn");
  if (!b) return;
  b.classList.toggle("on", !!on);
  b.classList.toggle("has", !on && !!session?.transforms?.crop); // a dot on the button while a crop is applied
}

function onPreviewStop(err) {
  updateTransport();
  if (session) setStatus(session.shell.statusEl, session.meta, session.transforms, "Playback stopped — " + ((err && err.message) || "decode error"));
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

// Every interesting SOURCE-time edge on the timeline (trim, cuts, zoom blocks, layer ranges, mute
// bands) plus the clip bounds — the jump targets for ⏮/⏭. The imported track is skipped: its offset
// lives on the OUTPUT timeline, not source time, so it has no direct seek target here.
function edgeTimes() {
  const t = session.transforms;
  const out = [0, session.meta.durationSec, t.trimIn, t.trimOut];
  (t.cuts || []).forEach((c) => out.push(c.in, c.out));
  (t.zoom || []).forEach((b) => out.push(b.tIn, b.tOut));
  session.store.layers.forEach((l) => { if (l.range) out.push(l.range.inSec, l.range.outSec); });
  ((t.audio && t.audio.cuts) || []).forEach((c) => out.push(c.in, c.out));
  (t.splits || []).forEach((x) => out.push(x));
  (t.markers || []).forEach((m) => out.push(m.t));
  return [...new Set(out.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
}

// Seek to the previous (-1) / next (+1) edge relative to the playhead.
function jumpEdge(dir) {
  if (!session) return;
  const edges = edgeTimes();
  const target = dir < 0
    ? [...edges].reverse().find((e) => e < lastTime - 0.05)
    : edges.find((e) => e > lastTime + 0.05);
  if (target != null) session.preview.seekTo(target);
}

// Frame-step (±1/30s) or 1s-step (⇧) relative to the playhead. Direction-aware across cuts: a step
// landing inside a removed region continues into the next/previous kept segment instead of letting
// seekTo snap it back to the edge it started from (which would make stepping at a cut edge a no-op).
function stepBy(sec) {
  if (!session) return;
  session.preview.pause();
  updateTransport();
  let target = Math.max(0, Math.min(session.meta.durationSec, lastTime + sec));
  const segs = segmentsOf(session.transforms);
  if (!segs.some((s) => target >= s.in && target < s.out)) {
    if (sec > 0) {
      const nxt = segs.find((s) => s.in > target);
      if (nxt) target = nxt.in;
    } else {
      const prv = [...segs].reverse().find((s) => s.out <= target);
      if (prv) target = Math.max(prv.in, prv.out - 0.001);
    }
  }
  session.preview.seekTo(target);
}

// ── export lock ───────────────────────────────────────────────────────────────────────────────
// An export of a long clip runs for minutes while the editor stays interactive, so each run works
// from a SNAPSHOT of the edit (transforms + layers) — the live objects keep changing under the user's
// hands, and a mid-run trim/cut/speed edit used to rewind output timestamps and abort the muxer.
// While one runs, every export entry point is disabled (no concurrent second transcode) and leaving
// the page asks first.
let exportBusy = false;
function lockExports(on) {
  for (const id of ["ss-export", "ss-export-caret", "ss-share-btn"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = on;
  }
}
window.addEventListener("beforeunload", (e) => {
  if (!exportBusy) return;
  e.preventDefault();
  e.returnValue = ""; // legacy browsers need a value to show the prompt
});

// Deep-enough copy of the layer store for an export: positional/style data is copied (so drags and
// deletes don't reach the running export), bitmaps / GIF frames are shared by reference (immutable).
function snapshotLayers(store) {
  const layers = store.visibleOrdered().map((l) => ({
    ...l,
    shape: l.shape ? JSON.parse(JSON.stringify(l.shape)) : l.shape,
    image: l.image ? { ...l.image } : l.image,
    range: l.range ? { ...l.range } : l.range,
  }));
  return { visibleOrdered: () => layers };
}

function exportArgs(btn) {
  return {
    input: session.input,
    transforms: structuredClone(session.transforms),
    store: snapshotLayers(session.store),
    fileName: session.fileName,
    sourceBytes: session.blob ? session.blob.size : 0, // caps the export bitrate at the source's own
    extraAudioInput: session.extraAudioInput, // ignored by the GIF path
    onProgress: (frac) => { btn.textContent = `Exporting ${Math.round(frac * 100)}%`; },
  };
}

// Claim the export lock (false if one is already running). The caller restores the button label after
// its result beat and then calls lockExports(false); exportBusy itself drops as soon as the work ends.
function beginExport() {
  if (!session || exportBusy) return false;
  exportBusy = true;
  lockExports(true);
  session.preview.pause();
  updateTransport();
  return true;
}

async function doExport(btn, format) {
  if (!beginExport()) return;
  const orig = btn.textContent;
  const args = exportArgs(btn);
  try {
    if (format === "gif") await runGifExport(args);
    else await runExport(args);
    exportBusy = false;
    btn.textContent = "Saved ✓";
    setTimeout(() => { btn.textContent = orig; lockExports(false); }, 1800);
  } catch (err) {
    exportBusy = false;
    btn.textContent = "Export failed";
    setStatus(session.shell.statusEl, session.meta, session.transforms, String((err && err.message) || err));
    setTimeout(() => { btn.textContent = orig; lockExports(false); }, 2600);
  }
}

// Keep the export menu's Drive item current: hidden when the build can't do Drive at all,
// "Set up Drive upload" before the user connects, "Upload MP4 to Drive" after. Reacts live to
// the Cloud setup window connecting/disconnecting via chrome.storage.onChanged below.
function refreshDriveMenuItem() {
  const item = document.getElementById("ss-exp-drive");
  const share = document.getElementById("ss-exp-share");
  const shareBtn = document.getElementById("ss-share-btn");
  if (!item) return;
  driveStatus()
    .then((d) => {
      const on = d.supported && d.configured;
      if (!on) { item.hidden = true; if (share) share.hidden = true; if (shareBtn) shareBtn.hidden = true; return; }
      item.hidden = false;
      item.dataset.connected = d.connected ? "1" : "";
      item.textContent = d.connected ? "Upload MP4 to Drive" : "Set up Drive upload";
      if (share) share.hidden = !d.connected; // menu item only makes sense once connected
      // The toolbar Share button stays visible whenever Drive is available, so it's discoverable
      // without opening the export menu; when not connected it routes to Cloud setup.
      if (shareBtn) { shareBtn.hidden = false; shareBtn.dataset.connected = d.connected ? "1" : ""; }
    })
    .catch(() => {});
}
chrome.storage?.onChanged?.addListener((ch, area) => {
  if (area === "local" && ch.driveAccount) refreshDriveMenuItem();
});

// Surface the service worker's auto-backup of the raw recording (state.drive) in the status bar,
// so an upload the user asked for isn't invisible while they edit. Transient by design: the next
// setStatus from an edit overwrites it, and the "done" note restores the normal line after a beat.
chrome.runtime?.onMessage?.addListener((m, sender) => {
  if (sender.id !== chrome.runtime.id || !m || m.type !== MSG.STATE_CHANGED) return;
  const d = m.state && m.state.drive;
  if (!d || !session) return;
  const el = session.shell.statusEl;
  if (d.status === "uploading") { el.classList.remove("ss-status-err"); el.textContent = `Backing up original to Drive ${d.pct || 0}%`; }
  else if (d.status === "done") {
    el.classList.remove("ss-status-err");
    el.textContent = "Original backed up to Drive";
    setTimeout(() => { if (session) setStatus(el, session.meta, session.transforms); }, 4000);
  } else if (d.status === "error") {
    setStatus(el, session.meta, session.transforms, "Drive backup failed: " + (d.error || "unknown error"));
  }
});

// Export the edited MP4 and push it straight to the user's Google Drive instead of saving locally.
// Only reachable when Drive is connected (the menu item reads "Set up" otherwise); the upload runs
// here in the editor page, so progress lives on the button and closing the tab cancels it.
async function driveExport(btn) {
  if (!beginExport()) return;
  const orig = btn.textContent;
  try {
    const { blob, fileName } = await runExport({ ...exportArgs(btn), download: false });
    btn.textContent = "Uploading 0%";
    await uploadToDrive(blob, fileName, {
      onProgress: (done, total) => { btn.textContent = `Uploading ${total ? Math.round((done / total) * 100) : 0}%`; },
    });
    exportBusy = false;
    btn.textContent = "Uploaded ✓";
    setTimeout(() => { btn.textContent = orig; lockExports(false); }, 1800);
  } catch (err) {
    exportBusy = false;
    btn.textContent = "Upload failed";
    setStatus(session.shell.statusEl, session.meta, session.transforms, String((err && err.message) || err));
    setTimeout(() => { btn.textContent = orig; lockExports(false); }, 2600);
  }
}

// Export the edited MP4, push it to Drive, make it "anyone with link", and hand back a screensnap
// share URL: opened in a new tab (so the user lands on the branded player) and copied to the clipboard.
async function shareExport(btn) {
  if (!beginExport()) return;
  const orig = btn.textContent;
  try {
    const { blob, fileName } = await runExport({ ...exportArgs(btn), download: false });
    btn.textContent = "Uploading 0%";
    const res = await uploadToDrive(blob, fileName, {
      onProgress: (done, total) => { btn.textContent = `Uploading ${total ? Math.round((done / total) * 100) : 0}%`; },
    });
    btn.textContent = "Creating link…";
    await makeShareable(res.id);
    const url = shareUrl(res.id, fileName);
    navigator.clipboard?.writeText(url).catch(() => {});
    // chrome.tabs.create works from an extension page without a fresh user gesture (window.open would
    // be blocked after the long export/upload), so the link reliably opens on the branded player.
    if (chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, "_blank", "noopener");
    exportBusy = false;
    btn.textContent = "Link ready ✓";
    const el = session.shell.statusEl;
    el.classList.remove("ss-status-err");
    el.textContent = "Share link copied to clipboard";
    setTimeout(() => { if (session) setStatus(el, session.meta, session.transforms); btn.textContent = orig; lockExports(false); }, 3200);
  } catch (err) {
    exportBusy = false;
    btn.textContent = "Share failed";
    setStatus(session.shell.statusEl, session.meta, session.transforms, String((err && err.message) || err));
    setTimeout(() => { btn.textContent = orig; lockExports(false); }, 2600);
  }
}

function setStatus(el, meta, t, errMsg) {
  if (!el) return;
  if (!errMsg) session?.history.change(); // every edit passes through here: it joins (or opens) an undo step
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

// Keyboard shortcuts — all ignored while typing in a field (e.g. the text-annotation input).
// Space = play/pause · J K L = shuttle · ←→ frame · ↑↓ prev/next edit · S = split at playhead · Delete = remove
// the selected piece · Q / W = trim start / end to the playhead · M = marker · V R A T B = tools · I = add image ·
// C = crop · X = cut mode · Z = add zoom · esc = Select + deselect · ⌘D = duplicate · ⌘Z / ⇧⌘Z = undo / redo.
const TOOL_KEYS = { v: "select", r: "rect", a: "arrow", t: "text", b: "blur" };
window.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  const tag = el && el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el && el.isContentEditable)) return;
  if (!session) return;
  if (e.code === "Space" || e.key === " ") { e.preventDefault(); togglePlay(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    const done = e.shiftKey ? session.history.redo() : session.history.undo();
    if (done) {
      // The store notify already redraws the preview + re-places the selection box; the timeline and
      // inspector are manual. A selected layer that the restore removed must also be deselected.
      if (selectedLayerId && !session.store.get(selectedLayerId)) selectLayer(null);
      else updateInspector();
      session.timeline.refresh();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return; // don't shadow browser shortcuts
  if (e.key === "ArrowLeft") { e.preventDefault(); stepBy(e.shiftKey ? -1 : -1 / 30); return; }
  if (e.key === "ArrowRight") { e.preventDefault(); stepBy(e.shiftKey ? 1 : 1 / 30); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); jumpEdge(-1); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); jumpEdge(1); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selectedPiece && !selectedLayerId) { e.preventDefault(); deleteSelectedPiece(); return; }
  if (e.key === "Escape") { setActiveTool("select"); selectLayer(null); if (selectedPiece) { selectedPiece = null; session.timeline.clearPiece(); } return; }
  const k = e.key.toLowerCase();
  if (k === "s") { splitAtPlayhead(); return; }
  if (k === "m") { toggleMarker(); return; }
  if (k === "q") { trimToPlayhead("in"); return; }
  if (k === "w") { trimToPlayhead("out"); return; }
  if (k === "j" || k === "k" || k === "l") { shuttle(k); return; }
  if (k === "i") { addImageFromPicker(); return; }
  if (k === "c") { toggleCrop(); return; }
  if (k === "x") { toggleCut(); return; }
  if (k === "z") { addZoom(); return; }
  if (TOOL_KEYS[k]) setActiveTool(TOOL_KEYS[k], e.shiftKey);
});

// Buttons in the editor never take focus on click: otherwise the next shortcut (S, ⌘Z…) shows a focus ring on
// whichever button was clicked last, and Enter / Space would press it again.
document.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && e.target.closest(".ss-ed button")) e.preventDefault();
}, true);

// Click-away deselect: clicking the stage background (outside the video) or an empty part of the
// timeline dismisses the selection box. Clicks on the canvas keep their existing behavior (annotate.js
// selects/deselects by hit-test), and clicks that act ON the selection — the resize handles, a layer's
// own track row, the inspector — or on the tool rail keep it. Other chrome (toolbar, transport,
// popovers) deliberately leaves the selection alone.
document.addEventListener("pointerdown", (e) => {
  if (!session || !selectedLayerId) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (!t.closest(".ss-stage, .ss-timeline")) return;
  if (t === session.shell.stageCanvas) return;
  if (t.closest(".ss-sel-host, .ss-tl-trk-layer")) return;
  selectLayer(null);
}, true);

boot();
