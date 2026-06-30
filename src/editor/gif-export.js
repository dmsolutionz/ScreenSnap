// GIF export: decode the clip with Mediabunny, composite each captured frame through the SAME
// compositor the MP4 path uses (so crop/zoom/trim/cuts/overlays all apply identically), sample down to
// a GIF-friendly frame rate + size, and hand the RGBA frames to the from-scratch encoder. No ffmpeg,
// no WASM. GIF is inherently low-fps / low-res, so we cap both and the caller surfaces the options.
import { VideoSampleSink } from "../vendor/mediabunny.mjs";
import { composeDims, keepFrame, outTimestamp, outDuration, effectiveSrcRect } from "./transforms.js";
import { drawComposite } from "./compositor.js";
import { encodeGif } from "./gif-encode.js";

// Keep the captured-frame count bounded so memory stays sane (each frame is a full RGBA buffer); if
// fps × duration would exceed this, the effective fps is lowered to fit while preserving duration.
const MAX_FRAMES = 300;

// { input, transforms, store, fps?=12, maxHeight?=480, onProgress, signal } -> Blob('image/gif')
export async function transcodeGif({ input, transforms, store, fps = 12, maxHeight = 480, onProgress, signal }) {
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error("No video track found in this clip.");

  const srcW = await vTrack.getDisplayWidth();
  const srcH = await vTrack.getDisplayHeight();

  // GIF dimensions: honor crop, clamp height to maxHeight (never upscale), and include the backdrop
  // padding. We feed the maxHeight clamp through composeDims as outScale so crop + backdrop compose.
  const scale = { maxHeight: Math.min(maxHeight, transforms.crop ? transforms.crop.h : srcH) };
  const { outW, outH, dest, backdrop } = composeDims({ ...transforms, outScale: scale }, srcW, srcH);

  const total = Math.max(0.0001, outDuration(transforms));
  // Drop fps if needed so we never blow past MAX_FRAMES.
  let effFps = Math.max(1, fps);
  if (total * effFps > MAX_FRAMES) effFps = Math.max(1, MAX_FRAMES / total);
  const frameStep = 1 / effFps;

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(outW, outH)
    : Object.assign(document.createElement("canvas"), { width: outW, height: outH });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const unit = Math.max(1, srcW / 900);
  const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];

  const frames = [];
  let nextCapture = 0;
  const vSink = new VideoSampleSink(vTrack);

  const lo = transforms.trimIn || 0;
  const hi = transforms.trimOut == null ? await vTrack.computeDuration() : transforms.trimOut;
  for await (const sample of vSink.samples(lo, hi)) {
    if (signal && signal.aborted) { sample.close(); throw new DOMException("Export cancelled", "AbortError"); }
    const srcSec = sample.timestamp;
    if (keepFrame(srcSec, transforms)) {
      const outT = outTimestamp(srcSec, transforms);
      if (outT + 1e-6 >= nextCapture) {
        const srcRect = effectiveSrcRect(transforms, srcSec, srcW, srcH);
        drawComposite(ctx, sample, layers, { outW, outH, srcW, srcH, unit, blurCanvas: null, srcRect, timeSec: srcSec, dest, backdrop });
        const img = ctx.getImageData(0, 0, outW, outH);
        frames.push({ data: img.data, outT });
        do { nextCapture += frameStep; } while (nextCapture <= outT);
        if (onProgress) onProgress(Math.min(0.6, (outT / total) * 0.6));
      }
    }
    sample.close(); // release the decoded frame
  }

  if (!frames.length) throw new Error("Nothing to export — the trim/cut range is empty.");

  // Each frame is shown until the NEXT captured frame's output time, so a frame that "covers" several
  // skipped capture slots (sparse source frames) holds proportionally longer — keeping the GIF's total
  // duration equal to the output duration instead of speeding through gaps. The last frame holds for a
  // nominal step (or out to the total duration, whichever is longer).
  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i].outT;
    const next = i + 1 < frames.length ? frames[i + 1].outT : Math.max(cur + frameStep, total);
    frames[i].delayMs = Math.max(20, Math.round(1000 * (next - cur)));
  }

  return encodeGif(frames, {
    width: outW,
    height: outH,
    signal,
    onProgress: (f) => { if (onProgress) onProgress(0.6 + 0.4 * f); },
  });
}
