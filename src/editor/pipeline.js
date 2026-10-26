// The transcode core: decode source frames with Mediabunny, composite each kept frame onto an
// output-sized canvas, encode to H.264, and mux to MP4. Audio is carried straight through (decode ->
// re-encode AAC) only when transforms.audioEnabled(t). This module is FOUNDATION-OWNED and final: it
// drives everything through transforms.* and compositor.drawComposite, so feature work enriches those
// without ever touching the loop here.
import {
  Input, ALL_FORMATS, BlobSource, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, getEncodableCodecs,
} from "../vendor/mediabunny.mjs";
import { composeDims, keepFrame, outTimestamp, outDuration, audioEnabled, effectiveSrcRect, videoBitrateFor, audioGainFor, segmentsOf, sourceVideoBitrate, capToSource } from "./transforms.js";
import { drawComposite } from "./compositor.js";
import { outputFrames } from "./frame-clock.js";
import { openClipFrames } from "./clip-layers.js";

// Scale an AudioBuffer's samples in place by g (0..1) — used by the streaming (no-mix) audio path.
function applyGain(buffer, g) {
  if (g === 1) return;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
}

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

// Packs decoded slices into a few large contiguous AudioBuffers (about CHUNKS_PER_TRACK per track,
// each 10–120s of output) and schedules ONE source node per chunk. An OfflineAudioContext touches every
// scheduled node on every 128-frame render quantum, so cost is nodes × duration: the old
// one-node-per-~21ms-packet scheme made a 4-min mix render for ~6 min (~30 for 7), and even fixed-size
// chunks still grow with the clip — sizing them to the clip keeps the node count ~constant. Each slice
// is written at its exact output sample position (ripple-cut joins stay sample-exact, gaps silent),
// with its gain baked into the copied samples; a zero-gain (muted) slice simply copies nothing.
const CHUNKS_PER_TRACK = 8;
function makeChunker(ctx, totalOut) {
  const chunkSec = Math.min(120, Math.max(10, totalOut / CHUNKS_PER_TRACK));
  let cur = null; // { startOut, sr, ch, cap, used, data: Float32Array[] }
  const flush = () => {
    const c = cur;
    cur = null;
    if (!c || !c.used) return;
    const buf = ctx.createBuffer(c.ch, c.used, c.sr);
    for (let k = 0; k < c.ch; k++) buf.copyToChannel(c.data[k].subarray(0, c.used), k);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.start(Math.max(0, c.startOut));
  };
  // Copy `durSec` of `buffer` starting `fromSec` into it, landing at output time `outSec`.
  const add = (buffer, fromSec, durSec, outSec, gain) => {
    if (!(gain > 0) || !(durSec > 0) || outSec >= totalOut) return;
    const sr = buffer.sampleRate, ch = buffer.numberOfChannels;
    const off = Math.max(0, Math.round(fromSec * sr));
    const len = Math.min(buffer.length - off, Math.round(durSec * sr));
    if (len <= 0) return;
    let p = cur ? Math.round((outSec - cur.startOut) * sr) : -1;
    if (cur && p < 0 && p >= -4) p = 0; // timestamp rounding jitter at a chunk's start
    if (!cur || cur.sr !== sr || cur.ch !== ch || p < 0 || p + len > cur.cap) {
      flush();
      const cap = Math.max(len, Math.ceil(chunkSec * sr));
      cur = { startOut: outSec, sr, ch, cap, used: 0, data: Array.from({ length: ch }, () => new Float32Array(cap)) };
      p = 0;
    }
    for (let k = 0; k < ch; k++) {
      const src = buffer.getChannelData(k).subarray(off, off + len);
      const dst = cur.data[k];
      if (gain === 1) dst.set(src, p);
      else for (let i = 0; i < len; i++) dst[p + i] = src[i] * gain;
    }
    cur.used = Math.max(cur.used, p + len);
  };
  return { add, flush };
}

// Mix the (trimmed / mute-masked) main audio and the imported track into ONE AudioBuffer via an
// OfflineAudioContext (standard Web Audio — no ffmpeg, no WASM; it also resamples a track whose rate
// differs from the mix rate). Each kept slice of each source buffer lands at its true OUTPUT-time
// position, trimmed to its kept-segment intersection, so ripple-cut joins are sample-exact with no
// overlap or gap. Anything past the context's fixed length renders as nothing.
// NOTE: this renders the full output as one PCM buffer (~11MB/min stereo 48k) and holds the decoded
// sources (packed into chunks) until rendering, so it's only used when an imported track actually
// needs mixing — the plain path streams (see transcode below).
// clipAudio: [{ track, layer }] — the audio of imported video clip layers, placed where each clip sits.
// -> AudioBuffer, or null if there was genuinely nothing to render.
async function mixAudio({ transforms, aTrack, wantMainAudio, extraTrack, extraAudio, clipAudio = [], totalOut, signal }) {
  // Size the context to the RICHEST of the two sources (mono up-mixes losslessly into stereo, lower
  // rates resample up) so imported stereo music isn't downmixed just because the mic track is mono.
  const mainFmt = wantMainAudio ? await firstBufferFormat(aTrack, transforms.trimIn) : null;
  const extraFmt = extraTrack ? await firstBufferFormat(extraTrack, extraAudio ? extraAudio.trimIn : 0) : null;
  const fmts = [mainFmt, extraFmt];
  for (const c of clipAudio) fmts.push(await firstBufferFormat(c.track, c.layer.video.srcIn || 0));
  const fmt = {
    sampleRate: Math.max(0, ...fmts.map((f) => (f ? f.sampleRate : 0))) || 48000,
    channels: Math.max(0, ...fmts.map((f) => (f ? f.channels : 0))) || 2,
  };
  const length = Math.max(1, Math.ceil(totalOut * fmt.sampleRate));
  const ctx = new OfflineAudioContext(Math.max(1, fmt.channels), length, fmt.sampleRate);

  if (wantMainAudio) {
    const chunks = makeChunker(ctx, totalOut);
    const sink = new AudioBufferSink(aTrack);
    const baseGain = audioGainFor(transforms); // global volume; global mute already excluded upstream
    const segs = segmentsOf(transforms);
    for await (const { buffer, timestamp } of sink.buffers(transforms.trimIn, transforms.trimOut)) {
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      // Schedule each buffer's intersection with each kept segment, so a buffer straddling a cut
      // contributes exactly its kept part — no doubled audio or click at the join.
      const bufEnd = timestamp + buffer.duration;
      for (const s of segs) {
        const from = Math.max(timestamp, s.in);
        const to = Math.min(bufEnd, s.out);
        if (to - from <= 1e-6) continue;
        const audible = transforms.audio ? keepFrame(from, transforms.audio) : true; // mute mask
        chunks.add(buffer, from - timestamp, to - from, outTimestamp(from, transforms), audible ? baseGain : 0);
      }
    }
    chunks.flush();
  }

  if (extraTrack && extraAudio) {
    const sink = new AudioBufferSink(extraTrack);
    const gain = extraAudio.muted ? 0 : (typeof extraAudio.volume === "number" ? extraAudio.volume : 1);
    if (gain > 0) {
      const chunks = makeChunker(ctx, totalOut);
      for await (const { buffer, timestamp } of sink.buffers(extraAudio.trimIn, extraAudio.trimOut)) {
        if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
        // Trim boundary buffers to the [trimIn, trimOut] window, mapped so the window's start lands
        // at offsetSec on the output timeline.
        const bufEnd = timestamp + buffer.duration;
        const from = Math.max(timestamp, extraAudio.trimIn);
        const to = Math.min(bufEnd, extraAudio.trimOut);
        if (to - from <= 1e-6) continue;
        chunks.add(buffer, from - timestamp, to - from, extraAudio.offsetSec + (from - extraAudio.trimIn), gain);
      }
      chunks.flush();
    }
  }

  // Clip audio: a clip's frame at clip time c plays at main source time range.inSec + (c - srcIn), so each
  // buffer maps onto the main timeline, is clipped to the clip's range and the kept (uncut) segments, and
  // lands at that point's output time — a ripple cut removes the clip's audio along with its picture.
  const segs = segmentsOf(transforms);
  for (const { track, layer } of clipAudio) {
    const v = layer.video, r = layer.range;
    const srcIn = v.srcIn || 0;
    const chunks = makeChunker(ctx, totalOut);
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers(srcIn, srcIn + (r.outSec - r.inSec))) {
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const m = r.inSec + (timestamp - srcIn);
      const mEnd = m + buffer.duration;
      for (const s of segs) {
        const from = Math.max(m, s.in, r.inSec);
        const to = Math.min(mEnd, s.out, r.outSec);
        if (to - from <= 1e-6) continue;
        chunks.add(buffer, from - m, to - from, outTimestamp(from, transforms), v.volume);
      }
    }
    chunks.flush();
  }

  return ctx.startRendering();
}

// input: a Mediabunny Input (from source.toInput). transforms: see transforms.js. store: layer store
// (compositor reads visibleOrdered()). onProgress(0..1). signal: optional AbortSignal. extraAudioInput:
// an optional second Mediabunny Input for an imported audio track (mixed in per transforms.extraAudio).
// sourceBytes: the source file's size, used to cap the export bitrate at the source's own (see below).
// -> Blob('video/mp4')
export async function transcode({ input, transforms, store, onProgress, signal, extraAudioInput, sourceBytes }) {
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

  const aTrack = await input.getPrimaryAudioTrack();

  // Video bitrate: the bpp-derived target for the output size, capped at the source clip's own average
  // video bitrate so an edit never makes the file bigger than the recording (scaled down with the
  // output's content pixels — crop / downscale — and up with speed). Backdrop padding is ignored: it's
  // static and nearly free to encode.
  const srcDur = sourceBytes > 0 ? await vTrack.computeDuration() : 0;
  const srcVideoBps = sourceVideoBitrate(sourceBytes, srcDur, !!aTrack);
  const bitrate = capToSource(videoBitrateFor(outW, outH), srcVideoBps, (dest.w * dest.h) / Math.max(1, srcW * srcH), transforms.speed || 1);

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vSrc = new CanvasSource(canvas, { codec: "avc", bitrate });
  output.addVideoTrack(vSrc, { frameRate: 30 });

  // Audio: the main track is carried when the transform allows it (1x speed in v1) and it isn't
  // globally muted; an imported track (transforms.extraAudio) is mixed in independently of the main
  // one. "Mute all audio" is a master mute covering both. An output audio track is added only when
  // something actually audible contributes — a muted/zero-volume/out-of-range source never forces a
  // silent AAC track into the file.
  const masterMuted = !!(transforms.audio && transforms.audio.muted);
  const wantMainAudio = !!aTrack && audioEnabled(transforms) && !masterMuted && audioGainFor(transforms) > 0;
  const ea = transforms.extraAudio;
  let extraTrack = null;
  if (extraAudioInput && ea) {
    try { extraTrack = await extraAudioInput.getPrimaryAudioTrack(); } catch { extraTrack = null; }
  }
  const extraAudible = !!extraTrack && !masterMuted && !ea.muted &&
    (typeof ea.volume !== "number" || ea.volume > 0) && (ea.offsetSec || 0) < totalOut;
  // Imported clip layers' own audio follows the same rule as the recording's (needs 1x speed, honours the
  // master mute); a muted / silent / audio-less clip contributes nothing.
  const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];
  const clipAudio = [];
  if (audioEnabled(transforms) && !masterMuted) {
    for (const l of layers) {
      if (l.kind !== "video" || !l.video || !l.video.hasAudio || l.video.muted || !(l.video.volume > 0) || !l.range) continue;
      try {
        const track = await new Input({ formats: ALL_FORMATS, source: new BlobSource(l.video.blob) }).getPrimaryAudioTrack();
        if (track) clipAudio.push({ track, layer: l });
      } catch { /* an unreadable clip track just stays silent */ }
    }
  }
  const hasAnyAudioSource = wantMainAudio || extraAudible || clipAudio.length > 0;
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

  const clipFrames = await openClipFrames(layers);

  try {
    // outputFrames() holds a frame across static (variable-frame-rate) stretches so time-ranged
    // overlays / zoom render there too, and owns every decoded sample's close() — including when an
    // add() below throws (the old inline close() was skipped on that path, leaking the frame).
    for await (const f of outputFrames({ vSink, transforms, totalOut, signal })) {
      const srcRect = effectiveSrcRect(transforms, f.srcSec, srcW, srcH);
      const clips = await clipFrames.framesAt(f.srcSec);
      drawComposite(ctx, f.sample, layers, { outW, outH, srcW, srcH, unit, blurCanvas: null, srcRect, timeSec: f.srcSec, dest, backdrop, clips });
      await vSrc.add(Math.max(0, f.outTs), Math.max(1 / 1000, f.dur));
      report(f.outTs / totalOut);
    }

    if (hasAnyAudioSource) {
      if (extraAudible || clipAudio.length) {
        // Several sources → mix offline into one buffer, then hand it to the encoder in a single add()
        // (AudioBufferSource.add() auto-chunks an arbitrarily large buffer internally).
        const mixed = await mixAudio({
          transforms, aTrack, wantMainAudio, extraTrack: extraAudible ? extraTrack : null, extraAudio: ea, clipAudio, totalOut, signal,
        });
        if (mixed) await aSrc.add(mixed);
      } else {
        // Main audio only → stream buffer-by-buffer (bounded memory on arbitrarily long recordings):
        // feed kept buffers in order, applying the mute mask / volume in place. AudioBufferSource
        // auto-sequences timestamps by accumulated duration, so kept buffers concatenate.
        const aSink = new AudioBufferSink(aTrack);
        const gain = audioGainFor(transforms);
        for await (const { buffer, timestamp } of aSink.buffers(transforms.trimIn, transforms.trimOut)) {
          if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
          if (!keepFrame(timestamp, transforms)) continue; // video's ripple gate
          const audible = transforms.audio ? keepFrame(timestamp, transforms.audio) : true; // mute mask
          applyGain(buffer, audible ? gain : 0);
          await aSrc.add(buffer);
        }
      }
    }

    await output.finalize();
    report(1);
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } catch (err) {
    try { await output.cancel(); } catch {}
    throw err;
  } finally {
    await clipFrames.close();
  }
}
