// Timeline: a CONSTANT-HEIGHT panel so adding a layer never reflows the stage. Layout is a frozen-pane
// track grid — a pinned ruler (big timecode + snap toggle in its header) and a pinned Video clip (filmstrip,
// name strip, dimmed out-of-trim regions) at the top, then a vertically-scrolling stack of track rows (zoom,
// one per overlay layer, audio, imported audio), then a zoom / pan navigator bar. Every row is [188px header |
// time area]. The header column is fixed (colored track badge + the track's own toggles); the time area is a
// shared horizontal scale driven in JS by `pxPerSecond` + `scrollX` (px, not %), so zoom / pan keep every
// track aligned. A single full-height playhead (flag head you can drag) spans the panel. All block
// interactions (select / move / resize / paint) go through one shared wireBlockDrag(); the video track keeps
// the trim / scrub / cut handlers.
//
// Rebuild discipline: the row SKELETON (headers + persistent time containers that own the pointer
// listeners) is only rebuilt when the layer set changes (a signature check), so a header control drag
// or a block drag's pointer-capture is never torn down mid-gesture. refresh() only rebuilds the block
// CHILDREN inside the persistent containers and re-lays-out positions. setPlayhead() only moves the
// playhead. Pure DOM (the filmstrip is one canvas; the waveform is one SVG path).

import { escapeHtml } from "./shapes.js";

const HEADER_W = 188; // px, the fixed track-header column (keep in step with .ss-tl-thead in editor.css)
const TIME_PAD = 10;  // horizontal inset of every time area (matching margins on all rows + ruler)
const ZOOM_STEP = 1.4;
const MAX_ZOOM_MULT = 10; // furthest zoom-in relative to Fit …
const MAX_PPS = 240;      // … or this many px per second, whichever is further (frame-level editing on long clips)
const FILM_BAR = 16;      // px, the clip's name strip over the filmstrip

const svg = (body) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.7 9.7 0 0 1 12 4c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/>'),
  vol: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  mute: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6m0-6 6 6"/>'),
  magnet: svg('<path d="M6 15a6 6 0 0 0 12 0V3h-4v12a2 2 0 0 1-4 0V3H6v12z"/><path d="M6 8h4M14 8h4"/>'),
};

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
// Timecode with hundredths — the big readout and the drag tips: 0:07.12
function fmtTc(sec) {
  const t = Math.max(0, sec || 0);
  const cs = Math.floor(t * 100);
  return `${Math.floor(cs / 6000)}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
// Ruler labels: m:ss, with tenths/hundredths only when the step is finer than a second.
function fmtTick(sec, step) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const whole = step >= 1 ? String(Math.round(s)).padStart(2, "0") : String(s.toFixed(step >= 0.1 ? 1 : 2)).padStart(step >= 0.1 ? 4 : 5, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${whole}` : `${m}:${whole}`;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Ruler: the smallest "nice" step that keeps labels >= 64px apart, and how many minor ticks to cut it into.
const STEPS = [[0.05, 5], [0.1, 5], [0.2, 4], [0.5, 5], [1, 5], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [900, 3], [1800, 6], [3600, 6]];
function rulerStep(pps) { return STEPS.find(([s]) => s * pps >= 64) || STEPS[STEPS.length - 1]; }

const LAYER_GLYPH = { rect: "▭", arrow: "↗", text: "T", blur: "◍", spot: "◉" };
function laneLabel(l) {
  if (!l) return "Layer";
  if (l.kind === "image") return (l.image && l.image.frames) ? "GIF" : "Image";
  if (l.kind === "video") return escapeHtml((l.video && l.video.name) || "Video"); // a file name, into innerHTML
  const t = (l.shape && l.shape.type) || "shape";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function laneGlyph(l) {
  if (l && l.kind === "image") return (l.image && l.image.frames) ? "GIF" : "▣";
  if (l && l.kind === "video") return "▶";
  return LAYER_GLYPH[(l && l.shape && l.shape.type) || ""] || "◆";
}

// Closed SVG path (viewBox "0 0 100 30") tracing a waveform envelope from interleaved [min,max,…] peaks.
// `gain` scales it for display only: a quiet recording is lifted toward full height (at most +12 dB, so
// near-silent room tone doesn't look loud) so you can still see where the words are.
function waveformPath(peaks, buckets, gain = 1) {
  if (!peaks || !buckets) return "";
  const midY = 15, top = [], bottom = [], span = Math.max(1, buckets - 1);
  for (let i = 0; i < buckets; i++) {
    const x = (i / span) * 100;
    top.push(`${x.toFixed(2)},${(midY - Math.min(1, (peaks[i * 2 + 1] || 0) * gain) * 14).toFixed(2)}`);
    bottom.push(`${x.toFixed(2)},${(midY - Math.max(-1, (peaks[i * 2] || 0) * gain) * 14).toFixed(2)}`);
  }
  bottom.reverse();
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
}

function displayGain(peaks) {
  let peak = 0;
  for (let i = 0; i < peaks.length; i++) peak = Math.max(peak, Math.abs(peaks[i]));
  return peak > 0 ? clamp(0.9 / peak, 1, 4) : 1;
}

// Shared select / move / resize wiring for a track's time area. Attached once to a persistent container.
//   secAt(clientX) -> source seconds. getBlocks() -> [{id,tIn,tOut,movable=true}]. onSelect(id|null).
//   onChange(id,{tIn,tOut},mode). onCreateStart/Move/End for empty-space paint. canInteract() gate.
// The drag in progress anywhere on the timeline can be cancelled with Esc: whoever starts one parks an
// "undo this drag" function here, and the timeline's Esc handler calls it.
let abortActive = null;

function wireBlockDrag(container, opts) {
  const { secAt, maxSec, minLen = 0.1, blockSelector, getBlocks, onSelect, onChange, onCreateStart, onCreateMove, onCreateEnd, canInteract } = opts;
  let drag = null, creating = null;
  container.addEventListener("pointerdown", (e) => {
    if (drag || creating) return;
    if (canInteract && !canInteract()) return;
    const blockEl = e.target.closest(blockSelector);
    if (!blockEl) {
      if (onCreateStart) { e.preventDefault(); container.setPointerCapture?.(e.pointerId); const sec = secAt(e.clientX); creating = { anchorSec: sec }; onCreateStart(sec); }
      else if (onSelect) onSelect(null);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const id = blockEl.dataset.id;
    if (onSelect) onSelect(id);
    const b = ((getBlocks && getBlocks()) || []).find((x) => String(x.id) === String(id));
    if (!b) return;
    const mode = (e.target.dataset && e.target.dataset.edge) || "move";
    if (mode === "move" && b.movable === false) return;
    container.setPointerCapture?.(e.pointerId);
    drag = { id: b.id, mode, startSec: secAt(e.clientX), orig: { tIn: b.tIn, tOut: b.tOut } };
    abortActive = () => { const d = drag; drag = null; if (d && onChange) onChange(d.id, d.orig, d.mode); if (opts.onDragEnd) opts.onDragEnd(); };
  });
  container.addEventListener("pointermove", (e) => {
    if (creating) { if (onCreateMove) onCreateMove(creating.anchorSec, secAt(e.clientX)); return; }
    if (!drag) return;
    const d = secAt(e.clientX) - drag.startSec;
    let { tIn, tOut } = drag.orig;
    if (drag.mode === "move") { const len = tOut - tIn; tIn = clamp(tIn + d, 0, maxSec - len); tOut = tIn + len; }
    else if (drag.mode === "in") tIn = clamp(tIn + d, 0, tOut - minLen);
    else if (drag.mode === "out") tOut = clamp(tOut + d, tIn + minLen, maxSec);
    if (opts.snap) {
      ({ tIn, tOut } = opts.snap(drag.id, { tIn, tOut }, drag.mode));
      if (drag.mode === "move") { // re-clamp after a snap shift, preserving length
        const len = tOut - tIn;
        if (tOut > maxSec) { tIn = maxSec - len; tOut = maxSec; }
        if (tIn < 0) { tIn = 0; tOut = len; }
      }
    }
    if (onChange) onChange(drag.id, { tIn, tOut }, drag.mode);
  });
  const end = (e) => {
    if (creating) { const c = creating; creating = null; container.releasePointerCapture?.(e.pointerId); if (onCreateEnd) onCreateEnd(c.anchorSec, secAt(e.clientX)); return; }
    if (!drag) return;
    container.releasePointerCapture?.(e.pointerId); drag = null; abortActive = null;
    if (opts.onDragEnd) opts.onDragEnd();
  };
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
}

// {
//   el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
//   getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
//   getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
//   getAudioState, onAudioMute, onAudioVolume,
//   store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
//   onLayerVisible, onLayerOpacity, onLayerReorder, onLayerDelete,
//   getExtraAudio, getExtraBlock, onExtraAudioChange, onExtraMute, onExtraVolume, onExtraRemove,
//   getFilmstrip, getClipName, onScaleChange,
//   getPieces, getSplits, getMarkers, onPieceSelect, onMarkerRemove
// }
//   getPieces() -> the kept video as [{in,out}] pieces (piecesOf). A click on the clip selects the piece
//   under it (onPieceSelect({in,out}|null)); the editor deletes it. getMarkers() -> [{id,t}]: drawn on the
//   ruler (click to jump, double-click to remove) and used as snap targets with the split points.
//   getExtraBlock() -> the imported track's {tIn,tOut} in SOURCE seconds (the controller converts from
//   its output-time offset), or null. getAudioState() -> { muted, volume } of the recording's own audio.
//   getFilmstrip() -> { items: (canvas|null)[], aspect() } from filmstrip.js, or null. onScaleChange()
//   fires when the zoom changes.
export function createTimeline(opts) {
  const {
    el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
    getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
    getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
    getAudioState, onAudioMute, onAudioVolume,
    store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
    onLayerVisible, onLayerOpacity, onLayerReorder, onLayerDelete,
    getExtraAudio, getExtraBlock, onExtraAudioChange, onExtraMute, onExtraVolume, onExtraRemove,
    getFilmstrip, getClipName, onScaleChange,
    getPieces, getSplits, getMarkers, onPieceSelect, onMarkerRemove,
  } = opts;

  const dur = Math.max(0.001, durationSec || 0);
  const doc = el.ownerDocument;

  // ── horizontal scale ──────────────────────────────────────────────────────────────────────────
  let fitMode = true;
  let userPps = 0;              // px per second when not in fit mode
  let scrollX = 0;              // px pan offset

  el.innerHTML = `<div class="ss-tl"></div>`;
  const panel = el.querySelector(".ss-tl");

  function timeW() {
    // usable width of a time area = panel minus the header column and the shared horizontal insets
    const w = panel.getBoundingClientRect().width - HEADER_W - TIME_PAD * 2;
    return Math.max(1, w);
  }
  function fitPps() { return timeW() / dur; }
  function maxPps() { return Math.max(fitPps() * MAX_ZOOM_MULT, MAX_PPS); }
  function pps() { return fitMode ? fitPps() : userPps; }
  function maxScroll() { return Math.max(0, dur * pps() - timeW()); }
  function xOf(sec) { return sec * pps() - scrollX; }
  function secAtIn(clientX, timeEl) {
    const r = timeEl.getBoundingClientRect();
    return clamp((clientX - r.left + scrollX) / pps(), 0, dur);
  }

  // ── skeleton (rebuilt only on layer-set change) ─────────────────────────────────────────────────
  let inEl, outEl, trimEl, cutsEl, piecesEl, vtime, rtime, rlabels, rmarks, lanesEl, playEl, filmEl, nameEl, dimL, dimR, tcEl, snapBtn;
  let ztime, atime, awsvg, awpath, amutesEl, amuteBtn, avolEl;
  let navTime, navThumb, navPh;
  const layerRows = new Map(); // id -> { time, block }
  let extraRow = null;         // { time }
  let lastSig = null;
  let cutMode = false;
  let snapOn = true, altDown = false;
  let pendingCut = null, pendingAMute = null, selectedMuteId = null, selectedExtra = false;

  function sig() {
    const ids = store ? store.layers.map((l) => l.id).join(",") : "";
    return `${ids}|${getExtraAudio && getExtraAudio() ? 1 : 0}`;
  }

  function header(cls, inner) {
    const h = doc.createElement("div");
    h.className = "ss-tl-thead " + cls;
    h.innerHTML = inner;
    return h;
  }
  function timeArea(cls) {
    const t = doc.createElement("div");
    t.className = "ss-tl-ttime " + cls;
    return t;
  }
  const badge = (kind, text) => `<span class="ss-tl-badge ss-tl-b-${kind}">${text}</span>`;

  function buildSkeleton() {
    layerRows.clear(); extraRow = null;
    panel.textContent = "";

    // ruler row: [big timecode + snap toggle | tick ruler]
    const ruler = doc.createElement("div");
    ruler.className = "ss-tl-ruler";
    ruler.appendChild(header("ss-tl-rhead",
      `<span class="ss-tl-tc" id="ss-tl-tc" title="Playhead position">0:00.00</span><span class="ss-tl-tctotal">/ ${fmt(dur)}</span>` +
      `<button class="ss-tl-snap-btn${snapOn ? " on" : ""}" type="button" id="ss-tl-snapbtn" title="Snapping ${snapOn ? "on" : "off"} (hold ⌥ to bypass)" aria-pressed="${snapOn}">${ICON.magnet}</button>`));
    tcEl = ruler.querySelector("#ss-tl-tc");
    snapBtn = ruler.querySelector("#ss-tl-snapbtn");
    snapBtn.addEventListener("click", () => {
      snapOn = !snapOn;
      snapBtn.classList.toggle("on", snapOn);
      snapBtn.setAttribute("aria-pressed", String(snapOn));
      snapBtn.title = `Snapping ${snapOn ? "on" : "off"} (hold ⌥ to bypass)`;
      if (!snapOn) hideSnapGuide();
    });
    rtime = timeArea("ss-tl-rtime");
    rlabels = doc.createElement("div"); rlabels.className = "ss-tl-rlabels"; rtime.appendChild(rlabels);
    rmarks = doc.createElement("div"); rmarks.className = "ss-tl-rmarks"; rtime.appendChild(rmarks);
    ruler.appendChild(rtime);
    panel.appendChild(ruler);

    // pinned video clip
    const vrow = doc.createElement("div");
    vrow.className = "ss-tl-vrow";
    vrow.appendChild(header("", `${badge("v", "V1")}<span class="ss-tl-tname">Video</span><span class="ss-tl-tdur">${fmt(dur)}</span>`));
    vtime = timeArea("ss-tl-vtime");
    filmEl = doc.createElement("canvas"); filmEl.className = "ss-tl-film";
    nameEl = doc.createElement("div"); nameEl.className = "ss-tl-clipname";
    dimL = doc.createElement("div"); dimL.className = "ss-tl-dim";
    dimR = doc.createElement("div"); dimR.className = "ss-tl-dim";
    trimEl = doc.createElement("div"); trimEl.className = "ss-tl-trim";
    cutsEl = doc.createElement("div"); cutsEl.className = "ss-tl-cuts";
    piecesEl = doc.createElement("div"); piecesEl.className = "ss-tl-pieces";
    inEl = doc.createElement("div"); inEl.className = "ss-tl-handle ss-tl-handle-in"; inEl.title = "Trim start — drag";
    outEl = doc.createElement("div"); outEl.className = "ss-tl-handle ss-tl-handle-out"; outEl.title = "Trim end — drag";
    vtime.append(filmEl, nameEl, dimL, dimR, trimEl, piecesEl, cutsEl, inEl, outEl);
    vrow.appendChild(vtime);
    panel.appendChild(vrow);
    wireVideoTrack();
    vtime.classList.toggle("ss-tl-cutmode", cutMode); // survive skeleton rebuilds mid cut-mode

    // scrolling lanes
    lanesEl = doc.createElement("div");
    lanesEl.className = "ss-tl-lanes";
    panel.appendChild(lanesEl);

    // zoom track
    const zrow = doc.createElement("div"); zrow.className = "ss-tl-trk";
    zrow.appendChild(header("", `${badge("z", "Z")}<span class="ss-tl-tname">Zoom</span>`));
    ztime = timeArea("ss-tl-ztime"); zrow.appendChild(ztime); lanesEl.appendChild(zrow);
    wireBlockDrag(ztime, {
      secAt: (x) => secAtIn(x, ztime), maxSec: dur, minLen: Math.min(0.4, dur), blockSelector: ".ss-tl-zblock",
      getBlocks: () => ((getZoomBlocks && getZoomBlocks()) || []).map((b) => ({ id: b.id, tIn: b.tIn, tOut: b.tOut })),
      onSelect: (id) => onZoomSelect && onZoomSelect(id),
      onChange: (id, r) => onZoomChange && onZoomChange(id, { tIn: r.tIn, tOut: r.tOut }),
      snap: makeSnap("zoom", Math.min(0.4, dur)),
      onDragEnd: hideSnapGuide,
    });

    // one track per overlay layer (top of stack first)
    const layers = store ? store.layers : [];
    for (let i = layers.length - 1; i >= 0; i--) buildLayerRow(layers[i]);

    // audio track
    const arow = doc.createElement("div"); arow.className = "ss-tl-trk ss-tl-trk-audio";
    const ah = header("", `${badge("a", "A1")}<span class="ss-tl-tname">Audio</span>` +
      `<button class="ss-tl-eye" data-amute type="button"></button>` +
      `<input class="ss-tl-op" data-avol type="range" min="0" max="1" step="0.05" value="1" title="Volume" />`);
    amuteBtn = ah.querySelector("[data-amute]");
    avolEl = ah.querySelector("[data-avol]");
    amuteBtn.addEventListener("click", () => onAudioMute && onAudioMute());
    avolEl.addEventListener("input", (e) => onAudioVolume && onAudioVolume(Number(e.target.value)));
    arow.appendChild(ah);
    atime = timeArea("ss-tl-atime");
    awsvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    awsvg.setAttribute("class", "ss-tl-await"); awsvg.setAttribute("viewBox", "0 0 100 30"); awsvg.setAttribute("preserveAspectRatio", "none");
    awpath = doc.createElementNS("http://www.w3.org/2000/svg", "path"); awsvg.appendChild(awpath); atime.appendChild(awsvg);
    amutesEl = doc.createElement("div"); amutesEl.className = "ss-tl-amutes"; atime.appendChild(amutesEl);
    arow.appendChild(atime); lanesEl.appendChild(arow);
    wireBlockDrag(atime, {
      secAt: (x) => secAtIn(x, atime), maxSec: dur, minLen: Math.min(0.08, dur), blockSelector: ".ss-tl-amute",
      canInteract: () => !atime.classList.contains("ss-tl-adisabled"),
      getBlocks: () => ((getAudioCuts && getAudioCuts()) || []).map((c, i) => ({ id: i, tIn: c.in, tOut: c.out })),
      onSelect: (id) => { selectedMuteId = id; renderMutes(); },
      onChange: (id, r) => onAudioMuteChange && onAudioMuteChange(Number(id), { tIn: r.tIn, tOut: r.tOut }),
      snap: makeSnap("mute", Math.min(0.08, dur)),
      onDragEnd: hideSnapGuide,
      onCreateStart: (sec) => { selectedMuteId = null; pendingAMute = { in: sec, out: sec }; renderMutes(); },
      onCreateMove: (a, sec) => { pendingAMute = { in: Math.min(a, sec), out: Math.max(a, sec) }; renderMutes(); },
      onCreateEnd: (a, sec) => { const lo = Math.min(a, sec), hi = Math.max(a, sec); pendingAMute = null; if (hi - lo > 0.08 && onAddAudioCut) onAddAudioCut(lo, hi); renderMutes(); },
    });

    // imported-audio track
    const ea = getExtraAudio && getExtraAudio();
    if (ea) buildExtraRow();

    // navigator: zoom buttons | a scrollbar whose thumb pans and whose end handles zoom
    const nav = doc.createElement("div"); nav.className = "ss-tl-nav";
    nav.appendChild(header("ss-tl-nhead",
      `<button class="ss-tl-zb" data-z="out" type="button" title="Zoom out">−</button><button class="ss-tl-zb" data-z="in" type="button" title="Zoom in">+</button><button class="ss-tl-zb ss-tl-zfit" data-z="fit" type="button" title="Fit the whole clip">Fit</button>`));
    nav.querySelector("[data-z=out]").addEventListener("click", () => api.zoomBy(1 / ZOOM_STEP));
    nav.querySelector("[data-z=in]").addEventListener("click", () => api.zoomBy(ZOOM_STEP));
    nav.querySelector("[data-z=fit]").addEventListener("click", () => api.fit());
    navTime = timeArea("ss-tl-ntime");
    navTime.innerHTML = `<div class="ss-tl-nav-track"></div><div class="ss-tl-nav-ph"></div><div class="ss-tl-nav-thumb" title="Drag to pan · drag the ends to zoom"><span class="ss-tl-nav-h" data-edge="in"></span><span class="ss-tl-nav-h" data-edge="out"></span></div>`;
    navThumb = navTime.querySelector(".ss-tl-nav-thumb");
    navPh = navTime.querySelector(".ss-tl-nav-ph");
    nav.appendChild(navTime);
    panel.appendChild(nav);
    wireNav();

    // full-height playhead: a flag head over the ruler you can drag, and a line through every track
    playEl = doc.createElement("div"); playEl.className = "ss-tl-ph";
    playEl.innerHTML = `<span class="ss-tl-ph-grab" title="Drag to scrub"></span>`;
    panel.appendChild(playEl);
    wirePlayheadGrab(playEl.querySelector(".ss-tl-ph-grab"));

    // snap guide (shown while a dragged edge snaps to the playhead / another edge / a whole second)
    snapEl = doc.createElement("div"); snapEl.className = "ss-tl-snap"; snapEl.style.display = "none";
    snapEl.innerHTML = `<span class="ss-tl-snap-lbl"></span>`;
    panel.appendChild(snapEl);

    // drag tip: the exact time of a trim handle / cut edge while it is being dragged
    tipEl = doc.createElement("div"); tipEl.className = "ss-tl-tip"; tipEl.style.display = "none";
    panel.appendChild(tipEl);

    lastSig = sig();
  }

  // ── snapping ─────────────────────────────────────────────────────────────────────────────────
  let snapEl = null, tipEl = null;
  function showSnapGuide(sec) {
    if (!snapEl) return;
    snapEl.style.display = "block";
    snapEl.style.left = `${HEADER_W + TIME_PAD + xOf(sec)}px`;
    snapEl.querySelector(".ss-tl-snap-lbl").textContent = fmt(sec);
  }
  function hideSnapGuide() { if (snapEl) snapEl.style.display = "none"; }
  function showTip(sec) {
    if (!tipEl) return;
    tipEl.style.display = "block";
    tipEl.style.left = `${HEADER_W + TIME_PAD + xOf(sec)}px`;
    tipEl.textContent = fmtTc(sec);
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }

  // Every interesting edge on the shared ruler, excluding the block being dragged (else it would
  // snap to itself): playhead, trim in/out, cut edges, zoom/layer/mute/extra block edges, whole seconds.
  function snapCandidates(kind, id) {
    const c = [0, dur];
    if (kind !== "playhead") c.push(playSec); // a dragged playhead never snaps onto itself (it would stick)
    if (kind !== "in") c.push(inSec);
    if (kind !== "out") c.push(outSec);
    for (const x of (getSplits && getSplits()) || []) c.push(x);
    for (const m of (getMarkers && getMarkers()) || []) c.push(m.t);
    // Whole seconds only once a second spans >= ~5× the 8px snap radius: on a long clip at Fit (a few
    // px per second) every position is within the radius of SOME whole second, so every drag snapped.
    if (pps() >= 40) for (let s = 1; s < dur; s++) c.push(s);
    for (const cut of (getCuts && getCuts()) || []) c.push(cut.in, cut.out);
    for (const b of (getZoomBlocks && getZoomBlocks()) || []) if (!(kind === "zoom" && String(b.id) === String(id))) c.push(b.tIn, b.tOut);
    if (store) for (const l of store.layers) if (l.range && !(kind === "layer" && String(l.id) === String(id))) c.push(l.range.inSec, l.range.outSec);
    ((getAudioCuts && getAudioCuts()) || []).forEach((m, i) => { if (!(kind === "mute" && String(i) === String(id))) c.push(m.in, m.out); });
    const eb = getExtraBlock && getExtraBlock();
    if (eb && kind !== "extra") c.push(eb.tIn, eb.tOut);
    return c;
  }

  // A snap fn for one lane: pulls the moving edge(s) onto the nearest candidate within ~8px. Off when the
  // magnet is toggled off or ⌥ is held (exact placement).
  function makeSnap(kind, minLen) {
    return (id, r, mode) => {
      if (!snapOn || altDown) { hideSnapGuide(); return r; }
      const th = 8 / pps();
      const cands = snapCandidates(kind, id);
      let best = null;
      const consider = (edge) => { for (const c of cands) { const d = c - edge; if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, sec: c, edge }; } };
      if (mode === "move") { consider(r.tIn); consider(r.tOut); } else consider(mode === "in" ? r.tIn : r.tOut);
      if (!best) { hideSnapGuide(); return r; }
      let { tIn, tOut } = r;
      if (mode === "move") { tIn += best.delta; tOut += best.delta; }
      else if (mode === "in") tIn = best.sec;
      else tOut = best.sec;
      if (tOut - tIn < minLen) { hideSnapGuide(); return r; } // never snap a block below its min length
      showSnapGuide(best.sec);
      return { tIn, tOut };
    };
  }
  const onKeyAlt = (e) => { altDown = e.altKey; };
  window.addEventListener("keydown", onKeyAlt);
  window.addEventListener("keyup", onKeyAlt);

  function buildLayerRow(l) {
    const row = doc.createElement("div"); row.className = "ss-tl-trk ss-tl-trk-layer"; row.dataset.id = l.id;
    const h = header("", "");
    const visible = l.visible !== false;
    const op = typeof l.opacity === "number" ? l.opacity : 1;
    h.innerHTML =
      `<span class="ss-tl-grip" data-grip title="Drag to reorder">⋮⋮</span>` +
      badge("l", laneGlyph(l)) +
      `<span class="ss-tl-tname ss-tl-lname">${laneLabel(l)}</span>` +
      `<input class="ss-tl-op" type="range" min="0" max="1" step="0.05" value="${op}" title="Opacity" />` +
      `<button class="ss-tl-eye${visible ? "" : " off"}" data-eye title="${visible ? "Hide" : "Show"}">${visible ? ICON.eye : ICON.eyeOff}</button>` +
      `<button class="ss-tl-del" data-del title="Delete">×</button>`;
    const eyeBtn = h.querySelector("[data-eye]");
    eyeBtn.addEventListener("click", () => {
      const cur = store.get(l.id); if (!cur) return;
      const nowVisible = cur.visible === false; // toggling a hidden layer makes it visible
      if (onLayerVisible) onLayerVisible(l.id, nowVisible);
      eyeBtn.innerHTML = nowVisible ? ICON.eye : ICON.eyeOff;
      eyeBtn.classList.toggle("off", !nowVisible);
      eyeBtn.title = nowVisible ? "Hide" : "Show";
    });
    const opEl = h.querySelector(".ss-tl-op");
    opEl.addEventListener("input", (e) => onLayerOpacity && onLayerOpacity(l.id, Number(e.target.value)));
    h.querySelector("[data-del]").addEventListener("click", () => onLayerDelete && onLayerDelete(l.id));
    wireReorder(h.querySelector("[data-grip]"), l.id);
    const t = timeArea("ss-tl-ltime");
    row.append(h, t); lanesEl.appendChild(row);
    layerRows.set(l.id, { time: t, block: null, eyeBtn, opEl });
    wireBlockDrag(t, {
      secAt: (x) => secAtIn(x, t), maxSec: dur, minLen: Math.min(0.1, dur), blockSelector: ".ss-tl-lblock",
      getBlocks: () => {
        const cur = store.get(l.id); if (!cur) return [];
        const r = cur.range;
        return [r ? { id: l.id, tIn: r.inSec, tOut: r.outSec } : { id: l.id, tIn: 0, tOut: dur, movable: false }];
      },
      onSelect: (id) => onLayerSelect && onLayerSelect(id),
      onChange: (id, r, mode) => onLayerRangeChange && onLayerRangeChange(id, { tIn: r.tIn, tOut: r.tOut }, mode),
      snap: makeSnap("layer", Math.min(0.1, dur)),
      onDragEnd: hideSnapGuide,
    });
  }

  function buildExtraRow() {
    const ea = getExtraAudio();
    const row = doc.createElement("div"); row.className = "ss-tl-trk ss-tl-trk-extra";
    const h = header("", "");
    h.innerHTML =
      badge("x", "A2") +
      `<span class="ss-tl-tname ss-tl-exname-h">${escapeHtml(ea.name || "audio")}</span>` +
      `<button class="ss-tl-eye ss-tl-exmute" data-exmute title="Mute track">${ea.muted ? ICON.mute : ICON.vol}</button>` +
      `<input class="ss-tl-op ss-tl-exvol" type="range" min="0" max="1" step="0.05" value="${typeof ea.volume === "number" ? ea.volume : 1}" title="Volume" />` +
      `<button class="ss-tl-del" data-exdel title="Remove track">×</button>`;
    h.querySelector("[data-exmute]").addEventListener("click", () => onExtraMute && onExtraMute());
    h.querySelector(".ss-tl-exvol").addEventListener("input", (e) => onExtraVolume && onExtraVolume(Number(e.target.value)));
    h.querySelector("[data-exdel]").addEventListener("click", () => onExtraRemove && onExtraRemove());
    const t = timeArea("ss-tl-extime");
    row.append(h, t); lanesEl.appendChild(row);
    extraRow = { time: t, nameEl: h.querySelector(".ss-tl-exname-h"), muteBtn: h.querySelector("[data-exmute]"), volEl: h.querySelector(".ss-tl-exvol") };
    wireBlockDrag(t, {
      secAt: (x) => secAtIn(x, t), maxSec: dur, minLen: Math.min(0.1, dur), blockSelector: ".ss-tl-exblock",
      getBlocks: () => {
        const eb = getExtraBlock && getExtraBlock();
        return eb ? [{ id: "ex", tIn: eb.tIn, tOut: eb.tOut }] : [];
      },
      onSelect: (id) => { selectedExtra = !!id; renderExtra(); },
      onChange: (_id, r, mode) => onExtraAudioChange && onExtraAudioChange({ tIn: r.tIn, tOut: r.tOut }, mode),
      snap: makeSnap("extra", Math.min(0.1, dur)),
      onDragEnd: hideSnapGuide,
    });
  }

  // ⋮⋮ drag-to-reorder: on release, move the layer to the row the pointer is over (reorder = z-order).
  function wireReorder(grip, id) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      grip.setPointerCapture?.(e.pointerId);
      const startY = e.clientY;
      let target = null;
      const move = (ev) => {
        const rows = [...lanesEl.querySelectorAll(".ss-tl-trk-layer")];
        target = null;
        for (const r of rows) { const rc = r.getBoundingClientRect(); if (ev.clientY >= rc.top && ev.clientY <= rc.bottom) target = r.dataset.id; }
        lanesEl.querySelectorAll(".ss-tl-trk-layer").forEach((r) => r.classList.toggle("ss-tl-drop", r.dataset.id === target && target !== id));
      };
      const up = (ev) => {
        grip.releasePointerCapture?.(ev.pointerId);
        grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up);
        lanesEl.querySelectorAll(".ss-tl-trk-layer").forEach((r) => r.classList.remove("ss-tl-drop"));
        if (Math.abs(ev.clientY - startY) > 4 && target && target !== id && onLayerReorder) onLayerReorder(id, target);
      };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
    });
  }

  // ── video track handlers (trim / scrub / cut / select a piece) ─────────────────────────────────────
  let inSec = 0, outSec = dur, playSec = 0, dragging = null, cutAnchor = 0, dragFrom = null, selPiece = null;
  const MIN_GAP = Math.min(0.05, dur);
  function vSecAt(clientX) { return secAtIn(clientX, vtime); }

  // Pull a dragged edge / playhead onto the nearest edit, marker or block edge within ~8px (not itself).
  function snapSec(sec, kind) {
    if (!snapOn || altDown) { hideSnapGuide(); return sec; }
    const th = 8 / pps();
    let best = null;
    for (const c of snapCandidates(kind, null)) { const d = Math.abs(c - sec); if (d <= th && (!best || d < best.d)) best = { d, c }; }
    if (!best) { hideSnapGuide(); return sec; }
    showSnapGuide(best.c);
    return best.c;
  }
  // Trim monitor: while an edge is dragged the preview shows the frame at that edge, so you see what you cut on.
  const monitor = (sec) => { if (onSeek) onSeek(sec); };

  function applyVDrag(clientX) {
    const sec = vSecAt(clientX);
    if (dragging === "in") { inSec = clamp(snapSec(sec, "in"), 0, outSec - MIN_GAP); showTip(inSec); if (onTrimChange) onTrimChange(inSec, outSec); monitor(inSec); }
    else if (dragging === "out") { outSec = clamp(snapSec(sec, "out"), inSec + MIN_GAP, dur); showTip(outSec); if (onTrimChange) onTrimChange(inSec, outSec); monitor(outSec); }
    else if (dragging === "scrub") { playSec = snapSec(sec, "playhead"); if (onSeek) onSeek(playSec); }
    else if (dragging === "cut") { const x = snapSec(sec, "cut"); pendingCut = { in: Math.min(cutAnchor, x), out: Math.max(cutAnchor, x) }; showTip(x); monitor(x); }
    layout();
  }
  function startV(which, e, onClip = false) {
    dragging = which;
    dragFrom = { x: e.clientX, onClip, inSec, outSec, playSec };
    abortActive = () => { // Esc: put everything back the way the press found it
      const f = dragFrom;
      if (dragging === "in" || dragging === "out") { inSec = f.inSec; outSec = f.outSec; if (onTrimChange) onTrimChange(inSec, outSec); }
      pendingCut = null;
      playSec = f.playSec; if (onSeek) onSeek(playSec);
      dragging = null; dragFrom = null; hideTip(); hideSnapGuide(); layout();
    };
  }
  const vMove = (e) => { if (dragging) applyVDrag(e.clientX); };
  const vEnd = (e) => {
    if (!dragging) return;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
    if (dragging === "cut" && pendingCut) { const c = pendingCut; pendingCut = null; if (c.out - c.in > 0.08 && onAddCut) onAddCut(c.in, c.out); }
    // a click (no drag) on the clip selects the piece under it, as clicking a clip does in an NLE
    if (dragging === "scrub" && dragFrom && dragFrom.onClip && Math.abs(e.clientX - dragFrom.x) < 4) selectPieceAt(vSecAt(e.clientX));
    dragging = null; dragFrom = null; abortActive = null; hideTip(); hideSnapGuide(); layout();
  };
  function selectPieceAt(sec) {
    const p = ((getPieces && getPieces()) || []).find((x) => sec >= x.in && sec <= x.out) || null;
    selPiece = p ? { in: p.in, out: p.out } : null;
    if (onPieceSelect) onPieceSelect(selPiece);
  }
  function wireVideoTrack() {
    const handleDown = (which) => (e) => { e.preventDefault(); e.stopPropagation(); startV(which, e); e.currentTarget.setPointerCapture?.(e.pointerId); applyVDrag(e.clientX); };
    inEl.addEventListener("pointerdown", handleDown("in"));
    outEl.addEventListener("pointerdown", handleDown("out"));
    vtime.addEventListener("pointerdown", (e) => {
      if (dragging || e.target === inEl || e.target === outEl || e.target.closest(".ss-tl-cut")) return;
      e.preventDefault(); vtime.setPointerCapture?.(e.pointerId);
      if (cutMode) { startV("cut", e); cutAnchor = vSecAt(e.clientX); pendingCut = { in: cutAnchor, out: cutAnchor }; layout(); }
      else { startV("scrub", e, true); applyVDrag(e.clientX); }
    });
    for (const t of [inEl, outEl, vtime]) { t.addEventListener("pointermove", vMove); t.addEventListener("pointerup", vEnd); t.addEventListener("pointercancel", vEnd); }
    // scrub via the ruler too (markers on it take their own clicks)
    rtime.addEventListener("pointerdown", (e) => { if (e.target.closest(".ss-tl-mk")) return; e.preventDefault(); rtime.setPointerCapture?.(e.pointerId); startV("scrub", e); applyVDrag(e.clientX); });
    rtime.addEventListener("pointermove", vMove); rtime.addEventListener("pointerup", vEnd); rtime.addEventListener("pointercancel", vEnd);
  }
  function wirePlayheadGrab(grab) {
    grab.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); grab.setPointerCapture?.(e.pointerId); startV("scrub", e); applyVDrag(e.clientX); });
    grab.addEventListener("pointermove", vMove); grab.addEventListener("pointerup", vEnd); grab.addEventListener("pointercancel", vEnd);
  }
  const onEsc = (e) => {
    if (e.key !== "Escape" || !abortActive) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const f = abortActive; abortActive = null; f();
  };
  window.addEventListener("keydown", onEsc, true);

  // ── navigator: the thumb is the visible window — drag it to pan, drag an end to zoom that side ────
  function setView(a, b) {
    const span = Math.max(b - a, timeW() / maxPps());
    setPps(timeW() / span);
    scrollX = clamp(a * pps(), 0, maxScroll());
    layout();
    if (onScaleChange) onScaleChange();
  }
  function wireNav() {
    let g = null;
    const secAtNav = (clientX) => { const r = navTime.getBoundingClientRect(); return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * dur; };
    const win = () => { const a = scrollX / pps(); return { a, b: a + timeW() / pps() }; };
    navTime.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      navTime.setPointerCapture?.(e.pointerId);
      const { a, b } = win(), sec = secAtNav(e.clientX);
      const edge = e.target.dataset && e.target.dataset.edge;
      if (edge) g = { mode: edge };
      else if (sec >= a && sec <= b) g = { mode: "pan", grab: sec - a };
      else { g = { mode: "pan", grab: (b - a) / 2 }; setView(sec - g.grab, sec + (b - a) - g.grab); } // click the track: centre the window there
    });
    navTime.addEventListener("pointermove", (e) => {
      if (!g) return;
      const sec = secAtNav(e.clientX), { a, b } = win(), min = timeW() / maxPps();
      if (g.mode === "pan") { const span = b - a, na = clamp(sec - g.grab, 0, dur - span); setView(na, na + span); }
      else if (g.mode === "in") setView(clamp(sec, 0, b - min), b);
      else setView(a, clamp(sec, a + min, dur));
    });
    const end = (e) => { g = null; navTime.releasePointerCapture?.(e.pointerId); };
    navTime.addEventListener("pointerup", end);
    navTime.addEventListener("pointercancel", end);
  }

  // ── block rendering (rebuilt every refresh; containers persist) ──────────────────────────────────
  function posBlock(elm, tIn, tOut) { elm.style.left = `${xOf(tIn)}px`; elm.style.width = `${Math.max(2, (tOut - tIn) * pps())}px`; }

  function renderCuts() {
    cutsEl.textContent = "";
    const cuts = (getCuts && getCuts()) || [];
    const all = pendingCut ? cuts.concat([pendingCut]) : cuts;
    all.forEach((c, i) => {
      const isPending = pendingCut && i === all.length - 1 && all.length > cuts.length;
      const band = doc.createElement("div"); band.className = "ss-tl-cut" + (isPending ? " ss-tl-cut-pending" : "");
      posBlock(band, Math.max(0, Math.min(c.in, c.out)), Math.min(dur, Math.max(c.in, c.out)));
      if (!isPending) {
        const x = doc.createElement("button"); x.className = "ss-tl-cut-x"; x.textContent = "×"; x.title = "Remove cut";
        x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
        x.addEventListener("click", (e) => { e.stopPropagation(); if (onRemoveCut) onRemoveCut(i); });
        band.appendChild(x);
      }
      cutsEl.appendChild(band);
    });
  }
  // The kept video's pieces (split points divide it), the selected one outlined, and the split marks.
  function renderPieces() {
    piecesEl.textContent = "";
    const pieces = (getPieces && getPieces()) || [];
    if (selPiece && !pieces.some((p) => Math.abs(p.in - selPiece.in) < 1e-3 && Math.abs(p.out - selPiece.out) < 1e-3)) {
      selPiece = null; // an edit removed or reshaped it
      if (onPieceSelect) onPieceSelect(null);
    }
    if (selPiece) {
      const box = doc.createElement("div"); box.className = "ss-tl-piece on";
      posBlock(box, selPiece.in, selPiece.out);
      piecesEl.appendChild(box);
    }
    for (const x of (getSplits && getSplits()) || []) {
      if (!pieces.some((p) => Math.abs(p.in - x) < 1e-3)) continue; // only splits that still divide kept video
      const m = doc.createElement("div"); m.className = "ss-tl-split"; m.style.left = `${xOf(x)}px`; m.title = `Split · ${fmtTc(x)}`;
      piecesEl.appendChild(m);
    }
  }
  function renderMarkers() {
    rmarks.textContent = "";
    for (const mk of (getMarkers && getMarkers()) || []) {
      if (mk.t < 0 || mk.t > dur) continue;
      const m = doc.createElement("button"); m.className = "ss-tl-mk"; m.type = "button";
      m.style.left = `${xOf(mk.t)}px`; m.title = `Marker · ${fmtTc(mk.t)} — click to jump, double-click to remove`;
      m.addEventListener("pointerdown", (e) => e.stopPropagation());
      m.addEventListener("click", (e) => { e.stopPropagation(); playSec = mk.t; if (onSeek) onSeek(mk.t); positionPlayhead(); });
      m.addEventListener("dblclick", (e) => { e.stopPropagation(); if (onMarkerRemove) onMarkerRemove(mk.id); });
      rmarks.appendChild(m);
    }
  }
  function renderZoom() {
    ztime.querySelectorAll(".ss-tl-zblock").forEach((n) => n.remove());
    const selId = getSelectedZoom && getSelectedZoom();
    for (const b of (getZoomBlocks && getZoomBlocks()) || []) {
      const lo = clamp(b.tIn, 0, dur), hi = clamp(b.tOut, lo, dur);
      const d2 = doc.createElement("div"); d2.className = "ss-tl-zblock" + (b.id === selId ? " on" : ""); d2.dataset.id = b.id;
      posBlock(d2, lo, hi); d2.title = `Zoom ${(b.scale || 1).toFixed(1)}x`;
      d2.innerHTML = `<span class="ss-tl-edge ss-tl-edge-l" data-edge="in"></span><span class="ss-tl-zname">${(b.scale || 1).toFixed(1)}x</span><span class="ss-tl-edge ss-tl-edge-r" data-edge="out"></span>`;
      ztime.appendChild(d2);
    }
  }
  function renderLayerBlocks() {
    const selId = getSelectedLayer && getSelectedLayer();
    for (const [id, ref] of layerRows) {
      const l = store.get(id); if (!l) continue;
      // The header is built once per layer set, so re-sync its controls from the store (undo/redo or
      // the inspector's opacity slider change these without rebuilding the row).
      const vis = l.visible !== false;
      ref.eyeBtn.innerHTML = vis ? ICON.eye : ICON.eyeOff; ref.eyeBtn.title = vis ? "Hide" : "Show"; ref.eyeBtn.classList.toggle("off", !vis);
      const op = String(typeof l.opacity === "number" ? l.opacity : 1);
      if (ref.opEl.value !== op && doc.activeElement !== ref.opEl) ref.opEl.value = op;
      ref.time.textContent = "";
      const r = l.range;
      const lo = r ? clamp(r.inSec, 0, dur) : 0, hi = r ? clamp(r.outSec, lo, dur) : dur;
      const b = doc.createElement("div");
      b.className = "ss-tl-lblock" + (r ? "" : " ss-tl-lblock-full") + (id === selId ? " on" : "");
      b.dataset.id = id; posBlock(b, lo, hi);
      b.title = r ? `${fmt(lo)}–${fmt(hi)}` : "Shown for the whole clip — drag an edge in to limit it";
      b.innerHTML = `<span class="ss-tl-edge ss-tl-edge-l" data-edge="in"></span><span class="ss-tl-lname-in">${laneLabel(l)}</span><span class="ss-tl-edge ss-tl-edge-r" data-edge="out"></span>`;
      ref.time.appendChild(b); ref.block = b;
    }
  }
  function renderMutes() {
    amutesEl.textContent = "";
    const cuts = (getAudioCuts && getAudioCuts()) || [];
    const all = pendingAMute ? cuts.concat([pendingAMute]) : cuts;
    all.forEach((c, i) => {
      const isPending = pendingAMute && i === all.length - 1 && all.length > cuts.length;
      const band = doc.createElement("div");
      band.className = "ss-tl-amute" + (isPending ? " ss-tl-amute-pending" : "") + (!isPending && String(i) === String(selectedMuteId) ? " on" : "");
      band.dataset.id = i; posBlock(band, Math.max(0, Math.min(c.in, c.out)), Math.min(dur, Math.max(c.in, c.out)));
      if (!isPending) {
        const x = doc.createElement("button"); x.className = "ss-tl-amute-x"; x.textContent = "×"; x.title = "Un-mute this region";
        x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
        x.addEventListener("click", (e) => { e.stopPropagation(); if (onRemoveAudioCut) onRemoveAudioCut(i); });
        band.append(
          Object.assign(doc.createElement("span"), { className: "ss-tl-edge ss-tl-edge-l" }),
          Object.assign(doc.createElement("span"), { className: "ss-tl-edge ss-tl-edge-r" }), x,
        );
        band.children[0].dataset.edge = "in"; band.children[1].dataset.edge = "out";
      }
      amutesEl.appendChild(band);
    });
  }
  function renderAudio() {
    const data = getAudioPeaks && getAudioPeaks();
    if (data && data.gain == null) data.gain = displayGain(data.peaks);
    awpath.setAttribute("d", data ? waveformPath(data.peaks, data.buckets, data.gain) : "");
    // The waveform spans the WHOLE clip on the shared scale (stretched by zoom, shifted by pan);
    // the lane's overflow:hidden clips it, keeping peaks aligned with the ruler and mute bands.
    awsvg.style.left = `${xOf(0)}px`;
    awsvg.style.width = `${dur * pps()}px`;
    const enabled = !getAudioEnabled || getAudioEnabled() !== false;
    atime.classList.toggle("ss-tl-adisabled", !enabled || !data);
    // The header's own mute + volume mirror the project's master audio state (also set from Project ▾).
    const st = (getAudioState && getAudioState()) || { muted: false, volume: 1 };
    amuteBtn.innerHTML = st.muted ? ICON.mute : ICON.vol;
    amuteBtn.classList.toggle("off", !!st.muted);
    amuteBtn.title = st.muted ? "Unmute audio" : "Mute audio";
    const vol = String(typeof st.volume === "number" ? st.volume : 1);
    if (avolEl.value !== vol && doc.activeElement !== avolEl) avolEl.value = vol;
    atime.classList.toggle("ss-tl-amuted", !!st.muted);
    renderMutes();
  }
  function renderExtra() {
    if (!extraRow) return;
    const ea = getExtraAudio && getExtraAudio();
    const eb = getExtraBlock && getExtraBlock();
    if (!ea || !eb) return;
    // Header controls are built once (the row survives mute / volume / re-import), so sync them here.
    extraRow.nameEl.textContent = ea.name || "audio";
    extraRow.muteBtn.innerHTML = ea.muted ? ICON.mute : ICON.vol;
    extraRow.muteBtn.classList.toggle("off", !!ea.muted);
    extraRow.muteBtn.title = ea.muted ? "Unmute track" : "Mute track";
    const vol = String(typeof ea.volume === "number" ? ea.volume : 1);
    if (extraRow.volEl.value !== vol && doc.activeElement !== extraRow.volEl) extraRow.volEl.value = vol;
    extraRow.time.textContent = "";
    const lo = clamp(eb.tIn, 0, dur), hi = clamp(eb.tOut, lo, dur);
    const b = doc.createElement("div"); b.className = "ss-tl-exblock" + (selectedExtra ? " on" : ""); b.dataset.id = "ex";
    posBlock(b, lo, hi); b.title = `${ea.name || "audio"} · ${fmt(Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0)))}`;
    b.innerHTML = `<span class="ss-tl-edge ss-tl-edge-l" data-edge="in"></span><span class="ss-tl-exname">${escapeHtml(ea.name || "audio")}</span><span class="ss-tl-edge ss-tl-edge-r" data-edge="out"></span>`;
    extraRow.time.appendChild(b);
  }

  // Ruler: a major tick + label at each "nice" step and minor ticks between, only for the visible window.
  function renderRuler() {
    rlabels.textContent = "";
    const p = pps(), [step, minors] = rulerStep(p);
    const t0 = scrollX / p, t1 = (scrollX + timeW()) / p;
    const frag = doc.createDocumentFragment();
    for (let k = Math.floor(t0 / step); k * step <= t1 + step; k++) {
      const s = k * step;
      if (s > dur + 1e-6) break;
      if (s >= -1e-6) {
        const t = doc.createElement("span"); t.className = "ss-tl-tk ss-tl-tk-major"; t.style.left = `${xOf(s)}px`;
        t.innerHTML = `<b>${fmtTick(s, step)}</b>`;
        frag.appendChild(t);
      }
      for (let j = 1; j < minors; j++) {
        const ms = s + (step * j) / minors;
        if (ms < 0 || ms > dur + 1e-6) continue;
        const m = doc.createElement("span"); m.className = "ss-tl-tk ss-tl-tk-minor"; m.style.left = `${xOf(ms)}px`;
        frag.appendChild(m);
      }
    }
    rlabels.appendChild(frag);
  }

  // Filmstrip: tile the decoded frames across the clip at the current scale (one canvas, only the visible
  // part is painted). Slots that haven't decoded yet stay a flat tone and fill in as the strip arrives.
  function renderFilm() {
    const w = vtime.clientWidth, h = vtime.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, (doc.defaultView && doc.defaultView.devicePixelRatio) || 1);
    if (filmEl.width !== Math.round(w * dpr) || filmEl.height !== Math.round(h * dpr)) { filmEl.width = Math.round(w * dpr); filmEl.height = Math.round(h * dpr); }
    const c = filmEl.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#d9e1e4"; c.fillRect(0, 0, w, h);
    const film = getFilmstrip && getFilmstrip();
    filmEl.dataset.frames = String(film ? film.items.filter(Boolean).length : 0);
    if (!film || !film.items.length) return;
    const tw = Math.max(24, Math.round(h * (film.aspect() || 16 / 9)));
    const clipPx = dur * pps() - scrollX;
    c.save();
    c.beginPath(); c.rect(0, 0, Math.min(w, clipPx), h); c.clip();
    for (let i = Math.floor(scrollX / tw); i * tw - scrollX < w; i++) {
      const x = i * tw - scrollX;
      const sec = clamp(((i + 0.5) * tw) / pps(), 0, dur);
      const img = film.items[Math.min(film.items.length - 1, Math.floor((sec / dur) * film.items.length))];
      if (img) { c.drawImage(img, x, 0, tw, h); c.fillStyle = "rgba(0,0,0,0.18)"; c.fillRect(x + tw - 1, 0, 1, h); }
    }
    c.restore();
  }

  // reposition everything horizontal (no rebuild); also refresh trim/cut/playhead
  function layout() {
    scrollX = clamp(scrollX, 0, maxScroll());
    renderRuler();
    renderFilm();
    nameEl.textContent = `${(getClipName && getClipName()) || "Recording"} · ${fmt(dur)}`;
    nameEl.style.left = `${Math.max(0, -xOf(0)) + 6}px`; // the name stays in view as the clip scrolls
    const inX = xOf(inSec), outX = xOf(outSec), endX = xOf(dur);
    dimL.style.left = `${Math.max(0, xOf(0))}px`; dimL.style.width = `${Math.max(0, inX - Math.max(0, xOf(0)))}px`;
    dimR.style.left = `${Math.max(0, outX)}px`; dimR.style.width = `${Math.max(0, endX - Math.max(0, outX))}px`;
    posBlock(trimEl, inSec, outSec);
    inEl.style.left = `${inX}px`;
    outEl.style.left = `${outX}px`;
    renderCuts();
    renderPieces();
    renderMarkers();
    renderZoom();
    renderLayerBlocks();
    renderAudio();
    renderExtra();
    positionPlayhead();
    renderNav();
  }
  function renderNav() {
    const total = dur * pps();
    navThumb.style.left = `${(scrollX / total) * 100}%`;
    navThumb.style.width = `${Math.min(100, (timeW() / total) * 100)}%`;
    navTime.classList.toggle("ss-tl-nfit", fitMode);
  }
  function positionPlayhead() {
    if (!playEl) return;
    const x = xOf(playSec);
    const w = timeW();
    navPh.style.left = `${(playSec / dur) * 100}%`;
    if (x < -1 || x > w + 1) { playEl.style.display = "none"; return; }
    playEl.style.display = "block";
    playEl.style.left = `${HEADER_W + TIME_PAD + x}px`;
  }

  function refresh() {
    if (sig() !== lastSig) buildSkeleton();
    layout();
  }

  buildSkeleton();
  layout();

  // Rebuild on layer add/remove/reorder (sig change) or reposition on any other store edit. The sig
  // guard means value-only edits (opacity/visibility/range) never tear down the persistent headers or
  // a block's in-progress pointer capture.
  const unsub = store && typeof store.subscribe === "function" ? store.subscribe(refresh) : null;

  // ⌘/ctrl + wheel (or a trackpad pinch) zooms around the pointer; a horizontal wheel/trackpad swipe (or
  // ⇧+wheel) pans the zoomed timeline; a plain vertical wheel scrolls the lanes natively.
  panel.addEventListener("wheel", (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const px = e.clientX - rtime.getBoundingClientRect().left;
      zoomTo((zoomAnim ? zoomTarget : pps()) * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), secAtIn(e.clientX, rtime), px);
      return;
    }
    const dx = e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY) ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
      if (maxScroll() <= 0) return; // nothing to pan at Fit
      e.preventDefault();
      scrollX = clamp(scrollX + dx, 0, maxScroll());
      layout();
    }
  }, { passive: false });

  // Keep the px-based layout in sync with the panel's size (fit-mode pps depends on it).
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => layout()) : null;
  if (ro) ro.observe(panel);

  // Zoom eases to its new scale (about 0.2 s, ease-out) keeping `anchorSec` under the same x, so the view
  // glides instead of jumping and what you were looking at stays put.
  let zoomAnim = 0, zoomTarget = 0;
  function zoomTo(target, anchorSec, anchorPx) {
    zoomTarget = clamp(target, fitPps(), maxPps());
    const from = pps(), t0 = performance.now(), D = 200;
    cancelAnimationFrame(zoomAnim);
    const step = (now) => {
      const u = Math.min(1, (now - t0) / D), k = 1 - Math.pow(1 - u, 3);
      setPps(Math.exp(Math.log(from) + (Math.log(zoomTarget) - Math.log(from)) * k));
      scrollX = clamp(anchorSec * pps() - anchorPx, 0, maxScroll());
      layout();
      if (onScaleChange) onScaleChange();
      zoomAnim = u < 1 ? requestAnimationFrame(step) : 0;
    };
    zoomAnim = requestAnimationFrame(step);
  }
  // Buttons zoom about the playhead when it is in view, else about the middle of the view.
  function zoomAboutPlayhead(mult) {
    const x = xOf(playSec), w = timeW(), px = x >= 0 && x <= w ? x : w / 2;
    zoomTo((zoomAnim ? zoomTarget : pps()) * mult, (scrollX + px) / pps(), px);
  }

  function setPps(v) {
    const fit = fitPps();
    const clamped = clamp(v, fit, maxPps());
    fitMode = clamped <= fit * 1.001;
    userPps = clamped;
  }

  const api = {
    // `follow`: while playing on a zoomed timeline, page the view along with the playhead.
    setPlayhead(sec, follow = false) {
      playSec = clamp(sec || 0, 0, dur);
      if (tcEl) tcEl.textContent = fmtTc(playSec);
      if (follow && !dragging && maxScroll() > 0) {
        const x = xOf(playSec), w = timeW();
        if (x > w - 24 || x < 0) { scrollX = clamp(playSec * pps() - w * 0.12, 0, maxScroll()); layout(); return; }
      }
      positionPlayhead();
    },
    setTrim(i, o) {
      let lo = clamp(i || 0, 0, dur), hi = clamp(o == null ? dur : o, 0, dur);
      if (hi < lo + MIN_GAP) hi = Math.min(dur, lo + MIN_GAP);
      if (lo > hi - MIN_GAP) lo = Math.max(0, hi - MIN_GAP);
      inSec = lo; outSec = hi; layout();
    },
    setCutMode(on) { cutMode = !!on; vtime.classList.toggle("ss-tl-cutmode", cutMode); },
    isCutMode: () => cutMode,
    zoomBy(mult) { zoomAboutPlayhead(mult); },
    fit() { zoomTo(fitPps(), 0, 0); },
    getSelectedPiece: () => selPiece,
    clearPiece() { selPiece = null; layout(); },
    setZoomNorm(t) { const fit = fitPps(); setPps(fit * (1 + clamp(t, 0, 1) * (maxPps() / fit - 1))); scrollX = clamp(scrollX, 0, maxScroll()); layout(); },
    getZoomNorm() { const fit = fitPps(), span = maxPps() / fit - 1; return span > 0 ? clamp((pps() / fit - 1) / span, 0, 1) : 0; },
    isSnapping: () => snapOn,
    redrawFilm() { renderFilm(); },
    refresh,
    destroy() {
      if (unsub) unsub(); if (ro) ro.disconnect();
      window.removeEventListener("keydown", onKeyAlt); window.removeEventListener("keyup", onKeyAlt);
      window.removeEventListener("keydown", onEsc, true); cancelAnimationFrame(zoomAnim);
      el.innerHTML = "";
    },
  };
  return api;
}
