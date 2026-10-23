#!/usr/bin/env node
// Voiceover for the launch film, spoken by FilmCraft's natural (Kokoro-82M) voices through its CLI — FilmCraft
// (github.com/storytold/filmcraft) built with the engine's `neural-voices` feature; its voice package is a
// pinned, SHA-256-checked download (`filmcraft-cli exec tts.downloadVoices wait=true`).
//
// Reads voice.json (render-film.mjs --captions: each line's text, start time and the time the next line starts),
// renders every line to a WAV, and if a line would run into the next one re-renders it a little faster (never
// beyond 1.25x — it warns instead). Each line is levelled to -18 LUFS at 48 kHz stereo. Writes <out>/vo-NN.wav and
// <out>/vo-cues.json for mix-audio.mjs (and, as speech durations, for capture-editor.mjs --speech).
//
//   node scripts/media/narrate.mjs --voice-script voice.json --filmcraft path/to/filmcraft-cli --out DIR [--voice kokoro-heart]
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
for (const k of ["voice-script", "filmcraft", "out"]) if (!argv[k]) { console.error(`missing --${k}`); process.exit(2); }
const OUT = resolve(argv.out), VOICE = argv.voice || "kokoro-heart";
mkdirSync(OUT, { recursive: true });

// How the words should sound (the captions are written for reading).
const spoken = (text) => text
  .replace(/screensnap/gi, "screen snap")
  .replace(/\bMP4\b/g, "M P 4")
  .replace(/\bGIF\b/g, "gif")
  .replace(/Screen \+ Cam/g, "Screen plus Cam")
  .replace(/…/g, "...");

function say(text, pace, path) {
  const params = JSON.stringify({ text: spoken(text), voice: VOICE, pace, path: path + ".raw.wav", wait: true });
  const r = spawnSync(argv.filmcraft, ["exec", "tts.preview", params], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`filmcraft tts.preview failed for "${text}":\n${r.stderr || r.stdout}`);
  const lv = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", path + ".raw.wav", "-af", "loudnorm=I=-18:TP=-3:LRA=7,aresample=48000", "-ac", "2", "-c:a", "pcm_s24le", path]);
  if (lv.status !== 0) throw new Error(`ffmpeg could not level "${text}"`);
  rmSync(path + ".raw.wav");
  const out = JSON.parse(r.stdout);
  return out.seconds ?? out.result?.seconds;
}

const lines = JSON.parse(readFileSync(argv["voice-script"], "utf8"));
const cues = [];
lines.forEach((l, i) => {
  const file = join(OUT, `vo-${String(i).padStart(2, "0")}.wav`);
  const room = l.until - l.t - 0.25; // a beat of air before the next line
  let pace = 1, dur = say(l.text, pace, file);
  if (dur > room) {
    pace = Math.min(1.25, Math.ceil((dur / room) * 100) / 100 + 0.02);
    dur = say(l.text, pace, file);
    if (dur > room) console.warn(`  ! line ${i} still runs ${(dur - room).toFixed(2)} s long at ${pace}x: "${l.text}"`);
  }
  cues.push({ t: Math.round((l.t + 0.1) * 1000) / 1000, file, dur, pace, text: l.text });
  console.log(`  ${String(i).padStart(2)}  ${l.t.toFixed(1).padStart(6)}s  ${dur.toFixed(2)}s/${room.toFixed(1)}s  ${pace}x  ${l.text}`);
});
writeFileSync(join(OUT, "vo-cues.json"), JSON.stringify(cues, null, 1));
console.log(`${cues.length} lines → ${OUT}/vo-cues.json`);
process.exit(0);
