// Audio for the demo footage: macOS `say` narration (one clip per sentence, placed on a 24 s timeline so it
// lines up with the visuals and stays silent through the dead stretch), a very quiet pink-noise room tone
// and a few soft UI clicks at the cursor-click times. Everything is built with ffmpeg (no npm deps).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/opt/homebrew/bin/ffprobe";
const VOICE = "Samantha", RATE = 185;           // calm, natural en-US voice at ~185 wpm
const TARGET_LUFS = -20, NOISE_RMS_DB = -52, CLICK_PEAK_DB = -24;
const SR = 48000;

/* Where each sentence starts (s). They are chosen to land on the matching visual beat, and the
   six before the dead stretch all end by ~14.7 s, so 15.0-17.4 is truly silent. */
export const NARRATION = [
  { id: "intro",   start: 0.80,  text: "Here's how Pulse performed last quarter." },
  { id: "revenue", start: 3.15,  text: "Revenue is up forty percent." },
  { id: "peak",    start: 5.05,  text: "The peak came in week eleven, over forty-one thousand dollars." },
  { id: "regions", start: 8.85,  text: "Most growth comes from North America and Europe." },
  { id: "orders",  start: 11.55, text: "Here are the latest orders." },
  { id: "export",  start: 13.05, text: "Now let's export the report." },
  // 15.0 - 17.4: dead stretch, no narration
  { id: "done",    start: 18.25, text: "Done. The report is ready to share." },
];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const ff = (args) => run(FFMPEG, ["-v", "error", "-y", ...args]);
const duration = (file) => parseFloat(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));
/** ffmpeg prints filter summaries (ebur128, volumedetect) on stderr, so run it and hand back that text. */
const ffLog = (args) => spawnSync(FFMPEG, ["-hide_banner", "-nostats", ...args], { encoding: "utf8" }).stderr;

/** Integrated loudness / true peak of a file, via ffmpeg's ebur128 filter. */
export function loudness(file) {
  const txt = ffLog(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const tail = txt.slice(txt.lastIndexOf("Summary:"));
  const num = (re) => parseFloat((tail.match(re) || [])[1]);
  return {
    integratedLUFS: num(/I:\s+(-?[\d.]+) LUFS/), loudnessRangeLU: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDBTP: num(/Peak:\s+(-?[\d.]+) dBFS/), summary: tail.trim(),
  };
}
const meanVolume = (file, filter = "") => {
  const txt = ffLog(["-i", file, "-af", (filter ? filter + "," : "") + "volumedetect", "-f", "null", "-"]);
  return parseFloat((txt.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1]);
};

/**
 * Build <dir>/narration.wav (voice only) and <dir>/mix.wav (voice + room tone + clicks), both exactly
 * `seconds` long, 48 kHz stereo. Returns the placed sentences (start/end measured) and loudness figures.
 */
export function buildAudio({ dir, seconds = 24, clicks = [], deadStart = 15, deadEnd = 17.4 }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // 1) one clip per sentence, leading/trailing silence trimmed so `start` is when the voice really begins
  const placed = NARRATION.map((s, i) => {
    const aiff = join(dir, `s${i + 1}.aiff`), wav = join(dir, `s${i + 1}.wav`);
    run("say", ["-v", VOICE, "-r", String(RATE), "-o", aiff, s.text]);
    const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01";
    ff(["-i", aiff, "-af", `${trim},areverse,${trim},areverse,afade=t=in:d=0.01,areverse,afade=t=in:d=0.04,areverse`, "-ar", String(SR), "-ac", "1", wav]);
    const dur = duration(wav);
    return { ...s, wav, duration: dur, end: s.start + dur };
  });
  for (const p of placed) {
    if (p.end > seconds - 1.4) throw new Error(`narration "${p.id}" ends at ${p.end.toFixed(2)} s (must finish by ~22.5 s)`);
    if (p.start < deadEnd && p.end > deadStart) throw new Error(`narration "${p.id}" (${p.start.toFixed(2)}-${p.end.toFixed(2)}) overlaps the dead stretch`);
  }
  for (let i = 1; i < placed.length; i++) if (placed[i].start < placed[i - 1].end + 0.1) throw new Error(`narration "${placed[i].id}" starts too soon after "${placed[i - 1].id}"`);

  // 2) lay the sentences on the timeline (mono -> stereo), then level them to the loudness target
  const inputs = placed.flatMap((p) => ["-i", p.wav]);
  const delays = placed.map((p, i) => `[${i}]adelay=${Math.round(p.start * 1000)}:all=1[d${i}]`).join(";");
  const mixIn = placed.map((_, i) => `[d${i}]`).join("");
  const raw = join(dir, "narration-raw.wav");
  ff([...inputs, "-filter_complex", `${delays};${mixIn}amix=inputs=${placed.length}:normalize=0:duration=longest,apad=whole_dur=${seconds},atrim=0:${seconds},pan=stereo|c0=c0|c1=c0`, "-ar", String(SR), raw]);
  const gain = TARGET_LUFS - loudness(raw).integratedLUFS;
  const narration = join(dir, "narration.wav");
  // alimiter is only a safety net; speech at -20 LUFS peaks far below it
  ff(["-i", raw, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=disabled`, "-ar", String(SR), narration]);

  // 3) room tone: two independent pink-noise channels at about -52 dB RMS, band-limited like a real mic/system path
  const noiseRaw = join(dir, "noise-raw.wav"), noise = join(dir, "noise.wav");
  ff(["-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:r=${SR}:a=0.5:seed=11`, "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:r=${SR}:a=0.5:seed=23`,
    "-filter_complex", "[0][1]amerge=inputs=2,highpass=f=35,lowpass=f=9000", noiseRaw]);
  ff(["-i", noiseRaw, "-af", `volume=${(NOISE_RMS_DB - meanVolume(noiseRaw)).toFixed(2)}dB`, noise]);

  // 4) soft UI click: a 3 ms noise transient plus a short damped tone, one per cursor click
  const click = join(dir, "click.wav");
  const a = Math.pow(10, CLICK_PEAK_DB / 20).toFixed(5);
  ff(["-f", "lavfi", "-i", `aevalsrc='${a}*(0.55*sin(2*PI*2100*t)+0.45*(random(0)*2-1))*exp(-t*420)':d=0.07:s=${SR}`,
    "-af", "lowpass=f=7000,highpass=f=300,aformat=channel_layouts=stereo", click]);
  const clickIns = clicks.flatMap(() => ["-i", click]);
  const clickDelays = clicks.map((c, i) => `[${i + 3}]adelay=${Math.round(c.t * 1000)}:all=1,apad=whole_dur=${seconds}[k${i}]`).join(";");
  const clickMix = clicks.map((_, i) => `[k${i}]`).join("");
  const mix = join(dir, "mix.wav");
  ff(["-i", narration, "-i", noise, "-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=stereo:d=${seconds}`, ...clickIns, "-filter_complex",
    `${clickDelays};[0][1][2]${clickMix}amix=inputs=${3 + clicks.length}:normalize=0:duration=longest,atrim=0:${seconds},asetpts=N/SR/TB`, "-ar", String(SR), "-ac", "2", mix]);

  return {
    sentences: placed.map(({ id, text, start, end }) => ({ id, text, start: +start.toFixed(3), end: +end.toFixed(3) })),
    files: { narration, mix },
    voice: `${VOICE} (macOS say, ${RATE} wpm)`,
    narrationLoudness: loudness(narration),
    mixLoudness: loudness(mix),
    deadStretchRmsDb: { mix: meanVolume(mix, `atrim=${deadStart}:${deadEnd}`), narration: meanVolume(narration, `atrim=${deadStart}:${deadEnd}`) },
    roomToneRmsDb: meanVolume(noise),
  };
}
