#!/usr/bin/env node
// Turns the rendered film frames + the final audio mix into the deliverables:
//
//   screensnap-launch-4k.mp4   the YouTube master: 3840x2160, 30 fps, H.264 High, CRF 12 (visually lossless; YouTube
//                              re-encodes anyway, so feed it the best source), closed GOP of 15 frames with 2 B-frames
//                              and bt709 colour tags as YouTube recommends, AAC-LC 384 kbps / 48 kHz, faststart.
//   captions.srt               copied alongside, for YouTube's subtitle upload (the captions are also burned in).
//   site/screensnap-demo.mp4   the website loop: the video-editor section only, 1280x720, muted, faded in and out.
//   site/screensnap-demo.gif   a small GIF fallback for the <video>.
//   site/poster.png            a still for the poster / og:image.
//
//   node scripts/media/encode-film.mjs --frames <dir with %06d.png> --audio mix.wav --captions captions.srt --out <dir>
import { mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
for (const k of ["frames", "audio", "out"]) if (!argv[k]) { console.error(`missing --${k}`); process.exit(2); }
const FPS = 30, OUT = argv.out, SITE = join(OUT, "site");
mkdirSync(SITE, { recursive: true });
// the PNG sequence as an input, starting at `startSec` (frame n is at n / FPS)
const seq = (startSec = 0) => ["-framerate", String(FPS), "-start_number", String(Math.round(startSec * FPS)), "-i", join(argv.frames, "%06d.png")];
const run = (label, args) => {
  const t0 = Date.now();
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) { console.error(`${label} failed`); process.exit(1); }
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};
const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + " MB";

// Chrome's frames are sRGB; tag the stream bt709 and convert the matrix explicitly so players agree on colour.
const toYuv = "scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p";
// ffmpeg doesn't always carry the primaries / transfer tags through the scale filter, so write all of the
// colour description (BT.709, limited range) straight into the H.264 VUI as well.
const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"];

// 1 ── the 4K master
const master = join(OUT, "screensnap-launch-4k.mp4");
run("4K master", [
  ...seq(), "-i", argv.audio, "-map", "0:v", "-map", "1:a",
  "-vf", toYuv, "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-profile:v", "high", "-level", "5.2",
  "-g", "15", "-bf", "2", "-x264-params", "open-gop=0", ...tags,
  "-c:a", "aac", "-b:a", "384k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", master,
]);
console.log("  ", master, mb(master));
if (argv.captions) copyFileSync(argv.captions, join(OUT, "captions.srt"));

// 2 ── the website loop: only the editor section (24.3 s → 53.6 s), muted, 720p
const A = 24.3, B = 53.6, DUR = B - A;
const demo = join(SITE, "screensnap-demo.mp4");
run("site demo", [
  ...seq(A), "-t", String(DUR), "-an",
  "-vf", `scale=1280:720:flags=lanczos,fade=t=in:st=0:d=0.4,fade=t=out:st=${DUR - 0.5}:d=0.5,format=yuv420p`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-profile:v", "high", "-movflags", "+faststart", ...tags, demo,
]);
console.log("  ", demo, mb(demo));

// 3 ── GIF fallback: small (it only shows in browsers that can't play the video), 8 fps, a shared palette
const gif = join(SITE, "screensnap-demo.gif");
run("site gif", [
  "-i", demo, "-t", "18",
  "-vf", "fps=8,scale=560:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=40:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
  "-loop", "0", gif,
]);
console.log("  ", gif, mb(gif));

// 4 ── poster: the crop box with its handles (after its key-cap has faded)
const poster = join(SITE, "poster.png");
run("poster", [...seq(42.0), "-frames:v", "1", "-vf", "scale=1280:720:flags=lanczos", poster]);
console.log("  ", poster, mb(poster));
