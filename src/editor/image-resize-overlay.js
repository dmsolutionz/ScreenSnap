// Resize handle overlay for a selected image/gif overlay layer. While an image layer is selected it
// draws a box around it on the stage; dragging the corner handle resizes it (aspect-ratio locked).
// The box itself is visual-only (pointer-events:none) — annotate.js's own select-tool drag already
// owns "move" on the image body (it mutates image.x/y directly on pointer events that hit the
// canvas), so only the handle intercepts pointer events here; a drag anywhere else on the box falls
// through to the canvas underneath and continues to work exactly as it does today. Coordinates map
// through composeDims so the box tracks the content area even with a backdrop/crop/resolution change
// — the same transform zoom-overlay.js uses, and this file otherwise mirrors that one's structure.
import { composeDims } from "./transforms.js";

const MIN_SIZE = 8; // minimum layer w/h, in SOURCE px — prevents a degenerate zero-size layer

// { stageEl, canvas, store, getTransforms, srcW, srcH, getLayer, onChange }
//   getLayer() -> the selected layer (kind === "image") or null — the overlay hides otherwise.
//   onChange({x,y,w,h}) -> persist a resize (controller store.update()s the layer + redraws).
export function createImageResizeOverlay({ stageEl, canvas, store, getTransforms, srcW, srcH, getLayer, onChange }) {
  let host = null;
  let box = null;
  let drag = null;
  let unsub = null;

  // The content area (the cropped frame, inside any backdrop padding) as a px rect — identical math
  // to zoom-overlay.js's contentRect(). `origin` selects stage-local coords (for placing the
  // absolutely-positioned box) vs screen coords (for pointer math).
  function contentRect(origin) {
    const r = canvas.getBoundingClientRect();
    const cd = composeDims((getTransforms && getTransforms()) || {}, srcW, srcH);
    const sx = r.width / (cd.outW || 1);
    const sy = r.height / (cd.outH || 1);
    let left = r.left;
    let top = r.top;
    if (origin === "stage") {
      const sr = stageEl.getBoundingClientRect();
      left = r.left - sr.left;
      top = r.top - sr.top;
    }
    return { left: left + cd.dest.x * sx, top: top + cd.dest.y * sy, w: cd.dest.w * sx, h: cd.dest.h * sy, sx, sy };
  }

  function build() {
    host = document.createElement("div");
    host.className = "ss-imgresize-host";
    host.style.cssText = "position:absolute;inset:0;z-index:24;pointer-events:none;";
    box = document.createElement("div");
    box.className = "ss-imgresize";
    box.innerHTML = `<span class="ss-imgresize-handle"></span>`;
    host.appendChild(box);
    stageEl.appendChild(host);
    box.querySelector(".ss-imgresize-handle").addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    // Track any layer edit (move, opacity, another resize) so the box stays aligned live, without
    // the controller having to remember to call refresh() from every mutation path.
    unsub = store && typeof store.subscribe === "function" ? store.subscribe(refresh) : null;
    refresh();
  }

  function refresh() {
    if (!host) return;
    const l = getLayer && getLayer();
    if (!l || l.kind !== "image" || !l.image) { box.style.display = "none"; return; }
    const im = l.image;
    const cr = contentRect("stage");
    box.style.cssText =
      "position:absolute;display:block;pointer-events:none;" +
      `left:${cr.left + im.x * cr.sx}px;top:${cr.top + im.y * cr.sy}px;width:${im.w * cr.sx}px;height:${im.h * cr.sy}px;`;
  }

  function onDown(e) {
    const l = getLayer && getLayer();
    if (!l || l.kind !== "image" || !l.image) return;
    e.preventDefault();
    e.stopPropagation();
    host.setPointerCapture?.(e.pointerId);
    const im = l.image;
    drag = { startX: e.clientX, orig: { x: im.x, y: im.y, w: im.w, h: im.h }, ratio: im.h > 0 ? im.w / im.h : 1 };
  }

  function onMove(e) {
    if (!drag) return;
    const cr = contentRect("screen");
    if (!(cr.sx > 0)) return; // no content area yet (pre-decode) — avoid NaN math
    const dxSrc = (e.clientX - drag.startX) / cr.sx;
    let w = Math.max(MIN_SIZE, drag.orig.w + dxSrc);
    let h = w / (drag.ratio || 1);
    if (h < MIN_SIZE) { h = MIN_SIZE; w = h * (drag.ratio || 1); }
    if (onChange) onChange({ x: drag.orig.x, y: drag.orig.y, w, h });
  }

  function onUp(e) {
    if (!drag) return;
    host.releasePointerCapture?.(e.pointerId);
    drag = null;
  }

  return {
    show() { if (!host) build(); else refresh(); },
    refresh,
    hide() { if (host) { if (unsub) unsub(); host.remove(); host = null; box = null; drag = null; unsub = null; } },
    destroy() { if (host) { if (unsub) unsub(); host.remove(); host = null; box = null; drag = null; unsub = null; } },
  };
}
