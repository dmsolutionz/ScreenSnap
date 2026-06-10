// Live preview. Playback is driven by a hidden <video> element fed the original recording blob — that
// gives native audio, perfect A/V sync, and native speed control for free. Each animation frame we
// composite the <video>'s current frame onto the stage canvas through the SAME compositor the export
// uses (base frame + overlay layers, scaled to the chosen output resolution), so what you see matches
// what you'll export. Mediabunny is used only for the export pipeline, not here.
import { drawComposite } from "./compositor.js";
import { outputDims } from "./transforms.js";

// { canvas, blob, getTransforms, store, onTime, onStop }
//   onTime(sec): fired each drawn frame (drives the timeline playhead + transport readout)
//   onStop(err): fired if the video can't be loaded/played
export function createPreview({ canvas, blob, getTransforms, store, onTime, onStop }) {
  const ctx = canvas.getContext("2d");
  let srcW = 0, srcH = 0, unit = 1, durationSec = 0;
  let raf = 0, playing = false, destroyed = false, ready = false;
  let unsubscribe = null;

  // Hidden <video> that owns decode + audio. Kept in the DOM (off-screen) so frames are always
  // available to drawImage even before first paint.
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const url = URL.createObjectURL(blob);
  video.src = url;
  (document.body || document.documentElement).appendChild(video);

  // Adapter so the compositor can drawImage() the <video> exactly like a Mediabunny VideoSample.
  const baseFrame = { draw: (c, x, y, w, h) => { try { c.drawImage(video, x, y, w, h); } catch {} } };

  const readyP = new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => {
      srcW = video.videoWidth || 2;
      srcH = video.videoHeight || 2;
      unit = Math.max(1, srcW / 900);
      durationSec = video.duration || 0;
      ready = true;
      resolve();
    }, { once: true });
  });
  video.addEventListener("error", () => {
    if (onStop) { try { onStop(new Error("Couldn’t load this video for preview.")); } catch {} }
  });
  // Safety net for looping when playback runs all the way to the real end.
  video.addEventListener("ended", () => {
    if (!playing || destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    try { video.currentTime = t ? t.trimIn : 0; video.play().catch(() => {}); } catch {}
  });

  if (store && typeof store.subscribe === "function") unsubscribe = store.subscribe(() => composite());

  // Composite the <video>'s current frame + visible layers onto the output-sized canvas.
  function composite() {
    if (destroyed || !ctx) return;
    const t = getTransforms ? getTransforms() : null;
    const dims = outputDims(srcW || 2, srcH || 2, t ? t.outScale : null);
    if (canvas.width !== dims.w) canvas.width = dims.w;
    if (canvas.height !== dims.h) canvas.height = dims.h;
    const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];
    drawComposite(ctx, ready ? baseFrame : null, layers, { outW: dims.w, outH: dims.h, srcW, srcH, unit, blurCanvas: null });
  }

  function loop() {
    if (!playing || destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    const start = t ? t.trimIn : 0;
    const end = t ? t.trimOut : durationSec;
    const speed = t && t.speed ? t.speed : 1;
    if (video.playbackRate !== speed) video.playbackRate = speed; // live speed change
    if (video.currentTime >= end - 0.02) { try { video.currentTime = start; } catch {} } // loop within trim
    composite();
    if (onTime) { try { onTime(video.currentTime); } catch {} }
    raf = requestAnimationFrame(loop);
  }

  function seekTo(sec) {
    return readyP.then(() => {
      if (destroyed) return;
      return new Promise((resolve) => {
        const done = () => { composite(); if (onTime) { try { onTime(video.currentTime); } catch {} } resolve(); };
        video.addEventListener("seeked", done, { once: true });
        try { video.currentTime = Math.max(0, sec); } catch { video.removeEventListener("seeked", done); resolve(); }
      });
    });
  }

  async function play() {
    if (playing || destroyed) return;
    await readyP;
    if (destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    if (t && (video.currentTime < t.trimIn || video.currentTime >= t.trimOut)) video.currentTime = t.trimIn;
    video.playbackRate = t && t.speed ? t.speed : 1;
    playing = true;
    try {
      await video.play();
    } catch (err) {
      playing = false;
      if (onStop) { try { onStop(err); } catch {} }
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { video.pause(); } catch {}
  }

  // Re-composite the current frame (instant) so layer/transform edits show immediately while paused.
  function redraw() { composite(); }

  function destroy() {
    destroyed = true;
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
    try { video.pause(); } catch {}
    video.removeAttribute("src");
    try { video.load(); } catch {}
    if (video.parentNode) video.parentNode.removeChild(video);
    URL.revokeObjectURL(url);
  }

  // Paint the first frame once metadata is in.
  readyP.then(() => { if (!destroyed) seekTo(0); });

  return {
    seekTo,
    play,
    pause,
    redraw,
    destroy,
    isPlaying: () => playing,
    currentTime: () => video.currentTime,
  };
}
