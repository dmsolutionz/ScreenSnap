#!/usr/bin/env node
// Voiceover for the launch film, spoken by FilmCraft's natural (Kokoro-82M) voices through its CLI — FilmCraft
// (github.com/storytold/filmcraft) built with the engine's `neural-voices` feature; its voice package is a
// pinned, SHA-256-checked download (`filmcraft-cli exec tts.downloadVoices wait=true`). See README.md.
//
// The narration is ONE continuous take, not a string of clips: every line is first rendered on its own just to
// measure it, then the whole script is synthesised once with FilmCraft's exact `[pause …]` markers between lines,
// so each line starts on its cue and there are no clip edges, level jumps or breaths at the joins. A line that
// would run into the next one pushes the rest a little later (reported). The take is levelled with one static
// gain (no dynamic loudness processing, which pumps on short phrases), warmed slightly and given a hint of room.
//
//   node scripts/media/narrate.mjs --voice-script voice.json --filmcraft path/to/filmcraft-cli --out DIR
//        [--voice kokoro-heart] [--pace 0.95] [--measure]   (--measure: only the per-line durations, for capture-editor --speech)
// voice.json: [{ t, text, until }] (render-film.mjs --captions). Writes DIR/vo.wav + DIR/vo-cues.json:
// { track, lines: [{ t, dur, text }] } — t is where the line really starts in the take.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "1" : all[i + 1]]] : a), []));
for (const k of ["voice-script", "filmcraft", "out"]) if (!argv[k]) { console.error(`missing --${k}`); process.exit(2); }
const OUT = resolve(argv.out), VOICE = argv.voice || "kokoro-heart", PACE = Number(argv.pace || 0.95);
mkdirSync(join(OUT, "lines"), { recursive: true });

// How the words should sound (captions are written to be read).
const spoken = (text) => text
  .replace(/\*/g, "")
  .replace(/screensnap/gi, "screen snap")
  .replace(/playhead/gi, "play head")
  .replace(/\b16:9\b/g, "sixteen by nine")
  .replace(/\bMP4\b/g, "M P 4")
  .replace(/\bGIF\b/g, "gif")
  .replace(/…/g, ",");

function tts(text, path) {
  const r = spawnSync(argv.filmcraft, ["exec", "tts.preview", JSON.stringify({ text, voice: VOICE, pace: PACE, path, wait: true })], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`filmcraft tts.preview failed:\n${(r.stderr || r.stdout).slice(0, 500)}`);
  const o = JSON.parse(r.stdout);
  return o.seconds ?? o.result?.seconds;
}
const ff = (args) => spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8" });

// 1 ── measure every line (cached by its words + voice + pace)
const script = JSON.parse(readFileSync(argv["voice-script"], "utf8"));
const lines = script.map((l) => {
  const say = spoken(l.text);
  const key = createHash("sha1").update(`${VOICE}|${PACE}|${say}`).digest("hex").slice(0, 12);
  const file = join(OUT, "lines", `${key}.wav`), meta = file + ".json";
  const dur = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).dur : tts(say, file);
  writeFileSync(meta, JSON.stringify({ dur }));
  return { ...l, say, dur };
});
if (argv.measure) {
  writeFileSync(join(OUT, "vo-cues.json"), JSON.stringify({ track: null, lines: lines.map(({ t, dur, text }) => ({ t, dur, text })) }, null, 1));
  console.log(`measured ${lines.length} lines → ${OUT}/vo-cues.json`);
  process.exit(0);
}

// 2 ── one continuous take: [pause] markers place each line on its cue. Spoken in one pass, lines run a little
// longer than measured alone, and the error adds up, so the take is rendered, measured and corrected until every
// line starts within ~0.1 s of its cue (Kokoro is deterministic, so a corrected pause moves only what follows it).
let cursor = 0;
const planned = lines.map((l) => {
  const start = Math.max(l.t, cursor + 0.3);
  if (start - l.t > 0.05) console.warn(`  ! "${l.text}" starts ${(start - l.t).toFixed(2)} s late (the line before runs long)`);
  cursor = start + l.dur;
  return { ...l, start };
});
const pauses = planned.map((l, i) => l.start - (i ? planned[i - 1].start + planned[i - 1].dur : 0));
const raw = join(OUT, "take-raw.wav");
// The pause markers are exact digital silence; speech never is. So the line starts are the ends of silences.
const onsetsOf = (file) => [...ff(["-i", file, "-af", "silencedetect=noise=-80dB:d=0.25", "-f", "null", "-"]).stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
let actual = [], took = 0;
for (let pass = 1; pass <= 5; pass++) {
  const text = planned.map((l, i) => {
    let marks = "";
    for (let gap = Math.round(Math.max(0.05, pauses[i]) * 1000); gap > 0; gap -= 10000) marks += `[pause ${Math.min(gap, 10000)}ms] `;
    return marks + l.say;
  }).join(" ");
  took = tts(text, raw);
  // match onsets to lines by following the running drift (a long pause inside a line adds an extra silence)
  const ons = onsetsOf(raw);
  let drift = 0, last = -1;
  actual = planned.map((l) => {
    const want = l.start + drift;
    const o = ons.filter((x) => x > last + 0.2 && Math.abs(x - want) < 2.5).sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0];
    if (o == null) return want;
    last = o; drift = o - l.start;
    return o;
  });
  const err = actual.map((t, i) => t - planned[i].start);
  const worst = Math.max(...err.map(Math.abs));
  console.log(`  pass ${pass}: ${took.toFixed(1)} s take, worst line ${worst.toFixed(2)} s off its cue`);
  if (worst < 0.1) break;
  for (let i = pauses.length - 1; i >= 0; i--) pauses[i] -= err[i] - (i ? err[i - 1] : 0);
}
const placed = planned.map((l, i) => ({ t: Math.round(actual[i] * 1000) / 1000, dur: l.dur, text: l.text }));
const worst = Math.max(...placed.map((p, i) => Math.abs(p.t - planned[i].start)));

// 4 ── level with one static gain to -18 LUFS, a touch of warmth and room, 48 kHz stereo
const I = Number((ff(["-i", raw, "-af", "ebur128", "-f", "null", "-"]).stderr.match(/I:\s+(-?[\d.]+) LUFS/g) || ["I: -24 LUFS"]).pop().match(/-?[\d.]+/)[0]);
const chain = [
  `volume=${(-18 - I).toFixed(2)}dB`,
  "highpass=f=70",
  "equalizer=f=200:t=q:w=1.0:g=1.5",   // a little body
  "equalizer=f=7000:t=q:w=1.5:g=-1.5", // soften the synthetic sheen
  "aecho=0.92:0.6:23|37:0.05|0.035",   // a hint of room, so it isn't bone-dry
  "aresample=48000",
  "afade=t=in:d=0.01",
].join(",");
const track = join(OUT, "vo.wav");
if (ff(["-i", raw, "-af", chain, "-ac", "2", "-c:a", "pcm_s24le", track]).status !== 0) throw new Error("ffmpeg could not level the take");
writeFileSync(join(OUT, "vo-cues.json"), JSON.stringify({ track, lines: placed }, null, 1));
console.log(`${lines.length} lines · one ${took.toFixed(1)} s take at ${PACE}x · cue drift ≤ ${worst.toFixed(2)} s · ${I.toFixed(1)} → -18 LUFS → ${track}`);
process.exit(0);
