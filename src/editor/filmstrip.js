// Filmstrip: a row of small, evenly spaced frames the timeline tiles across the Video clip (so the clip reads
// as picture, not as a flat bar). Frames come from a second hidden <video> on the same blob, seeked across the
// clip in one forward pass — the very decode path the live preview plays through, so it works wherever the
// preview does — and each frame is published as it lands, so the strip fills in left to right while the
// editor is already usable. Failure just leaves the clip plain.

const THUMB_H = 96;        // decoded frame height (px): 2x the strip's 48px so it stays sharp on retina
const SEEK_TIMEOUT = 4000; // ms to wait for one frame before moving on

// { blob, durationSec, onUpdate() } -> { items: (canvas|null)[], aspect(), destroy() }
//   items[i] is the frame nearest the middle of slot i of `count` equal slots across the clip.
export function createFilmstrip({ blob, durationSec, onUpdate }) {
  const count = Math.max(12, Math.min(80, Math.round(durationSec / 1.5)));
  const items = new Array(count).fill(null);
  let aspect = 16 / 9;
  let dead = false;

  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  video.src = url;
  (document.body || document.documentElement).appendChild(video);

  const when = (evt) => new Promise((resolve, reject) => {
    video.addEventListener(evt, resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("video error")), { once: true });
  });
  const seek = (t) => new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.001) return resolve();
    const timer = setTimeout(resolve, SEEK_TIMEOUT);
    video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    video.currentTime = t;
  });
  const cleanup = () => {
    video.removeAttribute("src");
    try { video.load(); } catch {}
    video.remove();
    URL.revokeObjectURL(url);
  };

  (async () => {
    await when("loadeddata");
    if (video.videoWidth > 0 && video.videoHeight > 0) aspect = video.videoWidth / video.videoHeight;
    const w = Math.max(2, Math.round(THUMB_H * aspect));
    const last = Math.max(0, (video.duration || durationSec) - 0.05); // the audio can outlast the picture
    for (let i = 0; i < count && !dead; i++) {
      await seek(Math.min(((i + 0.5) / count) * durationSec, last));
      if (dead) break;
      const c = document.createElement("canvas");
      c.width = w; c.height = THUMB_H;
      c.getContext("2d").drawImage(video, 0, 0, w, THUMB_H);
      items[i] = c;
      if (i % 3 === 2 && onUpdate) onUpdate();
    }
    if (!dead && onUpdate) onUpdate();
  })().catch((err) => console.warn("[screensnap] filmstrip failed:", err)).finally(cleanup);

  return { items, aspect: () => aspect, destroy() { dead = true; } };
}
