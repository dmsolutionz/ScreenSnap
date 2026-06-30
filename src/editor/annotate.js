// Pointer-driven annotation on the stage canvas: drag to create a shape layer for the current tool,
// or 'select' to pick / drag / delete an existing shape. Coordinates are mapped from the displayed
// canvas back into SOURCE-pixel space (the units the compositor + shapes.js expect). Tools:
// rect / arrow / blur drag, click-to-place text (inline <input> committed on blur), and select.
// We never render the canvas here — we mutate the store; preview.js owns rendering and redraws on
// store change.
import { newShapeLayer } from "./layers-model.js";
import { hit, translate } from "./shapes.js";
import { cropRect, composeDims } from "./transforms.js";

// { canvas, store, getTool, getColor, getTransforms }
export function createAnnotator({ canvas, store, getTool, getColor, getTransforms }) {
  let tool = (getTool && getTool()) || "select";
  let color = (getColor && getColor()) || "#22c55e";
  let drag = null;       // in-progress create drag: { tool,color,width,x1,y1,x2,y2 }
  let moving = null;     // in-progress select drag: { id, start:{x,y}, orig:shape }
  let selectedId = null;
  let editingText = false;
  // Latched SOURCE dimensions. The compositor draws shapes in source-pixel space and scales them by
  // outW/srcW, so every shape we store MUST be in source coords. preview.js sizes this canvas to the
  // *output* (outputDims w/ outScale): at "Original" (outScale:null) canvas.width === srcW, but at
  // 720p/1080p it is the downscaled output. We therefore can't trust canvas.width as source space.
  // We recover srcW/srcH by latching the canvas size whenever the resolution is Original, which is
  // the boot state (defaultTransforms => outScale:null, then preview.seekTo(0) sizes it to source).
  let srcW = 0;
  let srcH = 0;

  // Refresh the latched source dims when we can trust the canvas to be source-sized: Original res AND
  // no crop. (Boot seeks at default transforms — no outScale, no crop — so this latches the true full
  // source dims once before any crop/downscale is applied.) When a crop is active the canvas is sized
  // to the crop, so we must NOT re-latch from it.
  function syncSrcDims() {
    const t = getTransforms ? getTransforms() : null;
    const downscaled = !!(t && t.outScale && t.outScale.maxHeight);
    const cropped = !!(t && t.crop);
    const padded = !!(t && t.backdrop && t.backdrop.pad);
    // Only the un-downscaled, un-cropped, un-padded canvas equals the source frame — latch then.
    if (!downscaled && !cropped && !padded && canvas.width > 0 && canvas.height > 0) {
      srcW = canvas.width;
      srcH = canvas.height;
    }
  }

  // The base composition rect in SOURCE px that the displayed (un-zoomed) canvas represents — the crop
  // rect, or the full frame when there is no crop. Annotations are placed relative to this so they pin
  // to the cropped content (the compositor then maps them through crop+zoom like the base frame).
  function baseRect() {
    const t = getTransforms ? getTransforms() : null;
    return cropRect(t, srcW || canvas.width || 1, srcH || canvas.height || 1);
  }

  // Map a pointer event to SOURCE-pixel coordinates. The displayed canvas is the full COMPOSED output
  // (which may include backdrop padding), within which the content occupies `dest`. So we convert the
  // pointer to a fraction of the output, subtract the content's offset to get a fraction of the content
  // (= the crop rect), then map that into source px. With no backdrop, dest = the whole output and this
  // collapses to fractionX * cropW (and to fractionX * srcW with no crop) — the prior behavior.
  function toImg(e) {
    syncSrcDims();
    const r = canvas.getBoundingClientRect();
    const br = baseRect();
    const t = getTransforms ? getTransforms() : null;
    const cd = composeDims(t || {}, srcW || canvas.width || 1, srcH || canvas.height || 1);
    const fxOut = (e.clientX - r.left) / (r.width || 1);
    const fyOut = (e.clientY - r.top) / (r.height || 1);
    const fx = (fxOut * cd.outW - cd.dest.x) / (cd.dest.w || 1);
    const fy = (fyOut * cd.outH - cd.dest.y) / (cd.dest.h || 1);
    return { x: br.x + fx * br.w, y: br.y + fy * br.h };
  }
  // Stroke weight + hit tolerance scale with the SOURCE resolution, mirroring preview.js's `unit`,
  // so they stay correct regardless of the selected output resolution (stored coords are source px).
  function srcWidth() { syncSrcDims(); return srcW || canvas.width || 900; }
  function unit() { return Math.max(1, srcWidth() / 900); }
  function weight() { return Math.max(2, srcWidth() / 300); }

  // Top-most layer (image OR shape) hit at p, searched front-to-back over visible layers.
  function pointInRect(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
  function topLayerAt(p) {
    const tol = 9 * unit();
    const ordered = store.visibleOrdered ? store.visibleOrdered() : store.layers;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const l = ordered[i];
      if (!l) continue;
      if (l.kind === "image" && l.image && pointInRect(p, l.image)) return l;
      if (l.kind === "shape" && l.shape && hit(l.shape, p, tol)) return l;
    }
    return null;
  }

  function placeText(p) {
    editingText = true;
    selectedId = null;
    const c = (getColor && getColor()) || color;
    // size is stored in SOURCE px (compositor scales it by outW/srcW), so base it on source width.
    const size = Math.max(18, srcWidth() / 30);
    const r = canvas.getBoundingClientRect();
    const br = baseRect();
    // The content occupies `dest` within the displayed (possibly padded) output; convert source px to
    // display px through the content's on-screen box, and offset by the content's display origin.
    const cd = composeDims((getTransforms && getTransforms()) || {}, srcWidth(), srcH || canvas.height || 1);
    const contentW = r.width * cd.dest.w / (cd.outW || 1);
    const contentH = r.height * cd.dest.h / (cd.outH || 1);
    const originX = r.left + r.width * cd.dest.x / (cd.outW || 1);
    const originY = r.top + r.height * cd.dest.y / (cd.outH || 1);
    const sc = contentW / (br.w || 1);  // source px -> display px (x)
    const scY = contentH / (br.h || 1); // source px -> display px (y)
    const input = document.createElement("input");
    input.type = "text";
    input.style.cssText =
      "position:fixed;z-index:2147483647;margin:0;padding:0;border:0;outline:0;background:transparent;" +
      `font:600 ${size * sc}px 'Geist',system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1;`;
    input.style.left = originX + (p.x - br.x) * sc + "px";
    input.style.top = originY + (p.y - br.y) * scY + "px";
    input.style.color = c;
    document.body.appendChild(input);
    setTimeout(() => input.focus(), 0);
    const commit = () => {
      const text = input.value.trim();
      input.remove();
      editingText = false;
      if (text) store.add(newShapeLayer({ type: "text", color: c, size, x: p.x, y: p.y, text }));
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") input.blur();
      else if (ev.key === "Escape") { input.value = ""; input.blur(); }
    });
  }

  function down(e) {
    if (editingText) return;
    const t = (getTool && getTool()) || tool;
    if (t === "zoom") return; // zoom isn't an annotation — the editor handles zoom clicks itself
    const p = toImg(e);
    if (t === "select") {
      canvas.setPointerCapture?.(e.pointerId);
      const l = topLayerAt(p);
      selectedId = l ? l.id : null;
      if (l && l.kind === "image") moving = { id: l.id, kind: "image", start: p, orig: { x: l.image.x, y: l.image.y } };
      else if (l) moving = { id: l.id, kind: "shape", start: p, orig: JSON.parse(JSON.stringify(l.shape)) };
      return;
    }
    canvas.setPointerCapture?.(e.pointerId);
    selectedId = null;
    const c = (getColor && getColor()) || color;
    if (t === "text") return placeText(p);
    drag = { tool: t, color: c, width: weight(), x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }

  function move(e) {
    if (moving) {
      const p = toImg(e);
      const dx = p.x - moving.start.x, dy = p.y - moving.start.y;
      if (moving.kind === "image") {
        const cur = store.get(moving.id);
        if (cur && cur.image) store.update(moving.id, { image: { ...cur.image, x: moving.orig.x + dx, y: moving.orig.y + dy } });
      } else {
        store.update(moving.id, { shape: translate(moving.orig, dx, dy) });
      }
      return;
    }
    if (!drag) return;
    const p = toImg(e);
    drag.x2 = p.x;
    drag.y2 = p.y;
  }

  function up() {
    if (moving) { moving = null; return; }
    if (!drag) return;
    const d = drag;
    drag = null;
    const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2), w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
    if (d.tool === "arrow") {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4) return;
      store.add(newShapeLayer({ type: "arrow", color: d.color, width: d.width, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }));
      return;
    }
    if (w < 4 || h < 4) return;
    if (d.tool === "blur") store.add(newShapeLayer({ type: "blur", x, y, w, h }));
    else store.add(newShapeLayer({ type: d.tool, color: d.color, width: d.width, x, y, w, h }));
  }

  function onKey(e) {
    if (editingText) return; // the inline text <input> owns its own keys
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId != null) {
      e.preventDefault();
      store.remove(selectedId);
      selectedId = null;
    }
  }

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  window.addEventListener("keydown", onKey, true);

  return {
    setTool(t) { tool = t; if (t !== "select") selectedId = null; },
    setColor(c) {
      color = c;
      // Recolour the live selection so the colour swatch acts on the picked shape too.
      if (selectedId != null) {
        const l = store.get(selectedId);
        if (l && l.shape && l.shape.color != null) store.update(selectedId, { shape: { ...l.shape, color: c } });
      }
    },
    destroy() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", onKey, true);
    },
  };
}

// ── Regression guard: coordinate-space round-trip (output-vs-source mismatch) ──
// Pure, DOM-free reproduction of the pointer→source mapping (toImg, above) composed with the
// compositor's source→output scaling (compositor.js: ctx.scale(outW/srcW)). It proves that a pointer
// landed at a given fraction of the displayed stage ends up composited at the SAME fraction of the
// exported frame, regardless of the chosen output resolution — i.e. a click at the bottom-right with
// 720p selected on a 1080p+ source still composites at the bottom-right. Returns true on success and
// throws on regression, so it can be wired into a manual/scripted check.
//
// Manual repro (no harness): open a 1080p+ clip, pick Resolution = 720p, draw a rectangle in the
// bottom-right corner of the stage — confirm it stays bottom-right in the live preview and in the
// exported MP4. Before this fix it jumped toward the centre because coords were stored in output px.
export function __coordSpaceRegressionCheck() {
  // toImg maps a display-fraction to SOURCE px using the latched srcW/srcH (uniform downscale).
  const mapToSource = (frac, srcDim) => frac * srcDim;
  // The compositor maps a source coord back to output px via outDim/srcDim.
  const mapToOutput = (srcCoord, srcDim, outDim) => srcCoord * (outDim / srcDim);

  const cases = [
    // [srcW, srcH, outW, outH, fracX, fracY]
    [1920, 1080, 1280, 720, 1, 1], // bottom-right, 1080p source -> 720p output
    [2560, 1440, 1920, 1080, 1, 1], // bottom-right, 1440p -> 1080p
    [1920, 1080, 1920, 1080, 0.5, 0.5], // centre, Original (no downscale)
    [1920, 1080, 1280, 720, 0, 0], // top-left, downscaled
  ];
  for (const [srcW, srcH, outW, outH, fx, fy] of cases) {
    const sx = mapToSource(fx, srcW);
    const sy = mapToSource(fy, srcH);
    const ox = mapToOutput(sx, srcW, outW);
    const oy = mapToOutput(sy, srcH, outH);
    // The composited point must land at the same fraction of the output frame as the pointer fraction.
    if (Math.abs(ox / outW - fx) > 1e-9 || Math.abs(oy / outH - fy) > 1e-9) {
      throw new Error(
        `annotate coord round-trip failed: frac(${fx},${fy}) src(${srcW}x${srcH}) out(${outW}x${outH}) ` +
        `-> composited frac(${ox / outW},${oy / outH})`
      );
    }
  }
  return true;
}
