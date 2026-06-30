// Crop overlay for the video stage. While active it sits on top of the preview canvas (so it also
// suspends annotation), lets the user drag a rectangle with a dim-outside + rule-of-thirds affordance,
// and on Apply converts the selection — expressed as a fraction of the displayed canvas — into a crop
// rect in SOURCE pixels. Crops COMPOSE: the selection is measured against the current crop rect (the
// "base"), so cropping an already-cropped view narrows further. Reset clears the crop entirely.
import { cropRect } from "./transforms.js";

// { stageEl, canvas, getTransforms, srcW, srcH, onApply(crop|null), onExit }
export function createCropOverlay({ stageEl, canvas, getTransforms, srcW, srcH, onApply, onExit }) {
  let host = null;
  let sel = null;     // current selection in overlay-local px: { x, y, w, h }
  let drag = null;    // { x0, y0 }
  let active = false;
  let ratio = 0;      // locked aspect ratio (w/h); 0 = free-form

  const PRESETS = [["0", "Free"], ["1.7777778", "16:9"], ["1", "1:1"], ["0.5625", "9:16"], ["1.3333333", "4:3"]];

  function canvasBoxInStage() {
    // The canvas is centered inside the (position:relative, scrollable, padded) stage. Compute its box
    // relative to the stage's content origin via bounding rects + scroll — robust to the padding and
    // any scroll offset, which raw offsetLeft/Top can get wrong.
    const cr = canvas.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    return {
      left: cr.left - sr.left + stageEl.scrollLeft,
      top: cr.top - sr.top + stageEl.scrollTop,
      width: cr.width,
      height: cr.height,
    };
  }

  function build() {
    host = document.createElement("div");
    host.className = "ss-crop";
    const box = canvasBoxInStage();
    host.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:30;touch-action:none;cursor:crosshair;`;
    host.innerHTML = `
      <div class="ss-crop-shade" id="ss-crop-shade"></div>
      <div class="ss-crop-rect" id="ss-crop-rect">
        <span class="ss-crop-g ss-crop-gv1"></span><span class="ss-crop-g ss-crop-gv2"></span>
        <span class="ss-crop-g ss-crop-gh1"></span><span class="ss-crop-g ss-crop-gh2"></span>
      </div>
      <div class="ss-crop-bar" id="ss-crop-bar">
        <div class="ss-crop-presets" id="ss-crop-presets">
          ${PRESETS.map(([r, label], i) => `<button class="ss-crop-preset ${i === 0 ? "on" : ""}" data-ratio="${r}" type="button">${label}</button>`).join("")}
        </div>
        <span class="ss-crop-hint" id="ss-crop-hint">Drag to select a crop area</span>
        <button class="ss-btn ss-btn-ghost ss-crop-reset" id="ss-crop-reset" type="button">Reset</button>
        <button class="ss-btn ss-btn-ghost" id="ss-crop-cancel" type="button">Cancel</button>
        <button class="ss-btn ss-btn-primary" id="ss-crop-apply" type="button" disabled>Apply crop</button>
      </div>`;
    stageEl.appendChild(host);

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.querySelector("#ss-crop-apply").addEventListener("click", apply);
    host.querySelector("#ss-crop-cancel").addEventListener("click", () => exit());
    host.querySelector("#ss-crop-reset").addEventListener("click", reset);
    host.querySelector("#ss-crop-presets").addEventListener("pointerdown", (e) => e.stopPropagation());
    host.querySelector("#ss-crop-presets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ratio]");
      if (!b) return;
      ratio = Number(b.dataset.ratio) || 0;
      host.querySelectorAll(".ss-crop-preset").forEach((x) => x.classList.toggle("on", x === b));
      applyRatioToSelection();
      paint();
    });
    // Start with the whole frame selected so Apply/Reset read naturally.
    sel = { x: 0, y: 0, w: box.width, h: box.height };
    paint();
  }

  function localPoint(e) {
    const r = host.getBoundingClientRect();
    return { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) };
  }

  function onDown(e) {
    if (e.target.closest(".ss-crop-bar")) return; // let the buttons work
    e.preventDefault();
    host.setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    drag = { x0: p.x, y0: p.y, box: canvasBoxInStage() }; // cache the box for the whole drag
    sel = { x: p.x, y: p.y, w: 0, h: 0 };
    paint();
  }
  function onMove(e) {
    if (!drag) return;
    const p = localPoint(e);
    if (ratio) sel = ratioRect(drag.x0, drag.y0, p.x, p.y, ratio, drag.box);
    else sel = { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) };
    paint();
  }
  function onUp(e) {
    if (!drag) return;
    drag = null;
    host.releasePointerCapture?.(e.pointerId);
    if (sel && (sel.w < 8 || sel.h < 8)) { // tiny drag → "select all" (at the locked ratio, if any)
      if (ratio) applyRatioToSelection();
      else { const box = canvasBoxInStage(); sel = { x: 0, y: 0, w: box.width, h: box.height }; }
    }
    paint();
  }

  // Constrain a drag to the locked aspect ratio, clamped to the available space in the drag direction.
  function ratioRect(ax, ay, px, py, r, box) {
    let w = Math.abs(px - ax);
    let h = w / r;
    const availX = px >= ax ? box.width - ax : ax;
    const availY = py >= ay ? box.height - ay : ay;
    if (w > availX) { w = availX; h = w / r; }
    if (h > availY) { h = availY; w = h * r; }
    const x = px >= ax ? ax : ax - w;
    const y = py >= ay ? ay : ay - h;
    return { x, y, w, h };
  }

  // Reshape the current selection to the locked ratio, centered on its center (or the canvas center),
  // fitting within ~90% of the canvas. No-op in free mode.
  function applyRatioToSelection() {
    if (!ratio) return;
    const box = canvasBoxInStage();
    const cx = sel ? sel.x + sel.w / 2 : box.width / 2;
    const cy = sel ? sel.y + sel.h / 2 : box.height / 2;
    let w = box.width * 0.9;
    let h = w / ratio;
    if (h > box.height * 0.9) { h = box.height * 0.9; w = h * ratio; }
    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.max(0, Math.min(x, box.width - w));
    y = Math.max(0, Math.min(y, box.height - h));
    sel = { x, y, w, h };
  }

  function paint() {
    if (!host) return;
    const rectEl = host.querySelector("#ss-crop-rect");
    const shade = host.querySelector("#ss-crop-shade");
    const apply = host.querySelector("#ss-crop-apply");
    const hint = host.querySelector("#ss-crop-hint");
    const has = sel && sel.w >= 8 && sel.h >= 8;
    rectEl.style.cssText =
      `position:absolute;left:${sel.x}px;top:${sel.y}px;width:${sel.w}px;height:${sel.h}px;` +
      "box-sizing:border-box;border:1px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);pointer-events:none;";
    rectEl.style.display = has ? "block" : "none";
    shade.style.cssText = has ? "display:none" : "position:absolute;inset:0;background:rgba(0,0,0,0.35);pointer-events:none;";
    apply.disabled = !isCropMeaningful();
    if (hint) hint.style.display = has ? "none" : "";
  }

  // A crop only matters if the selection is meaningfully smaller than the whole canvas.
  function isCropMeaningful() {
    const box = canvasBoxInStage();
    if (!sel || sel.w < 8 || sel.h < 8) return false;
    return sel.w < box.width - 2 || sel.h < box.height - 2;
  }

  function selToCrop() {
    const box = canvasBoxInStage();
    const t = getTransforms ? getTransforms() : null;
    const base = cropRect(t, srcW, srcH); // current crop (or full frame) = what the canvas displays
    const fx = sel.x / box.width, fy = sel.y / box.height;
    const fw = sel.w / box.width, fh = sel.h / box.height;
    let w = Math.round(base.w * fw);
    let h = Math.round(base.h * fh);
    let x = Math.round(base.x + base.w * fx);
    let y = Math.round(base.y + base.h * fy);
    w = clamp(w, 2, srcW);
    // With a locked ratio, derive height from width so the crop lands at the nominal aspect (the
    // independent rounding above could otherwise drift it by a pixel).
    h = clamp(ratio ? Math.round(w / ratio) : h, 2, srcH);
    x = clamp(x, 0, srcW - w); y = clamp(y, 0, srcH - h);
    return { x, y, w, h };
  }

  function apply() {
    if (!isCropMeaningful()) return;
    const crop = selToCrop();
    exit();
    if (onApply) onApply(crop);
  }
  function reset() {
    exit();
    if (onApply) onApply(null); // clear crop entirely
  }

  function exit() {
    if (!host) return;
    host.remove();
    host = null;
    sel = null;
    drag = null;
    active = false;
    if (onExit) onExit();
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  return {
    enter() { if (active) return; active = true; build(); },
    exit,
    isActive: () => active,
  };
}
