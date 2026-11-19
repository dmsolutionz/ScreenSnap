// New projects. The editor is built around one base video (the preview plays it, the timeline measures
// it, the export walks its frames), so a project that starts from nothing starts from a generated blank:
// a solid / gradient frame encoded at 1 fps as a tiny H.264 MP4 (WebCodecs via Mediabunny — no ffmpeg,
// no WASM). Clips, images, text and audio then go on top as ordinary layers, and the export's frame
// clock holds each blank frame across its second, so the result is a normal 30 fps MP4.
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, getEncodableCodecs } from "../vendor/mediabunny.mjs";
import { resolveBg } from "./compositor.js";

export const FORMATS = [
  { id: "landscape", label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  { id: "portrait", label: "9:16 · 1080×1920", w: 1080, h: 1920 },
  { id: "square", label: "1:1 · 1080×1080", w: 1080, h: 1080 },
  { id: "feed", label: "4:5 · 1080×1350", w: 1080, h: 1350 },
  { id: "hd", label: "16:9 · 1280×720", w: 1280, h: 720 },
];
export const LENGTHS = [[15, "15 s"], [30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"], [600, "10 min"]];
export const BACKGROUNDS = [["black", "Black"], ["dark", "Dark"], ["white", "White"], ["grad-slate", "Slate"], ["grad-violet", "Violet"], ["grad-ocean", "Ocean"], ["grad-sunset", "Sunset"], ["grad-mint", "Mint"]];

const FPS = 1;
export const MAX_PROJECT_SEC = 60 * 60;

// Seconds of blank needed to hold `sec` of content: whole frames, at least one.
export function blankLength(sec) {
  const s = Math.min(MAX_PROJECT_SEC, Math.max(1, Number(sec) || 0));
  return Math.ceil(s * FPS - 1e-6) / FPS;
}

// Lay clips end to end from t=0. clips: [{ durationSec }] -> [{ inSec, outSec }] + total length.
export function sequenceClips(clips) {
  let at = 0;
  const ranges = clips.map((c) => {
    const r = { inSec: at, outSec: at + Math.max(0, c.durationSec || 0) };
    at = r.outSec;
    return r;
  });
  return { ranges, totalSec: at };
}

// { width, height, durationSec, bg } -> Blob('video/mp4')
export async function makeBlankVideo({ width, height, durationSec, bg = "black", onProgress }) {
  const codecs = await getEncodableCodecs();
  if (!codecs || !codecs.includes("avc")) throw new Error("This browser can't encode H.264 video, so a new project can't be created here. Try a recent Chrome.");
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = resolveBg(ctx, bg, width, height);
  ctx.fillRect(0, 0, width, height);

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  // Every frame a keyframe: seeking the preview anywhere lands exactly, and identical frames cost bytes.
  const src = new CanvasSource(canvas, { codec: "avc", bitrate: 400e3, keyFrameInterval: 0 });
  output.addVideoTrack(src);
  await output.start();
  const total = blankLength(durationSec);
  const n = Math.round(total * FPS);
  try {
    for (let i = 0; i < n; i++) {
      await src.add(i / FPS, 1 / FPS);
      if (onProgress && i % 10 === 0) onProgress(i / n);
    }
    await output.finalize();
  } catch (err) {
    try { await output.cancel(); } catch {}
    throw err;
  }
  return new Blob([output.target.buffer], { type: "video/mp4" });
}
