// The transcode core: decode source frames with Mediabunny, composite each kept frame onto an
// output-sized canvas, encode to H.264, and mux to MP4. Audio is carried straight through (decode ->
// re-encode AAC) only when transforms.audioEnabled(t). This module is FOUNDATION-OWNED and final: it
// drives everything through transforms.* and compositor.drawComposite, so feature work enriches those
// without ever touching the loop here.
import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, getEncodableCodecs,
} from "../vendor/mediabunny.mjs";
import { composeDims, keepFrame, outTimestamp, outFrameDuration, outDuration, audioEnabled, effectiveSrcRect, videoBitrateFor, audioGainFor } from "./transforms.js";
import { drawComposite } from "./compositor.js";

// Read the sample rate / channel count of a track's first decoded buffer (used to size the mixing
// OfflineAudioContext). Returns null if the track can't be read.
async function firstBufferFormat(track, startSec) {
  try {
    const sink = new AudioBufferSink(track);
    const b = await sink.getBuffer(Math.max(0, startSec || 0));
    if (b && b.buffer) return { sampleRate: b.buffer.sampleRate, channels: b.buffer.numberOfChannels };
  } catch { /* fall through to null */ }
  return null;
}

// Mix the (trimmed / mute-masked) main audio and an optional imported track into ONE AudioBuffer via
// an OfflineAudioContext (a standard Web Audio API — no ffmpeg, no WASM, no new dependency). Each source
// buffer is scheduled at its true OUTPUT-time position through its own GainNode, and the context sums
// them; anything scheduled past the context's fixed length renders as nothing (natural truncation).
// -> AudioBuffer, or null if there was genuinely nothing to render.
async function mixAudio({ transforms, aTrack, wantMainAudio, extraTrack, extraAudio, totalOut, signal }) {
  const fmt =
    (wantMainAudio ? await firstBufferFormat(aTrack, transforms.trimIn) : null) ||
    (extraTrack ? await firstBufferFormat(extraTrack, extraAudio ? extraAudio.trimIn : 0) : null) ||
    { sampleRate: 48000, channels: 2 };
  const length = Math.max(1, Math.ceil(totalOut * fmt.sampleRate));
  const ctx = new OfflineAudioContext(Math.max(1, fmt.channels), length, fmt.sampleRate);

  const schedule = (buffer, outSec, gain) => {
    if (!(gain > 0) || outSec >= totalOut) return;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    node.connect(g).connect(ctx.destination);
    node.start(Math.max(0, outSec));
  };

  if (wantMainAudio) {
    const sink = new AudioBufferSink(aTrack);
    const baseGain = audioGainFor(transforms); // global volume; global mute already excluded upstream
    for await (const { buffer, timestamp } of sink.buffers(transforms.trimIn, transforms.trimOut)) {
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (!keepFrame(timestamp, transforms)) continue; // video's own ripple gate — unchanged
      const audible = transforms.audio ? keepFrame(timestamp, transforms.audio) : true; // mute mask
      schedule(buffer, outTimestamp(timestamp, transforms), audible ? baseGain : 0);
    }
  }

  if (extraTrack && extraAudio) {
    const sink = new AudioBufferSink(extraTrack);
    const gain = extraAudio.muted ? 0 : (typeof extraAudio.volume === "number" ? extraAudio.volume : 1);
    if (gain > 0) {
      for await (const { buffer, timestamp } of sink.buffers(extraAudio.trimIn, extraAudio.trimOut)) {
        if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        // Map the file's own time to the OUTPUT timeline: its trimmed start lands at offsetSec.
        schedule(buffer, extraAudio.offsetSec + (timestamp - extraAudio.trimIn), gain);
      }
    }
  }

  return ctx.startRendering();
}

// input: a Mediabunny Input (from source.toInput). transforms: see transforms.js. store: layer store
// (compositor reads visibleOrdered()). onProgress(0..1). signal: optional AbortSignal. extraAudioInput:
// an optional second Mediabunny Input for an imported audio track (mixed in per transforms.extraAudio).
// -> Blob('video/mp4')
export async function transcode({ input, transforms, store, onProgress, signal, extraAudioInput }) {
  const codecs = await getEncodableCodecs();
  if (!codecs || !codecs.includes("avc")) {
    throw new Error("This browser can't encode H.264 (AVC) video, so MP4 export isn't available here. Try a recent Chrome.");
  }

  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error("No video track found in this clip.");

  const srcW = await vTrack.getDisplayWidth();
  const srcH = await vTrack.getDisplayHeight();
  const { outW, outH, dest, backdrop } = composeDims(transforms, srcW, srcH);

  const totalOut = Math.max(0.0001, outDuration(transforms));

  // Output canvas: feature builds (annotations) draw layers onto this via the compositor.
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(outW, outH)
    : Object.assign(document.createElement("canvas"), { width: outW, height: outH });
  const ctx = canvas.getContext("2d");
  const unit = Math.max(1, srcW / 900);

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vSrc = new CanvasSource(canvas, { codec: "avc", bitrate: videoBitrateFor(outW, outH) });
  output.addVideoTrack(vSrc, { frameRate: 30 });

  // Audio: the main track is carried when the transform allows it (1x speed in v1) and it isn't
  // globally muted; an imported track (transforms.extraAudio) is mixed in independently of the main
  // one. We add an output audio track whenever EITHER contributes — split from "does main audio play"
  // so an imported voiceover works even on a recording that has no audio of its own.
  const aTrack = await input.getPrimaryAudioTrack();
  const wantMainAudio = !!aTrack && audioEnabled(transforms) && !(transforms.audio && transforms.audio.muted);
  let extraTrack = null;
  if (extraAudioInput && transforms.extraAudio) {
    try { extraTrack = await extraAudioInput.getPrimaryAudioTrack(); } catch { extraTrack = null; }
  }
  const hasAnyAudioSource = wantMainAudio || !!extraTrack;
  let aSrc = null;
  if (hasAnyAudioSource) {
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
        const srcRect = effectiveSrcRect(transforms, srcSec, srcW, srcH);
        drawComposite(ctx, sample, layers, { outW, outH, srcW, srcH, unit, blurCanvas: null, srcRect, timeSec: srcSec, dest, backdrop });
        const ts = outTimestamp(srcSec, transforms);
        const dur = outFrameDuration(sample.duration || 1 / 30, transforms);
        await vSrc.add(Math.max(0, ts), Math.max(1 / 1000, dur));
        report(ts / totalOut);
      }
      sample.close(); // REQUIRED: release the frame to avoid decoder backpressure / leaks
    }

    if (hasAnyAudioSource) {
      // Mix everything into one buffer offline, then hand it to the encoder in a single add() —
      // AudioBufferSource.add() auto-chunks an arbitrarily large buffer internally, so one call is fine.
      const mixed = await mixAudio({
        transforms, aTrack, wantMainAudio, extraTrack,
        extraAudio: transforms.extraAudio, totalOut, signal,
      });
      if (mixed) await aSrc.add(mixed);
    }

    await output.finalize();
    report(1);
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } catch (err) {
    try { await output.cancel(); } catch {}
    throw err;
  }
}
