// Live preview. Playback is driven by a hidden <video> element fed the original recording blob — that
// gives native audio, perfect A/V sync, and native speed control for free. Each animation frame we
// composite the <video>'s current frame onto the stage canvas through the SAME compositor the export
// uses (base frame + overlay layers, scaled to the chosen output resolution), so what you see matches
// what you'll export. Mediabunny is used only for the export pipeline, not here.
import { drawComposite } from "./compositor.js";
import { composeDims, effectiveSrcRect, segmentsOf, outTimestamp } from "./transforms.js";

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// If ct sits inside a removed (cut) gap, return the next kept segment's start so playback can skip
// over it; null when ct is already inside a kept segment.
function nextSegmentStart(segs, ct) {
  for (const s of segs) if (ct >= s.in && ct < s.out) return null;
  let best = null;
  for (const s of segs) if (s.in > ct && (best == null || s.in < best)) best = s.in;
  return best;
}

// Snap a requested time into the kept (non-cut) range so a scrub can't rest the preview on a frame
// that won't exist in the export. In a kept segment → unchanged; in a gap → the nearest segment edge.
function snapToKept(segs, sec) {
  for (const s of segs) if (sec >= s.in && sec < s.out) return sec;
  let best = segs.length ? segs[0].in : 0;
  let bestD = Infinity;
  for (const s of segs) {
    for (const edge of [s.in, Math.max(s.in, s.out - 0.001)]) {
      const d = Math.abs(edge - sec);
      if (d < bestD) { bestD = d; best = edge; }
    }
  }
  return Math.max(0, best);
}

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

  // Adapter so the compositor can drawImage() the <video> exactly like a Mediabunny VideoSample —
  // forwards either the dest-only (dx,dy,dw,dh) or the source-rect (sx,sy,sw,sh,dx,dy,dw,dh) form.
  const baseFrame = { draw: (c, ...args) => { try { c.drawImage(video, ...args); } catch {} } };

  // Optional imported audio track (voiceover / music), played through a second hidden element and kept
  // in lockstep with the main video's OUTPUT-time position. No genlock between the two elements, so
  // minor drift is possible over long playback — corrected on export (pipeline.js mixes it precisely).
  let extraEl = null;      // hidden <audio> for the imported track, or null
  let extraUrl = null;

  function setExtraAudio(extraBlob) {
    if (extraUrl) { try { URL.revokeObjectURL(extraUrl); } catch {} extraUrl = null; }
    if (!extraBlob) {
      if (extraEl) { try { extraEl.pause(); } catch {} extraEl.removeAttribute("src"); try { extraEl.load(); } catch {} if (extraEl.parentNode) extraEl.parentNode.removeChild(extraEl); extraEl = null; }
      return;
    }
    if (!extraEl) {
      extraEl = document.createElement("audio");
      extraEl.preload = "auto";
      extraEl.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      (document.body || document.documentElement).appendChild(extraEl);
    }
    extraUrl = URL.createObjectURL(extraBlob);
    extraEl.src = extraUrl;
  }

  // Keep the imported track positioned/audible relative to the output timeline. outputPos is the main
  // video's current output-time; `active` is whether the preview is playing (paused → keep silent but
  // correctly positioned for the next play). Called from loop() and seekTo().
  function syncExtraAudio(outputPos, active) {
    const t = getTransforms ? getTransforms() : null;
    const ea = t && t.extraAudio;
    if (!extraEl || !ea) { if (extraEl) { try { extraEl.pause(); } catch {} } return; }
    const start = ea.offsetSec || 0;
    const end = start + Math.max(0, (ea.trimOut || 0) - (ea.trimIn || 0));
    const inWindow = outputPos >= start && outputPos < end;
    // "Mute all audio" (t.audio.muted) is a master mute and silences this track too.
    const masterMuted = !!(t.audio && t.audio.muted);
    const vol = ea.muted || masterMuted ? 0 : clamp01(typeof ea.volume === "number" ? ea.volume : 1);
    if (extraEl.volume !== vol) extraEl.volume = vol;
    const wantAt = (ea.trimIn || 0) + (outputPos - start);
    if (!active || !inWindow) {
      if (!extraEl.paused) { try { extraEl.pause(); } catch {} }
      if (!active && inWindow && Number.isFinite(wantAt)) { try { extraEl.currentTime = Math.max(0, wantAt); } catch {} }
      return;
    }
    if (extraEl.paused) {
      if (Number.isFinite(wantAt)) { try { extraEl.currentTime = Math.max(0, wantAt); } catch {} }
      extraEl.play().catch(() => {});
    } else if (Number.isFinite(wantAt) && Math.abs(extraEl.currentTime - wantAt) > 0.25) {
      // Already playing but out of position (scrub-while-playing, loop wrap) — re-seek. The 0.25s
      // threshold corrects discrete jumps without fighting normal frame-to-frame element drift.
      try { extraEl.currentTime = Math.max(0, wantAt); } catch {}
    }
  }

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
    // Live global mute/volume — mirrors the playbackRate sync in loop() below. Per-region mute (the
    // audio lane's mute bands) isn't reflected here: that would need a Web Audio graph on the <video>
    // element, deferred (see transforms.js / pipeline.js comments); the export applies it correctly.
    const a = t && t.audio;
    const gain = a ? (a.muted ? 0 : (typeof a.volume === "number" ? a.volume : 1)) : 1;
    if (video.volume !== gain) video.volume = gain;
    const cd = composeDims(t || {}, srcW || 2, srcH || 2);
    if (canvas.width !== cd.outW) canvas.width = cd.outW;
    if (canvas.height !== cd.outH) canvas.height = cd.outH;
    const layers = store && typeof store.visibleOrdered === "function" ? store.visibleOrdered() : [];
    const srcSec = video.currentTime || 0;
    const srcRect = t ? effectiveSrcRect(t, srcSec, srcW || 2, srcH || 2) : null;
    drawComposite(ctx, ready ? baseFrame : null, layers, { outW: cd.outW, outH: cd.outH, srcW, srcH, unit, blurCanvas: null, srcRect, timeSec: srcSec, dest: cd.dest, backdrop: cd.backdrop });
  }

  function loop() {
    if (!playing || destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    const segs = t ? segmentsOf(t) : [{ in: 0, out: durationSec }];
    const start = segs[0].in;
    const end = segs[segs.length - 1].out;
    const speed = t && t.speed ? t.speed : 1;
    if (video.playbackRate !== speed) video.playbackRate = speed; // live speed change
    const ct = video.currentTime;
    if (ct >= end - 0.02) {
      try { video.currentTime = start; } catch {} // loop within the kept range
    } else {
      const skip = nextSegmentStart(segs, ct); // jump over removed (cut) gaps
      if (skip != null && skip - ct > 0.001) { try { video.currentTime = skip; } catch {} }
    }
    composite();
    if (t) syncExtraAudio(outTimestamp(video.currentTime, t), true);
    if (onTime) { try { onTime(video.currentTime); } catch {} }
    raf = requestAnimationFrame(loop);
  }

  function seekTo(sec) {
    return readyP.then(() => {
      if (destroyed) return;
      const t = getTransforms ? getTransforms() : null;
      const target = t ? snapToKept(segmentsOf(t), Math.max(0, sec)) : Math.max(0, sec);
      return new Promise((resolve) => {
        const done = () => {
          composite();
          if (t) syncExtraAudio(outTimestamp(video.currentTime, t), playing);
          if (onTime) { try { onTime(video.currentTime); } catch {} }
          resolve();
        };
        video.addEventListener("seeked", done, { once: true });
        try { video.currentTime = target; } catch { video.removeEventListener("seeked", done); resolve(); }
      });
    });
  }

  async function play() {
    if (playing || destroyed) return;
    await readyP;
    if (destroyed) return;
    const t = getTransforms ? getTransforms() : null;
    if (t) {
      const segs = segmentsOf(t);
      const ct = video.currentTime;
      const inKept = segs.some((s) => ct >= s.in && ct < s.out);
      if (!inKept) video.currentTime = segs[0].in;
    }
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
    if (extraEl) { try { extraEl.pause(); } catch {} }
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
    setExtraAudio(null); // tear down the imported-audio element + revoke its URL
  }

  // Paint the first frame once metadata is in.
  readyP.then(() => { if (!destroyed) seekTo(0); });

  return {
    seekTo,
    play,
    pause,
    redraw,
    destroy,
    setExtraAudio,
    isPlaying: () => playing,
    currentTime: () => video.currentTime,
  };
}
