// Zoom focus overlay for the video stage. While a zoom block is selected it shows a box over the
// preview representing the magnified region: drag the body to move the focus point (cx,cy) and drag the
// corner to change the magnification (scale). The host covers the stage but is pointer-transparent
// except for the box itself, so annotation and the rest of the stage keep working. Coordinates map
// through composeDims so the box tracks the content area even with a backdrop/crop/resolution change.
import { composeDims } from "./transforms.js";

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// { stageEl, canvas, getTransforms, srcW, srcH, getBlock, onChange }
//   getBlock() -> the selected block { cx, cy, scale } or null
//   onChange({ cx, cy, scale }) -> persist an edit (controller updates the block + redraws)
export function createZoomOverlay({ stageEl, canvas, getTransforms, srcW, srcH, getBlock, onChange }) {
  let host = null;
  let box = null;
  let drag = null;
  const MAX_SCALE = 8;

  // The content area (the cropped frame, inside any backdrop padding) as a px rect. `origin` selects
  // stage-local coords (for placing the absolutely-positioned box) vs screen coords (for pointer math).
  function contentRect(origin) {
    const r = canvas.getBoundingClientRect();
    const cd = composeDims((getTransforms && getTransforms()) || {}, srcW, srcH);
    const sx = r.width / (cd.outW || 1);
    const sy = r.height / (cd.outH || 1);
    let left = r.left;
    let top = r.top;
    if (origin === "stage") {
      // r (canvas rect) already reflects the stage's scroll position, and the absolutely-positioned
      // host is pinned to the stage's padding box — so this delta is the box's stage-local offset; do
      // NOT add scrollLeft/Top (that would double-count the scroll).
      const sr = stageEl.getBoundingClientRect();
      left = r.left - sr.left;
      top = r.top - sr.top;
    }
    return { left: left + cd.dest.x * sx, top: top + cd.dest.y * sy, w: cd.dest.w * sx, h: cd.dest.h * sy };
  }

  function build() {
    host = document.createElement("div");
    host.className = "ss-zfocus-host";
    host.style.cssText = "position:absolute;inset:0;z-index:25;pointer-events:none;";
    box = document.createElement("div");
    box.className = "ss-zfocus";
    box.innerHTML = `<span class="ss-zfocus-tag">Zoom focus</span><span class="ss-zfocus-handle"></span>`;
    host.appendChild(box);
    stageEl.appendChild(host);
    box.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    refresh();
  }

  function refresh() {
    if (!host) return;
    const blk = getBlock && getBlock();
    if (!blk) { box.style.display = "none"; return; }
    const cr = contentRect("stage");
    const s = clamp(blk.scale || 1, 1, MAX_SCALE);
    const bw = cr.w / s;
    const bh = cr.h / s;
    const cxPx = cr.left + clamp(blk.cx, 0, 1) * cr.w;
    const cyPx = cr.top + clamp(blk.cy, 0, 1) * cr.h;
    box.style.cssText =
      `position:absolute;display:block;pointer-events:auto;cursor:move;` +
      `left:${cxPx - bw / 2}px;top:${cyPx - bh / 2}px;width:${bw}px;height:${bh}px;`;
  }

  function onDown(e) {
    const blk = getBlock && getBlock();
    if (!blk) return;
    e.preventDefault();
    e.stopPropagation();
    host.setPointerCapture?.(e.pointerId);
    const isHandle = e.target.classList && e.target.classList.contains("ss-zfocus-handle");
    drag = { mode: isHandle ? "resize" : "move", startX: e.clientX, startY: e.clientY, orig: { cx: blk.cx, cy: blk.cy, scale: blk.scale || 1 } };
  }

  function onMove(e) {
    if (!drag) return;
    const crs = contentRect("screen");
    if (!(crs.w > 0) || !(crs.h > 0)) return; // no content area yet (pre-decode) — avoid NaN math
    if (drag.mode === "move") {
      const dcx = (e.clientX - drag.startX) / (crs.w || 1);
      const dcy = (e.clientY - drag.startY) / (crs.h || 1);
      const s = clamp(drag.orig.scale || 1, 1, MAX_SCALE);
      const halfX = 0.5 / s;
      const halfY = 0.5 / s;
      const cx = clamp(drag.orig.cx + dcx, halfX, 1 - halfX);
      const cy = clamp(drag.orig.cy + dcy, halfY, 1 - halfY);
      if (onChange) onChange({ cx, cy, scale: drag.orig.scale });
    } else {
      // Resize from the box center: a wider box = lower magnification. Min half-width = content/(2·MAX).
      const centerX = crs.left + clamp(drag.orig.cx, 0, 1) * crs.w;
      const minHalf = crs.w / (2 * MAX_SCALE);
      const halfW = Math.max(minHalf, Math.min(crs.w / 2, Math.abs(e.clientX - centerX)));
      const scale = clamp(crs.w / (2 * halfW), 1, MAX_SCALE);
      const half = 0.5 / scale;
      const cx = clamp(drag.orig.cx, half, 1 - half);
      const cy = clamp(drag.orig.cy, half, 1 - half);
      if (onChange) onChange({ cx, cy, scale });
    }
  }

  function onUp(e) {
    if (!drag) return;
    host.releasePointerCapture?.(e.pointerId);
    drag = null;
  }

  return {
    show() { if (!host) build(); else refresh(); },
    refresh,
    hide() { if (host) { host.remove(); host = null; box = null; drag = null; } },
    destroy() { if (host) { host.remove(); host = null; box = null; drag = null; } },
  };
}
