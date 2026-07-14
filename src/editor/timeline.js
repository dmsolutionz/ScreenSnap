// Timeline: a horizontal track with draggable trim-in / trim-out handles, a playhead, removable CUT
// bands (the removed sub-intervals that make multi-segment trim), plus a stack of lanes below it that
// all share ONE interaction model (see wireBlockDrag): click a block to select, drag its body to move,
// drag an edge to resize. The lanes are:
//   • ZOOM — one block per zoom block (magnification keyframes).
//   • LAYERS — one row per overlay layer (image/gif/shape/text); a full-width bar means "shown for the
//     whole clip", and dragging an edge inward carves out a concrete time window (layer.range).
//   • AUDIO (mute) — the main track's waveform with removable MUTE bands (an independent silence mask;
//     painting/moving one never cuts or shifts the video). Drag empty space to paint a new band; drag an
//     existing band to move/resize it.
//   • EXTRA AUDIO — an optional imported voiceover/music track shown as one block that can be moved and
//     trimmed, with its own mute + volume in the lane's label column.
// Clicking the main track seeks; "cut mode" paints a removed region instead of seeking. Every edit is
// reported to the controller, which owns the data (the timeline only renders + reports). Pure DOM, no
// canvas — the waveform is a single SVG path, not a canvas element.

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// A short lane label for an overlay layer (fits the ~34px label column). Derived from our own layer
// enums, so the text is always safe to render.
function laneLabel(l) {
  if (!l) return "";
  if (l.kind === "image") return (l.image && l.image.frames) ? "GIF" : "IMG";
  const type = (l.shape && l.shape.type) || "shape";
  return type.slice(0, 4).toUpperCase();
}

// Build a closed SVG path (viewBox "0 0 100 30") tracing the waveform envelope from interleaved
// [min0,max0,min1,max1,...] peak values in [-1,1] — top edge = per-bucket max, bottom edge = min.
function waveformPath(peaks, buckets) {
  if (!peaks || !buckets) return "";
  const midY = 15, amp = 14;
  const top = [];
  const bottom = [];
  const span = Math.max(1, buckets - 1);
  for (let i = 0; i < buckets; i++) {
    const x = (i / span) * 100;
    const maxV = peaks[i * 2 + 1] || 0;
    const minV = peaks[i * 2] || 0;
    top.push(`${x.toFixed(2)},${(midY - maxV * amp).toFixed(2)}`);
    bottom.push(`${x.toFixed(2)},${(midY - minV * amp).toFixed(2)}`);
  }
  bottom.reverse();
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
}

// Shared select/move/resize pointer wiring for a lane. Attached ONCE to a stable container element;
// blocks inside it are rebuilt freely on repaint (delegation survives that). Callbacks:
//   secAt(clientX) -> source seconds under the pointer (each lane maps its own track rect).
//   getBlocks() -> [{ id, tIn, tOut, movable=true }] fresh each interaction (source seconds).
//   onSelect(id|null) -> fired on pointerdown, before any drag.
//   onChange(id, { tIn, tOut }, mode) -> per pointermove during a drag; mode is 'move'|'in'|'out'.
//   onCreateStart/Move/End(anchorSec[, sec]) -> optional; a drag on EMPTY space (no block hit) paints a
//     new block instead of deselecting (used by the mute lane). Absent -> empty click = onSelect(null).
//   canInteract() -> optional gate; when it returns false the lane ignores pointerdown entirely.
// opts: { secAt, maxSec, minLen, blockSelector, getBlocks, onSelect, onChange, onCreateStart,
//         onCreateMove, onCreateEnd, canInteract }
function wireBlockDrag(container, opts) {
  const {
    secAt, maxSec, minLen = 0.1, blockSelector,
    getBlocks, onSelect, onChange, onCreateStart, onCreateMove, onCreateEnd, canInteract,
  } = opts;
  let drag = null;      // { id, mode, startSec, orig:{tIn,tOut} }
  let creating = null;  // { anchorSec }

  container.addEventListener("pointerdown", (e) => {
    if (drag || creating) return;
    if (canInteract && !canInteract()) return;
    const blockEl = e.target.closest(blockSelector);
    if (!blockEl) {
      if (onCreateStart) {
        e.preventDefault();
        container.setPointerCapture?.(e.pointerId);
        const sec = secAt(e.clientX);
        creating = { anchorSec: sec };
        onCreateStart(sec);
      } else if (onSelect) {
        onSelect(null);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = blockEl.dataset.id;
    if (onSelect) onSelect(id);
    const b = ((getBlocks && getBlocks()) || []).find((x) => String(x.id) === String(id));
    if (!b) return;
    const mode = (e.target.dataset && e.target.dataset.edge) || "move";
    if (mode === "move" && b.movable === false) return; // full-width / non-movable block: select only
    container.setPointerCapture?.(e.pointerId);
    drag = { id: b.id, mode, startSec: secAt(e.clientX), orig: { tIn: b.tIn, tOut: b.tOut } };
  });

  container.addEventListener("pointermove", (e) => {
    if (creating) { if (onCreateMove) onCreateMove(creating.anchorSec, secAt(e.clientX)); return; }
    if (!drag) return;
    const d = secAt(e.clientX) - drag.startSec;
    let { tIn, tOut } = drag.orig;
    if (drag.mode === "move") {
      const len = tOut - tIn;
      tIn = Math.max(0, Math.min(tIn + d, maxSec - len));
      tOut = tIn + len;
    } else if (drag.mode === "in") {
      tIn = Math.max(0, Math.min(tIn + d, tOut - minLen));
    } else if (drag.mode === "out") {
      tOut = Math.min(maxSec, Math.max(tOut + d, tIn + minLen));
    }
    if (onChange) onChange(drag.id, { tIn, tOut }, drag.mode);
  });

  const end = (e) => {
    if (creating) {
      const c = creating;
      creating = null;
      container.releasePointerCapture?.(e.pointerId);
      if (onCreateEnd) onCreateEnd(c.anchorSec, secAt(e.clientX));
      return;
    }
    if (!drag) return;
    container.releasePointerCapture?.(e.pointerId);
    drag = null;
  };
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
}

// {
//   el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
//   getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
//   getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
//   store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
//   getExtraAudio, onExtraAudioChange, onExtraMute, onExtraVolume
// }
export function createTimeline(opts) {
  const {
    el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts,
    getZoomBlocks, getSelectedZoom, onZoomSelect, onZoomChange,
    getAudioPeaks, getAudioCuts, onAddAudioCut, onRemoveAudioCut, onAudioMuteChange, getAudioEnabled,
    store, getSelectedLayer, onLayerSelect, onLayerRangeChange,
    getExtraAudio, onExtraAudioChange, onExtraMute, onExtraVolume,
  } = opts;
  const dur = Math.max(0.001, durationSec || 0);
  let inSec = 0;
  let outSec = dur;
  let playSec = 0;
  let cutMode = false;
  let pendingCut = null; // { in, out } while dragging a new cut

  el.innerHTML = `
    <div class="ss-tl">
      <div class="ss-tl-times"><span class="ss-tl-in">00:00</span><span class="ss-tl-play">00:00</span><span class="ss-tl-out">${fmt(dur)}</span></div>
      <div class="ss-tl-track" id="ss-tl-track">
        <div class="ss-tl-trim" id="ss-tl-trim"></div>
        <div class="ss-tl-cuts" id="ss-tl-cuts"></div>
        <div class="ss-tl-handle ss-tl-handle-in" id="ss-tl-in" title="Trim start"></div>
        <div class="ss-tl-handle ss-tl-handle-out" id="ss-tl-out" title="Trim end"></div>
        <div class="ss-tl-playhead" id="ss-tl-playhead"></div>
      </div>
      <div class="ss-tl-zoomlane" id="ss-tl-zoomlane">
        <span class="ss-tl-zlabel">zoom</span>
        <div class="ss-tl-zblocks" id="ss-tl-zblocks"></div>
      </div>
      <div class="ss-tl-layerlanes" id="ss-tl-layerlanes"></div>
      <div class="ss-tl-audiolane" id="ss-tl-audiolane">
        <span class="ss-tl-alabel">audio</span>
        <div class="ss-tl-atrack" id="ss-tl-atrack">
          <svg class="ss-tl-await" id="ss-tl-await" viewBox="0 0 100 30" preserveAspectRatio="none"><path id="ss-tl-awpath"></path></svg>
          <div class="ss-tl-amutes" id="ss-tl-amutes"></div>
        </div>
      </div>
      <div class="ss-tl-exlane" id="ss-tl-exlane">
        <div class="ss-tl-exlabel">
          <button class="ss-tl-exmute" id="ss-tl-exmute" type="button" title="Mute this track">🔊</button>
          <input class="ss-tl-exvol" id="ss-tl-exvol" type="range" min="0" max="1" step="0.05" value="1" title="Imported track volume" />
        </div>
        <div class="ss-tl-extrack" id="ss-tl-extrack"></div>
      </div>
    </div>`;

  const track = el.querySelector("#ss-tl-track");
  const trimEl = el.querySelector("#ss-tl-trim");
  const cutsEl = el.querySelector("#ss-tl-cuts");
  const inEl = el.querySelector("#ss-tl-in");
  const outEl = el.querySelector("#ss-tl-out");
  const playEl = el.querySelector("#ss-tl-playhead");
  const inLbl = el.querySelector(".ss-tl-in");
  const outLbl = el.querySelector(".ss-tl-out");
  const playLbl = el.querySelector(".ss-tl-play");
  const zblocks = el.querySelector("#ss-tl-zblocks");
  const layerlanes = el.querySelector("#ss-tl-layerlanes");
  const atrack = el.querySelector("#ss-tl-atrack");
  const awpath = el.querySelector("#ss-tl-awpath");
  const amutesEl = el.querySelector("#ss-tl-amutes");
  const exlane = el.querySelector("#ss-tl-exlane");
  const exmuteBtn = el.querySelector("#ss-tl-exmute");
  const exvolInput = el.querySelector("#ss-tl-exvol");
  const extrack = el.querySelector("#ss-tl-extrack");

  const pct = (sec) => `${(sec / dur) * 100}%`;
  const widthPct = (lo, hi) => `${Math.max(0.6, ((hi - lo) / dur) * 100)}%`;

  // A secAt(clientX) closure bound to a track element (measured fresh each call so it tracks resize).
  function secAtEl(getEl) {
    return (clientX) => {
      const e2 = typeof getEl === "function" ? getEl() : getEl;
      if (!e2) return 0;
      const r = e2.getBoundingClientRect();
      const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(1, frac)) * dur;
    };
  }

  // ── Renderers ────────────────────────────────────────────────────────────────────────────────────
  function renderCuts() {
    const cuts = (getCuts && getCuts()) || [];
    cutsEl.textContent = "";
    const all = pendingCut ? cuts.concat([pendingCut]) : cuts;
    all.forEach((c, i) => {
      const isPending = pendingCut && i === all.length - 1 && all.length > cuts.length;
      const band = document.createElement("div");
      band.className = "ss-tl-cut" + (isPending ? " ss-tl-cut-pending" : "");
      const lo = Math.max(0, Math.min(c.in, c.out));
      const hi = Math.min(dur, Math.max(c.in, c.out));
      band.style.left = pct(lo);
      band.style.width = `${((hi - lo) / dur) * 100}%`;
      if (!isPending) {
        const x = document.createElement("button");
        x.className = "ss-tl-cut-x";
        x.textContent = "×";
        x.title = "Remove cut";
        x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
        x.addEventListener("click", (e) => { e.stopPropagation(); if (onRemoveCut) onRemoveCut(i); });
        band.appendChild(x);
      }
      cutsEl.appendChild(band);
    });
  }

  function renderZoomBlocks() {
    const blocks = (getZoomBlocks && getZoomBlocks()) || [];
    const selId = getSelectedZoom && getSelectedZoom();
    zblocks.textContent = "";
    for (const b of blocks) {
      const lo = Math.max(0, Math.min(dur, b.tIn));
      const hi = Math.max(lo, Math.min(dur, b.tOut));
      const el2 = document.createElement("div");
      el2.className = "ss-tl-zblock" + (b.id === selId ? " on" : "");
      el2.dataset.id = b.id;
      el2.style.left = pct(lo);
      el2.style.width = widthPct(lo, hi);
      el2.title = `Zoom ${(b.scale || 1).toFixed(1)}x · ${fmt(lo)}–${fmt(hi)}`;
      el2.innerHTML =
        `<span class="ss-tl-zedge ss-tl-zedge-l" data-edge="in"></span>` +
        `<span class="ss-tl-zname">${(b.scale || 1).toFixed(1)}x</span>` +
        `<span class="ss-tl-zedge ss-tl-zedge-r" data-edge="out"></span>`;
      zblocks.appendChild(el2);
    }
  }

  function renderLayerLanes() {
    const layers = store ? store.layers : [];
    layerlanes.style.display = layers.length ? "" : "none";
    layerlanes.textContent = "";
    if (!layers.length) return;
    const selId = getSelectedLayer && getSelectedLayer();
    const total = layers.length;
    // Top of the list = top of the draw stack (last in the array), matching the sidebar's order.
    for (let idx = total - 1; idx >= 0; idx--) {
      const l = layers[idx];
      const r = l.range || null;
      const lo = r ? Math.max(0, Math.min(dur, r.inSec)) : 0;
      const hi = r ? Math.max(lo, Math.min(dur, r.outSec)) : dur;

      const row = document.createElement("div");
      row.className = "ss-tl-layerrow";
      const lbl = document.createElement("span");
      lbl.className = "ss-tl-llabel";
      lbl.textContent = laneLabel(l);
      const lblocks = document.createElement("div");
      lblocks.className = "ss-tl-lblocks";

      const block = document.createElement("div");
      block.className = "ss-tl-lblock" + (r ? "" : " ss-tl-lblock-full") + (l.id === selId ? " on" : "");
      block.dataset.id = l.id;
      block.style.left = pct(lo);
      block.style.width = r ? widthPct(lo, hi) : "100%";
      block.title = r ? `${fmt(lo)}–${fmt(hi)}` : "Shown for the whole clip — drag an edge in to limit it";
      const edgeL = document.createElement("span");
      edgeL.className = "ss-tl-ledge ss-tl-ledge-l";
      edgeL.dataset.edge = "in";
      const edgeR = document.createElement("span");
      edgeR.className = "ss-tl-ledge ss-tl-ledge-r";
      edgeR.dataset.edge = "out";
      block.appendChild(edgeL);
      block.appendChild(edgeR);
      lblocks.appendChild(block);

      row.appendChild(lbl);
      row.appendChild(lblocks);
      layerlanes.appendChild(row);
    }
  }

  function renderAudioMutes() {
    const cuts = (getAudioCuts && getAudioCuts()) || [];
    amutesEl.textContent = "";
    const all = pendingAMute ? cuts.concat([pendingAMute]) : cuts;
    all.forEach((c, i) => {
      const isPending = pendingAMute && i === all.length - 1 && all.length > cuts.length;
      const band = document.createElement("div");
      band.className = "ss-tl-amute" + (isPending ? " ss-tl-amute-pending" : "") + (!isPending && String(i) === String(selectedMuteId) ? " on" : "");
      band.dataset.id = i;
      const lo = Math.max(0, Math.min(c.in, c.out));
      const hi = Math.min(dur, Math.max(c.in, c.out));
      band.style.left = pct(lo);
      band.style.width = `${((hi - lo) / dur) * 100}%`;
      if (!isPending) {
        const edgeL = document.createElement("span");
        edgeL.className = "ss-tl-amedge ss-tl-amedge-l";
        edgeL.dataset.edge = "in";
        const edgeR = document.createElement("span");
        edgeR.className = "ss-tl-amedge ss-tl-amedge-r";
        edgeR.dataset.edge = "out";
        const x = document.createElement("button");
        x.className = "ss-tl-amute-x";
        x.textContent = "×";
        x.title = "Un-mute this region";
        x.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
        x.addEventListener("click", (e) => { e.stopPropagation(); if (onRemoveAudioCut) onRemoveAudioCut(i); });
        band.appendChild(edgeL);
        band.appendChild(edgeR);
        band.appendChild(x);
      }
      amutesEl.appendChild(band);
    });
  }

  function renderAudio() {
    const data = getAudioPeaks && getAudioPeaks();
    awpath.setAttribute("d", data ? waveformPath(data.peaks, data.buckets) : "");
    const enabled = !getAudioEnabled || getAudioEnabled() !== false;
    const hasTrack = !!data;
    atrack.classList.toggle("ss-tl-adisabled", !enabled || !hasTrack);
    atrack.title = !hasTrack ? "No audio track" : !enabled ? "Audio is off (speed ≠ 1x)" : "Drag empty space to mute a region";
    renderAudioMutes();
  }

  function renderExtra() {
    const ea = getExtraAudio && getExtraAudio();
    exlane.style.display = ea ? "" : "none";
    extrack.textContent = "";
    if (!ea) return;
    exmuteBtn.textContent = ea.muted ? "🔇" : "🔊";
    exmuteBtn.classList.toggle("on", !!ea.muted);
    const vol = typeof ea.volume === "number" ? ea.volume : 1;
    if (document.activeElement !== exvolInput) exvolInput.value = String(vol);

    const len = Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0));
    const lo = Math.max(0, Math.min(dur, ea.offsetSec || 0));
    const hi = Math.max(lo, Math.min(dur, (ea.offsetSec || 0) + len));
    const block = document.createElement("div");
    block.className = "ss-tl-exblock" + (selectedExtra ? " on" : "");
    block.dataset.id = "ex";
    block.style.left = pct(lo);
    block.style.width = widthPct(lo, hi);
    block.title = `${ea.name || "audio"} · ${fmt(len)}`;
    const edgeL = document.createElement("span");
    edgeL.className = "ss-tl-exedge ss-tl-exedge-l";
    edgeL.dataset.edge = "in";
    const edgeR = document.createElement("span");
    edgeR.className = "ss-tl-exedge ss-tl-exedge-r";
    edgeR.dataset.edge = "out";
    const name = document.createElement("span");
    name.className = "ss-tl-exname";
    name.textContent = ea.name || "audio";
    block.appendChild(edgeL);
    block.appendChild(name);
    block.appendChild(edgeR);
    extrack.appendChild(block);
  }

  function paint() {
    inEl.style.left = pct(inSec);
    outEl.style.left = pct(outSec);
    trimEl.style.left = pct(inSec);
    trimEl.style.width = `${((outSec - inSec) / dur) * 100}%`;
    playEl.style.left = pct(playSec);
    inLbl.textContent = fmt(inSec);
    outLbl.textContent = fmt(outSec);
    playLbl.textContent = fmt(playSec);
    renderCuts();
    renderZoomBlocks();
    renderLayerLanes();
    renderAudio();
    renderExtra();
  }

  // ── Main track: trim handles, scrub, cut painting ──────────────────────────────────────────────────
  const mainSecAt = secAtEl(track);
  const secAt = (clientX) => mainSecAt(clientX); // legacy alias used by the trim/scrub handlers below

  const MIN_GAP = Math.min(0.05, dur);       // trim handles
  const MIN_ZOOM = Math.min(0.4, dur);       // shortest zoom block
  const MIN_LAYER_RANGE = Math.min(0.1, dur); // shortest layer time-window
  const MIN_MUTE = Math.min(0.08, dur);      // shortest mute band
  const MIN_EXAUDIO = Math.min(0.1, dur);    // shortest imported-audio window

  let dragging = null; // 'in' | 'out' | 'scrub' | 'cut' | null
  let cutAnchor = 0;
  let pendingAMute = null;      // { in, out } while dragging a new mute band
  let selectedMuteId = null;    // cosmetic highlight of a grabbed mute band
  let selectedExtra = false;    // cosmetic highlight of the imported-audio block

  function applyDrag(clientX) {
    const sec = secAt(clientX);
    if (dragging === "in") {
      inSec = Math.max(0, Math.min(sec, outSec - MIN_GAP));
      if (onTrimChange) onTrimChange(inSec, outSec);
    } else if (dragging === "out") {
      outSec = Math.min(dur, Math.max(sec, inSec + MIN_GAP));
      if (onTrimChange) onTrimChange(inSec, outSec);
    } else if (dragging === "scrub") {
      playSec = sec;
      if (onSeek) onSeek(sec);
    } else if (dragging === "cut") {
      pendingCut = { in: Math.min(cutAnchor, sec), out: Math.max(cutAnchor, sec) };
    }
    paint();
  }

  function handleDown(which) {
    return (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = which;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      applyDrag(e.clientX);
    };
  }
  inEl.addEventListener("pointerdown", handleDown("in"));
  outEl.addEventListener("pointerdown", handleDown("out"));

  track.addEventListener("pointerdown", (e) => {
    if (dragging) return;
    e.preventDefault();
    track.setPointerCapture?.(e.pointerId);
    if (cutMode) {
      dragging = "cut";
      cutAnchor = secAt(e.clientX);
      pendingCut = { in: cutAnchor, out: cutAnchor };
      paint();
    } else {
      dragging = "scrub";
      applyDrag(e.clientX);
    }
  });

  function onMove(e) {
    if (!dragging) return;
    applyDrag(e.clientX);
  }
  inEl.addEventListener("pointermove", onMove);
  outEl.addEventListener("pointermove", onMove);
  track.addEventListener("pointermove", onMove);

  const endDrag = (e) => {
    if (!dragging) return;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
    if (dragging === "cut" && pendingCut) {
      const c = pendingCut;
      pendingCut = null;
      if (c.out - c.in > 0.08 && onAddCut) onAddCut(c.in, c.out);
    }
    dragging = null;
    paint();
  };
  inEl.addEventListener("pointerup", endDrag);
  outEl.addEventListener("pointerup", endDrag);
  track.addEventListener("pointerup", endDrag);
  inEl.addEventListener("pointercancel", endDrag);
  outEl.addEventListener("pointercancel", endDrag);
  track.addEventListener("pointercancel", endDrag);

  // ── Zoom lane ──────────────────────────────────────────────────────────────────────────────────
  wireBlockDrag(zblocks, {
    secAt: secAtEl(zblocks),
    maxSec: dur,
    minLen: MIN_ZOOM,
    blockSelector: ".ss-tl-zblock",
    getBlocks: () => ((getZoomBlocks && getZoomBlocks()) || []).map((b) => ({ id: b.id, tIn: b.tIn, tOut: b.tOut })),
    onSelect: (id) => { if (onZoomSelect) onZoomSelect(id); },
    onChange: (id, r) => { if (onZoomChange) onZoomChange(id, { tIn: r.tIn, tOut: r.tOut }); },
  });

  // ── Layer-range lanes ──────────────────────────────────────────────────────────────────────────
  wireBlockDrag(layerlanes, {
    secAt: secAtEl(() => layerlanes.querySelector(".ss-tl-lblocks")),
    maxSec: dur,
    minLen: MIN_LAYER_RANGE,
    blockSelector: ".ss-tl-lblock",
    getBlocks: () => (store ? store.layers : []).map((l) => {
      const r = l.range;
      return r ? { id: l.id, tIn: r.inSec, tOut: r.outSec } : { id: l.id, tIn: 0, tOut: dur, movable: false };
    }),
    onSelect: (id) => { if (onLayerSelect) onLayerSelect(id); },
    onChange: (id, r) => { if (onLayerRangeChange) onLayerRangeChange(id, { tIn: r.tIn, tOut: r.tOut }); },
  });

  // ── Audio (mute) lane ────────────────────────────────────────────────────────────────────────────
  wireBlockDrag(atrack, {
    secAt: secAtEl(atrack),
    maxSec: dur,
    minLen: MIN_MUTE,
    blockSelector: ".ss-tl-amute",
    canInteract: () => !atrack.classList.contains("ss-tl-adisabled"),
    getBlocks: () => ((getAudioCuts && getAudioCuts()) || []).map((c, i) => ({ id: i, tIn: c.in, tOut: c.out })),
    onSelect: (id) => { selectedMuteId = id; renderAudioMutes(); },
    onChange: (id, r) => { if (onAudioMuteChange) onAudioMuteChange(Number(id), { tIn: r.tIn, tOut: r.tOut }); },
    onCreateStart: (sec) => { selectedMuteId = null; pendingAMute = { in: sec, out: sec }; renderAudioMutes(); },
    onCreateMove: (anchor, sec) => { pendingAMute = { in: Math.min(anchor, sec), out: Math.max(anchor, sec) }; renderAudioMutes(); },
    onCreateEnd: (anchor, sec) => {
      const lo = Math.min(anchor, sec), hi = Math.max(anchor, sec);
      pendingAMute = null;
      if (hi - lo > 0.08 && onAddAudioCut) onAddAudioCut(lo, hi);
      renderAudioMutes();
    },
  });

  // ── Imported-audio lane ──────────────────────────────────────────────────────────────────────────
  wireBlockDrag(extrack, {
    secAt: secAtEl(extrack),
    maxSec: dur,
    minLen: MIN_EXAUDIO,
    blockSelector: ".ss-tl-exblock",
    getBlocks: () => {
      const ea = getExtraAudio && getExtraAudio();
      if (!ea) return [];
      const len = Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0));
      return [{ id: "ex", tIn: ea.offsetSec || 0, tOut: (ea.offsetSec || 0) + len }];
    },
    onSelect: (id) => { selectedExtra = !!id; renderExtra(); },
    onChange: (_id, r, mode) => { if (onExtraAudioChange) onExtraAudioChange({ tIn: r.tIn, tOut: r.tOut }, mode); },
  });
  exmuteBtn.addEventListener("click", () => { if (onExtraMute) onExtraMute(); });
  exvolInput.addEventListener("input", () => { if (onExtraVolume) onExtraVolume(Number(exvolInput.value)); });

  // ── Live refresh: layer edits can originate from the sidebar or a canvas drag (not just here), so
  // subscribe to the store directly rather than relying on the controller to call refresh(). ──
  const unsub = store && typeof store.subscribe === "function" ? store.subscribe(() => paint()) : null;

  paint();

  return {
    setPlayhead(sec) { playSec = Math.max(0, Math.min(dur, sec || 0)); paint(); },
    setTrim(i, o) {
      let lo = Math.max(0, Math.min(dur, i || 0));
      let hi = Math.max(0, Math.min(dur, o == null ? dur : o));
      if (hi < lo + MIN_GAP) hi = Math.min(dur, lo + MIN_GAP);
      if (lo > hi - MIN_GAP) lo = Math.max(0, hi - MIN_GAP);
      inSec = lo;
      outSec = hi;
      paint();
    },
    setCutMode(on) { cutMode = !!on; track.classList.toggle("ss-tl-cutmode", cutMode); },
    isCutMode: () => cutMode,
    refresh() { paint(); },
    destroy() { if (unsub) unsub(); el.innerHTML = ""; },
  };
}
