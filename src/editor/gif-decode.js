// Animated-GIF decode for the overlay layer: turns a GIF into ready-to-draw frames + per-frame
// delays so the compositor can pick the right frame for any playback time. Browser-native via the
// WebCodecs ImageDecoder API — no WASM, no ffmpeg, no deps. Each frame is flattened onto a persistent
// canvas (handling GIF disposal/transparency) and snapshotted to an ImageBitmap, so callers just draw.
// If ImageDecoder is missing or decode fails, decodeGif throws — the caller falls back to a static image.

const DEFAULT_DELAY_MS = 100; // browsers clamp 0-delay GIF frames to ~100ms; match that.

// Accept Blob, ArrayBuffer, or Uint8Array; return a Uint8Array view of the bytes.
async function toBytes(input) {
  if (!input) throw new Error("decodeGif: no input");
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    // Uint8Array (or any typed-array/DataView view) — re-wrap the exact byte range.
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error("decodeGif: unsupported input type");
}

// Decode a GIF blob/arraybuffer/uint8array into frames. Uses WebCodecs ImageDecoder.
// Returns: { width, height, totalMs, frames: Array<{ bitmap: ImageBitmap, delayMs: number }> }
export async function decodeGif(input) {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("decodeGif: ImageDecoder (WebCodecs) unavailable");
  }

  const data = await toBytes(input);
  const decoder = new ImageDecoder({ data, type: "image/gif" });

  try {
    // Wait until track metadata (frameCount) is known.
    if (decoder.tracks && decoder.tracks.ready) await decoder.tracks.ready;
    if (decoder.completed) await decoder.completed;

    const track = decoder.tracks && decoder.tracks.selectedTrack;
    const frameCount = (track && track.frameCount) || 0;
    if (frameCount <= 0) throw new Error("decodeGif: GIF reported no frames");

    // Persistent accumulation canvas: we draw each decoded frame over the previous result so disposal /
    // transparency resolve correctly, then snapshot a complete image. Sized lazily from the first frame.
    let canvas = null;
    let ctx = null;
    let width = 0;
    let height = 0;
    const frames = [];

    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      try {
        if (!canvas) {
          width = image.displayWidth || image.codedWidth || 0;
          height = image.displayHeight || image.codedHeight || 0;
          if (width <= 0 || height <= 0) throw new Error("decodeGif: zero-sized frame");
          canvas = new OffscreenCanvas(width, height);
          ctx = canvas.getContext("2d", { willReadFrequently: false });
          if (!ctx) throw new Error("decodeGif: no 2D context");
        }
        // Draw over the running accumulation (do NOT clear): for typical GIFs this yields each frame
        // fully composited, and it's robust to partial/restore-to-previous frames.
        ctx.drawImage(image, 0, 0, width, height);

        // VideoFrame.duration is microseconds and may be null/0; clamp to the browser's 0-delay default.
        const durUs = image.duration;
        const delayMs = durUs && durUs > 0 ? durUs / 1000 : DEFAULT_DELAY_MS;

        const bitmap = await createImageBitmap(canvas);
        frames.push({ bitmap, delayMs });
      } finally {
        image.close();
      }
    }

    const totalMs = frames.reduce((sum, f) => sum + f.delayMs, 0);
    return { width, height, totalMs, frames };
  } finally {
    decoder.close();
  }
}

// Given a decode result and an elapsed time in milliseconds, return the looping frame index to show.
// Pure. Guards: empty frames -> 0; totalMs <= 0 -> 0.
export function frameIndexAt(decoded, elapsedMs) {
  const frames = decoded && decoded.frames;
  if (!frames || frames.length === 0) return 0;
  const total = (decoded && decoded.totalMs) || 0;
  if (total <= 0) return 0;

  // Wrap into the loop period (guard against negative/NaN elapsed), then walk delays to find the frame.
  let t = Number.isFinite(elapsedMs) ? elapsedMs % total : 0;
  if (t < 0) t += total;
  for (let i = 0; i < frames.length; i++) {
    t -= frames[i].delayMs;
    if (t < 0) return i;
  }
  return frames.length - 1; // float rounding fallthrough — show the last frame.
}

// Free all decoded ImageBitmaps so the GC can reclaim their backing memory. Safe to call on a
// half-built or null result; idempotent enough that double-close is harmless.
export function closeDecoded(decoded) {
  const frames = decoded && decoded.frames;
  if (!frames) return;
  for (const f of frames) {
    if (f && f.bitmap && typeof f.bitmap.close === "function") {
      try {
        f.bitmap.close();
      } catch {
        // ignore — already closed / not closeable.
      }
    }
  }
}
