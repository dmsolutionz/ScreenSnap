// Timeline: a horizontal bar with draggable trim-in / trim-out handles, a playhead, removable CUT
// bands (the removed sub-intervals that make multi-segment trim), and small ZOOM keyframe marks.
// Clicking the track seeks; dragging a handle reports the new trim window. In "cut mode" dragging the
// track paints a new removed region instead of seeking. Cuts and zoom marks are read from getters the
// controller owns, so the timeline only renders + reports edits. Pure DOM, no canvas.

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// { el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts, getZoom }
export function createTimeline({ el, durationSec, onTrimChange, onSeek, onAddCut, onRemoveCut, getCuts, getZoom }) {
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
        <div class="ss-tl-zooms" id="ss-tl-zooms"></div>
        <div class="ss-tl-handle ss-tl-handle-in" id="ss-tl-in" title="Trim start"></div>
        <div class="ss-tl-handle ss-tl-handle-out" id="ss-tl-out" title="Trim end"></div>
        <div class="ss-tl-playhead" id="ss-tl-playhead"></div>
      </div>
    </div>`;

  const track = el.querySelector("#ss-tl-track");
  const trimEl = el.querySelector("#ss-tl-trim");
  const cutsEl = el.querySelector("#ss-tl-cuts");
  const zoomsEl = el.querySelector("#ss-tl-zooms");
  const inEl = el.querySelector("#ss-tl-in");
  const outEl = el.querySelector("#ss-tl-out");
  const playEl = el.querySelector("#ss-tl-playhead");
  const inLbl = el.querySelector(".ss-tl-in");
  const outLbl = el.querySelector(".ss-tl-out");
  const playLbl = el.querySelector(".ss-tl-play");

  const pct = (sec) => `${(sec / dur) * 100}%`;

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

  function renderZooms() {
    const kfs = (getZoom && getZoom()) || [];
    zoomsEl.textContent = "";
    for (const k of kfs) {
      const m = document.createElement("div");
      m.className = "ss-tl-zoom" + (k.scale > 1.01 ? " ss-tl-zoom-in" : "");
      m.style.left = pct(Math.max(0, Math.min(dur, k.t)));
      m.title = `Zoom ${k.scale > 1.01 ? k.scale.toFixed(1) + "x" : "out"} @ ${fmt(k.t)}`;
      zoomsEl.appendChild(m);
    }
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
    renderZooms();
  }

  function secAt(clientX) {
    const r = track.getBoundingClientRect();
    const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(1, frac)) * dur;
  }

  // Keep at least a small gap so trimIn stays strictly below trimOut within [0, dur].
  const MIN_GAP = Math.min(0.05, dur);

  let dragging = null; // 'in' | 'out' | 'scrub' | 'cut' | null
  let cutAnchor = 0;

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

  // Track pointerdown: paint a cut in cut mode, otherwise scrub/seek.
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
    destroy() { el.innerHTML = ""; },
  };
}
