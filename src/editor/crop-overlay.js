// Crop tool for the video stage. While active it shows the WHOLE frame (the editor feeds it a transforms
// getter with the applied crop and zooms suppressed) with a persistent crop box on top: dimmed outside,
// rule-of-thirds inside, eight handles. Drag inside the box to move it, drag an edge or corner to resize it
// (a ratio preset, or ⇧, keeps its shape; ⌥ resizes about the centre), drag outside it to draw a new one,
// arrow keys nudge. Ratio chips, exact W × H and a portrait/landscape swap live in the options row under the
// toolbar (the same slot the layer inspector uses). ↵ / Apply commits the box as transforms.crop in SOURCE
// pixels (null when it covers the whole frame), Esc / Cancel discards the edit, and the box is re-editable
// any time because it is always measured against the full frame. All the math is in crop-geometry.js.
import { composeDims } from "./transforms.js";
import { RATIOS, MIN_CROP, clamp, sameRect, intRect, boxHit, resizeBox, dragRect, ratioFit, swapRect, sizeRect } from "./crop-geometry.js";

const GRAB = 10; // screen px: how close the pointer must be to an edge / corner to take hold of it
const PAD = 16;  // the host reaches this far past the canvas so edge handles stay grabbable at the border
const CURSORS = { "-1,-1": "nwse-resize", "1,1": "nwse-resize", "1,-1": "nesw-resize", "-1,1": "nesw-resize", "0,-1": "ns-resize", "0,1": "ns-resize", "-1,0": "ew-resize", "1,0": "ew-resize" };
const HANDLES = ["-1,-1", "0,-1", "1,-1", "1,0", "1,1", "0,1", "-1,1", "-1,0"];

// { stageEl, canvas, inspectorEl, getTransforms, getCrop, srcW, srcH, onEnter(), onApply(crop|null), onExit() }
//   getTransforms() -> the transforms the stage is DRAWN with (full frame while cropping)
//   getCrop()       -> the crop currently applied to the edit ({x,y,w,h} source px) or null
export function createCropOverlay({ stageEl, canvas, inspectorEl, getTransforms, getCrop, srcW, srcH, onEnter, onApply, onExit }) {
  let host = null, frameEl = null, chipEl = null;
  let active = false;
  let frame = null;   // the crop box, source px: { x, y, w, h }
  let ratio = null;   // locked aspect ratio (w/h); null = free
  let drag = null;
  const full = () => ({ x: 0, y: 0, w: srcW, h: srcH });
  const base = () => { const c = getCrop && getCrop(); return c ? { ...c } : full(); };
  const dirty = () => !!frame && !sameRect(frame, base());

  // ── geometry: canvas box in the stage, the content rect inside it (a backdrop pads the canvas), and the
  // source ⇄ host-local maps built from them ──
  function geom() {
    const cr = canvas.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    const box = { left: cr.left - sr.left + stageEl.scrollLeft, top: cr.top - sr.top + stageEl.scrollTop, width: cr.width, height: cr.height };
    const cd = composeDims((getTransforms && getTransforms()) || {}, srcW, srcH);
    const kx = box.width / (cd.outW || 1), ky = box.height / (cd.outH || 1);
    const cb = { x: PAD + cd.dest.x * kx, y: PAD + cd.dest.y * ky, w: cd.dest.w * kx, h: cd.dest.h * ky };
    return { box, cb, sx: cb.w / srcW, sy: cb.h / srcH };
  }
  const toSrc = (g, e) => {
    const r = host.getBoundingClientRect();
    return { x: ((e.clientX - r.left) - g.cb.x) / g.sx, y: ((e.clientY - r.top) - g.cb.y) / g.sy };
  };

  // ── options row ──
  function buildOptions() {
    inspectorEl.innerHTML = `<div class="ss-insp ss-crop-row">
      <span class="ss-insp-title">Crop</span>
      <div class="ss-crop-presets" id="ss-crop-presets">${RATIOS.map(([label]) => `<button class="ss-crop-preset" data-ratio="${label}" type="button">${label}</button>`).join("")}</div>
      <span class="ss-insp-sep"></span>
      <span class="ss-insp-ctl">size
        <input class="ss-crop-num" id="ss-crop-w" inputmode="numeric" aria-label="Crop width" /> ×
        <input class="ss-crop-num" id="ss-crop-h" inputmode="numeric" aria-label="Crop height" /> px
        <button class="ss-insp-btn" id="ss-crop-swap" type="button" title="Swap portrait / landscape">⇄</button></span>
      <span class="ss-insp-spacer"></span>
      <span class="ss-insp-hint ss-crop-hint">drag to move · pull edges to resize · ⇧ keep shape · ⌥ from centre</span>
      <button class="ss-btn ss-btn-ghost ss-btn-sm" id="ss-crop-reset" type="button" title="Back to the whole frame">Reset</button>
      <button class="ss-btn ss-btn-ghost ss-btn-sm" id="ss-crop-cancel" type="button" title="Discard (Esc)">Cancel</button>
      <button class="ss-btn ss-btn-primary ss-btn-sm" id="ss-crop-apply" type="button" title="Apply (Enter)">Apply crop</button>
    </div>`;
    const q = (s) => inspectorEl.querySelector(s);
    q("#ss-crop-presets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ratio]");
      if (b) setRatio(b.dataset.ratio);
    });
    const typed = (changed) => () => {
      const next = sizeRect(frame, Number(q("#ss-crop-w").value), Number(q("#ss-crop-h").value), changed, ratio, srcW, srcH);
      if (next) frame = next;
      paint(); // an invalid entry just snaps back
    };
    q("#ss-crop-w").addEventListener("change", typed("w"));
    q("#ss-crop-h").addEventListener("change", typed("h"));
    for (const id of ["#ss-crop-w", "#ss-crop-h"]) q(id).addEventListener("focus", (e) => e.target.select());
    q("#ss-crop-swap").addEventListener("click", () => { if (ratio) ratio = 1 / ratio; frame = swapRect(frame, srcW, srcH); paint(); });
    q("#ss-crop-reset").addEventListener("click", () => { frame = full(); paint(); });
    q("#ss-crop-cancel").addEventListener("click", () => cancel());
    q("#ss-crop-apply").addEventListener("click", () => commit());
  }

  // A preset refits the box to the largest rect of that ratio centred in it (never adding area) and then
  // holds while the box is drawn or resized; Free keeps the box as it is.
  function setRatio(label) {
    const r = RATIOS.find((x) => x[0] === label);
    ratio = r ? r[1] : null;
    if (ratio) frame = ratioFit(frame, ratio, srcW, srcH);
    paint();
  }

  function build() {
    host = document.createElement("div");
    host.className = "ss-crop";
    host.style.cssText = "position:absolute;z-index:30;touch-action:none;user-select:none;cursor:crosshair;";
    host.innerHTML = `<div class="ss-crop-frame" id="ss-crop-frame">
        <span class="ss-crop-g ss-crop-gv1"></span><span class="ss-crop-g ss-crop-gv2"></span>
        <span class="ss-crop-g ss-crop-gh1"></span><span class="ss-crop-g ss-crop-gh2"></span>
        ${HANDLES.map((h) => `<i class="ss-crop-h" data-h="${h}"></i>`).join("")}
        <span class="ss-crop-chip" id="ss-crop-chip" hidden></span>
      </div>`;
    stageEl.appendChild(host);
    frameEl = host.querySelector("#ss-crop-frame");
    chipEl = host.querySelector("#ss-crop-chip");
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    host.addEventListener("dblclick", () => { if (dirty()) commit(); });
  }

  function place() {
    const { box } = geom();
    host.style.left = `${box.left - PAD}px`;
    host.style.top = `${box.top - PAD}px`;
    host.style.width = `${box.width + PAD * 2}px`;
    host.style.height = `${box.height + PAD * 2}px`;
  }

  function paint() {
    if (!host || !frame) return;
    place();
    const g = geom();
    frameEl.style.cssText = `left:${g.cb.x + frame.x * g.sx}px;top:${g.cb.y + frame.y * g.sy}px;width:${frame.w * g.sx}px;height:${frame.h * g.sy}px;`;
    frameEl.classList.toggle("whole", sameRect(frame, full()));
    frameEl.classList.toggle("dragging", !!drag);
    const q = (s) => inspectorEl.querySelector(s);
    const wEl = q("#ss-crop-w"), hEl = q("#ss-crop-h");
    if (wEl && document.activeElement !== wEl) wEl.value = String(frame.w);
    if (hEl && document.activeElement !== hEl) hEl.value = String(frame.h);
    inspectorEl.querySelectorAll(".ss-crop-preset").forEach((b) => {
      const r = RATIOS.find((x) => x[0] === b.dataset.ratio);
      b.classList.toggle("on", (r[1] == null ? ratio == null : ratio != null && Math.abs(r[1] - ratio) < 1e-6));
    });
    q("#ss-crop-apply").disabled = !dirty();
    q("#ss-crop-reset").disabled = sameRect(frame, full());
    if (chipEl) { chipEl.hidden = !drag || drag.kind === "move"; chipEl.textContent = `${frame.w} × ${frame.h}`; }
  }

  // ── pointer ──
  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = geom(), p = toSrc(g, e);
    const hit = boxHit(frame, p, GRAB / g.sx);
    if (hit && hit !== "inside") drag = { kind: "resize", hx: hit.hx, hy: hit.hy, start: p, orig: { ...frame } };
    else if (hit === "inside" && !sameRect(frame, full())) drag = { kind: "move", start: p, orig: { ...frame } };
    else { const x = clamp(p.x, 0, srcW), y = clamp(p.y, 0, srcH); drag = { kind: "draw", x1: x, y1: y, x2: x, y2: y, prev: { ...frame } }; }
    host.setPointerCapture?.(e.pointerId);
    paint();
  }

  function onMove(e) {
    const g = geom(), p = toSrc(g, e);
    if (!drag) { // hover: show what a press here would do
      const hit = boxHit(frame, p, GRAB / g.sx);
      host.style.cursor = hit && hit !== "inside" ? CURSORS[`${hit.hx},${hit.hy}`] : hit === "inside" && !sameRect(frame, full()) ? "move" : "crosshair";
      return;
    }
    let r;
    if (drag.kind === "draw") {
      drag.x2 = p.x; drag.y2 = p.y;
      r = dragRect(drag, ratio || (e.shiftKey ? 1 : null), srcW, srcH);
    } else {
      const d = { x: p.x - drag.start.x, y: p.y - drag.start.y };
      if (drag.kind === "move") r = { ...drag.orig, x: clamp(drag.orig.x + d.x, 0, srcW - drag.orig.w), y: clamp(drag.orig.y + d.y, 0, srcH - drag.orig.h) };
      else r = resizeBox(drag.orig, drag.hx, drag.hy, d, { ratio: ratio || (e.shiftKey ? drag.orig.w / drag.orig.h : null), alt: e.altKey, bounds: { w: srcW, h: srcH }, min: MIN_CROP });
    }
    frame = intRect(r, srcW, srcH);
    paint();
  }

  function onUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    host.releasePointerCapture?.(e.pointerId);
    // A click (or a sliver) while drawing is not a new box: keep the one that was there.
    if (d.kind === "draw" && (frame.w < MIN_CROP || frame.h < MIN_CROP)) frame = d.prev;
    paint();
  }

  // ── keyboard (capture phase, so the editor's frame-step / tool shortcuts don't also fire) ──
  function onKey(e) {
    if (!active) return;
    const t = e.target, typing = !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "Escape") { swallow(); if (typing) t.blur(); cancel(); return; }
    // Enter applies — even right after clicking a ratio chip (which keeps focus); only Reset / Cancel / Apply
    // keep their own meaning when focused.
    if (e.key === "Enter" && !(t && t.matches && t.matches("#ss-crop-reset, #ss-crop-cancel, #ss-crop-apply"))) { swallow(); if (typing) t.blur(); commit(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    swallow();
    frame = { ...frame, x: clamp(frame.x + d[0], 0, srcW - frame.w), y: clamp(frame.y + d[1], 0, srcH - frame.h) };
    paint();
  }

  function enter() {
    if (active) return;
    active = true;
    if (onEnter) onEnter();
    frame = base();
    ratio = null;
    buildOptions();
    build();
    window.addEventListener("keydown", onKey, true);
    paint();
  }

  function exit() {
    if (!active) return;
    active = false;
    window.removeEventListener("keydown", onKey, true);
    if (host) host.remove();
    host = frameEl = chipEl = null;
    frame = null; drag = null;
    inspectorEl.innerHTML = "";
    if (onExit) onExit();
  }

  function commit() {
    if (!active) return;
    if (dirty() && onApply) onApply(sameRect(frame, full()) ? null : { ...frame });
    exit();
  }
  function cancel() { exit(); }

  return {
    enter, exit, commit, cancel,
    refresh() { if (active) paint(); },
    isActive: () => active,
    isDirty: () => active && dirty(),
  };
}
