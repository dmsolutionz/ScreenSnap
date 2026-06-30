// Composites one output frame: a source sub-rect of the base video frame (crop/zoom) scaled to the
// output canvas, plus annotation layers drawn on top. Image layers are drawn directly (and animated
// GIF layers pick the right frame for the current time); shape layers are drawn via shapes.js in
// source coordinates. Everything maps through the same source-rect transform so crop, zoom, and
// overlay positions all stay consistent between the live preview and the export.
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

// Pick the bitmap to draw for an image layer at a given time. Static layers return image.bitmap;
// animated GIF layers (image.frames = [{bitmap, delayMs}], image.totalMs) loop by elapsed time.
function layerBitmap(image, timeSec) {
  const frames = image && image.frames;
  if (!frames || !frames.length) return image ? image.bitmap : null;
  const total = image.totalMs || 0;
  if (total <= 0) return frames[0].bitmap;
  let ms = (timeSec * 1000) % total;
  if (ms < 0) ms += total;
  let acc = 0;
  for (const f of frames) {
    acc += f.delayMs;
    if (ms < acc) return f.bitmap;
  }
  return frames[frames.length - 1].bitmap;
}

// A layer with a time range (source seconds) only shows within it; range null = whole clip.
function inRange(layer, timeSec) {
  const r = layer && layer.range;
  if (!r) return true;
  return timeSec >= (r.inSec || 0) && timeSec < (r.outSec == null ? Infinity : r.outSec);
}

// opts: { outW, outH, srcW, srcH, unit, blurCanvas|null, srcRect|null, timeSec }
//   srcRect {x,y,w,h} in source px = the region of the base frame to draw across the whole output
//     (crop + zoom). Defaults to the full frame. Overlay layers (stored in source coords) are mapped
//     through this same rect so they track the crop/zoom.
//   timeSec = current SOURCE time, used for per-layer time ranges and animated GIF frames.
// baseSample is a Mediabunny VideoSample / preview adapter (has .draw(ctx, sx,sy,sw,sh, dx,dy,dw,dh))
// OR null. layers are in draw order.
export function drawComposite(ctx, baseSample, layers, opts) {
  const { outW, outH, srcW, srcH, unit, blurCanvas, srcRect, timeSec } = opts || {};
  const sr = srcRect && srcRect.w > 0 && srcRect.h > 0 ? srcRect : { x: 0, y: 0, w: srcW || outW, h: srcH || outH };
  ctx.clearRect(0, 0, outW, outH);

  if (baseSample) {
    // Draw only the source sub-rect, scaled to fill the output. With the default full-frame rect this
    // is identical to the previous straight scale-to-output behavior.
    baseSample.draw(ctx, sr.x, sr.y, sr.w, sr.h, 0, 0, outW, outH);
  }

  if (!layers || !layers.length) return;

  const scaleX = sr.w ? outW / sr.w : 1;
  const scaleY = sr.h ? outH / sr.h : 1;
  const offX = -sr.x * scaleX;
  const offY = -sr.y * scaleY;
  const ts = timeSec || 0;

  // The blur shape draws from a pre-blurred copy of the base frame (in source coords). If the caller
  // did not supply one and a visible blur shape exists, build a cheap per-frame fallback.
  let blur = blurCanvas || null;
  if (!blur) {
    const needsBlur = layers.some(
      (l) => l && l.visible !== false && l.kind === "shape" && l.shape && l.shape.type === "blur" && inRange(l, ts)
    );
    if (needsBlur) blur = buildBlurCanvas(baseSample, srcW || outW, srcH || outH);
  }

  for (const layer of layers) {
    if (!layer || layer.visible === false) continue;
    if (!inRange(layer, ts)) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity == null ? 1 : layer.opacity;
    if (layer.kind === "image" && layer.image) {
      const im = layer.image;
      const bmp = layerBitmap(im, ts);
      if (bmp) ctx.drawImage(bmp, im.x * scaleX + offX, im.y * scaleY + offY, im.w * scaleX, im.h * scaleY);
    } else if (layer.kind === "shape" && layer.shape) {
      ctx.translate(offX, offY);
      ctx.scale(scaleX, scaleY);
      drawShape(ctx, layer.shape, unit || 1, blur);
    }
    ctx.restore();
  }
}
