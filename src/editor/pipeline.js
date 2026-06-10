// The transcode core: decode source frames with Mediabunny, composite each kept frame onto an
// output-sized canvas, encode to H.264, and mux to MP4. Audio is carried straight through (decode ->
// re-encode AAC) only when transforms.audioEnabled(t). This module is FOUNDATION-OWNED and final: it
// drives everything through transforms.* and compositor.drawComposite, so feature work enriches those
// without ever touching the loop here.
import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, getEncodableCodecs,
} from "../vendor/mediabunny.mjs";
import { outputDims, keepFrame, outTimestamp, outFrameDuration, outDuration, audioEnabled } from "./transforms.js";
import { drawComposite } from "./compositor.js";

// input: a Mediabunny Input (from source.toInput). transforms: see transforms.js. store: layer store
// (compositor reads visibleOrdered()). onProgress(0..1). signal: optional AbortSignal.
// -> Blob('video/mp4')
export async function transcode({ input, transforms, store, onProgress, signal }) {
  const codecs = await getEncodableCodecs();
  if (!codecs || !codecs.includes("avc")) {
    throw new Error("This browser can't encode H.264 (AVC) video, so MP4 export isn't available here. Try a recent Chrome.");
  }

  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error("No video track found in this clip.");

  const srcW = await vTrack.getDisplayWidth();
  const srcH = await vTrack.getDisplayHeight();
  const { w: outW, h: outH } = outputDims(srcW, srcH, transforms.outScale);

  const totalOut = Math.max(0.0001, outDuration(transforms));

  // Output canvas: feature builds (annotations) draw layers onto this via the compositor.
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(outW, outH)
    : Object.assign(document.createElement("canvas"), { width: outW, height: outH });
  const ctx = canvas.getContext("2d");
  const unit = Math.max(1, srcW / 900);

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vSrc = new CanvasSource(canvas, { codec: "avc", bitrate: 8e6 });
  output.addVideoTrack(vSrc, { frameRate: 30 });

  // Audio: only carried when the transform allows it (1x speed in v1). Re-encode to AAC via
  // AudioBufferSink -> AudioBufferSource.
  const aTrack = await input.getPrimaryAudioTrack();
  const wantAudio = !!aTrack && audioEnabled(transforms);
  let aSrc = null;
  if (wantAudio) {
    aSrc = new AudioBufferSource({ codec: "aac", bitrate: 192e3 });
    output.addAudioTrack(aSrc);
  }

  await output.start();

  const vSink = new VideoSampleSink(vTrack);
  let lastReported = -1;
  const report = (frac) => {
    if (typeof onProgress !== "function") return;
    const clamped = Math.max(0, Math.min(1, frac));
    if (clamped - lastReported >= 0.01 || clamped >= 1) { lastReported = clamped; onProgress(clamped); }
  };

  const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];

  try {
    for await (const sample of vSink.samples(transforms.trimIn, transforms.trimOut)) {
      if (signal && signal.aborted) { sample.close(); throw new DOMException("Export cancelled", "AbortError"); }
      const srcSec = sample.timestamp;
      if (keepFrame(srcSec, transforms)) {
        drawComposite(ctx, sample, layers, { outW, outH, srcW, srcH, unit, blurCanvas: null });
        const ts = outTimestamp(srcSec, transforms);
        const dur = outFrameDuration(sample.duration || 1 / 30, transforms);
        await vSrc.add(Math.max(0, ts), Math.max(1 / 1000, dur));
        report(ts / totalOut);
      }
      sample.close(); // REQUIRED: release the frame to avoid decoder backpressure / leaks
    }

    if (wantAudio) {
      const aSink = new AudioBufferSink(aTrack);
      // AudioBufferSource auto-sequences timestamps from 0 by accumulated buffer duration, so we feed
      // buffers in order (skipping any that start before the trim-in boundary) and the first kept
      // buffer lands at output time 0 — aligned with the trimmed video.
      for await (const { buffer, timestamp } of aSink.buffers(transforms.trimIn, transforms.trimOut)) {
        if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        if (timestamp < transforms.trimIn) continue;
        await aSrc.add(buffer);
      }
    }

    await output.finalize();
    report(1);
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } catch (err) {
    try { await output.cancel(); } catch {}
    throw err;
  }
}
