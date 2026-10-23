#!/usr/bin/env node
/**
 * synth-audio.mjs - procedural soundtrack + SFX for the screensnap launch / walkthrough films.
 *
 * Everything is synthesised from scratch (no samples, no network, zero npm deps) and is fully
 * deterministic (seeded PRNG). Usage:
 *
 *   node scripts/media/synth-audio.mjs --out <dir> [--structure <name|file.json>] [--lufs -17] [--skip-sfx] [--skip-analysis]
 *
 * --structure picks the song form: `launch` (default, the 88 s launch film), `walkthrough` (the 232 s
 * tutorial cut) or a JSON file shaped like the STRUCTURES entries below.
 *
 * Writes into <dir>:
 *   music.wav            full length, stereo, 48 kHz, 32-bit float, ~-17 LUFS, true peak <= -1.5 dBTP
 *   stems/*.wav          drums, bass, chords, arp, lead, fx - same format; they already carry the master
 *                        gain curve, so summing them reproduces music.wav exactly
 *   sfx/*.wav            one-shot UI / transition sounds, 24-bit, peak -3 dBFS
 *   cues.json            tempo grid, section starts, hit times, beats/bars/kicks for the compositor
 *   analysis/            spectrogram PNGs, loudness tables, checks.json (needs ffmpeg for the images)
 *
 * Timing: 120 BPM at 48 kHz means one 16th note is exactly 6000 samples, so every event sits on an
 * integer sample and nothing drifts. Key A minor, Am - F - C - G (see generateChords for the turnarounds).
 *
 * Layout of this file: 1 grid + arrangement data, 2 DSP utilities, 3 instruments, 4 effects,
 * 5 arrangement/rendering, 6 master bus, 7 SFX, 8 I/O, 9 analysis, 10 main.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ========================================================================== 1. grid + arrangement */

const SR = 48000;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5 s
const STEP = (SR * BEAT) / 4; // one 16th note = 6000 samples
const BAR = STEP * 16; // 96000 samples = 2.0 s
if (!Number.isInteger(STEP)) throw new Error('tempo/sample-rate combination is not sample-exact');

const sec = s => Math.round(s * SR); // seconds -> sample index
const atStep = k => k * STEP; // 16th-note step (fractions of 0.5 = 32nds are still integers) -> sample
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/**
 * Song structures. Sections are contiguous, start at 0 and sit on bar lines (multiples of 2 s); the
 * first is an `intro` (impact at 2.0 s) and the last a `tail` (final hit on its first downbeat). `role`
 * drives the arrangement:
 *   intro, hook (light groove), build (arp + claps), drop / drop2 (full), bed (calm groove under
 *   captions), breakdown (thin, riser out), finale (biggest), tail (final hit + ring-out).
 * Optional per-section keys: `lead` (bool, overrides the role default), `lift` ([from, to] seconds of
 * brighter 16th-hat groove inside a bed), `db` ({ stem: [startDb, endDb] } overrides SECTION_DB),
 * `gainDb` ([startDb, endDb] applied to every stem - the quickest way to shape the energy map).
 * `chords` (one per bar) is optional; otherwise Am-F-C-G restarts per section and pulls to G at the end.
 * `energyOrder` lists [quieter id, louder id] pairs that the analysis asserts.
 * Pass a built-in name or a JSON file of the same shape with --structure.
 */
const STRUCTURES = {
  launch: {
    sections: [
      { id: 'intro', role: 'intro', name: 'Intro / logo reveal', start: 0, end: 4 },
      { id: 'hook', role: 'hook', name: 'Hook: free, no paywall', start: 4, end: 12 },
      { id: 'build', role: 'build', name: 'Record anything (popup)', start: 12, end: 24 },
      { id: 'drop', role: 'drop', name: 'Video editor (the star)', start: 24, end: 52 },
      { id: 'breakdown', role: 'breakdown', name: 'Screenshots', start: 52, end: 62 },
      { id: 'drop2', role: 'drop2', name: 'Private by design', start: 62, end: 74 },
      { id: 'finale', role: 'finale', name: 'Outro / call to action', start: 74, end: 84 },
      { id: 'tail', role: 'tail', name: 'Tail', start: 84, end: 88 },
    ],
    chords: 'Am Am  Am F C G  Am F C G F G  Am F C G Am F C G Am F C G C G  Am F C F G  Am F C G C G  Am F C G G  Am Am',
    energyOrder: [['intro', 'hook'], ['hook', 'build'], ['build', 'drop'], ['breakdown', 'drop'], ['drop', 'finale'], ['breakdown', 'drop2']],
  },
  walkthrough: {
    sections: [
      { id: 'intro', role: 'intro', name: 'Intro / logo reveal', start: 0, end: 4, gainDb: [-1, -1] },
      { id: 'hook', role: 'hook', name: 'Hook', start: 4, end: 12, gainDb: [-3, -3] },
      { id: 'build', role: 'build', name: 'Build (arp + claps enter)', start: 12, end: 34, gainDb: [-4, -2.5] },
      { id: 'editor', role: 'bed', name: 'Editor walkthrough (under captions)', start: 34, end: 180, lift: [98, 130] },
      { id: 'screenshots', role: 'breakdown', name: 'Screenshots', start: 180, end: 206, gainDb: [-3, -2] },
      { id: 'private', role: 'drop2', name: 'Private by design', start: 206, end: 218, lead: false, gainDb: [-1.8, -1.8] },
      { id: 'finale', role: 'finale', name: 'Outro / call to action', start: 218, end: 228, gainDb: [-2.2, -2.2] },
      { id: 'tail', role: 'tail', name: 'Final hit + ring-out', start: 228, end: 232, gainDb: [-1.5, -1.5] },
    ],
    energyOrder: [['intro', 'hook'], ['hook', 'editor'], ['screenshots', 'editor'], ['screenshots', 'private'], ['editor', 'private'], ['private', 'finale']],
  },
};

const ROLE_TEXT = {
  intro: 'pad swell + riser, big impact at 2.0, drums pause until 4.0',
  hook: 'light groove: soft kick, off-beat hats, sub bass, pad',
  build: 'arp + claps enter, hats open up, riser into the next section',
  drop: 'FULL: kick, claps, rolling bass, pads, arp, lead hook',
  bed: 'calm bed under captions: soft kick, light hats, pads + arp; a variation every 16 bars',
  breakdown: 'thin drums, pads + arp, snare roll + riser out',
  drop2: 'full groove again with an octave-bounce bass',
  finale: 'biggest section, roll into the final hit',
  tail: 'final hit, long reverb ring-out to silence',
};
const PROGRESSION = ['Am', 'F', 'C', 'G'];
const FULL_ROLES = new Set(['drop', 'drop2', 'finale']);
const IMPACT_TIME = 2; // seconds into the intro

/* Derived arrangement state, filled in by configure() for the chosen structure. */
let STRUCTURE;
let SECTIONS;
let BARS;
let N;
let BAR_SEC; // bar -> section
let BAR_ROLE;
let BAR_CHORDS;
let TRANSITIONS; // how each section is entered (riser / gap / roll / crash ...)
let GAP_STEPS; // [from step, to step) of silence before the big downbeats
let ROLL_BARS; // bar -> { index, count } for bars taken over by a snare roll
let FILL_BARS; // bars that end with a snare fill (into a finale)
let RISERS; // riser windows, collected while rendering the fx stem (for cues.json)

function configure(structure) {
  const secs = structure.sections;
  secs.forEach((s, i) => {
    const okGrid = Number.isInteger(s.start / 2) && Number.isInteger(s.end / 2) && s.end > s.start;
    const okChain = i ? s.start === secs[i - 1].end : s.start === 0;
    if (!okGrid || !okChain || !ROLE_TEXT[s.role]) throw new Error(`bad section ${JSON.stringify(s)}: needs a known role and contiguous bar-line start/end`);
  });
  if (secs[0].role !== 'intro' || secs[0].end < 4) throw new Error('the first section must be an intro of at least 4 s');
  if (secs.at(-1).role !== 'tail' || secs.at(-1).end - secs.at(-1).start !== 4) throw new Error('the last section must be a 4 s tail');
  STRUCTURE = structure;
  SECTIONS = secs.map(s => ({ ...s, music: s.music ?? ROLE_TEXT[s.role], startBar: s.start / 2, endBar: s.end / 2 }));
  BARS = SECTIONS.at(-1).endBar;
  N = BAR * BARS;
  BAR_SEC = range(0, BARS).map(b => SECTIONS.find(s => b >= s.startBar && b < s.endBar));
  BAR_ROLE = BAR_SEC.map(s => s.role);
  BAR_CHORDS = structure.chords ? structure.chords.split(/\s+/).filter(Boolean) : generateChords();
  if (BAR_CHORDS.length !== BARS) throw new Error(`chords cover ${BAR_CHORDS.length} bars, expected ${BARS}`);

  TRANSITIONS = [];
  GAP_STEPS = [];
  ROLL_BARS = new Map();
  FILL_BARS = new Set();
  RISERS = [];
  const ENTRY = { build: 'rise', drop: 'drop', drop2: 'drop', bed: 'soft', breakdown: 'down', finale: 'lift', tail: 'final' };
  SECTIONS.forEach((s, i) => {
    const entry = i && ENTRY[s.role];
    if (!entry) return;
    const prev = SECTIONS[i - 1];
    const step = s.startBar * 16;
    const tr = { section: s, prev, entry, time: s.start, step, gap: 0, roll: null };
    if (entry === 'drop' || entry === 'final') {
      tr.gap = entry === 'final' ? 2 : 1;
      const g = step - tr.gap;
      const count = prev.role === 'breakdown' ? 2 : 1;
      const b = step - 16 * count;
      if (count === 2) tr.roll = { segs: [[b, b + 16, 2], [b + 16, b + 24, 1], [b + 24, g, 0.5]], v0: 0.18, v1: 1 };
      else if (tr.gap === 2) tr.roll = { segs: [[b, b + 8, 2], [b + 8, b + 12, 1], [b + 12, g, 0.5]], v0: 0.25, v1: 1 };
      else tr.roll = { segs: [[b, b + 8, 2], [b + 8, g, 1]], v0: 0.2, v1: 1 };
      for (let k = 0; k < count; k++) ROLL_BARS.set(b / 16 + k, { index: k, count });
      GAP_STEPS.push([g, step]);
    }
    if (entry === 'lift') FILL_BARS.add(s.startBar - 1);
    TRANSITIONS.push(tr);
  });
}

/** Am-F-C-G restarting on every section; the last bar before the next section is pulled to G. */
function generateChords() {
  const out = [];
  SECTIONS.forEach((s, i) => {
    const bars = s.endBar - s.startBar;
    const still = s.role === 'intro' || s.role === 'tail';
    const ch = range(0, bars).map(k => (still ? 'Am' : PROGRESSION[k % 4]));
    const last = ch[bars - 1];
    if (!still && i < SECTIONS.length - 1 && bars >= 2 && last !== 'G') {
      if (last !== 'Am') ch[bars - 2] = last;
      ch[bars - 1] = 'G';
    }
    out.push(...ch);
  });
  return out;
}

/** pad = voicing, arp = pool of chord tones (F4..C6), root = bass root (A1, F1, C2, G1). */
const CHORDS = {
  Am: { root: 33, pad: [57, 60, 64, 69], arp: [69, 72, 76, 81, 84] },
  F: { root: 29, pad: [57, 60, 65, 69], arp: [65, 69, 72, 77, 81] },
  C: { root: 36, pad: [55, 60, 64, 67], arp: [67, 72, 76, 79, 84] },
  G: { root: 31, pad: [55, 59, 62, 67], arp: [67, 71, 74, 79, 83] },
};

/** Lead motif per chord: [step in bar, length in 16ths, MIDI]. */
const LEAD_MOTIF = {
  Am: [[0, 3, 76], [3, 1, 74], [4, 2, 72], [6, 2, 74], [8, 3, 76], [11, 1, 79], [12, 4, 81]],
  F: [[0, 3, 77], [3, 1, 76], [4, 2, 72], [6, 2, 69], [8, 4, 72], [12, 2, 74], [14, 2, 72]],
  C: [[0, 3, 79], [3, 1, 76], [4, 2, 79], [6, 2, 76], [8, 3, 79], [11, 1, 76], [12, 4, 72]],
  G: [[0, 3, 74], [3, 1, 71], [4, 2, 74], [6, 2, 79], [8, 4, 79], [12, 2, 74], [14, 2, 76]],
};
/** Arp note-index patterns over the chord's tone pool; a bed switches pattern pairs every 16 bars. */
const ARP_PATTERNS = [
  [0, 2, 1, 3, 2, 4, 3, 2, 0, 2, 1, 3, 4, 3, 2, 1],
  [4, 2, 3, 1, 2, 0, 1, 2, 4, 2, 3, 1, 0, 1, 2, 3],
  [1, 3, 2, 4, 3, 2, 1, 0, 1, 3, 2, 4, 2, 1, 0, 2],
  [0, 1, 2, 4, 3, 2, 1, 3, 0, 1, 2, 4, 3, 4, 2, 1],
];
const ARP_VEL = [1.0, 0.5, 0.7, 0.5, 0.85, 0.5, 0.7, 0.5, 0.95, 0.5, 0.75, 0.5, 0.85, 0.5, 0.7, 0.55];
const BED_BLOCK = 16; // bars per variation block inside a bed

/** Bass patterns: [step, length in 16ths, semitone offset from the chord root]. */
const roll16 = oct => [0, 1, 2, 3].flatMap(k => [[4 * k + 1, 1, 0], [4 * k + 2, 1, 0], [4 * k + 3, 1, oct(k)]]);
const BASS_PATTERNS = {
  hook: [[2, 2, 0], [6, 2, 0], [10, 2, 0], [14, 2, 0]],
  build: [[2, 2, 0], [6, 2, 0], [10, 2, 0], [11, 1, 12], [14, 2, 0], [15, 1, 12]],
  drop: roll16(k => (k % 2 ? 12 : 0)), // rolling 16ths around the kick
  breakdown: [[0, 15, 0]], // sustained sub only
  drop2: [[2, 1, 0], [3, 1, 12], [6, 1, 7], [7, 1, 12], [10, 1, 0], [11, 1, 12], [14, 1, 7], [15, 1, 12]], // octave bounce
  finale: roll16(() => 12),
};

/** Is time t (s) inside a bed section's `lift` window? */
const inLift = (s, t) => Boolean(s.lift && t >= s.lift[0] && t < s.lift[1]);

/** Bed automation: steady level, a filter dip-and-reopen at every 16-bar block, brighter during the lift. */
function bedSweep(base, lifted, dip) {
  return s => {
    const keys = [[0, base]];
    for (let t = s.start + BED_BLOCK * 2; t < s.end; t += BED_BLOCK * 2) {
      const before = inLift(s, t - 0.1) ? lifted : base;
      const after = inLift(s, t) ? lifted : base;
      keys.push([t - s.start - 0.05, before], [t - s.start, dip], [t - s.start + 6, after]);
    }
    return keys;
  };
}

/**
 * Mix automation per role: [seconds from section start (negative = from section end), value].
 * Gains are linear, cutoffs in Hz (interpolated in log space). Values may be functions of the section.
 */
const AUTO = {
  padGain: {
    intro: [[0, 0], [0.4, 0.04], [1.9, 0.5], [2.0, 0.55], [-0.1, 0.4]], hook: [[0, 0.4]], build: [[0, 0.46], [-0.1, 0.58]],
    drop: [[0, 0.55], [-0.1, 0.55]], bed: [[0, 0.5], [-0.1, 0.5]], breakdown: [[0.4, 0.85], [-0.1, 0.95]], drop2: [[0.1, 0.55], [-0.1, 0.55]],
    finale: [[0.2, 0.65], [-0.1, 0.65]], tail: [[0.2, 0.5], [2.5, 0.3], [4, 0.1]],
  },
  padCut: {
    intro: [[0, 200], [2, 4200], [2.6, 3200]], hook: [[0, 1600]], build: [[0, 2000], [-0.1, 4200]], drop: [[0.2, 5200], [-0.1, 5200]],
    bed: bedSweep(3000, 4300, 1300), breakdown: [[0.4, 2400], [-0.1, 5200]], drop2: [[0.2, 6200]], finale: [[0.2, 7600], [-0.01, 8600]],
    tail: [[2, 3500], [4, 1500]],
  },
  arpGain: {
    build: [[0, 0], [0.4, 0.3], [-0.1, 0.7]], drop: [[0, 0.8], [-0.1, 0.8]], bed: s => (s.lift ? [[0, 0.75], [s.lift[0] - s.start, 0.75], [s.lift[0] - s.start + 0.1, 0.85], [s.lift[1] - s.start, 0.85], [s.lift[1] - s.start + 0.1, 0.75]] : [[0, 0.75]]),
    breakdown: [[0.1, 1.0], [-0.1, 1.05]], drop2: [[0.1, 0.8], [-0.1, 0.8]], finale: [[0.1, 0.95]],
  },
  arpCut: {
    build: [[0, 1000], [-0.1, 3000]], drop: [[0, 3400]], bed: bedSweep(2800, 3800, 1500), breakdown: [[0, 2300], [-0.1, 4800]],
    drop2: [[0.1, 3600]], finale: [[0.1, 4400]],
  },
  bassGain: { hook: [[0, 0.7], [-0.1, 0.9]], build: [[0, 0.95], [-0.1, 1.0]], drop: [[0, 1.0]], bed: [[0, 0.75]], breakdown: [[0, 0.6], [-0.1, 0.75]], drop2: [[0, 1.0]], finale: [[0, 1.1]] },
  bassSaw: { hook: [[0, 0.12]], build: [[0, 0.3]], drop: [[0, 0.5]], bed: [[0, 0.22]], breakdown: [[0, 0]], drop2: [[0, 0.55]], finale: [[0, 0.7]] },
  leadGain: { drop: [[0, 0.8]], drop2: [[0, 0.85]], finale: [[0, 1.0]] },
  chordSend: { intro: [[0, 0.2]], finale: [[-0.1, 0.2]], tail: [[0, 0.65]] },
  fxSend: { intro: [[0, 0.18]], finale: [[-0.1, 0.18]], tail: [[0, 0.45]] },
};

/** Turn a per-role AUTO table into a curve over the configured structure. */
function roleCurve(table, opts) {
  const keys = [];
  for (const s of SECTIONS) {
    const spec = typeof table[s.role] === 'function' ? table[s.role](s) : table[s.role];
    for (const [t, v] of spec ?? []) {
      let at = t < 0 ? s.end + t : Math.min(s.start + t, s.end);
      if (keys.length && at <= keys[keys.length - 1][0]) at = keys[keys.length - 1][0] + 1e-4;
      keys.push([at, v]);
    }
  }
  return keyframes(keys, opts);
}

/** Sidechain depth per stem (0 = none, 1 = full duck) and per-stem trims. */
const DUCK = { bass: 0.9, pad: 0.6, arp: 0.35, lead: 0.25 };
const TRIM = { drums: 1.0, bass: 0.9, chords: 1.0, arp: 1.0, lead: 1.0, fx: 1.0 };
/** Per-stem level shaping per role as [dB at section start, dB at section end] - the main energy-map control. */
const SECTION_DB = {
  drums: { hook: [-1, -1], build: [-2, 0], bed: [-2, -2] },
  bass: { hook: [-2.5, -2.5], build: [-4.5, -2], drop: [-1.5, -1.5], bed: [-5, -5], breakdown: [-8, -8], drop2: [-3, -3], finale: [-3, -3] },
  chords: { intro: [-5, -5], bed: [-1.5, -1.5], breakdown: [-6, -6], tail: [-3, -3] },
  arp: { bed: [-2, -2], breakdown: [-4.5, -4.5], finale: [-1, -1] },
  lead: { drop2: [-2, -2], finale: [-1.5, -1.5] },
  fx: { breakdown: [-2, -2] },
};
let TARGET_LUFS = -17; // --lufs overrides
const TRUE_PEAK_LIMIT = -1.5;

/* ========================================================================== 2. DSP utilities */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const dbToLin = db => 10 ** (db / 20);
const linToDb = x => 20 * Math.log10(Math.max(x, 1e-12));
const midiHz = m => 440 * 2 ** ((m - 69) / 12);
const cents = c => 2 ** (c / 1200);

/** mulberry32 - tiny deterministic PRNG, returns floats in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Equal-power pan with unity at the centre (the sides get +3 dB, so the total power is constant). */
function panGains(p) {
  const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2];
}

/** Piecewise-linear (or log-linear) automation curve through [seconds, value] keys. */
function keyframes(keys, { log = false } = {}) {
  return t => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i][0]) {
        const [t0, v0] = keys[i - 1];
        const [t1, v1] = keys[i];
        const u = (t - t0) / (t1 - t0);
        return log ? v0 * (v1 / v0) ** u : v0 + (v1 - v0) * u;
      }
    }
    return keys[keys.length - 1][1];
  };
}

/** Sample a function of time into a per-sample Float32Array (evaluated every `stride` samples, interpolated). */
function bake(fn, n = N, stride = 48) {
  const out = new Float32Array(n);
  let a = fn(0);
  for (let i = 0; i < n; i += stride) {
    const b = fn(Math.min(i + stride, n) / SR);
    const len = Math.min(stride, n - i);
    for (let k = 0; k < len; k++) out[i + k] = a + ((b - a) * k) / stride;
    a = b;
  }
  return out;
}

const stereo = (n = N) => ({ l: new Float32Array(n), r: new Float32Array(n) });

/** Add `src` into `dst` at sample `at` (mono, scalar gain). */
function addInto(dst, src, at, gain = 1) {
  const n = Math.min(src.length, dst.length - at);
  for (let i = 0; i < n; i++) dst[at + i] += src[i] * gain;
}

/** Place a mono prototype hit on a stereo bus. `maxLen` truncates with a short fade (hat choke). */
function put(bus, proto, at, gain, pan = 0, maxLen = proto.length) {
  const [gl, gr] = panGains(pan);
  const n = Math.min(maxLen, proto.length, N - at);
  const fade = maxLen < proto.length ? Math.min(n, sec(0.006)) : 0;
  for (let i = 0; i < n; i++) {
    const g = fade && i >= n - fade ? gain * ((n - i) / fade) : gain;
    bus.l[at + i] += proto[i] * g * gl;
    bus.r[at + i] += proto[i] * g * gr;
  }
}

function normalize(buf, peak = 1) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m;
  return buf;
}

/** RBJ cookbook biquad (transposed direct form II). Coefficients can be re-set while running. */
class Biquad {
  constructor(type, f, q = Math.SQRT1_2, gainDb = 0) {
    this.z1 = 0;
    this.z2 = 0;
    this.set(type, f, q, gainDb);
  }

  set(type, f, q = Math.SQRT1_2, gainDb = 0) {
    this.q = q;
    const w0 = (TAU * clamp(f, 10, SR * 0.45)) / SR;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'hp':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bp': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highshelf': {
        const A = 10 ** (gainDb / 40);
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
      default:
        throw new Error(`unknown biquad type ${type}`);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  /** Build a filter straight from normalised coefficients (a0 = 1). */
  static fromCoefs(b0, b1, b2, a1, a2) {
    return Object.assign(new Biquad('lp', 1000), { b0, b1, b2, a1, a2 });
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** 4th-order Butterworth low-pass whose cutoff follows `cut` (Hz per sample), coefficients refreshed every 32 samples. */
function sweepLowpass(buf, cut, stages = 2) {
  const qs = stages === 2 ? [0.5412, 1.3066] : [Math.SQRT1_2];
  const filters = qs.map(q => new Biquad('lp', 1000, q));
  for (let i = 0; i < buf.length; i += 32) {
    for (const f of filters) f.set('lp', cut[i], f.q);
    const end = Math.min(i + 32, buf.length);
    for (let k = i; k < end; k++) {
      let x = buf[k];
      for (const f of filters) x = f.process(x);
      buf[k] = x;
    }
  }
}

function filterStatic(buf, ...filters) {
  for (let i = 0; i < buf.length; i++) {
    let x = buf[i];
    for (const f of filters) x = f.process(x);
    buf[i] = x;
  }
}

/** Band-limited (PolyBLEP) oscillator helpers. `ph` in [0,1), `dt` = f / SR. */
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
const sawBL = (ph, dt) => 2 * ph - 1 - polyBlep(ph, dt);
const squareBL = (ph, dt) => {
  const p2 = ph + 0.5 >= 1 ? ph - 0.5 : ph + 0.5;
  return (ph < 0.5 ? 1 : -1) + polyBlep(ph, dt) - polyBlep(p2, dt);
};

/** Exponentially gliding, exponentially decaying sine (kick, boom, pop, chime partials ...). */
function addTone(buf, t0, dur, { f0, f1 = f0, glide = 0.03, amp = 1, attack = 0.001, decay = 0.1, drive = 0, fadeOut = 0.01 }) {
  const i0 = sec(t0);
  const n = Math.min(sec(dur), buf.length - i0);
  const norm = drive ? 1 / Math.tanh(drive) : 1;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (TAU * (f1 + (f0 - f1) * Math.exp(-t / glide))) / SR;
    let env = Math.exp(-t / decay);
    if (t < attack) env *= t / attack;
    const rem = dur - t;
    if (rem < fadeOut) env *= rem / fadeOut;
    const s = Math.sin(ph);
    buf[i0 + i] += amp * env * (drive ? Math.tanh(drive * s) * norm : s);
  }
}

/** A sine whose pitch and level are arbitrary functions of normalised time u in [0,1]. */
function addSweepTone(buf, t0, dur, freqAt, ampAt) {
  const i0 = sec(t0);
  const n = Math.min(sec(dur), buf.length - i0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    ph += (TAU * freqAt(u)) / SR;
    buf[i0 + i] += ampAt(u) * Math.sin(ph) * Math.min(1, (n - i) / sec(0.003));
  }
}

/** Filtered white-noise burst with exponential decay. */
function addNoise(buf, t0, dur, { amp = 1, attack = 0.0005, decay = 0.05, filters = [], seed = 1, fadeOut = 0.003 }) {
  const r = rng(seed);
  const i0 = sec(t0);
  const n = Math.min(sec(dur), buf.length - i0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let x = r() * 2 - 1;
    for (const f of filters) x = f.process(x);
    let env = Math.exp(-t / decay);
    if (t < attack) env *= t / attack;
    const rem = dur - t;
    if (rem < fadeOut) env *= rem / fadeOut;
    buf[i0 + i] += amp * env * x;
  }
}

/** Band-passed noise with a moving centre frequency (risers, whooshes). `ampAt(u)` shapes the level. */
function addNoiseSweep(buf, t0, dur, { f0, f1, q = 1.2, ampAt = u => u * u, curve = 1, seed = 1, hp = 150 }) {
  const r = rng(seed);
  const i0 = sec(t0);
  const n = Math.min(sec(dur), buf.length - i0);
  const bp = new Biquad('bp', f0, q);
  const high = new Biquad('hp', hp, 0.7);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 15) === 0) bp.set('bp', f0 * (f1 / f0) ** u ** curve, q);
    buf[i0 + i] += ampAt(u) * high.process(bp.process(r() * 2 - 1)) * Math.min(1, (n - i) / sec(0.002));
  }
}

/* ========================================================================== 3. instruments */

function makeKick({ f0 = 158, f1 = 46, glide = 0.028, decay = 0.095, dur = 0.3, drive = 1.5, click = 0.4 } = {}) {
  const b = new Float32Array(sec(dur));
  addTone(b, 0, dur, { f0, f1, glide, decay, attack: 0.0008, drive, fadeOut: 0.06 });
  // 2 ms click transient
  addNoise(b, 0, 0.004, { amp: click, decay: 0.0007, attack: 0.0001, seed: 5, filters: [new Biquad('hp', 1500, 0.7), new Biquad('lp', 9000, 0.7)] });
  return normalize(b);
}

function makeClap(seed) {
  const b = new Float32Array(sec(0.3));
  const chain = () => [new Biquad('hp', 700, 0.7), new Biquad('bp', 2000, 0.8), new Biquad('lp', 9000, 0.7)];
  [0, 0.0105, 0.021].forEach((t, i) => addNoise(b, t, 0.03, { decay: 0.005, seed: seed + i, filters: chain() }));
  addNoise(b, 0.031, 0.26, { decay: 0.075, seed: seed + 9, filters: chain() });
  return normalize(b);
}

function makeSnare(seed, { pitch = 190, noiseDecay = 0.11, len = 0.28 } = {}) {
  const b = new Float32Array(sec(len));
  addTone(b, 0, len, { f0: pitch * 1.5, f1: pitch, glide: 0.012, decay: 0.05, amp: 0.6 });
  addNoise(b, 0, len, { decay: noiseDecay, seed, amp: 1, filters: [new Biquad('hp', 1100, 0.7), new Biquad('bp', 3400, 0.6), new Biquad('lp', 10000, 0.7)] });
  return normalize(b);
}

function makeHat(seed, open) {
  const dur = open ? 0.45 : 0.1;
  const b = new Float32Array(sec(dur));
  addNoise(b, 0, dur, {
    decay: open ? 0.11 : 0.016, attack: 0.0003, seed, fadeOut: 0.02,
    filters: [new Biquad('hp', 6200, 0.8), new Biquad('bp', 9500, 0.8), new Biquad('lp', 12000, 0.7)],
  });
  return normalize(b);
}

/** Cymbal-ish crash: bright noise + a few narrow resonances. */
function makeCrash(seed, dur = 3.5, tau = 0.9) {
  const b = new Float32Array(sec(dur));
  addNoise(b, 0, dur, { decay: tau, attack: 0.0015, seed, fadeOut: 0.05, filters: [new Biquad('hp', 2600, 0.7), new Biquad('lp', 11500, 0.7)] });
  for (const [f, k] of [[3150, 1.2], [4720, 0.9], [6180, 0.75], [7640, 0.6]]) {
    addNoise(b, 0, dur, { decay: tau * k, attack: 0.001, seed: seed + f, amp: 3, fadeOut: 0.05, filters: [new Biquad('bp', f, 18), new Biquad('bp', f, 18)] });
  }
  return normalize(b);
}

/** Detuned saw pad / chord-stab voices: unison cents and pan positions. */
const UNISON_CENTS = [-13, -6, 0, 6, 13];
const UNISON_PAN = [-0.9, -0.45, 0, 0.45, 0.9];

/** Pad bus: 5 detuned PolyBLEP saws per note, slow attack, overlapping release. */
function renderPadBus(L, R) {
  const r = rng(21);
  const ATT = sec(0.35);
  const REL = sec(0.6);
  const PRE = sec(0.12); // start a touch early so the new chord is in place on the bar line
  for (const seg of chordSegments()) {
    const i0 = Math.max(0, seg.bar0 * BAR - (seg.bar0 ? PRE : 0));
    const i1 = seg.bar1 * BAR;
    const iEnd = Math.min(N, i1 + REL);
    CHORDS[seg.chord].pad.forEach((midi, ni) => {
      UNISON_CENTS.forEach((c, v) => {
        const dt = (midiHz(midi) * cents(c)) / SR;
        const [gl, gr] = panGains(UNISON_PAN[v] * (ni % 2 ? -1 : 1));
        let ph = r();
        for (let i = i0; i < iEnd; i++) {
          let a = i < i0 + ATT ? smoothstep((i - i0) / ATT) : 1;
          if (i >= i1) a *= 1 - smoothstep((i - i1) / REL);
          const s = sawBL(ph, dt) * a * 0.1;
          ph += dt;
          if (ph >= 1) ph -= 1;
          L[i] += s * gl;
          R[i] += s * gr;
        }
      });
    });
  }
}

function chordSegments() {
  const segs = [];
  BAR_CHORDS.forEach((chord, bar) => {
    const last = segs[segs.length - 1];
    if (last && last.chord === chord) last.bar1 = bar + 1;
    else segs.push({ chord, bar0: bar, bar1: bar + 1 });
  });
  return segs;
}

/** Bright saw-stack stab with a closing low-pass; written straight into the L/R buses. */
function addStab(L, R, at, midis, { len = 2.5, gain = 1, tau = 0.6, c0 = 9000, c1 = 2200, ctau = 0.25, seed = 1 }) {
  const n = Math.min(sec(len), N - at);
  const tl = new Float32Array(n);
  const tr = new Float32Array(n);
  const r = rng(seed);
  midis.forEach((midi, ni) => {
    UNISON_CENTS.forEach((c, v) => {
      const dt = (midiHz(midi) * cents(c)) / SR;
      const [gl, gr] = panGains(UNISON_PAN[v] * (ni % 2 ? -1 : 1));
      let ph = r();
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const rem = len - t;
        const s = sawBL(ph, dt) * Math.min(1, t / 0.004) * Math.exp(-t / tau) * (rem < 0.25 ? rem / 0.25 : 1) * 0.07;
        ph += dt;
        if (ph >= 1) ph -= 1;
        tl[i] += s * gl;
        tr[i] += s * gr;
      }
    });
  });
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) cut[i] = c1 + (c0 - c1) * Math.exp(-i / SR / ctau);
  sweepLowpass(tl, cut);
  sweepLowpass(tr, cut);
  for (let i = 0; i < n; i++) { L[at + i] += tl[i] * gain; R[at + i] += tr[i] * gain; }
}

/** Bass note: saturated sub sine + low-passed saw one octave above. */
function addBassNote(buf, at, lenSamples, midi, gain, sawMix) {
  const f = midiHz(midi);
  const rel = sec(0.012);
  const n = Math.min(lenSamples + rel, N - at);
  const att = sec(0.003);
  const dtSaw = (2 * f) / SR;
  const lp = new Biquad('lp', 900, 0.9);
  let phSub = 0;
  let phSaw = 0;
  for (let k = 0; k < n; k++) {
    const t = k / SR;
    if ((k & 15) === 0) lp.set('lp', 380 + 900 * Math.exp(-t / 0.07), 0.9);
    let env = Math.min(1, k / att) * (1 - 0.2 * Math.min(1, k / lenSamples));
    if (k > lenSamples) env *= 1 - (k - lenSamples) / rel;
    const sub = Math.tanh(1.4 * Math.sin(phSub)) * 0.78;
    const saw = lp.process(sawBL(phSaw, dtSaw));
    phSub += (TAU * f) / SR;
    phSaw += dtSaw;
    if (phSaw >= 1) phSaw -= 1;
    buf[at + k] += (sub + sawMix * saw * 0.6) * env * gain;
  }
}

/** Arp pluck: two detuned saws (left/right) + a square, resonant low-pass snapping shut. */
function addArpNote(L, R, at, midi, vel, brightHz, pan) {
  const f = midiHz(midi);
  const len = sec(0.3);
  const fadeN = sec(0.03);
  const n = Math.min(len, N - at);
  const dA = (f * cents(-7)) / SR;
  const dB = (f * cents(7)) / SR;
  const dS = f / SR;
  let pa = 0.1;
  let pb = 0.35;
  let ps = 0;
  const fl = new Biquad('lp', brightHz, 1.4);
  const fr = new Biquad('lp', brightHz, 1.4);
  const [gl, gr] = panGains(pan);
  for (let k = 0; k < n; k++) {
    const t = k / SR;
    if ((k & 15) === 0) {
      const c = Math.min(9000, brightHz * (1 + 3.5 * Math.exp(-t / 0.07)));
      fl.set('lp', c, 1.4);
      fr.set('lp', c, 1.4);
    }
    const env = Math.min(1, k / sec(0.002)) * Math.exp(-t / 0.1) * (k > n - fadeN ? (n - k) / fadeN : 1) * vel;
    const sq = 0.5 * squareBL(ps, dS);
    L[at + k] += fl.process((sawBL(pa, dA) + sq) * env) * gl;
    R[at + k] += fr.process((sawBL(pb, dB) + sq) * env) * gr;
    pa += dA; if (pa >= 1) pa -= 1;
    pb += dB; if (pb >= 1) pb -= 1;
    ps += dS; if (ps >= 1) ps -= 1;
  }
}

/** Mono lead pluck with a little delayed vibrato. */
function addLeadNote(buf, at, lenSamples, midi, gain, brightHz) {
  const f = midiHz(midi);
  const rel = sec(0.09);
  const n = Math.min(lenSamples + rel, N - at);
  const lp = new Biquad('lp', brightHz, 1.1);
  let pa = 0;
  let pb = 0.31;
  let ps = 0.6;
  for (let k = 0; k < n; k++) {
    const t = k / SR;
    if ((k & 15) === 0) lp.set('lp', Math.min(9000, brightHz * (0.8 + 1.8 * Math.exp(-t / 0.09))), 1.1);
    const vib = t > 0.18 ? 1 + 0.0035 * Math.min(1, (t - 0.18) / 0.2) * Math.sin(TAU * 5.4 * t) : 1;
    const dt = (f * vib) / SR;
    let env = Math.min(1, k / sec(0.003)) * (0.55 + 0.45 * Math.exp(-t / 0.16));
    if (k > lenSamples) env *= 1 - (k - lenSamples) / rel;
    const s = 0.5 * sawBL(pa, dt * cents(-5)) + 0.5 * sawBL(pb, dt * cents(5)) + 0.25 * squareBL(ps, dt);
    pa += dt * cents(-5); if (pa >= 1) pa -= 1;
    pb += dt * cents(5); if (pb >= 1) pb -= 1;
    ps += dt; if (ps >= 1) ps -= 1;
    buf[at + k] += lp.process(s) * env * gain;
  }
}

/* ========================================================================== 4. effects */

class Comb {
  constructor(len, fb, damp, depth, rate, phase) {
    this.len = len; this.size = len + depth + 4; this.buf = new Float32Array(this.size); this.w = 0;
    this.fb = fb; this.damp = damp; this.store = 0;
    this.depth = depth; this.inc = rate / SR; this.ph = phase;
  }

  process(x) {
    this.ph += this.inc;
    if (this.ph >= 1) this.ph -= 1;
    const tri = 4 * Math.abs(this.ph - 0.5) - 1; // cheap triangle LFO, -1..1
    let rp = this.w - (this.len + this.depth * tri);
    if (rp < 0) rp += this.size;
    const i0 = rp | 0;
    const fr = rp - i0;
    const i1 = i0 + 1 === this.size ? 0 : i0 + 1;
    const y = this.buf[i0] * (1 - fr) + this.buf[i1] * fr;
    this.store = y * (1 - this.damp) + this.store * this.damp;
    const v = x + this.store * this.fb;
    this.buf[this.w] = v > 1e-20 || v < -1e-20 ? v : 0;
    if (++this.w === this.size) this.w = 0;
    return y;
  }
}

class Allpass {
  constructor(len, g) { this.buf = new Float32Array(len); this.i = 0; this.g = g; }

  process(x) {
    const b = this.buf[this.i];
    const v = x + b * this.g;
    this.buf[this.i] = v > 1e-20 || v < -1e-20 ? v : 0;
    if (++this.i === this.buf.length) this.i = 0;
    return b - x;
  }
}

/** Freeverb-style Schroeder reverb: 8 damped, slightly modulated combs + 4 allpasses per channel, RT60-tuned feedback. */
class Reverb {
  constructor({ rt60 = 2.5, damp = 0.25, predelay = 0.02, hp = 220, lp = 9000, modDepth = 5 } = {}) {
    const scale = SR / 44100;
    const combLens = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const apLens = [556, 441, 341, 225];
    let energy = 0;
    this.ch = [0, 1].map(c => ({
      combs: combLens.map((l, i) => {
        const len = Math.round((l + 23 * c) * scale);
        const fb = 10 ** ((-3 * len) / (SR * rt60)); // -60 dB after rt60 seconds
        energy += 1 / (1 - fb * fb);
        return new Comb(len, fb, damp, modDepth, 0.35 + 0.07 * i + 0.03 * c, (i * 0.37 + c * 0.5) % 1);
      }),
      aps: apLens.map(l => new Allpass(Math.round((l + 23 * c) * scale), 0.5)),
    }));
    this.norm = 1 / Math.sqrt(energy / 2);
    this.pre = Math.max(1, sec(predelay));
    this.hp = hp; this.lp = lp;
  }

  /** Returns the wet signal only ({l, r}); inputs are summed to mono, so width comes from the decorrelated comb sets. */
  process(inL, inR) {
    const n = inL.length;
    const out = stereo(n);
    const hp = new Biquad('hp', this.hp, 0.7);
    const lp = new Biquad('lp', this.lp, 0.7);
    const pd = new Float32Array(this.pre);
    let pi = 0;
    const [cl, cr] = this.ch;
    for (let i = 0; i < n; i++) {
      let x = lp.process(hp.process((inL[i] + inR[i]) * 0.5));
      const d = pd[pi]; pd[pi] = x; if (++pi === pd.length) pi = 0; x = d;
      let a = 0;
      let b = 0;
      for (let k = 0; k < 8; k++) { a += cl.combs[k].process(x); b += cr.combs[k].process(x); }
      for (let k = 0; k < 4; k++) { a = cl.aps[k].process(a); b = cr.aps[k].process(b); }
      out.l[i] = a * this.norm;
      out.r[i] = b * this.norm;
    }
    return out;
  }
}

/** Tempo-synced ping-pong delay with a band-limited feedback path. Returns the wet signal only. */
function pingPong(inL, inR, { time, feedback = 0.45, lo = 300, hi = 4500 }) {
  const n = inL.length;
  const out = stereo(n);
  const bl = new Float32Array(time);
  const br = new Float32Array(time);
  const fl = [new Biquad('hp', lo, 0.7), new Biquad('lp', hi, 0.7)];
  const fr = [new Biquad('hp', lo, 0.7), new Biquad('lp', hi, 0.7)];
  let w = 0;
  for (let i = 0; i < n; i++) {
    const yl = bl[w];
    const yr = br[w];
    out.l[i] = yl;
    out.r[i] = yr;
    let a = yr * feedback; for (const f of fl) a = f.process(a);
    let b = yl; for (const f of fr) b = f.process(b);
    const nl = (inL[i] + inR[i]) * 0.5 + a;
    bl[w] = nl > 1e-20 || nl < -1e-20 ? nl : 0;
    br[w] = b > 1e-20 || b < -1e-20 ? b : 0;
    if (++w === time) w = 0;
  }
  return out;
}

/** Sidechain "presence": 1 right after a (velocity-weighted) kick, decaying to 0 over 300 ms. */
function buildDuckPresence(kicks) {
  const p = new Float32Array(N);
  const T = sec(0.3);
  const att = sec(0.0015);
  const shape = new Float32Array(T);
  for (let k = 0; k < T; k++) shape[k] = Math.min(1, k / att) * (1 - k / T) ** 2.2;
  for (const { at, vel } of kicks) {
    for (let k = 0; k < T && at + k < N; k++) p[at + k] = Math.max(p[at + k], vel * shape[k]);
  }
  return p;
}
const duckGain = (presence, depth) => presence.map(v => 1 - depth * v);

/** Gain curve that is 0 inside the pre-drop gaps (2 ms down-ramp, 1 ms up-ramp that ends on the downbeat). */
function buildGap() {
  const g = new Float32Array(N).fill(1);
  const dn = sec(0.002);
  const up = sec(0.001);
  for (const [a, b] of GAP_STEPS) {
    const i0 = atStep(a);
    const i1 = atStep(b);
    for (let i = i0 - dn; i < i0; i++) g[i] = 0.5 + 0.5 * Math.cos((Math.PI * (i - (i0 - dn))) / dn);
    for (let i = i0; i < i1 - up; i++) g[i] = 0;
    for (let i = i1 - up; i < i1; i++) g[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i - (i1 - up))) / up);
  }
  return g;
}

function applyGain(bus, ...gains) {
  for (let i = 0; i < bus.l.length; i++) {
    let g = 1;
    for (const a of gains) g *= a[i];
    bus.l[i] *= g;
    bus.r[i] *= g;
  }
}

/* ========================================================================== 5. arrangement + rendering */

/** All drum events for the whole piece, as { at: sample, vel, ... } lists. */
function scheduleDrums() {
  const ev = { kick: [], clap: [], snare: [], hat: [], open: [], roll: [] };
  const add = (list, step, vel, extra = {}) => list.push({ at: atStep(step), vel, step, ...extra });

  add(ev.kick, (IMPACT_TIME * SR) / STEP, 1, { kind: 'impact' });
  for (const tr of TRANSITIONS) {
    if (tr.entry === 'final') add(ev.kick, tr.step, 1, { kind: 'impact' });
    if (!tr.roll) continue;
    const hits = [];
    for (const [a, b, iv] of tr.roll.segs) for (let s = a; s < b - 1e-9; s += iv) hits.push(s);
    const { v0, v1 } = tr.roll;
    hits.forEach((s, i) => add(ev.roll, s, v0 + ((v1 - v0) * i) / (hits.length - 1), { u: i / (hits.length - 1) }));
  }

  for (let bar = 0; bar < BARS; bar++) {
    const sc = BAR_SEC[bar];
    const role = sc.role;
    const rel = bar - sc.startBar;
    const len = sc.endBar - sc.startBar;
    const roll = ROLL_BARS.get(bar);
    for (let s = 0; s < 16; s++) {
      const step = bar * 16 + s;
      const beat = s % 4 === 0;
      const off = s % 4 === 2;
      const odd = s % 2 === 1;
      const backbeat = s === 4 || s === 12;
      const kick = (vel, kind = 'main') => add(ev.kick, step, vel, { kind });
      const hat = vel => add(ev.hat, step, vel);
      const open = vel => add(ev.open, step, vel);
      const clap = vel => add(ev.clap, step, vel);
      const snare = vel => add(ev.snare, step, vel);

      if (roll) { // the snare roll owns this bar; keep only a few kicks under it
        if (roll.count === 1 && beat && s < 8) kick(role === 'build' ? 0.9 : 1);
        if (roll.count === 2 && roll.index === 0 && s === 0) kick(0.55, 'soft');
        continue;
      }
      if (role === 'hook') {
        if (beat) kick(0.8);
        if (rel < 2) { if (off) hat(0.28); } else { if (s % 2 === 0) hat(0.3); if (s === 14) open(0.3); }
      } else if (role === 'build') {
        const sixteenths = rel >= 2;
        if (beat) kick(0.9);
        if (backbeat) clap(0.7);
        if (beat) hat(0.38);
        else if (off) (sixteenths ? open : hat)(sixteenths ? 0.4 : 0.3);
        else if (odd && sixteenths) hat(0.2);
      } else if (role === 'bed') {
        if ((rel + 1) % BED_BLOCK === 0 && rel < len - 1) continue; // one-bar drum drop-out before each new block
        const lift = inLift(sc, bar * 2 + s * 0.125);
        if (beat) kick(lift ? 0.75 : 0.68, 'soft');
        if (backbeat) clap(lift ? 0.45 : 0.38);
        if (lift) { if (beat) hat(0.3); else if (off) open(0.3); else hat(0.16); } else if (off) hat(0.26); else if (s % 2 === 0) hat(0.14);
      } else if (role === 'breakdown') {
        if (s === 0 || s === 8) kick(0.55, 'soft');
        if (s % 2 === 0) hat(0.2);
        if (ROLL_BARS.has(bar + 1) && s === 14) open(0.3);
      } else if (FULL_ROLES.has(role)) {
        const lvl = role === 'finale' ? 1.15 : role === 'drop2' ? 1.05 : 1;
        if (beat) kick(1);
        if (backbeat) { clap(lvl); snare(0.8 * lvl); if (role === 'finale') clap(0.6); }
        if (beat) hat(0.4 * lvl); else if (off) open(0.5 * lvl); else hat(0.22 * lvl);
        if (bar % 4 === 3 && s === 14) clap(0.35); // ghost clap at phrase ends
        if (bar % 8 === 7 && s >= 12) snare(0.4 + (s - 12) * 0.15);
        if (FILL_BARS.has(bar) && s >= 12) snare(0.5 + (s - 12) * 0.17); // fill into the finale
      }
    }
  }
  return ev;
}

function renderDrums(ev, gap) {
  const dry = stereo();
  const snareBus = stereo();
  const kicks = {
    main: makeKick(),
    soft: makeKick({ f0: 140, decay: 0.08, click: 0.25 }),
    impact: makeKick({ f0: 190, f1: 42, glide: 0.04, decay: 0.16, dur: 0.7, drive: 1.8, click: 0.5 }),
  };
  const claps = [0, 1, 2].map(i => makeClap(100 + i * 20));
  const snares = [0, 1].map(i => makeSnare(200 + i, { pitch: 190 }));
  const closed = [0, 1, 2].map(i => makeHat(300 + i, false));
  const opens = [0, 1].map(i => makeHat(400 + i, true));
  const rollSnares = range(0, 8).map(i => makeSnare(500 + i, { pitch: 170 + i * 18, noiseDecay: 0.05, len: 0.14 }));
  const L = { kick: 0.82, impactKick: 0.95, clap: 0.5, snare: 0.4, hat: 0.2, open: 0.22, roll: 0.5 };

  for (const e of ev.kick) put(dry, kicks[e.kind], e.at, e.vel * (e.kind === 'impact' ? L.impactKick : L.kick));
  ev.clap.forEach((e, i) => put(snareBus, claps[i % 3], e.at, e.vel * L.clap, ((i % 3) - 1) * 0.12));
  ev.snare.forEach((e, i) => put(snareBus, snares[i % 2], e.at, e.vel * L.snare));
  ev.roll.forEach(e => put(snareBus, rollSnares[Math.round(e.u * 7)], e.at, e.vel * L.roll));
  ev.hat.forEach((e, i) => put(dry, closed[(e.step * 7 + 3) % 3], e.at, e.vel * L.hat, i % 2 ? 0.25 : -0.25));
  ev.open.forEach((e, i) => put(dry, opens[i % 2], e.at, e.vel * L.open, i % 2 ? -0.2 : 0.2, 2 * STEP));
  applyGain(dry, gap);
  applyGain(snareBus, gap);

  const plate = new Reverb({ rt60: 0.9, damp: 0.4, predelay: 0.01, hp: 300, lp: 8000, modDepth: 3 });
  const wet = plate.process(snareBus.l, snareBus.r);
  const out = stereo();
  for (let i = 0; i < N; i++) {
    out.l[i] = dry.l[i] + snareBus.l[i] + wet.l[i] * 0.22;
    out.r[i] = dry.r[i] + snareBus.r[i] + wet.r[i] * 0.22;
  }
  return out;
}

function bassPattern(bar) {
  const sc = BAR_SEC[bar];
  if (sc.role === 'bed') return inLift(sc, bar * 2) ? BASS_PATTERNS.build : BASS_PATTERNS.hook;
  return BASS_PATTERNS[sc.role];
}

function renderBass(presence, gap) {
  const gainAt = roleCurve(AUTO.bassGain);
  const sawAt = roleCurve(AUTO.bassSaw);
  const mono = new Float32Array(N);
  for (let bar = 0; bar < BARS; bar++) {
    const pattern = bassPattern(bar);
    if (!pattern) continue;
    const root = CHORDS[BAR_CHORDS[bar]].root;
    for (const [s, len, off] of pattern) {
      const at = bar * BAR + s * STEP;
      addBassNote(mono, at, len * STEP, root + off, gainAt(at / SR), sawAt(at / SR));
    }
  }
  const duck = duckGain(presence, DUCK.bass);
  for (let i = 0; i < N; i++) mono[i] *= duck[i] * gap[i];
  return { l: mono, r: Float32Array.from(mono) };
}

function renderChords(presence, gap) {
  const bus = stereo();
  renderPadBus(bus.l, bus.r);
  const cut = bake(roleCurve(AUTO.padCut, { log: true }));
  for (const ch of [bus.l, bus.r]) { filterStatic(ch, new Biquad('hp', 160, 0.7)); sweepLowpass(ch, cut); }
  applyGain(bus, bake(roleCurve(AUTO.padGain)), duckGain(presence, DUCK.pad), gap);

  // downbeat stabs (added after ducking so they keep their attack)
  const AM = [57, 60, 64, 69, 72, 76];
  const stabs = [[IMPACT_TIME, [45, ...AM], { gain: 0.5, len: 2.4, tau: 0.7 }]];
  for (const tr of TRANSITIONS) {
    if (tr.entry === 'drop') stabs.push([tr.time, AM, { gain: 0.65, len: 1.2, tau: 0.3 }]);
    if (tr.entry === 'lift') stabs.push([tr.time, [45, ...AM], { gain: 0.8, len: 1.6, tau: 0.45 }]);
    if (tr.entry === 'final') stabs.push([tr.time, [45, ...AM, 81], { gain: 0.85, len: 4.0, tau: 1.0, ctau: 0.5, c0: 9500, c1: 1800 }]);
  }
  stabs.forEach(([t, notes, o], i) => addStab(bus.l, bus.r, sec(t), notes, { ...o, seed: 31 + i }));

  const hall = new Reverb({ rt60: 3.2, damp: 0.3, predelay: 0.025, hp: 260, lp: 8500 });
  const send = bake(roleCurve(AUTO.chordSend));
  const wet = hall.process(bus.l.map((v, i) => v * send[i]), bus.r.map((v, i) => v * send[i]));
  for (let i = 0; i < N; i++) { bus.l[i] += wet.l[i]; bus.r[i] += wet.r[i]; }
  return bus;
}

function renderArp(presence, gap) {
  const bus = stereo();
  const gainAt = roleCurve(AUTO.arpGain);
  const cutAt = roleCurve(AUTO.arpCut, { log: true });
  const from = SECTIONS.find(s => s.role === 'build')?.startBar ?? 1;
  const to = SECTIONS.at(-1).startBar; // the final hit
  for (let step = from * 16; step < to * 16; step++) {
    const bar = step >> 4;
    const j = step & 15;
    const t = (step * STEP) / SR;
    const sc = BAR_SEC[bar];
    const pair = sc.role === 'bed' ? Math.floor((bar - sc.startBar) / BED_BLOCK) % 2 : 0; // new pattern pair every block
    const midi = CHORDS[BAR_CHORDS[bar]].arp[ARP_PATTERNS[pair * 2 + (bar % 2)][j]];
    const pan = 0.5 * Math.sin((TAU * t) / 8);
    addArpNote(bus.l, bus.r, step * STEP, midi, ARP_VEL[j] * gainAt(t) * 0.29, cutAt(t), pan);
  }
  const duck = duckGain(presence, DUCK.arp);
  applyGain(bus, duck, gap);
  const delay = pingPong(bus.l, bus.r, { time: 3 * STEP, feedback: 0.45 });
  applyGain(delay, gap);
  const hall = new Reverb({ rt60: 2.6, damp: 0.35, predelay: 0.03, hp: 300, lp: 8000 });
  const wet = hall.process(bus.l, bus.r);
  const out = stereo();
  for (let i = 0; i < N; i++) {
    out.l[i] = bus.l[i] + delay.l[i] * 0.5 + wet.l[i] * 0.3;
    out.r[i] = bus.r[i] + delay.r[i] * 0.5 + wet.r[i] * 0.3;
  }
  return out;
}

/**
 * Which bars carry the lead hook, and transposed by how much. Drops state the hook in bars 0-3 and an
 * octave higher in bars 8-11 of every 16; drop2 / finale play it throughout (never under a roll).
 */
function leadBars() {
  const bars = new Map();
  for (let bar = 0; bar < BARS; bar++) {
    const sc = BAR_SEC[bar];
    const on = sc.lead ?? FULL_ROLES.has(sc.role);
    if (!on || ROLL_BARS.has(bar)) continue;
    const rel = (bar - sc.startBar) % 16;
    if (sc.role !== 'drop') bars.set(bar, 0);
    else if (rel < 4) bars.set(bar, 0);
    else if (rel >= 8 && rel < 12) bars.set(bar, 12);
  }
  return bars;
}

function renderLead(presence, gap) {
  const mono = new Float32Array(N);
  const gainAt = roleCurve(AUTO.leadGain);
  for (const [bar, up] of leadBars()) {
    const role = BAR_ROLE[bar];
    for (const [s, len, midi] of LEAD_MOTIF[BAR_CHORDS[bar]]) {
      const at = bar * BAR + s * STEP;
      const g = 0.32 * gainAt(at / SR);
      const bright = role === 'finale' ? 3400 : 2600;
      addLeadNote(mono, at, len * STEP - sec(0.012), midi + up, g, bright);
      if (role === 'finale') addLeadNote(mono, at, len * STEP - sec(0.012), midi + 12, g * 0.5, bright * 1.2);
    }
  }
  const duck = duckGain(presence, DUCK.lead);
  for (let i = 0; i < N; i++) mono[i] *= duck[i] * gap[i];
  const delay = pingPong(mono, mono, { time: 3 * STEP, feedback: 0.4 });
  applyGain(delay, gap);
  const hall = new Reverb({ rt60: 2.4, damp: 0.35, predelay: 0.03, hp: 300, lp: 8000 });
  const wet = hall.process(mono, mono);
  const out = stereo();
  for (let i = 0; i < N; i++) {
    out.l[i] = mono[i] + delay.l[i] * 0.4 + wet.l[i] * 0.25;
    out.r[i] = mono[i] + delay.r[i] * 0.4 + wet.r[i] * 0.25;
  }
  return out;
}

/** Risers, impacts, crashes - all positioned from the section transitions (bar lines). */
function renderFx() {
  const bus = stereo();
  const onBoth = fn => { fn(bus.l, 0); fn(bus.r, 1); };
  const reverse = a => Float32Array.from(a).reverse();

  const crash = (t, gain, seed) => {
    addInto(bus.l, makeCrash(seed), sec(t), gain);
    addInto(bus.r, makeCrash(seed + 1), sec(t), gain);
  };
  const boom = (t, gain, decay = 0.8, dur = 3) => onBoth(b => addTone(b, t, dur, { f0: 96, f1: 55, glide: 0.07, decay, attack: 0.002, drive: 0.8, amp: gain }));
  const noiseBurst = (t, gain, decay = 0.35, seed = 1) => onBoth((b, c) => {
    addNoise(b, t, 1.5, { amp: gain, decay, seed: seed + c, filters: [new Biquad('lp', 6500, 0.7), new Biquad('hp', 100, 0.7)] });
    addNoise(b, t, 2.5, { amp: gain * 0.4, decay: decay * 2.5, seed: seed + 10 + c, filters: [new Biquad('lp', 400, 0.7)] });
  });
  const riser = (end, dur, gain, { tonal = 0.25, f0 = 300, f1 = 10000, seed = 1 } = {}) => {
    RISERS.push({ start: end - dur, end });
    onBoth((b, c) => addNoiseSweep(b, end - dur, dur, { f0, f1, q: 1.1, ampAt: u => gain * u ** 2.2, seed: seed + c }));
    if (tonal) onBoth(b => addSweepTone(b, end - dur, dur, u => 220 * 4 ** (u ** 1.5), u => tonal * gain * u ** 2.2));
  };

  // intro: reversed-cymbal riser + sub rise landing on the impact, then sub boom + noise burst (the kick is in the drum stem)
  const T = IMPACT_TIME;
  onBoth((b, c) => addInto(b, reverse(makeCrash(41 + c, T, 0.5)), 0, 0.3));
  onBoth(b => addSweepTone(b, 0, T, u => 27.5 * 2 ** u, u => 0.3 * u ** 2));
  riser(T, T, 0.08, { tonal: 0, f0: 400, f1: 9000, seed: 51 });
  boom(T, 0.75, 0.38, 2.0);
  noiseBurst(T, 0.55, 0.2, 61);

  TRANSITIONS.forEach((tr, i) => {
    const t = tr.time;
    const seed = 71 + i * 10;
    const strong = tr.prev.role === 'breakdown';
    if (tr.entry === 'rise') riser(t, 2, 0.1, { tonal: 0, f0: 500, f1: 6000, seed });
    if (tr.entry === 'soft') { riser(t, 4, 0.3, { tonal: 0.1, seed }); crash(t, 0.3, seed + 5); }
    if (tr.entry === 'drop') { riser(t, 4, strong ? 0.9 : 0.7, { seed }); crash(t, strong ? 0.8 : 0.7, seed + 5); boom(t, strong ? 0.6 : 0.55, 0.5, 1.5); }
    if (tr.entry === 'lift') { riser(t, 2, 0.35, { tonal: 0.15, seed }); crash(t, 0.75, seed + 5); boom(t, 0.65, 0.6, 1.8); }
    if (tr.entry === 'down') { // down-sweep into a breakdown
      onBoth((b, c) => addNoiseSweep(b, t, 1.8, { f0: 7000, f1: 250, q: 1, ampAt: u => 0.35 * (1 - u) ** 2, seed: seed + c }));
      onBoth(b => addSweepTone(b, t, 0.9, u => 62 - 30 * u, u => 0.45 * (1 - u) ** 1.5));
    }
    if (tr.entry === 'final') { riser(t, 4, 0.9, { seed }); crash(t, 0.6, seed + 5); boom(t, 0.7, 0.9, 3.5); noiseBurst(t, 0.5, 0.4, seed + 7); }
  });
  // beds: a soft swell into each new 16-bar block
  for (const s of SECTIONS.filter(x => x.role === 'bed')) {
    for (let t = s.start + BED_BLOCK * 2, k = 0; t < s.end; t += BED_BLOCK * 2, k++) riser(t, 2, 0.12, { tonal: 0, f0: 600, f1: 7000, seed: 301 + k * 2 });
  }

  // the fx stem is its own reverb send; the long hall carries the ring-out
  const hall = new Reverb({ rt60: 3.2, damp: 0.3, predelay: 0.02, hp: 250, lp: 9000 });
  const send = bake(roleCurve(AUTO.fxSend));
  const wet = hall.process(bus.l.map((v, i) => v * send[i]), bus.r.map((v, i) => v * send[i]));
  for (let i = 0; i < N; i++) { bus.l[i] += wet.l[i]; bus.r[i] += wet.r[i]; }
  return bus;
}

/* ========================================================================== 6. master bus */

/** Start/end fades shared by every stem: 4 ms in; smooth fade-out from 1.2 s after the final hit to exactly zero 100 ms before the end. */
function endFades() {
  const a = SECTIONS.at(-1).start + 1.2;
  const b = N / SR - 0.1;
  return bake(t => {
    const head = Math.min(1, t / 0.004);
    const tail = t < a ? 1 : t >= b ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - a)) / (b - a));
    return head * tail;
  }, N, 1);
}

/** Per-section dB shaping for one stem (linear ramps over each section, 50 ms cross-ramps between sections). */
function sectionGainCurve(stem) {
  const keys = [];
  for (const s of SECTIONS) {
    const [a, b] = s.db?.[stem] ?? SECTION_DB[stem][s.role] ?? [0, 0];
    const [ga, gb] = s.gainDb ?? [0, 0];
    keys.push([s.start, a + ga], [s.end - 0.05, b + gb]);
  }
  const kf = keyframes(keys);
  return bake(t => dbToLin(kf(t)));
}

/** Peak-detecting, stereo-linked gentle bus compressor. Returns a linear gain curve. */
function compressorGain(L, R, { threshold = -9, ratio = 2, knee = 6, attack = 0.02, release = 0.25 } = {}) {
  const g = new Float32Array(L.length);
  const ca = Math.exp(-1 / (attack * SR));
  const cr = Math.exp(-1 / (release * SR));
  let gr = 0;
  for (let i = 0; i < L.length; i++) {
    const lvl = linToDb(Math.max(Math.abs(L[i]), Math.abs(R[i])));
    const over = lvl - threshold;
    let out;
    if (2 * over < -knee) out = lvl;
    else if (2 * Math.abs(over) <= knee) out = lvl + ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
    else out = threshold + over / ratio;
    const target = out - lvl;
    gr = target < gr ? ca * gr + (1 - ca) * target : cr * gr + (1 - cr) * target;
    g[i] = dbToLin(gr);
  }
  return g;
}

/** Look-ahead soft limiter: tanh knee above 85 % of the ceiling, sliding-min + moving-average smoothing (2 ms). */
function limiterGain(L, R, ceiling, la = sec(0.002)) {
  const n = L.length;
  const th = ceiling * 0.85;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    raw[i] = p <= th ? 1 : (th + (ceiling - th) * Math.tanh((p - th) / (ceiling - th))) / p;
  }
  // m[i] = min(raw[i .. i+la]) via a monotonic deque
  const w = la + 1;
  const m = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && raw[dq[tail - 1]] >= raw[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + w - 1) head++;
    m[i] = raw[dq[head]];
  }
  // out[i] = mean(m[i-w+1 .. i])
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += m[i];
    if (i >= w) acc -= m[i - w];
    out[i] = (acc + Math.max(0, w - 1 - i)) / w; // pad with 1.0 before t=0
  }
  return out;
}

/** BS.1770 K-weighted energy per 100 ms hop (sum of both channels' mean squares). */
function hopEnergies(L, R, from = 0, to = L.length) {
  const hop = sec(0.1);
  const out = [];
  // BS.1770 K-weighting at 48 kHz: high-shelf pre-filter, then the RLB high-pass
  const chans = [L, R].map(() => [
    Biquad.fromCoefs(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
    Biquad.fromCoefs(1, -2, 1, -1.99004745483398, 0.99007225036621),
  ]);
  for (let h = from; h + hop <= to; h += hop) {
    let e = 0;
    [L, R].forEach((x, c) => {
      let s = 0;
      for (let i = h; i < h + hop; i++) {
        let v = x[i];
        for (const f of chans[c]) v = f.process(v);
        s += v * v;
      }
      e += s / hop;
    });
    out.push(e);
  }
  return out;
}

/** Integrated loudness (LUFS) with the standard -70 LU absolute and -10 LU relative gates. */
function integratedLufs(L, R, from = 0, to = L.length) {
  const hops = hopEnergies(L, R, from, to);
  const blocks = [];
  for (let i = 0; i + 4 <= hops.length; i++) blocks.push((hops[i] + hops[i + 1] + hops[i + 2] + hops[i + 3]) / 4);
  const lufs = e => -0.691 + 10 * Math.log10(e);
  const abs = blocks.filter(e => lufs(e) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = abs.filter(e => lufs(e) > rel);
  return lufs(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** True peak (dBTP) via 4x oversampling with a windowed-sinc interpolator, scanning only near large samples. */
function truePeakDb(L, R) {
  const taps = 12;
  const phases = [1, 2, 3].map(p => {
    const frac = p / 4;
    return Array.from({ length: 2 * taps }, (_, i) => {
      const m = i - taps + 1;
      const x = m - frac;
      const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
      return sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (taps + 1)));
    });
  });
  let peak = 0;
  for (const x of [L, R]) {
    let sp = 0;
    for (let i = 0; i < x.length; i++) sp = Math.max(sp, Math.abs(x[i]));
    peak = Math.max(peak, sp);
    const screen = sp * 0.35;
    for (let i = taps; i < x.length - taps - 1; i++) {
      if (Math.abs(x[i]) < screen && Math.abs(x[i + 1]) < screen) continue;
      for (const h of phases) {
        let y = 0;
        for (let k = 0; k < 2 * taps; k++) y += x[i + k - taps + 1] * h[k];
        peak = Math.max(peak, Math.abs(y));
      }
    }
  }
  return linToDb(peak);
}

/**
 * Sum -> pre-scale -> bus compressor -> make-up gain + soft limiter, iterated until the integrated
 * loudness hits TARGET_LUFS with the true peak under the limit. Returns one gain curve for all stems.
 */
function masterGainCurve(sum) {
  const peak0 = Math.max(...[sum.l, sum.r].map(x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
  const pre = 0.89 / peak0;
  const L = sum.l.map(v => v * pre);
  const R = sum.r.map(v => v * pre);
  const comp = compressorGain(L, R);
  const grDb = comp.map(g => -linToDb(g));
  log(`  bus compressor: mean gain reduction ${(grDb.reduce((a, b) => a + b, 0) / grDb.length).toFixed(2)} dB, max ${grDb.reduce((a, b) => Math.max(a, b), 0).toFixed(2)} dB`);
  const cl = L.map((v, i) => v * comp[i]);
  const cr = R.map((v, i) => v * comp[i]);

  let ceilingDb = -2.5;
  let makeup = 1;
  let result;
  for (let pass = 0; pass < 6; pass++) {
    for (let iter = 0; iter < 5; iter++) {
      const ceiling = dbToLin(ceilingDb);
      const lim = limiterGain(cl.map(v => v * makeup), cr.map(v => v * makeup), ceiling);
      const yl = cl.map((v, i) => v * makeup * lim[i]);
      const yr = cr.map((v, i) => v * makeup * lim[i]);
      const lufs = integratedLufs(yl, yr);
      result = { lim, yl, yr, lufs };
      if (Math.abs(lufs - TARGET_LUFS) < 0.03) break;
      makeup *= dbToLin(TARGET_LUFS - lufs);
    }
    const tp = truePeakDb(result.yl, result.yr);
    result.tp = tp;
    log(`  master pass ${pass}: ${result.lufs.toFixed(2)} LUFS, true peak ${tp.toFixed(2)} dBTP (ceiling ${ceilingDb.toFixed(2)} dBFS)`);
    if (tp <= TRUE_PEAK_LIMIT - 0.1) break;
    ceilingDb -= tp - (TRUE_PEAK_LIMIT - 0.15);
  }
  const total = new Float32Array(N);
  for (let i = 0; i < N; i++) total[i] = pre * comp[i] * makeup * result.lim[i];
  return { curve: total, lufs: result.lufs, truePeak: result.tp, makeupDb: linToDb(makeup * pre), limiterMaxDb: linToDb(result.lim.reduce((m, v) => Math.min(m, v), 1)) };
}

/* ========================================================================== 7. SFX */

const newSfx = dur => ({ n: sec(dur), l: new Float32Array(sec(dur)), r: new Float32Array(sec(dur)) });
/** Run a layer builder on both channels (ch = 0/1 so noise layers can be decorrelated). */
const both = (s, fn) => { fn(s.l, 0); fn(s.r, 1); };
const nf = (type, f, q) => new Biquad(type, f, q);

/** Turn a mono signal into stereo with a pan that moves over normalised time. */
function panMono(m, panAt) {
  const n = m.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [gl, gr] = panGains(panAt(i / (n - 1)));
    l[i] = m[i] * gl;
    r[i] = m[i] * gr;
  }
  return { n, l, r };
}

function addPlate(s, wet, rt60 = 0.9) {
  const rv = new Reverb({ rt60, damp: 0.4, predelay: 0.008, hp: 250, lp: 8000, modDepth: 3 });
  const w = rv.process(s.l, s.r);
  for (let i = 0; i < s.n; i++) { s.l[i] += w.l[i] * wet; s.r[i] += w.r[i] * wet; }
}

const SFX = {
  impact_low: { fadeOut: 0.25, build() {
    const s = newSfx(1.5);
    both(s, b => {
      addTone(b, 0, 1.5, { f0: 100, f1: 46, glide: 0.06, decay: 0.42, drive: 1, attack: 0.002 });
      addTone(b, 0, 0.5, { f0: 200, f1: 92, glide: 0.04, decay: 0.12, amp: 0.35 });
    });
    both(s, (b, c) => {
      addNoise(b, 0, 1.2, { amp: 0.8, decay: 0.3, seed: 11 + c, attack: 0.0008, filters: [nf('lp', 7000), nf('hp', 90)] });
      addNoise(b, 0, 1.4, { amp: 0.5, decay: 0.6, seed: 21 + c, filters: [nf('lp', 400)] });
    });
    addPlate(s, 0.25);
    return s;
  } },
  riser_2s: { fadeOut: 0.004, build() {
    const s = newSfx(2);
    both(s, (b, c) => addNoiseSweep(b, 0, 2, { f0: 250, f1: 9000, q: 1.1, ampAt: u => u ** 2.2, seed: 31 + c }));
    both(s, b => addSweepTone(b, 0, 2, u => 110 * 8 ** (u ** 1.5), u => 0.25 * u ** 2.2));
    return s;
  } },
  whoosh_fast: { fadeOut: 0.03, build() {
    const m = new Float32Array(sec(0.35));
    addNoiseSweep(m, 0, 0.35, { f0: 500, f1: 6000, q: 1.2, ampAt: u => Math.sin(Math.PI * u ** 0.7) ** 2, seed: 41 });
    return panMono(m, u => -0.7 + 1.4 * u);
  } },
  whoosh_slow: { fadeOut: 0.06, build() {
    const m = new Float32Array(sec(0.9));
    addNoiseSweep(m, 0, 0.9, { f0: 220, f1: 3200, q: 0.9, ampAt: u => Math.sin(Math.PI * u) ** 2, seed: 42 });
    return panMono(m, u => -0.5 + u);
  } },
  swoosh_in: { fadeOut: 0.04, build() {
    const m = new Float32Array(sec(0.5));
    addNoiseSweep(m, 0, 0.5, { f0: 350, f1: 4200, q: 1.1, ampAt: u => (u < 0.7 ? (u / 0.7) ** 1.5 : ((1 - u) / 0.3) ** 1.5), seed: 43 });
    return panMono(m, u => 0.6 * (1 - u));
  } },
  swoosh_out: { fadeOut: 0.05, build() {
    const m = new Float32Array(sec(0.5));
    addNoiseSweep(m, 0, 0.5, { f0: 4200, f1: 300, q: 1.1, ampAt: u => (u < 0.08 ? u / 0.08 : (1 - u) ** 1.6), seed: 44 });
    return panMono(m, u => -0.6 * u);
  } },
  click: { fadeOut: 0.012, build() {
    const s = newSfx(0.07);
    both(s, b => {
      addTone(b, 0, 0.05, { f0: 1800, decay: 0.006, amp: 0.8, attack: 0.0003 });
      addTone(b, 0, 0.05, { f0: 420, decay: 0.012, amp: 0.35, attack: 0.0003 });
      addNoise(b, 0, 0.02, { decay: 0.002, amp: 0.7, seed: 51, attack: 0.0001, filters: [nf('bp', 3500, 1)] });
      addTone(b, 0.045, 0.02, { f0: 2200, decay: 0.004, amp: 0.4, attack: 0.0003 });
      addNoise(b, 0.045, 0.01, { decay: 0.0015, amp: 0.3, seed: 52, attack: 0.0001, filters: [nf('bp', 4000, 1)] });
    });
    return s;
  } },
  click_soft: { fadeOut: 0.02, build() {
    const s = newSfx(0.08);
    both(s, b => {
      addTone(b, 0, 0.06, { f0: 900, decay: 0.01, amp: 0.6, attack: 0.0006 });
      addNoise(b, 0, 0.02, { decay: 0.004, amp: 0.4, seed: 53, attack: 0.0004, filters: [nf('lp', 3500)] });
      addTone(b, 0.05, 0.03, { f0: 1100, decay: 0.006, amp: 0.25, attack: 0.0005 });
    });
    return s;
  } },
  pop: { fadeOut: 0.02, build() {
    const s = newSfx(0.12);
    both(s, b => {
      addTone(b, 0, 0.12, { f0: 380, f1: 1150, glide: 0.025, decay: 0.035, attack: 0.0015 });
      addNoise(b, 0, 0.01, { decay: 0.002, amp: 0.3, seed: 61, filters: [nf('bp', 2500, 1)] });
    });
    return s;
  } },
  pop_up: { fadeOut: 0.02, build() {
    const s = newSfx(0.1);
    both(s, b => {
      addTone(b, 0, 0.1, { f0: 700, f1: 2000, glide: 0.02, decay: 0.028, attack: 0.001 });
      addNoise(b, 0, 0.01, { decay: 0.002, amp: 0.25, seed: 62, filters: [nf('bp', 3500, 1)] });
    });
    return s;
  } },
  tick: { fadeOut: 0.008, build() {
    const s = newSfx(0.03);
    both(s, b => {
      addTone(b, 0, 0.03, { f0: 3000, decay: 0.004, attack: 0.0002 });
      addNoise(b, 0, 0.01, { decay: 0.0015, amp: 0.5, seed: 63, attack: 0.0001, filters: [nf('hp', 2500)] });
    });
    return s;
  } },
  toggle_on: { fadeOut: 0.03, build() {
    const s = newSfx(0.14);
    both(s, b => {
      addTone(b, 0, 0.06, { f0: 660, decay: 0.02, attack: 0.001 });
      addTone(b, 0.045, 0.09, { f0: 990, decay: 0.025, amp: 0.9, attack: 0.001 });
      addNoise(b, 0, 0.01, { decay: 0.002, amp: 0.3, seed: 64, filters: [nf('bp', 3000, 1)] });
    });
    return s;
  } },
  toggle_off: { fadeOut: 0.03, build() {
    const s = newSfx(0.14);
    both(s, b => {
      addTone(b, 0, 0.06, { f0: 880, decay: 0.02, amp: 0.8, attack: 0.001 });
      addTone(b, 0.045, 0.09, { f0: 560, decay: 0.025, amp: 0.9, attack: 0.001 });
      addNoise(b, 0, 0.01, { decay: 0.002, amp: 0.25, seed: 65, filters: [nf('bp', 2200, 1)] });
    });
    return s;
  } },
  shutter: { fadeOut: 0.04, build() {
    const s = newSfx(0.25);
    both(s, (b, c) => {
      addNoise(b, 0, 0.05, { decay: 0.012, amp: 1, seed: 71 + c, attack: 0.0002, filters: [nf('hp', 1200), nf('bp', 2800, 1.2)] });
      addTone(b, 0, 0.06, { f0: 160, decay: 0.02, amp: 0.5, attack: 0.0005 });
      addNoise(b, 0.01, 0.07, { decay: 0.04, amp: 0.12, seed: 73 + c, attack: 0.01, filters: [nf('bp', 5000, 2)] });
      addNoise(b, 0.085, 0.07, { decay: 0.009, amp: 0.8, seed: 75 + c, attack: 0.0002, filters: [nf('hp', 1500), nf('bp', 3600, 1.2)] });
      addTone(b, 0.085, 0.06, { f0: 220, decay: 0.015, amp: 0.45, attack: 0.0005 });
    });
    return s;
  } },
  chime_success: { fadeOut: 0.3, build() {
    const s = newSfx(0.9);
    [[0, 784], [0.13, 1047], [0.26, 1319]].forEach(([t, f], i) => both(s, b => {
      const d = i === 2 ? 0.45 : 0.25;
      addTone(b, t, 0.8, { f0: f, decay: d, attack: 0.002, amp: 0.8 });
      addTone(b, t, 0.5, { f0: f * 2, decay: d * 0.5, attack: 0.002, amp: 0.25 });
      addTone(b, t, 0.3, { f0: f * 2.76, decay: d * 0.25, attack: 0.002, amp: 0.1 });
    }));
    addPlate(s, 0.3, 1.2);
    return s;
  } },
  type: { fadeOut: 0.015, build() {
    const s = newSfx(0.07);
    both(s, b => {
      addTone(b, 0, 0.05, { f0: 240, f1: 180, glide: 0.01, decay: 0.012, amp: 0.5, attack: 0.0006 });
      addNoise(b, 0, 0.02, { decay: 0.004, amp: 0.5, seed: 81, attack: 0.0003, filters: [nf('lp', 5000), nf('hp', 600)] });
    });
    return s;
  } },
  sparkle: { fadeOut: 0.25, build() {
    const s = newSfx(1.0);
    const r = rng(91);
    const freqs = [1760, 2093, 2349, 2637, 3136, 3520, 4186];
    const pans = [];
    for (let i = 0; i < 28; i++) {
      const t = r() * 0.7;
      const f = freqs[Math.floor(r() * freqs.length)];
      const ping = new Float32Array(s.n);
      addTone(ping, t, 0.5, { f0: f, decay: 0.08 + r() * 0.22, attack: 0.001, amp: 0.3 + r() * 0.7 });
      pans.push([ping, r() * 2 - 1]);
    }
    for (const [ping, p] of pans) {
      const [gl, gr] = panGains(p);
      for (let i = 0; i < s.n; i++) { s.l[i] += ping[i] * gl; s.r[i] += ping[i] * gr; }
    }
    both(s, (b, c) => addNoise(b, 0, 1, { amp: 0.1, decay: 0.4, seed: 92 + c, attack: 0.02, filters: [nf('bp', 6000, 1.5)] }));
    addPlate(s, 0.25, 1.1);
    return s;
  } },
  strike: { fadeOut: 0.04, build() {
    const m = new Float32Array(sec(0.2));
    addNoiseSweep(m, 0, 0.2, { f0: 800, f1: 8000, q: 1.4, ampAt: u => Math.min(1, u / 0.02) * Math.exp(-u * 4.5), seed: 95 });
    return panMono(m, u => -0.8 + 1.6 * u);
  } },
  thud_soft: { fadeOut: 0.05, build() {
    const s = newSfx(0.25);
    both(s, (b, c) => {
      addTone(b, 0, 0.25, { f0: 120, f1: 52, glide: 0.03, decay: 0.07, drive: 0.6, attack: 0.002 });
      addNoise(b, 0, 0.05, { decay: 0.02, amp: 0.35, seed: 97 + c, attack: 0.001, filters: [nf('lp', 500)] });
    });
    return s;
  } },
};

/** Fade both ends to exactly zero, remove DC without moving the end points, peak-normalise to -3 dBFS. */
function finishSfx(s, { fadeIn = 0.001, fadeOut = 0.01 }) {
  const fi = Math.min(sec(fadeIn), s.n >> 1);
  const fo = Math.min(sec(fadeOut), s.n >> 1);
  const win = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const fromEnd = s.n - 1 - i;
    win[i] = (i < fi ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fi) : 1) * (fromEnd < fo ? 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fo) : 1);
  }
  const winSum = win.reduce((a, b) => a + b, 0);
  for (const ch of [s.l, s.r]) {
    let sum = 0;
    for (let i = 0; i < s.n; i++) { ch[i] *= win[i]; sum += ch[i]; }
    const c = sum / winSum; // subtract c * win so the mean is exactly 0 and the ends stay at 0
    for (let i = 0; i < s.n; i++) ch[i] -= c * win[i];
  }
  let peak = 0;
  for (let i = 0; i < s.n; i++) peak = Math.max(peak, Math.abs(s.l[i]), Math.abs(s.r[i]));
  const g = dbToLin(-3) / peak;
  for (let i = 0; i < s.n; i++) { s.l[i] *= g; s.r[i] *= g; }
  return s;
}

/* ========================================================================== 8. I/O */

function encodeWav(chans, { float }) {
  const n = chans[0].length;
  const ch = chans.length;
  const bytes = float ? 4 : 3;
  const dataLen = n * ch * bytes;
  const head = 12 + 24 + (float ? 12 : 0) + 8;
  const buf = Buffer.alloc(head + dataLen);
  let o = 0;
  buf.write('RIFF', o); buf.writeUInt32LE(head - 8 + dataLen, o + 4); buf.write('WAVE', o + 8); o += 12;
  buf.write('fmt ', o); buf.writeUInt32LE(16, o + 4); buf.writeUInt16LE(float ? 3 : 1, o + 8); buf.writeUInt16LE(ch, o + 10);
  buf.writeUInt32LE(SR, o + 12); buf.writeUInt32LE(SR * ch * bytes, o + 16); buf.writeUInt16LE(ch * bytes, o + 20); buf.writeUInt16LE(bytes * 8, o + 22); o += 24;
  if (float) { buf.write('fact', o); buf.writeUInt32LE(4, o + 4); buf.writeUInt32LE(n, o + 8); o += 12; }
  buf.write('data', o); buf.writeUInt32LE(dataLen, o + 4); o += 8;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      if (float) buf.writeFloatLE(chans[c][i], o);
      else buf.writeIntLE(Math.round(clamp(chans[c][i], -1, 1) * 8388607), o, 3);
      o += bytes;
    }
  }
  return buf;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let o = 12;
  let fmt;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(o + 8), ch: buf.readUInt16LE(o + 10), sr: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') {
      const bytes = fmt.bits / 8;
      const n = Math.floor(size / (bytes * fmt.ch));
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n));
      let p = o + 8;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          chans[c][i] = fmt.tag === 3 ? buf.readFloatLE(p) : buf.readIntLE(p, bytes) / 2 ** (fmt.bits - 1);
          p += bytes;
        }
      }
      return { sr: fmt.sr, bits: fmt.bits, chans };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}

const log = (...a) => console.log(...a);
const mkdir = p => fs.mkdirSync(p, { recursive: true });

function writeCues(out, sched) {
  const barsT = Array.from({ length: BARS + 1 }, (_, b) => b * 2);
  const cues = {
    bpm: BPM, beatsPerBar: 4, beatSeconds: BEAT, barSeconds: BEAT * 4, sixteenthSeconds: BEAT / 4,
    sampleRate: SR, durationSeconds: N / SR, key: 'A minor', progression: ['Am', 'F', 'C', 'G'],
    structure: STRUCTURE.label,
    hits: {
      impact: IMPACT_TIME,
      ...Object.fromEntries(SECTIONS.slice(1, -1).map(s => [s.id, s.start])),
      finalHit: SECTIONS.at(-1).start,
      end: N / SR,
    },
    sections: SECTIONS.map(s => ({ id: s.id, name: s.name, music: s.music, start: s.start, end: s.end, startBar: s.start / 2 + 1, bars: (s.end - s.start) / 2 })),
    risers: [...RISERS].sort((a, b) => a.start - b.start),
    silences: GAP_STEPS.map(([a, b]) => ({ start: (a * STEP) / SR, end: (b * STEP) / SR })),
    barChords: BAR_CHORDS.map((chord, i) => ({ bar: i + 1, start: i * 2, chord })),
    beats: Array.from({ length: BARS * 4 }, (_, i) => i * BEAT),
    bars: barsT.slice(0, BARS),
    kicks: sched.kick.map(e => e.at / SR),
    claps: [...new Set(sched.clap.map(e => e.at / SR))],
  };
  fs.writeFileSync(path.join(out, 'cues.json'), `${JSON.stringify(cues, null, 1)}\n`);
}

/* ========================================================================== 9. analysis */

const FFMPEG = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => spawnSync(p, ['-version']).status === 0);

function ffmpeg(args) {
  return spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function parseEbur(stderr) {
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = re => { const m = tail.match(re); return m ? Number(m[1]) : null; };
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

function bandRms(x, lo, hi, from, to) {
  const hp = new Biquad('hp', lo, 0.7);
  const lp = new Biquad('lp', hi, 0.7);
  let s = 0;
  for (let i = from; i < to; i++) { const v = lp.process(hp.process(x[i])); s += v * v; }
  return Math.sqrt(s / (to - from));
}

function runChecks(outDir, sched) {
  const checks = [];
  const check = (name, pass, detail) => { checks.push({ name, pass, detail }); log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
  const music = readWav(path.join(outDir, 'music.wav'));
  const [L, R] = music.chans;

  check('format', music.sr === SR && L.length === N && music.chans.length === 2, `${music.sr} Hz, ${L.length} frames = ${(L.length / music.sr).toFixed(6)} s, ${music.bits}-bit`);
  let bad = 0; let peak = 0; let sumL = 0; let sumR = 0;
  for (let i = 0; i < N; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) bad++;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sumL += L[i]; sumR += R[i];
  }
  check('finite samples', bad === 0, `${bad} NaN/Inf`);
  check('no clipping', peak < 1, `max |x| = ${peak.toFixed(4)} (${linToDb(peak).toFixed(2)} dBFS)`);
  check('no DC offset', Math.abs(sumL / N) < 0.001 && Math.abs(sumR / N) < 0.001, `mean L ${(sumL / N).toExponential(2)}, R ${(sumR / N).toExponential(2)}`);
  let head = 0; let tail = 0;
  for (let i = 0; i < 64; i++) head = Math.max(head, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = N - sec(0.1); i < N; i++) tail = Math.max(tail, Math.abs(L[i]), Math.abs(R[i]));
  check('first samples ~0', head < 1e-3, `max of first 64 = ${head.toExponential(2)}`);
  check('last 100 ms silent', tail < 1e-4, `max = ${tail.toExponential(2)} (${linToDb(tail).toFixed(0)} dBFS)`);

  // stems sum to the music exactly (they carry the same master gain curve)
  let maxDiff = 0;
  const stems = {};
  for (const name of ['drums', 'bass', 'chords', 'arp', 'lead', 'fx']) stems[name] = readWav(path.join(outDir, 'stems', `${name}.wav`)).chans;
  for (let i = 0; i < N; i += 7) {
    let l = 0; let r = 0;
    for (const s of Object.values(stems)) { l += s[0][i]; r += s[1][i]; }
    maxDiff = Math.max(maxDiff, Math.abs(l - L[i]), Math.abs(r - R[i]));
  }
  check('stems sum to music', maxDiff < 1e-4, `max difference ${maxDiff.toExponential(2)}`);
  let sideB = 0;
  for (let i = 0; i < N; i++) sideB = Math.max(sideB, Math.abs(stems.bass[0][i] - stems.bass[1][i]));
  check('bass is centred (mono)', sideB === 0, `max L-R ${sideB}`);

  // kick onsets sit on the sample grid: first sample above 5 % of the kick peak must be within 1.5 ms of the event
  const kickLow = new Float32Array(N);
  { const lp = new Biquad('lp', 150, 0.7); for (let i = 0; i < N; i++) kickLow[i] = lp.process(stems.drums[0][i]); }
  let worst = 0;
  for (const k of sched.kick.filter(e => e.vel >= 0.8)) {
    let pk = 0;
    for (let i = k.at; i < k.at + sec(0.05); i++) pk = Math.max(pk, Math.abs(kickLow[i]));
    let i = k.at - sec(0.004);
    while (i < k.at + sec(0.05) && Math.abs(kickLow[i]) < 0.05 * pk) i++;
    worst = Math.max(worst, Math.abs(i - k.at) / SR);
  }
  check('kick onsets on the grid', worst < 0.0015, `worst offset ${(worst * 1000).toFixed(2)} ms over ${sched.kick.filter(e => e.vel >= 0.8).length} kicks`);

  // risers: 4-10 kHz energy grows over the last 2 s before each hit
  const hitTimes = [IMPACT_TIME, ...TRANSITIONS.filter(t => t.entry === 'drop' || t.entry === 'final').map(t => t.time)];
  for (const hit of hitTimes) {
    const slice = t => bandRms(L, 4000, 10000, sec(t), sec(t + 0.25));
    const early = slice(hit - 2); const late = slice(hit - 0.75);
    check(`riser into ${hit}.0 s`, late > early * 2, `${linToDb(early).toFixed(1)} -> ${linToDb(late).toFixed(1)} dB`);
  }

  checkSfx(outDir, check);

  // energy map: section loudness ordering (ungated K-weighted, per section)
  const secL = {};
  for (const s of SECTIONS) {
    const hops = hopEnergies(L, R, sec(s.start), sec(s.end));
    secL[s.id] = -0.691 + 10 * Math.log10(hops.reduce((a, b) => a + b, 0) / hops.length);
  }
  const pairs = STRUCTURE.energyOrder ?? [];
  const broken = pairs.filter(([a, b]) => !(secL[a] < secL[b])).map(([a, b]) => `${a} !< ${b}`);
  check('energy map', broken.length === 0, `${SECTIONS.map(s => `${s.id} ${secL[s.id].toFixed(1)}`).join(' | ')}${broken.length ? ` - ${broken.join(', ')}` : ''}`);
  return { checks, sectionLufs: secL };
}

/** One-shots: -3 dBFS peak, no DC, silent first/last sample, no NaN. */
function checkSfx(outDir, check) {
  const dir = path.join(outDir, 'sfx');
  if (!fs.existsSync(dir)) return;
  const problems = [];
  let count = 0;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.wav'))) {
    const { chans, bits, sr } = readWav(path.join(dir, f));
    count++;
    const peak = Math.max(...chans.map(c => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    const mean = Math.max(...chans.map(c => Math.abs(c.reduce((a, v) => a + v, 0) / c.length)));
    const ends = Math.max(...chans.map(c => Math.max(Math.abs(c[0]), Math.abs(c[c.length - 1]))));
    if (Math.abs(linToDb(peak) + 3) > 0.1) problems.push(`${f} peak ${linToDb(peak).toFixed(2)} dBFS`);
    if (mean > 5e-4) problems.push(`${f} DC ${mean.toExponential(1)}`);
    if (ends > 1e-5) problems.push(`${f} end samples ${ends.toExponential(1)}`);
    if (chans.length !== 2 || sr !== SR || bits !== 24) problems.push(`${f} format`);
  }
  check('sfx one-shots', problems.length === 0 && count > 0, problems.length ? problems.join('; ') : `${count} files: stereo 48 kHz 24-bit, peak -3 dBFS, no DC, zero first/last sample`);
}

function runFfmpegAnalysis(outDir) {
  const dir = path.join(outDir, 'analysis');
  mkdir(dir);
  const wav = path.join(outDir, 'music.wav');
  ffmpeg(['-i', wav, '-lavfi', 'showspectrumpic=s=1600x600:legend=1', path.join(dir, 'spec.png')]);
  ffmpeg(['-i', wav, '-lavfi', 'showspectrumpic=s=1600x600:legend=1:fscale=log:scale=log', path.join(dir, 'spec_log.png')]);
  ffmpeg(['-i', wav, '-filter_complex', 'showwavespic=s=1600x300:colors=#22c55e', '-frames:v', '1', path.join(dir, 'waveform.png')]);

  const fullRun = ffmpeg(['-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr;
  const full = parseEbur(fullRun);
  // momentary (400 ms) / short-term (3 s) loudness over time, every 100 ms
  const timeline = [...fullRun.matchAll(/t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|-?inf)\s+S:\s*(-?[\d.]+|-?inf)/g)]
    .map(m => ({ t: Number(m[1]), m: Number(m[2]), s: Number(m[3]) }));
  fs.writeFileSync(path.join(dir, 'loudness_timeline.csv'), `t,momentary_lufs,shortterm_lufs\n${timeline.map(r => `${r.t},${r.m},${r.s}`).join('\n')}\n`);
  const rows = SECTIONS.map(s => {
    const seg = ['-ss', String(s.start), '-t', String(s.end - s.start), '-i', wav];
    const e = parseEbur(ffmpeg([...seg, '-af', 'ebur128=peak=true', '-f', 'null', '-']).stderr);
    const a = ffmpeg([...seg, '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level', '-f', 'null', '-']).stderr;
    const rms = a.match(/RMS level dB:\s*(-?[\d.]+|-inf)/);
    const inSec = timeline.filter(r => r.t > s.start + 0.4 && r.t <= s.end && Number.isFinite(r.m));
    return {
      id: s.id, start: s.start, end: s.end, lufs: e.I, rmsDb: rms ? Number(rms[1]) : null, truePeak: e.truePeak,
      momentaryMax: Math.max(...inSec.map(r => r.m)),
    };
  });
  const text = ['section        start   end   LUFS(int)  RMS dBFS  momentary max  true peak',
    ...rows.map(r => `${r.id.padEnd(12)} ${String(r.start).padStart(6)} ${String(r.end).padStart(5)} ${String(r.lufs).padStart(10)} ${r.rmsDb.toFixed(1).padStart(9)} ${r.momentaryMax.toFixed(1).padStart(14)} ${String(r.truePeak).padStart(10)}`),
    '', `full file: I ${full.I} LUFS, LRA ${full.LRA} LU, true peak ${full.truePeak} dBTP`].join('\n');
  fs.writeFileSync(path.join(dir, 'section_loudness.txt'), `${text}\n`);
  fs.writeFileSync(path.join(dir, 'loudness.json'), `${JSON.stringify({ full, sections: rows }, null, 1)}\n`);
  log(text);
  return { full, rows };
}

/* ========================================================================== 10. main */

function parseArgs(argv) {
  const args = { out: path.resolve('synth-audio-out'), structure: 'launch', sfx: true, analysis: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--structure') args.structure = argv[++i];
    else if (argv[i] === '--lufs') args.lufs = Number(argv[++i]);
    else if (argv[i] === '--skip-sfx') args.sfx = false;
    else if (argv[i] === '--skip-analysis') args.analysis = false;
    else { console.error('usage: synth-audio.mjs --out <dir> [--structure launch|walkthrough|<file.json>] [--lufs -17] [--skip-sfx] [--skip-analysis]'); process.exit(2); }
  }
  return args;
}

function buildMusic(outDir) {
  const t0 = Date.now();
  const lap = what => log(`  ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const sched = scheduleDrums();
  const presence = buildDuckPresence(sched.kick);
  const gap = buildGap();
  const stems = {};
  stems.drums = renderDrums(sched, gap); lap('drums');
  stems.bass = renderBass(presence, gap); lap('bass');
  stems.chords = renderChords(presence, gap); lap('chords');
  stems.arp = renderArp(presence, gap); lap('arp');
  stems.lead = renderLead(presence, gap); lap('lead');
  stems.fx = renderFx(); lap('fx');

  const fades = endFades();
  const sum = stereo();
  for (const [name, s] of Object.entries(stems)) {
    const shape = sectionGainCurve(name);
    for (const ch of [s.l, s.r]) filterStatic(ch, new Biquad('hp', 22, Math.SQRT1_2)); // DC / sub-sonic blocker (kick lobes carry DC)
    for (let i = 0; i < N; i++) {
      const g = fades[i] * TRIM[name] * shape[i];
      s.l[i] *= g; s.r[i] *= g;
      sum.l[i] += s.l[i]; sum.r[i] += s.r[i];
    }
  }
  const master = masterGainCurve(sum);
  lap('master');
  log(`  makeup+pre ${master.makeupDb.toFixed(2)} dB, deepest limiter reduction ${master.limiterMaxDb.toFixed(2)} dB`);

  mkdir(path.join(outDir, 'stems'));
  const music = stereo();
  for (const [name, s] of Object.entries(stems)) {
    for (let i = 0; i < N; i++) { s.l[i] *= master.curve[i]; s.r[i] *= master.curve[i]; music.l[i] += s.l[i]; music.r[i] += s.r[i]; }
    fs.writeFileSync(path.join(outDir, 'stems', `${name}.wav`), encodeWav([s.l, s.r], { float: true }));
  }
  fs.writeFileSync(path.join(outDir, 'music.wav'), encodeWav([music.l, music.r], { float: true }));

  // per-stem K-weighted loudness by section (ungated, LUFS-style), so the balance is visible
  log('\n  stem loudness per section (K-weighted, ungated, LUFS-style)');
  log(`  ${'stem'.padEnd(8)}${SECTIONS.map(s => s.id.padStart(10)).join('')}`);
  for (const [name, s] of Object.entries({ ...stems, MUSIC: music })) {
    log(`  ${name.padEnd(8)}${SECTIONS.map(sc => {
      const hops = hopEnergies(s.l, s.r, sec(sc.start), sec(sc.end));
      return (-0.691 + 10 * Math.log10(hops.reduce((x, y) => x + y, 0) / hops.length + 1e-20)).toFixed(1).padStart(10);
    }).join('')}`);
  }
  return sched;
}

function buildSfx(outDir) {
  mkdir(path.join(outDir, 'sfx'));
  for (const [name, def] of Object.entries(SFX)) {
    const s = finishSfx(def.build(), { fadeOut: def.fadeOut });
    fs.writeFileSync(path.join(outDir, 'sfx', `${name}.wav`), encodeWav([s.l, s.r], { float: false }));
    log(`  sfx/${name}.wav  ${(s.n / SR).toFixed(3)} s`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Number.isFinite(args.lufs)) TARGET_LUFS = args.lufs;
  const structure = STRUCTURES[args.structure] ?? JSON.parse(fs.readFileSync(args.structure, 'utf8'));
  configure({ label: STRUCTURES[args.structure] ? args.structure : path.basename(args.structure), ...structure });
  mkdir(args.out);
  log(`synth-audio [${STRUCTURE.label}, ${N / SR} s] -> ${args.out}`);
  log('music');
  const sched = buildMusic(args.out);
  if (args.sfx) { log('\nsfx'); buildSfx(args.out); }
  writeCues(args.out, sched);
  if (args.analysis) {
    log('\nchecks');
    const { checks, sectionLufs } = runChecks(args.out, sched);
    mkdir(path.join(args.out, 'analysis'));
    fs.writeFileSync(path.join(args.out, 'analysis', 'checks.json'), `${JSON.stringify({ checks, sectionLufsUngated: sectionLufs }, null, 1)}\n`);
    if (FFMPEG) { log('\nffmpeg analysis'); runFfmpegAnalysis(args.out); } else log('\nffmpeg not found - skipping spectrogram / EBU R128 report');
    if (checks.some(c => !c.pass)) process.exitCode = 1;
  }
}

main();
