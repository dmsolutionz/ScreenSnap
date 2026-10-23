#!/usr/bin/env node
// Final audio mix for the launch film: the synthesized music bed + the sound-effect cue sheet that
// render-film.mjs wrote (sfx-cues.json) + the voiceover (narrate.mjs's vo-cues.json), summed at sample-accurate
// positions. The music ducks briefly under each effect and, more deeply and smoothly, under the narration, so
// the voice always sits on top; then the mix
// is loudness-normalised in two passes with ffmpeg's loudnorm to YouTube's reference: -14 LUFS integrated,
// true peak <= -1.5 dBTP (aimed at -2).
//
//   node scripts/media/mix-audio.mjs --audio <dir with music.wav + sfx/> --cues sfx-cues.json [--voice vo-cues.json] --out mix.wav
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!argv.audio || !argv.cues || !argv.out) { console.error("usage: mix-audio.mjs --audio <dir> --cues sfx-cues.json --out mix.wav"); process.exit(2); }
const SR = 48000;

// ── tiny WAV I/O (PCM 16/24/32 + float32) ──
function readWav(file) {
  const b = readFileSync(file);
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { tag: b.readUInt16LE(pos + 8), ch: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22), sub: len >= 40 ? b.readUInt16LE(pos + 32) : 0 };
    else if (id === "data") { data = b.subarray(pos + 8, pos + 8 + len); break; }
    pos += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: not a WAV`);
  const tag = fmt.tag === 0xfffe ? fmt.sub : fmt.tag, bytes = fmt.bits / 8, n = Math.floor(data.length / bytes / fmt.ch);
  if (fmt.rate !== SR) throw new Error(`${file}: expected ${SR} Hz, got ${fmt.rate}`);
  const chans = Array.from({ length: Math.max(2, fmt.ch) }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    const o = (i * fmt.ch + c) * bytes;
    chans[c][i] = tag === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648;
  }
  if (fmt.ch === 1) chans[1] = chans[0];
  return chans.slice(0, 2);
}
function writeWavF32(file, [l, r]) {
  const n = l.length, out = Buffer.alloc(44 + n * 8);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 8, 28); out.writeUInt16LE(8, 32); out.writeUInt16LE(32, 34);
  out.write("data", 36); out.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { out.writeFloatLE(l[i], 44 + i * 8); out.writeFloatLE(r[i], 48 + i * 8); }
  writeFileSync(file, out);
}

const music = readWav(join(argv.audio, "music.wav")); // the film is exactly as long as its music bed
const N = music[0].length;

// ── sound-effect bus ──
const cues = JSON.parse(readFileSync(argv.cues, "utf8"));
const bus = [new Float32Array(N), new Float32Array(N)];
const cache = new Map();
for (const cue of cues) {
  if (!cache.has(cue.name)) cache.set(cue.name, readWav(join(argv.audio, "sfx", `${cue.name}.wav`)));
  const wav = cache.get(cue.name), g = Math.pow(10, cue.db / 20), at = Math.round(cue.t * SR);
  for (let c = 0; c < 2; c++) for (let i = 0; i < wav[c].length && at + i < N; i++) if (at + i >= 0) bus[c][at + i] += wav[c][i] * g;
}

// ── voiceover bus ──
const voice = [new Float32Array(N), new Float32Array(N)];
// narrate.mjs's one continuous take (already placed on the film's clock) + where each line is, for the ducking
const vo = argv.voice ? JSON.parse(readFileSync(argv.voice, "utf8")) : { track: null, lines: [] };
const lines = vo.lines;
if (vo.track) { const wav = readWav(vo.track); for (let c = 0; c < 2; c++) voice[c].set(wav[c].subarray(0, N)); }
// Where speech is: 1 inside a line, 0 outside, with 120 ms ramps — the music fades down before the first word
// and back up after the last, instead of pumping on every syllable.
const speaking = new Float32Array(N);
for (const l of lines) { const a = Math.round(l.t * SR), b = Math.min(N, Math.round((l.t + l.dur) * SR)); for (let i = Math.max(0, a); i < b; i++) speaking[i] = 1; }
const ramp = Math.round(0.12 * SR);
const smooth = new Float32Array(N);
for (let i = 0, run = 0; i < N; i++) { run = speaking[i] ? Math.min(ramp, run + 1) : Math.max(0, run - 1); smooth[i] = run / ramp; }
for (let i = N - 2, run = 0; i >= 0; i--) { run = speaking[i] ? ramp : Math.max(0, run - 1); smooth[i] = Math.max(smooth[i], run / ramp); } // pre-roll

// ── duck the music under the effects (fast, at most about -4 dB) and the voice (smooth, about -9 dB) ──
const attack = Math.exp(-1 / (0.004 * SR)), release = Math.exp(-1 / (0.22 * SR));
const VOICE_DUCK = 1 - Math.pow(10, -9 / 20);
let env = 0;
const mix = [new Float32Array(N), new Float32Array(N)];
for (let i = 0; i < N; i++) {
  const x = Math.max(Math.abs(bus[0][i]), Math.abs(bus[1][i]));
  env = x > env ? attack * env + (1 - attack) * x : release * env; // peak follower
  const duck = (1 - 0.38 * Math.min(1, env / 0.2)) * (1 - VOICE_DUCK * smooth[i]);
  mix[0][i] = music[0][i] * duck + bus[0][i] + voice[0][i];
  mix[1][i] = music[1][i] * duck + bus[1][i] + voice[1][i];
}
const pre = argv.out.replace(/\.wav$/, "") + ".pre.wav";
writeWavF32(pre, mix);

// ── two-pass loudness normalisation (linear, so dynamics are untouched) ──
const target = "I=-14:TP=-2:LRA=11";
const p1 = spawnSync("ffmpeg", ["-hide_banner", "-i", pre, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(p1.stderr.slice(p1.stderr.lastIndexOf("{"), p1.stderr.lastIndexOf("}") + 1));
const af = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const p2 = spawnSync("ffmpeg", ["-y", "-hide_banner", "-i", pre, "-af", `${af},aresample=${SR}`, "-c:a", "pcm_s24le", argv.out], { encoding: "utf8" });
if (p2.status !== 0) { console.error(p2.stderr); process.exit(1); }
const chk = spawnSync("ffmpeg", ["-hide_banner", "-i", argv.out, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const sum = chk.slice(chk.lastIndexOf("Integrated loudness"));
console.log(`${cues.length} effects + ${lines.length} voice lines placed · measured before: ${m.input_i} LUFS / ${m.input_tp} dBTP`);
console.log(sum.split("\n").filter((l) => /I:|LRA:|Peak:/.test(l)).map((l) => "  " + l.trim()).join("\n"));
