// Live preview. Two ways to put a frame on the stage canvas:
//   • Playback streams frames through Mediabunny's `sink.samples(from, to)` async iterator, paced to
//     the wall clock (and frame-dropped when decoding falls behind) for smooth motion.
//   • Seeking / paused display uses `sink.getSample(sec)` for random access.
// A VideoSampleSink decodes ONE thing at a time, so ALL sink access is serialized through
// runExclusive(): every new operation bumps an op-token (cancelling whatever is running) and waits
// for it to release the sink before starting. This is what keeps playback from throwing.
import { VideoSampleSink } from "../vendor/mediabunny.mjs";
import { drawComposite } from "./compositor.js";
import { outputDims } from "./transforms.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// { canvas, input, getTransforms, store, onTime, onStop }
//   onTime(sec): fired after each drawn frame (drives the timeline playhead + transport readout)
//   onStop(err): fired if playback halts itself after repeated decode failures
export function createPreview({ canvas, input, getTransforms, store, onTime, onStop }) {
  const ctx = canvas.getContext("2d");
  let sink = null;
  let srcW = 0;
  let srcH = 0;
  let unit = 1;
  let durationSec = 0;
  let curSec = 0;
  let playing = false;
  let lastSample = null; // cached decoded frame for instant re-composite on layer edits
  let destroyed = false;
  let unsubscribe = null;

  // Single sink consumer at a time. Each call bumps opToken (cancelling the running op) and chains
  // after it on `active`, so the previous op fully releases the decoder before the next touches it.
  let opToken = 0;
  let active = Promise.resolve();
  function runExclusive(fn) {
    const token = ++opToken;
    const run = active.catch(() => {}).then(() => {
      if (token !== opToken || destroyed) return;
      return fn(token);
    });
    active = run.catch(() => {});
    return run;
  }

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
  // Defensive: a stale frame (e.g. mid-restart) must not throw out of a store-change handler.
  function composite() {
    if (destroyed || !ctx) return;
    const t = getTransforms ? getTransforms() : null;
    const dims = outputDims(srcW || 2, srcH || 2, t ? t.outScale : null);
    if (canvas.width !== dims.w) canvas.width = dims.w;
    if (canvas.height !== dims.h) canvas.height = dims.h;
    const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];
    try {
      drawComposite(ctx, lastSample || null, layers, { outW: dims.w, outH: dims.h, srcW, srcH, unit, blurCanvas: null });
    } catch {}
  }

  // Random-access decode of a single frame (seek / paused display). Caches it for later re-composite.
  async function decodeOne(sec, token) {
    await ready;
    if (!sink || destroyed || token !== opToken) return;
    let sample = null;
    try {
      sample = await sink.getSample(Math.max(0, sec));
    } catch {
      return;
    }
    if (destroyed || token !== opToken) { if (sample) sample.close(); return; }
    if (lastSample && lastSample !== sample) lastSample.close();
    lastSample = sample;
    curSec = sec;
    composite();
    if (onTime) { try { onTime(sec); } catch {} }
  }

  // Stream frames through the samples() iterator, paced to the wall clock. Loops back to trimIn at
  // trimOut. Breaking the for-await closes the iterator (releasing the decoder) before we return.
  async function playLoop(token) {
    await ready;
    if (!sink || destroyed) return;
    let errStreak = 0;

    while (playing && token === opToken && !destroyed) {
      const t = getTransforms ? getTransforms() : null;
      const start = t ? t.trimIn : 0;
      const end = t ? t.trimOut : durationSec;
      const speed = t && t.speed ? t.speed : 1;
      let from = Math.max(start, Math.min(curSec, end));
      if (from >= end) from = start;
      const srcStart = from;
      const wallStart = performance.now();
      let drew = false;

      try {
        for await (const sample of sink.samples(from, end)) {
          if (!playing || token !== opToken || destroyed) { sample.close(); break; }
          const ts = sample.timestamp;
          if (ts > end + 1e-3) { sample.close(); break; }
          // Where this frame should appear on the wall clock, given playback speed.
          const delay = wallStart + ((ts - srcStart) / speed) * 1000 - performance.now();
          if (delay < -150) { curSec = ts; sample.close(); continue; } // far behind — drop to catch up
          if (delay > 0) await sleep(delay);
          if (!playing || token !== opToken || destroyed) { sample.close(); break; }
          if (lastSample && lastSample !== sample) lastSample.close();
          lastSample = sample;
          curSec = ts;
          composite();
          if (onTime) { try { onTime(ts); } catch {} }
          drew = true;
          errStreak = 0;
        }
      } catch (err) {
        if (++errStreak > 5) {
          stopPlayback();
          if (onStop) { try { onStop(err); } catch {} }
          return;
        }
        await sleep(80);
      }

      if (!playing || token !== opToken || destroyed) return;
      curSec = start; // reached trimOut — loop
      if (!drew) await sleep(80); // nothing decoded in range; avoid a hot spin
    }
  }

  function seekTo(sec) {
    curSec = Math.max(0, sec);
    if (playing) runExclusive((token) => playLoop(token)); // re-anchor playback at the new position
    else runExclusive((token) => decodeOne(curSec, token));
  }

  function play() {
    if (playing || destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    if (t && (curSec < t.trimIn || curSec >= t.trimOut)) curSec = t.trimIn;
    playing = true;
    runExclusive((token) => playLoop(token));
  }

  function stopPlayback() { playing = false; opToken++; } // bump cancels any running loop

  function pause() {
    if (!playing) return;
    stopPlayback();
    // Re-cache a stable standalone frame at the current spot so paused redraws don't lean on a frame
    // owned by the (now closed) playback iterator.
    runExclusive((token) => decodeOne(curSec, token));
  }

  function redraw() {
    if (lastSample) composite();
    else runExclusive((token) => decodeOne(curSec, token));
  }

  function destroy() {
    destroyed = true;
    playing = false;
    opToken++;
    if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
    if (lastSample) { try { lastSample.close(); } catch {} lastSample = null; }
  }

  return {
    seekTo,
    play,
    pause,
    redraw,
    destroy,
    isPlaying: () => playing,
    currentTime: () => curSec,
  };
}
