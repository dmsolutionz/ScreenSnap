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

// Backdrop background presets → a fillStyle (CanvasGradient for the gradients, color string for solids).
function lin(ctx, w, h, stops) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  stops.forEach((c, i) => g.addColorStop(stops.length > 1 ? i / (stops.length - 1) : 0, c));
  return g;
}
function resolveBg(ctx, key, w, h) {
  switch (key) {
    case "dark": return "#18181b";
    case "light": return "#f3f4f6";
    case "white": return "#ffffff";
    case "grad-ocean": return lin(ctx, w, h, ["#0ea5e9", "#2563eb"]);
    case "grad-sunset": return lin(ctx, w, h, ["#f59e0b", "#ef4444"]);
    case "grad-mint": return lin(ctx, w, h, ["#34d399", "#059669"]);
    case "grad-slate": return lin(ctx, w, h, ["#334155", "#0f172a"]);
    case "grad-violet":
    default: return lin(ctx, w, h, ["#7c3aed", "#db2777"]);
  }
}
function roundRectPath(ctx, d, r) {
  const rr = Math.max(0, Math.min(r, Math.min(d.w, d.h) / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(d.x, d.y, d.w, d.h, rr); return; }
  ctx.moveTo(d.x + rr, d.y);
  ctx.arcTo(d.x + d.w, d.y, d.x + d.w, d.y + d.h, rr);
  ctx.arcTo(d.x + d.w, d.y + d.h, d.x, d.y + d.h, rr);
  ctx.arcTo(d.x, d.y + d.h, d.x, d.y, rr);
  ctx.arcTo(d.x, d.y, d.x + d.w, d.y, rr);
  ctx.closePath();
}

// opts: { outW, outH, srcW, srcH, unit, blurCanvas|null, srcRect|null, timeSec, dest|null, backdrop|null }
//   srcRect {x,y,w,h} in source px = the region of the base frame to draw (crop + zoom). Defaults to
//     the full frame. Overlay layers (stored in source coords) map through srcRect → dest.
//   dest {x,y,w,h} in output px = where the content is drawn within the output canvas. Defaults to the
//     whole canvas. A backdrop makes dest a centered inset, leaving room for the padded background.
//   backdrop { bg, radius, shadow } = paint a background behind the content, clip it to a rounded card,
//     and cast a soft shadow. radius is a fraction of the content's smaller side.
//   timeSec = current SOURCE time, used for per-layer time ranges and animated GIF frames.
// baseSample is a Mediabunny VideoSample / preview adapter (has .draw(ctx, sx,sy,sw,sh, dx,dy,dw,dh))
// OR null. layers are in draw order.
export function drawComposite(ctx, baseSample, layers, opts) {
  const { outW, outH, srcW, srcH, unit, blurCanvas, srcRect, timeSec, dest, backdrop } = opts || {};
  const sr = srcRect && srcRect.w > 0 && srcRect.h > 0 ? srcRect : { x: 0, y: 0, w: srcW || outW, h: srcH || outH };
  const dst = dest && dest.w > 0 && dest.h > 0 ? dest : { x: 0, y: 0, w: outW, h: outH };
  ctx.clearRect(0, 0, outW, outH);

  // Backdrop: fill the background, cast the card's shadow, then clip everything that follows to the
  // rounded content card so the base frame + overlays sit inside it.
  let clipped = false;
  if (backdrop) {
    const radius = Math.max(0, (backdrop.radius || 0) * Math.min(dst.w, dst.h));
    ctx.fillStyle = resolveBg(ctx, backdrop.bg, outW, outH);
    ctx.fillRect(0, 0, outW, outH);
    if (backdrop.shadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.34)";
      ctx.shadowBlur = Math.max(8, outW * 0.02);
      ctx.shadowOffsetY = Math.max(4, outW * 0.01);
      ctx.fillStyle = "#000";
      roundRectPath(ctx, dst, radius);
      ctx.fill(); // hidden under the opaque content; only its shadow shows
      ctx.restore();
    }
    ctx.save();
    roundRectPath(ctx, dst, radius);
    ctx.clip();
    // Opaque matte inside the card so a base frame with baked-in transparency/letterbox shows black
    // (the conventional video matte) rather than leaking the shadow card behind it. No-op for the
    // usual opaque MP4 frame, which fully covers it.
    ctx.fillStyle = "#000";
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
    clipped = true;
  }

  // Draw the source sub-rect into the dest rect. With the default full-frame srcRect + full-output
  // dest and no backdrop, this is identical to the previous straight scale-to-output behavior.
  if (baseSample) baseSample.draw(ctx, sr.x, sr.y, sr.w, sr.h, dst.x, dst.y, dst.w, dst.h);

  if (layers && layers.length) {
    const scaleX = sr.w ? dst.w / sr.w : 1;
    const scaleY = sr.h ? dst.h / sr.h : 1;
    const offX = dst.x - sr.x * scaleX;
    const offY = dst.y - sr.y * scaleY;
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

  if (clipped) ctx.restore();
}
