// Timeline: a CONSTANT-HEIGHT panel so adding a layer never reflows the stage. Layout is a frozen-pane
// track grid — a pinned ruler + pinned Video track at the top, then a vertically-scrolling stack of
// track rows (zoom, one per overlay layer, audio, imported audio). Every row is [172px header | time
// area]. The header column is fixed; the time area is a shared horizontal scale driven in JS by
// `pxPerSecond` + `scrollX` (px, not %), so tl-zoom / pan keep every track aligned. A single
// full-height playhead spans the panel. All block interactions (select / move / resize / paint) go
// through one shared wireBlockDrag(); the video track keeps the trim / scrub / cut handlers.
//
// Rebuild discipline: the row SKELETON (headers + persistent time containers that own the pointer
// listeners) is only rebuilt when the layer set changes (a signature check), so a header control drag
// or a block drag's pointer-capture is never torn down mid-gesture. refresh() only rebuilds the block
// CHILDREN inside the persistent containers and re-lays-out positions. setPlayhead() only moves the
// playhead. Pure DOM, no canvas (waveform is one SVG path).

import { escapeHtml } from "./shapes.js";

const HEADER_W = 172; // px, the fixed track-header column
const ZOOM_STEP = 1.4;
const MAX_ZOOM_MULT = 10; // furthest zoom-in relative to Fit

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function laneLabel(l) {
  if (!l) return "Layer";
  if (l.kind === "image") return (l.image && l.image.frames) ? "GIF" : "Image";
  const t = (l.shape && l.shape.type) || "shape";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Closed SVG path (viewBox "0 0 100 30") tracing a waveform envelope from interleaved [min,max,…] peaks.
function waveformPath(peaks, buckets) {
  if (!peaks || !buckets) return "";
  const midY = 15, amp = 14, top = [], bottom = [], span = Math.max(1, buckets - 1);
  for (let i = 0; i < buckets; i++) {
    const x = (i / span) * 100;
    top.push(`${x.toFixed(2)},${(midY - (peaks[i * 2 + 1] || 0) * amp).toFixed(2)}`);
    bottom.push(`${x.toFixed(2)},${(midY - (peaks[i * 2] || 0) * amp).toFixed(2)}`);
  }
  bottom.reverse();
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
}

// Shared select / move / resize wiring for a track's time area. Attached once to a persistent container.
//   secAt(clientX) -> source seconds. getBlocks() -> [{id,tIn,tOut,movable=true}]. onSelect(id|null).
//   onChange(id,{tIn,tOut},mode). onCreateStart/Move/End for empty-space paint. canInteract() gate.
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
    container.releasePointerCapture?.(e.pointerId); drag = null;
    if (opts.onDragEnd) opts.onDragEnd();
  };
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
}

// {
//   el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
//   getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
//   getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
//   store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
//   onLayerVisible, onLayerOpacity, onLayerReorder, onLayerDelete,
//   getExtraAudio, getExtraBlock, onExtraAudioChange, onExtraMute, onExtraVolume, onExtraRemove,
//   onScaleChange
// }
//   getExtraBlock() -> the imported track's {tIn,tOut} in SOURCE seconds (the controller converts from
//   its output-time offset), or null. onScaleChange() fires when tl-zoom changes (slider stays synced).
export function createTimeline(opts) {
  const {
    el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
    getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
    getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
    store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
    onLayerVisible, onLayerOpacity, onLayerReorder, onLayerDelete,
    getExtraAudio, getExtraBlock, onExtraAudioChange, onExtraMute, onExtraVolume, onExtraRemove,
    onScaleChange,
  } = opts;

  const dur = Math.max(0.001, durationSec || 0);
  const doc = el.ownerDocument;

  // ── horizontal scale ──────────────────────────────────────────────────────────────────────────
  let fitMode = true;
  let userPps = 0;              // px per second when not in fit mode
  let scrollX = 0;              // px pan offset

  el.innerHTML = `<div class="ss-tl"></div>`;
  const panel = el.querySelector(".ss-tl");

  const TIME_PAD = 10; // horizontal inset of every time area (matching margins on all rows + ruler)
  function timeW() {
    // usable width of a time area = panel minus the header column and the shared horizontal insets
    const w = panel.getBoundingClientRect().width - HEADER_W - TIME_PAD * 2;
    return Math.max(1, w);
  }
  function fitPps() { return timeW() / dur; }
  function pps() { return fitMode ? fitPps() : userPps; }
  function maxScroll() { return Math.max(0, dur * pps() - timeW()); }
  function xOf(sec) { return sec * pps() - scrollX; }
  function secAtIn(clientX, timeEl) {
    const r = timeEl.getBoundingClientRect();
    return clamp((clientX - r.left + scrollX) / pps(), 0, dur);
  }

  // ── skeleton (rebuilt only on layer-set change) ─────────────────────────────────────────────────
  let inEl, outEl, trimEl, cutsEl, vtime, rtime, rlabels, lanesEl, playEl;
  let ztime, atime, awsvg, awpath, amutesEl;
  const layerRows = new Map(); // id -> { time, block }
  let extraRow = null;         // { time }
  let lastSig = null;
  let cutMode = false;
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

  function buildSkeleton() {
    layerRows.clear(); extraRow = null;
    panel.textContent = "";

    // ruler row
    const ruler = doc.createElement("div");
    ruler.className = "ss-tl-ruler";
    ruler.appendChild(header("ss-tl-rhead", `<span>Tracks</span>`));
    rtime = timeArea("ss-tl-rtime");
    rlabels = doc.createElement("div"); rlabels.className = "ss-tl-rlabels"; rtime.appendChild(rlabels);
    ruler.appendChild(rtime);
    panel.appendChild(ruler);

    // pinned video track
    const vrow = doc.createElement("div");
    vrow.className = "ss-tl-vrow";
    vrow.appendChild(header("", `<span class="ss-tl-ticon">🎞</span><span class="ss-tl-tname">Video</span><span class="ss-tl-tdur">${fmt(dur)}</span>`));
    vtime = timeArea("ss-tl-vtime");
    trimEl = doc.createElement("div"); trimEl.className = "ss-tl-trim";
    cutsEl = doc.createElement("div"); cutsEl.className = "ss-tl-cuts";
    inEl = doc.createElement("div"); inEl.className = "ss-tl-handle ss-tl-handle-in"; inEl.title = "Trim start";
    outEl = doc.createElement("div"); outEl.className = "ss-tl-handle ss-tl-handle-out"; outEl.title = "Trim end";
    vtime.append(trimEl, cutsEl, inEl, outEl);
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
    zrow.appendChild(header("", `<span class="ss-tl-ticon">🔍</span><span class="ss-tl-tname">Zoom</span>`));
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
    arow.appendChild(header("", `<span class="ss-tl-ticon">🔊</span><span class="ss-tl-tname">Audio</span>`));
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

    // full-height playhead
    playEl = doc.createElement("div"); playEl.className = "ss-tl-ph";
    playEl.innerHTML = `<span class="ss-tl-ph-grab"></span>`;
    panel.appendChild(playEl);

    // snap guide (shown while a dragged edge snaps to the playhead / another edge / a whole second)
    snapEl = doc.createElement("div"); snapEl.className = "ss-tl-snap"; snapEl.style.display = "none";
    snapEl.innerHTML = `<span class="ss-tl-snap-lbl"></span>`;
    panel.appendChild(snapEl);

    lastSig = sig();
  }

  // ── snapping ─────────────────────────────────────────────────────────────────────────────────
  let snapEl = null;
  function showSnapGuide(sec) {
    if (!snapEl) return;
    snapEl.style.display = "block";
    snapEl.style.left = `${HEADER_W + TIME_PAD + xOf(sec)}px`;
    snapEl.querySelector(".ss-tl-snap-lbl").textContent = fmt(sec);
  }
  function hideSnapGuide() { if (snapEl) snapEl.style.display = "none"; }

  // Every interesting edge on the shared ruler, excluding the block being dragged (else it would
  // snap to itself): playhead, trim in/out, cut edges, zoom/layer/mute/extra block edges, whole seconds.
  function snapCandidates(kind, id) {
    const c = [0, dur, playSec, inSec, outSec];
    for (let s = 1; s < dur; s++) c.push(s);
    for (const cut of (getCuts && getCuts()) || []) c.push(cut.in, cut.out);
    for (const b of (getZoomBlocks && getZoomBlocks()) || []) if (!(kind === "zoom" && String(b.id) === String(id))) c.push(b.tIn, b.tOut);
    if (store) for (const l of store.layers) if (l.range && !(kind === "layer" && String(l.id) === String(id))) c.push(l.range.inSec, l.range.outSec);
    ((getAudioCuts && getAudioCuts()) || []).forEach((m, i) => { if (!(kind === "mute" && String(i) === String(id))) c.push(m.in, m.out); });
    const eb = getExtraBlock && getExtraBlock();
    if (eb && kind !== "extra") c.push(eb.tIn, eb.tOut);
    return c;
  }

  // A snap fn for one lane: pulls the moving edge(s) onto the nearest candidate within ~8px.
  function makeSnap(kind, minLen) {
    return (id, r, mode) => {
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

  function buildLayerRow(l) {
    const row = doc.createElement("div"); row.className = "ss-tl-trk ss-tl-trk-layer"; row.dataset.id = l.id;
    const h = header("", "");
    const visible = l.visible !== false;
    const op = typeof l.opacity === "number" ? l.opacity : 1;
    h.innerHTML =
      `<span class="ss-tl-grip" data-grip title="Drag to reorder">⋮⋮</span>` +
      `<span class="ss-tl-tname ss-tl-lname">${laneLabel(l)}</span>` +
      `<input class="ss-tl-op" type="range" min="0" max="1" step="0.05" value="${op}" title="Opacity" />` +
      `<button class="ss-tl-eye" data-eye title="${visible ? "Hide" : "Show"}">${visible ? "👁" : "🚫"}</button>` +
      `<button class="ss-tl-del" data-del title="Delete">×</button>`;
    const eyeBtn = h.querySelector("[data-eye]");
    eyeBtn.addEventListener("click", () => {
      const cur = store.get(l.id); if (!cur) return;
      const nowVisible = cur.visible === false; // toggling a hidden layer makes it visible
      if (onLayerVisible) onLayerVisible(l.id, nowVisible);
      eyeBtn.textContent = nowVisible ? "👁" : "🚫";
      eyeBtn.title = nowVisible ? "Hide" : "Show";
    });
    h.querySelector(".ss-tl-op").addEventListener("input", (e) => onLayerOpacity && onLayerOpacity(l.id, Number(e.target.value)));
    h.querySelector("[data-del]").addEventListener("click", () => onLayerDelete && onLayerDelete(l.id));
    wireReorder(h.querySelector("[data-grip]"), l.id);
    const t = timeArea("ss-tl-ltime");
    row.append(h, t); lanesEl.appendChild(row);
    layerRows.set(l.id, { time: t, block: null });
    wireBlockDrag(t, {
      secAt: (x) => secAtIn(x, t), maxSec: dur, minLen: Math.min(0.1, dur), blockSelector: ".ss-tl-lblock",
      getBlocks: () => {
        const cur = store.get(l.id); if (!cur) return [];
        const r = cur.range;
        return [r ? { id: l.id, tIn: r.inSec, tOut: r.outSec } : { id: l.id, tIn: 0, tOut: dur, movable: false }];
      },
      onSelect: (id) => onLayerSelect && onLayerSelect(id),
      onChange: (id, r) => onLayerRangeChange && onLayerRangeChange(id, { tIn: r.tIn, tOut: r.tOut }),
      snap: makeSnap("layer", Math.min(0.1, dur)),
      onDragEnd: hideSnapGuide,
    });
  }

  function buildExtraRow() {
    const ea = getExtraAudio();
    const row = doc.createElement("div"); row.className = "ss-tl-trk ss-tl-trk-extra";
    const h = header("", "");
    h.innerHTML =
      `<span class="ss-tl-ticon">🎙</span>` +
      `<span class="ss-tl-tname ss-tl-exname-h">${escapeHtml(ea.name || "audio")}</span>` +
      `<button class="ss-tl-eye ss-tl-exmute" data-exmute title="Mute track">${ea.muted ? "🔇" : "🔊"}</button>` +
      `<input class="ss-tl-op ss-tl-exvol" type="range" min="0" max="1" step="0.05" value="${typeof ea.volume === "number" ? ea.volume : 1}" title="Volume" />` +
      `<button class="ss-tl-del" data-exdel title="Remove track">×</button>`;
    h.querySelector("[data-exmute]").addEventListener("click", () => onExtraMute && onExtraMute());
    h.querySelector(".ss-tl-exvol").addEventListener("input", (e) => onExtraVolume && onExtraVolume(Number(e.target.value)));
    h.querySelector("[data-exdel]").addEventListener("click", () => onExtraRemove && onExtraRemove());
    const t = timeArea("ss-tl-extime");
    row.append(h, t); lanesEl.appendChild(row);
    extraRow = { time: t };
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

  // ── video track handlers (trim / scrub / cut) ───────────────────────────────────────────────────
  let inSec = 0, outSec = dur, playSec = 0, dragging = null, cutAnchor = 0;
  const MIN_GAP = Math.min(0.05, dur);
  function vSecAt(clientX) { return secAtIn(clientX, vtime); }

  function applyVDrag(clientX) {
    const sec = vSecAt(clientX);
    if (dragging === "in") { inSec = clamp(sec, 0, outSec - MIN_GAP); if (onTrimChange) onTrimChange(inSec, outSec); }
    else if (dragging === "out") { outSec = clamp(sec, inSec + MIN_GAP, dur); if (onTrimChange) onTrimChange(inSec, outSec); }
    else if (dragging === "scrub") { playSec = sec; if (onSeek) onSeek(sec); }
    else if (dragging === "cut") { pendingCut = { in: Math.min(cutAnchor, sec), out: Math.max(cutAnchor, sec) }; }
    layout();
  }
  function wireVideoTrack() {
    const handleDown = (which) => (e) => { e.preventDefault(); e.stopPropagation(); dragging = which; e.currentTarget.setPointerCapture?.(e.pointerId); applyVDrag(e.clientX); };
    inEl.addEventListener("pointerdown", handleDown("in"));
    outEl.addEventListener("pointerdown", handleDown("out"));
    vtime.addEventListener("pointerdown", (e) => {
      if (dragging || e.target === inEl || e.target === outEl || e.target.closest(".ss-tl-cut")) return;
      e.preventDefault(); vtime.setPointerCapture?.(e.pointerId);
      if (cutMode) { dragging = "cut"; cutAnchor = vSecAt(e.clientX); pendingCut = { in: cutAnchor, out: cutAnchor }; layout(); }
      else { dragging = "scrub"; applyVDrag(e.clientX); }
    });
    const move = (e) => { if (dragging) applyVDrag(e.clientX); };
    const endV = (e) => {
      if (!dragging) return;
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
      if (dragging === "cut" && pendingCut) { const c = pendingCut; pendingCut = null; if (c.out - c.in > 0.08 && onAddCut) onAddCut(c.in, c.out); }
      dragging = null; layout();
    };
    for (const t of [inEl, outEl, vtime]) { t.addEventListener("pointermove", move); t.addEventListener("pointerup", endV); t.addEventListener("pointercancel", endV); }
    // scrub via the ruler too
    rtime.addEventListener("pointerdown", (e) => { e.preventDefault(); rtime.setPointerCapture?.(e.pointerId); dragging = "scrub"; applyVDrag(e.clientX); });
    rtime.addEventListener("pointermove", move); rtime.addEventListener("pointerup", endV); rtime.addEventListener("pointercancel", endV);
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
      ref.time.textContent = "";
      const r = l.range;
      const lo = r ? clamp(r.inSec, 0, dur) : 0, hi = r ? clamp(r.outSec, lo, dur) : dur;
      const b = doc.createElement("div");
      b.className = "ss-tl-lblock" + (r ? "" : " ss-tl-lblock-full") + (id === selId ? " on" : "");
      b.dataset.id = id; posBlock(b, lo, hi);
      b.title = r ? `${fmt(lo)}–${fmt(hi)}` : "Shown for the whole clip — drag an edge in to limit it";
      b.innerHTML = `<span class="ss-tl-edge ss-tl-edge-l" data-edge="in"></span><span class="ss-tl-edge ss-tl-edge-r" data-edge="out"></span>`;
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
    awpath.setAttribute("d", data ? waveformPath(data.peaks, data.buckets) : "");
    // The waveform spans the WHOLE clip on the shared scale (stretched by tl-zoom, shifted by pan);
    // the lane's overflow:hidden clips it, keeping peaks aligned with the ruler and mute bands.
    awsvg.style.left = `${xOf(0)}px`;
    awsvg.style.width = `${dur * pps()}px`;
    const enabled = !getAudioEnabled || getAudioEnabled() !== false;
    atime.classList.toggle("ss-tl-adisabled", !enabled || !data);
    renderMutes();
  }
  function renderExtra() {
    if (!extraRow) return;
    const ea = getExtraAudio && getExtraAudio();
    const eb = getExtraBlock && getExtraBlock();
    if (!ea || !eb) return;
    extraRow.time.textContent = "";
    const lo = clamp(eb.tIn, 0, dur), hi = clamp(eb.tOut, lo, dur);
    const b = doc.createElement("div"); b.className = "ss-tl-exblock" + (selectedExtra ? " on" : ""); b.dataset.id = "ex";
    posBlock(b, lo, hi); b.title = `${ea.name || "audio"} · ${fmt(Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0)))}`;
    b.innerHTML = `<span class="ss-tl-edge ss-tl-edge-l" data-edge="in"></span><span class="ss-tl-exname">${escapeHtml(ea.name || "audio")}</span><span class="ss-tl-edge ss-tl-edge-r" data-edge="out"></span>`;
    extraRow.time.appendChild(b);
  }

  function renderRuler() {
    rlabels.textContent = "";
    const step = Math.max(1, Math.ceil(52 / pps())); // ≥52px between labels
    for (let s = 0; s <= dur + 0.001; s += step) {
      const t = doc.createElement("span"); t.className = "ss-tl-tick"; t.textContent = fmt(s); t.style.left = `${xOf(s)}px`;
      rlabels.appendChild(t);
    }
  }

  // reposition everything horizontal (no rebuild); also refresh trim/cut/playhead
  function layout() {
    scrollX = clamp(scrollX, 0, maxScroll());
    renderRuler();
    posBlock(trimEl, inSec, outSec);
    inEl.style.left = `${xOf(inSec)}px`;
    outEl.style.left = `${xOf(outSec)}px`;
    renderCuts();
    renderZoom();
    renderLayerBlocks();
    renderAudio();
    renderExtra();
    positionPlayhead();
  }
  function positionPlayhead() {
    if (!playEl) return;
    const x = xOf(playSec);
    const w = timeW();
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

  // ⌘/ctrl + wheel zooms around the pointer; a horizontal wheel/trackpad swipe (or ⇧+wheel) pans the
  // zoomed timeline; a plain vertical wheel scrolls the lanes natively.
  panel.addEventListener("wheel", (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const before = pps();
      const anchorSec = secAtIn(e.clientX, rtime);
      const mult = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setPps(before * mult);
      scrollX = clamp(anchorSec * pps() - (e.clientX - rtime.getBoundingClientRect().left), 0, maxScroll());
      layout();
      if (onScaleChange) onScaleChange();
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

  function setPps(v) {
    const fit = fitPps();
    const clamped = clamp(v, fit, fit * MAX_ZOOM_MULT);
    fitMode = clamped <= fit * 1.001;
    userPps = clamped;
  }

  return {
    setPlayhead(sec) { playSec = clamp(sec || 0, 0, dur); positionPlayhead(); },
    setTrim(i, o) {
      let lo = clamp(i || 0, 0, dur), hi = clamp(o == null ? dur : o, 0, dur);
      if (hi < lo + MIN_GAP) hi = Math.min(dur, lo + MIN_GAP);
      if (lo > hi - MIN_GAP) lo = Math.max(0, hi - MIN_GAP);
      inSec = lo; outSec = hi; layout();
    },
    setCutMode(on) { cutMode = !!on; vtime.classList.toggle("ss-tl-cutmode", cutMode); },
    isCutMode: () => cutMode,
    zoomBy(mult) { setPps(pps() * mult); scrollX = clamp(scrollX, 0, maxScroll()); layout(); if (onScaleChange) onScaleChange(); },
    fit() { fitMode = true; scrollX = 0; layout(); if (onScaleChange) onScaleChange(); },
    setZoomNorm(t) { const fit = fitPps(); setPps(fit * (1 + clamp(t, 0, 1) * (MAX_ZOOM_MULT - 1))); scrollX = clamp(scrollX, 0, maxScroll()); layout(); },
    getZoomNorm() { const fit = fitPps(); return clamp((pps() / fit - 1) / (MAX_ZOOM_MULT - 1), 0, 1); },
    refresh,
    destroy() { if (unsub) unsub(); if (ro) ro.disconnect(); el.innerHTML = ""; },
  };
}
