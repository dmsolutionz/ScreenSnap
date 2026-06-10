// Composites one output frame: the base video frame (scaled to the output canvas) plus annotation
// layers drawn on top. Image layers are drawn directly; shape layers are drawn via shapes.js in
// source coordinates, scaled to the output the same way the base frame is.
import { drawShape } from "./shapes.js";

// Reusable scratch canvases for the cheap blur fallback (downscale → upscale gives a soft blur
// without WASM or canvas filters that some offscreen contexts disallow). The blur canvas is sized in
// SOURCE coords because drawShape places blur regions in source coords (under ctx.scale below).
let _blurFull = null;
let _blurSmall = null;
function buildBlurCanvas(baseSample, srcW, srcH) {
  const w = Math.max(2, Math.round(srcW));
  const h = Math.max(2, Math.round(srcH));
  const dw = Math.max(2, Math.round(w / 8));
  const dh = Math.max(2, Math.round(h / 8));

  const full = _blurFull || (_blurFull = document.createElement("canvas"));
  full.width = w;
  full.height = h;
  const fctx = full.getContext("2d");
  fctx.clearRect(0, 0, w, h);

  if (baseSample) {
    const small = _blurSmall || (_blurSmall = document.createElement("canvas"));
    small.width = dw;
    small.height = dh;
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    baseSample.draw(sctx, 0, 0, dw, dh);
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "low";
    fctx.drawImage(small, 0, 0, dw, dh, 0, 0, w, h);
  }
  return full;
}

// opts: { outW, outH, srcW, srcH, unit, blurCanvas|null }
// baseSample is a Mediabunny VideoSample (has .draw(ctx, x, y[, w, h])) OR null. layers are in draw order.
export function drawComposite(ctx, baseSample, layers, opts) {
  const { outW, outH, srcW, srcH, unit, blurCanvas } = opts || {};
  ctx.clearRect(0, 0, outW, outH);

  if (baseSample) {
    // VideoSample.draw(ctx, dx, dy, dWidth, dHeight) scales the frame straight to the output size.
    baseSample.draw(ctx, 0, 0, outW, outH);
  }

  if (!layers || !layers.length) return;

  const scaleX = srcW ? outW / srcW : 1;
  const scaleY = srcH ? outH / srcH : 1;

  // The blur shape draws from a pre-blurred copy of the base frame (in source coords). If the caller
  // did not supply one and a visible blur shape exists, build a cheap per-frame fallback.
  let blur = blurCanvas || null;
  if (!blur) {
    const needsBlur = layers.some(
      (l) => l && l.visible !== false && l.kind === "shape" && l.shape && l.shape.type === "blur"
    );
    if (needsBlur) blur = buildBlurCanvas(baseSample, srcW || outW, srcH || outH);
  }

  for (const layer of layers) {
    if (!layer || layer.visible === false) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity == null ? 1 : layer.opacity;
    if (layer.kind === "image" && layer.image && layer.image.bitmap) {
      const im = layer.image;
      ctx.drawImage(im.bitmap, im.x * scaleX, im.y * scaleY, im.w * scaleX, im.h * scaleY);
    } else if (layer.kind === "shape" && layer.shape) {
      ctx.scale(scaleX, scaleY);
      drawShape(ctx, layer.shape, unit || 1, blur);
    }
    ctx.restore();
  }
}
