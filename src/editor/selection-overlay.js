// Selection + resize overlay for the stage. Two independent things it draws:
//   1. A dashed CREATION box while you drag a new rect / blur / arrow, so you can see the region you're
//      marking out before you release (fed the in-progress rect via setDraft()).
//   2. A SELECTION box with 8 resize handles around the currently-selected layer (image OR any shape),
//      so it's obvious what's selected and you can drag a handle to change its size/shape.
// The box bodies are pointer-events:none — annotate.js still owns click-to-select and drag-to-move on
// the canvas underneath; only the handles capture pointer events (to resize). Source-pixel geometry is
// mapped to display px through the SAME crop + output-scale transform the compositor uses, so the box
// tracks the content correctly at any resolution / crop / backdrop. (Time-varying zoom is not tracked;
// the box reflects the un-zoomed placement, same limitation the other stage overlays accept.)
import { composeDims, cropRect } from "./transforms.js";
import { bbox, setBounds } from "./shapes.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 8; // minimum layer size, in SOURCE px

// { stageEl, canvas, store, getTransforms, srcW, srcH, getLayer }
//   getLayer() -> the selected layer (image or shape) or null.
export function createSelectionOverlay({ stageEl, canvas, store, getTransforms, srcW, srcH, getLayer }) {
  let host = null, boxEl = null, draftEl = null;
  const handleEls = {};
  let drag = null;       // { id, kind, role, startX, startY, orig:{bounds, image?, shape?} }
  let unsub = null;
  let draftRect = null;  // in-progress creation rect in source px, or null
  const ctx2d = canvas.getContext("2d"); // used to measure text bounds

  // Source-px -> display-px mapping (crop + output-scale + backdrop aware). Mirrors the compositor's
  // srcRect->dest math (without the time-varying zoom term). origin 'stage' -> stage-local coords.
  function mapping(origin) {
    const t = (getTransforms && getTransforms()) || {};
    const cd = composeDims(t, srcW, srcH);
    const crop = cropRect(t, srcW, srcH);
    const r = canvas.getBoundingClientRect();
    const kx = r.width / (cd.outW || 1);   // display px per output px
    const ky = r.height / (cd.outH || 1);
    const scaleX = cd.dest.w / (crop.w || 1); // output px per source px
    const scaleY = cd.dest.h / (crop.h || 1);
    const offX = cd.dest.x - crop.x * scaleX; // output px
    const offY = cd.dest.y - crop.y * scaleY;
    let baseLeft = r.left, baseTop = r.top;
    if (origin === "stage") {
      const sr = stageEl.getBoundingClientRect();
      baseLeft = r.left - sr.left;
      baseTop = r.top - sr.top;
    }
    const dpx = scaleX * kx; // display px per source px
    const dpy = scaleY * ky;
    return {
      dpx, dpy,
      toDisplay: (b) => ({
        left: baseLeft + (b.x * scaleX + offX) * kx,
        top: baseTop + (b.y * scaleY + offY) * ky,
        w: b.w * dpx,
        h: b.h * dpy,
      }),
    };
  }

  function layerBounds(layer) {
    if (!layer) return null;
    if (layer.kind === "image" && layer.image) return { x: layer.image.x, y: layer.image.y, w: layer.image.w, h: layer.image.h };
    if (layer.kind === "shape" && layer.shape) return bbox(layer.shape, ctx2d);
    return null;
  }

  function build() {
    host = document.createElement("div");
    host.className = "ss-sel-host";
    host.style.cssText = "position:absolute;inset:0;z-index:26;pointer-events:none;";

    draftEl = document.createElement("div");
    draftEl.className = "ss-sel-draft";
    draftEl.style.display = "none";
    host.appendChild(draftEl);

    boxEl = document.createElement("div");
    boxEl.className = "ss-sel-box";
    boxEl.style.display = "none";
    for (const role of HANDLES) {
      const h = document.createElement("span");
      h.className = `ss-sel-handle ss-sel-${role}`;
      h.dataset.role = role;
      h.addEventListener("pointerdown", (e) => onHandleDown(role, e));
      boxEl.appendChild(h);
      handleEls[role] = h;
    }
    host.appendChild(boxEl);

    stageEl.appendChild(host);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    unsub = store && typeof store.subscribe === "function" ? store.subscribe(refresh) : null;
    refresh();
  }

  function refresh() {
    if (!host) return;
    const m = mapping("stage");

    // Creation draft box.
    if (draftRect && draftRect.w >= 0 && draftRect.h >= 0) {
      const d = m.toDisplay(draftRect);
      draftEl.style.cssText = `position:absolute;display:block;pointer-events:none;left:${d.left}px;top:${d.top}px;width:${Math.max(0, d.w)}px;height:${Math.max(0, d.h)}px;`;
      draftEl.className = "ss-sel-draft";
    } else {
      draftEl.style.display = "none";
    }

    // Selection box + handles.
    const b = layerBounds(getLayer && getLayer());
    if (!b) { boxEl.style.display = "none"; return; }
    const d = m.toDisplay(b);
    boxEl.style.left = `${d.left}px`;
    boxEl.style.top = `${d.top}px`;
    boxEl.style.width = `${Math.max(0, d.w)}px`;
    boxEl.style.height = `${Math.max(0, d.h)}px`;
    boxEl.style.display = "block";
  }

  function onHandleDown(role, e) {
    const layer = getLayer && getLayer();
    const bounds = layerBounds(layer);
    if (!layer || !bounds) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the canvas underneath start a move
    host.setPointerCapture?.(e.pointerId);
    drag = {
      id: layer.id, kind: layer.kind, role, startX: e.clientX, startY: e.clientY,
      orig: {
        bounds,
        image: layer.image ? { ...layer.image } : null,
        shape: layer.shape ? JSON.parse(JSON.stringify(layer.shape)) : null,
      },
    };
  }

  function applyHandle(o, role, dx, dy) {
    let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
    if (role.includes("w")) left += dx;
    if (role.includes("e")) right += dx;
    if (role.includes("n")) top += dy;
    if (role.includes("s")) bottom += dy;
    if (right - left < MIN) { if (role.includes("w")) left = right - MIN; else right = left + MIN; }
    if (bottom - top < MIN) { if (role.includes("n")) top = bottom - MIN; else bottom = top + MIN; }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function onMove(e) {
    if (!drag) return;
    const m = mapping("screen");
    if (!(m.dpx > 0) || !(m.dpy > 0)) return; // pre-decode — avoid NaN
    const dxSrc = (e.clientX - drag.startX) / m.dpx;
    const dySrc = (e.clientY - drag.startY) / m.dpy;
    const nb = applyHandle(drag.orig.bounds, drag.role, dxSrc, dySrc);
    if (drag.kind === "image") {
      store.update(drag.id, { image: { ...drag.orig.image, x: nb.x, y: nb.y, w: nb.w, h: nb.h } });
    } else {
      store.update(drag.id, { shape: setBounds(drag.orig.shape, nb, drag.orig.bounds) });
    }
  }

  function onUp(e) {
    if (!drag) return;
    host.releasePointerCapture?.(e.pointerId);
    drag = null;
  }

  return {
    show() { if (!host) build(); else refresh(); },
    refresh() { if (!host) build(); else refresh(); },
    setDraft(rect) { draftRect = rect || null; if (!host && rect) build(); else refresh(); },
    hide() { if (host) { if (unsub) unsub(); host.remove(); host = null; boxEl = null; draftEl = null; drag = null; unsub = null; } },
    destroy() { if (host) { if (unsub) unsub(); host.remove(); host = null; boxEl = null; draftEl = null; drag = null; unsub = null; } },
  };
}
