// Live preview: draws a single source frame onto the stage canvas via the compositor, so what you see
// matches what export produces. It decodes the base video frame on seek/play and re-composites the
// layers on top — layer edits redraw instantly off the cached frame, without re-decoding.
import { VideoSampleSink } from "../vendor/mediabunny.mjs";
import { drawComposite } from "./compositor.js";
import { outputDims } from "./transforms.js";

// { canvas, input, getTransforms, store }
export function createPreview({ canvas, input, getTransforms, store }) {
  const ctx = canvas.getContext("2d");
  let sink = null;
  let srcW = 0;
  let srcH = 0;
  let unit = 1;
  let durationSec = 0;
  let curSec = 0;
  let raf = 0;
  let playing = false;
  let lastWall = 0;
  let lastSample = null; // cached decoded VideoSample for instant re-composite on layer edits
  let destroyed = false;
  let unsubscribe = null;
  const ready = init();

  async function init() {
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack || destroyed) return;
    srcW = await vTrack.getDisplayWidth();
    srcH = await vTrack.getDisplayHeight();
    unit = Math.max(1, srcW / 900);
    durationSec = await vTrack.computeDuration();
    if (destroyed) return;
    sink = new VideoSampleSink(vTrack);
    // Layer edits (add/remove/move/opacity/visibility) re-composite instantly off the cached frame.
    if (store && typeof store.subscribe === "function") {
      unsubscribe = store.subscribe(() => composite());
    }
  }

  // Composite the cached base frame + current layers onto the (output-sized) canvas. No decode.
  function composite() {
    if (destroyed || !ctx) return;
    const t = getTransforms ? getTransforms() : null;
    const dims = outputDims(srcW || 2, srcH || 2, t ? t.outScale : null);
    if (canvas.width !== dims.w) canvas.width = dims.w;
    if (canvas.height !== dims.h) canvas.height = dims.h;
    const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];
    drawComposite(ctx, lastSample || null, layers, {
      outW: dims.w,
      outH: dims.h,
      srcW,
      srcH,
      unit,
      blurCanvas: null,
    });
  }

  // Decode the base frame nearest `sec`, cache it, then composite. Always closes the previous frame.
  async function decodeAndDraw(sec) {
    await ready;
    if (destroyed || !sink) return;
    let sample = null;
    try {
      sample = await sink.getSample(Math.max(0, sec));
    } catch {
      sample = null;
    }
    if (destroyed) {
      if (sample) sample.close();
      return;
    }
    if (lastSample && lastSample !== sample) lastSample.close();
    lastSample = sample;
    composite();
  }

  async function seekTo(sec) {
    curSec = sec;
    await decodeAndDraw(sec);
  }

  function loop() {
    if (!playing) return;
    const now = performance.now();
    const dt = (now - lastWall) / 1000;
    lastWall = now;
    const t = getTransforms ? getTransforms() : null;
    const start = t ? t.trimIn : 0;
    const end = t ? t.trimOut : durationSec;
    const speed = t && t.speed ? t.speed : 1;
    // Advance source time by real elapsed * playback speed, looping back to trimIn at trimOut.
    curSec += dt * speed;
    if (curSec >= end) curSec = start;
    decodeAndDraw(curSec);
    if (playing) raf = requestAnimationFrame(loop);
  }

  function play() {
    if (playing || destroyed) return;
    playing = true;
    lastWall = performance.now();
    const t = getTransforms ? getTransforms() : null;
    if (t && (curSec < t.trimIn || curSec >= t.trimOut)) curSec = t.trimIn;
    raf = requestAnimationFrame(loop);
  }

  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Re-composite the current frame from cache (instant) so layer/transform edits show immediately.
  // Falls back to a decode if no frame has been cached yet.
  function redraw() {
    if (lastSample) composite();
    else decodeAndDraw(curSec);
  }

  function destroy() {
    destroyed = true;
    pause();
    if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
    if (lastSample) { try { lastSample.close(); } catch {} lastSample = null; }
    sink = null;
  }

  return { seekTo, play, pause, redraw, destroy };
}
