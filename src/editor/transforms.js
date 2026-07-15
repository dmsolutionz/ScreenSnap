// Pure transform math: trim / resolution / speed / crop / zoom. No DOM, no Mediabunny. The pipeline
// drives every per-frame decision through these so the export stays a thin loop. Every fn is pure and
// total: divides guard against zero/NaN speed, trim is clamped within [0, duration], and crop/zoom
// rects are clamped to source bounds.
//
// Time model: trimIn/trimOut are the outer kept window; `cuts` are removed sub-intervals inside it
// (source seconds), so the kept output is a list of SEGMENTS (trim minus cuts). Multi-segment is
// back-compatible — with no cuts there is exactly one segment [trimIn, trimOut] and every fn behaves
// as it did before. crop is a fixed source sub-rect; zoom is a keyframed magnification WITHIN the
// crop (or full frame). crop + zoom both resolve to a single source rect per frame via
// effectiveSrcRect(), which the compositor draws to the whole output canvas.

export function defaultTransforms(meta) {
  const dur = Math.max(0, (meta && meta.durationSec) || 0);
  return {
    trimIn: 0, trimOut: dur, cuts: [], outScale: null, speed: 1, crop: null, zoom: [], backdrop: null,
    // Independent audio mute mask — same {trimIn,trimOut,cuts} shape as the video fields above, so
    // segmentsOf()/keepFrame() work unmodified when called as segmentsOf(t.audio)/keepFrame(sec, t.audio).
    // This is NOT a ripple window like video's cuts (which shift later segments earlier in the output):
    // it only decides, per audio buffer already included by the video's own trim/cuts, whether to pass
    // real samples through or zero them — so muting a stretch of audio never desyncs it from the video.
    audio: { trimIn: 0, trimOut: dur, cuts: [], volume: 1, muted: false },
    // An optional imported audio track (voiceover / music) layered onto the OUTPUT timeline. null until
    // one is added. offsetSec is in OUTPUT seconds (the final trimmed/cut timeline), NOT source seconds:
    // an imported asset is placed on the edited result, not tied to a moment in the recording, so it
    // never needs to skip over the video's cut gaps. trimIn/trimOut select which portion of the file is
    // used (in the file's own seconds); durationSec is the file's native length. The file's Mediabunny
    // Input isn't plain data, so it lives on the editor `session` (session.extraAudioInput), not here.
    extraAudio: null, // { name, durationSec, trimIn, trimOut, offsetSec, volume, muted }
  };
}

// Round a value to the nearest EVEN integer (>= 2). H.264 chroma subsampling requires even dims.
function toEven(n) {
  let v = Math.round(n);
  if (!Number.isFinite(v) || v < 2) v = 2;
  if (v % 2) v += 1;
  return v;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Target video bitrate for a given output frame size, so export file size actually shrinks with
// resolution instead of encoding a smaller frame at a fixed bitrate. bpp (bits/pixel/frame) is tuned
// for screen-recording content (mostly static UI, far less motion than camera video), clamped to a
// floor (keeps small/cropped outputs legible) and a ceiling (caps a large "Original" 4K+ export).
const BITRATE_BPP = 0.12;
const MIN_BITRATE = 1.5e6;
const MAX_BITRATE = 20e6;
export function videoBitrateFor(outW, outH, fps = 30) {
  const raw = BITRATE_BPP * Math.max(0, outW) * Math.max(0, outH) * fps;
  return Math.round(clamp(raw, MIN_BITRATE, MAX_BITRATE));
}

// outScale null => source dims unchanged. {maxHeight} => scale down to fit that height (never up),
// preserving aspect. crop (optional {x,y,w,h} source px) sets the BASE dimensions before scaling, so
// a cropped export is sized to the crop, not the source. Both dims forced to nearest even int.
export function outputDims(srcW, srcH, outScale, crop) {
  let w = crop && crop.w ? crop.w : srcW;
  let h = crop && crop.h ? crop.h : srcH;
  if (outScale && outScale.maxHeight && h > outScale.maxHeight) {
    const scale = outScale.maxHeight / h;
    h = outScale.maxHeight;
    w = w * scale;
  }
  return { w: toEven(w), h: toEven(h) };
}

// The crop rect as a complete, clamped {x,y,w,h} in source pixels (full frame when crop is null).
export function cropRect(t, srcW, srcH) {
  const c = t && t.crop;
  if (!c) return { x: 0, y: 0, w: srcW, h: srcH };
  const w = clamp(c.w, 2, srcW);
  const h = clamp(c.h, 2, srcH);
  const x = clamp(c.x, 0, srcW - w);
  const y = clamp(c.y, 0, srcH - h);
  return { x, y, w, h };
}

// ── Backdrop (beautify: padded background around the content) ─────────────────────────────────────
// composeDims() returns the FINAL output canvas size plus the dest rect where the (cropped) content is
// drawn within it. With no backdrop the content fills the whole output (dest = full, identical to the
// prior behavior). With a backdrop the output grows by `pad` (a fraction of the content width) on
// every side and the content is centered, leaving room for the background / shadow / rounded card.
// backdrop = { pad, radius, shadow, bg } where pad/radius are fractions of the content width.
export function composeDims(t, srcW, srcH) {
  const c = outputDims(srcW, srcH, t && t.outScale, t && t.crop); // content (frame) dims, even
  const bd = t && t.backdrop;
  const pad = bd && bd.pad ? clamp(bd.pad, 0, 0.4) : 0;
  if (!pad) return { outW: c.w, outH: c.h, dest: { x: 0, y: 0, w: c.w, h: c.h }, backdrop: null };
  const p = Math.round(pad * c.w);
  const outW = toEven(c.w + p * 2);
  const outH = toEven(c.h + p * 2);
  const dest = { x: Math.round((outW - c.w) / 2), y: Math.round((outH - c.h) / 2), w: c.w, h: c.h };
  return { outW, outH, dest, backdrop: bd };
}

// ── Segments (trim minus cuts) ──────────────────────────────────────────────────────────────────
// Normalize cuts and subtract them from [trimIn, trimOut] to get the ordered list of kept segments.
// Each segment is {in, out} in SOURCE seconds. Always returns at least one segment. Generic over any
// object with {trimIn,trimOut,cuts} — used for both the video transforms and transforms.audio (the
// independent audio mute mask), so segmentsOf(t.audio)/keepFrame(sec, t.audio) work unmodified.
export function segmentsOf(t) {
  const lo = Math.max(0, t.trimIn || 0);
  const hi = Math.max(lo, t.trimOut == null ? lo : t.trimOut);
  const cuts = Array.isArray(t.cuts) ? t.cuts : [];
  // Clip cuts to the trim window, drop empties, sort, then merge overlaps.
  const norm = cuts
    .map((c) => ({ in: Math.max(lo, Math.min(c.in, c.out)), out: Math.min(hi, Math.max(c.in, c.out)) }))
    .filter((c) => c.out - c.in > 0.0005)
    .sort((a, b) => a.in - b.in);
  const merged = [];
  for (const c of norm) {
    const last = merged[merged.length - 1];
    if (last && c.in <= last.out) last.out = Math.max(last.out, c.out);
    else merged.push({ ...c });
  }
  // Kept segments = the gaps between merged cuts within [lo, hi].
  const segs = [];
  let cursor = lo;
  for (const c of merged) {
    if (c.in > cursor + 0.0005) segs.push({ in: cursor, out: c.in });
    cursor = Math.max(cursor, c.out);
  }
  if (hi > cursor + 0.0005) segs.push({ in: cursor, out: hi });
  return segs.length ? segs : [{ in: lo, out: Math.max(lo, hi) }];
}

// Guard speed against 0/NaN so output timestamps stay finite.
function safeSpeed(t) {
  const s = t && t.speed;
  return s && s > 0 ? s : 1;
}

// Keep a source-time frame if it falls inside any kept segment. (Half-open [in, out).)
export function keepFrame(srcSec, t) {
  const segs = segmentsOf(t);
  for (const s of segs) if (srcSec >= s.in && srcSec < s.out) return true;
  return false;
}

// Map a kept source time to its output time: sum the (speed-divided) durations of every segment
// before the one containing srcSec, plus the offset within that segment. Frames in cut regions return
// their nearest preceding boundary (they're filtered by keepFrame before this is called).
export function outTimestamp(srcSec, t) {
  const segs = segmentsOf(t);
  const sp = safeSpeed(t);
  let acc = 0;
  for (const s of segs) {
    if (srcSec < s.in) break;
    if (srcSec < s.out) return (acc + (srcSec - s.in)) / sp;
    acc += s.out - s.in;
  }
  return acc / sp;
}

// Inverse of outTimestamp: map an OUTPUT time back to the SOURCE time that plays there. Walks the
// kept segments accumulating (speed-multiplied) output time; an outSec at/past the end of the output
// maps to the last kept segment's end. Used to place output-anchored objects (the imported audio
// track) on the timeline's source-seconds ruler.
export function srcTimestamp(outSec, t) {
  const segs = segmentsOf(t);
  let rem = Math.max(0, outSec) * safeSpeed(t);
  for (const s of segs) {
    const len = s.out - s.in;
    if (rem <= len) return s.in + rem;
    rem -= len;
  }
  return segs[segs.length - 1].out;
}

// Fall back to a 30fps frame duration when the source sample reports no duration.
export function outFrameDuration(srcDurSec, t) {
  return (srcDurSec || 1 / 30) / safeSpeed(t);
}

// Total output duration = summed segment durations / speed.
export function outDuration(t) {
  const segs = segmentsOf(t);
  let sum = 0;
  for (const s of segs) sum += s.out - s.in;
  return sum / safeSpeed(t);
}

// Audio is only carried straight through at 1x speed. Any speed change would require resampling /
// pitch handling we don't do, so we export video-only in that case (surfaced in the UI). Multi-segment
// audio is concatenated in the pipeline by feeding only buffers inside a kept segment.
export function audioEnabled(t) {
  return safeSpeed(t) === 1;
}

// The gain (0..1) to apply to kept audio samples, from the independent audio mute mask (t.audio).
// Global mute -> 0; otherwise the global volume slider, defaulting to 1. Regional mute-out is applied
// separately per-buffer via keepFrame(timestamp, t.audio) at the call site (pipeline.js).
export function audioGainFor(t) {
  const a = t && t.audio;
  if (!a || a.muted) return 0;
  return typeof a.volume === "number" ? a.volume : 1;
}

// ── Zoom (blocks of magnification, each eased in/out) ────────────────────────────────────────────
// Blocks: [{ id, tIn, tOut, cx, cy, scale }] where tIn/tOut are SOURCE seconds, cx/cy are the focus
// point in [0..1] of the crop rect, and scale >= 1 magnifies. Within a block the magnification eases
// 1 → scale (hold) → 1 with a short smoothstep ramp at each edge; outside every block there is no
// zoom. Returns the effective { cx, cy, scale } at a source time, or null when none applies. Blocks
// are expected non-overlapping; if they overlap, the first containing block wins.
export function zoomAt(t, srcSec) {
  const blocks = Array.isArray(t && t.zoom) ? t.zoom : [];
  for (const b of blocks) {
    if (!b || srcSec < b.tIn || srcSec >= b.tOut) continue;
    const dur = Math.max(0.0001, b.tOut - b.tIn);
    const ramp = Math.min(0.4, dur / 2); // ease-in / ease-out time (seconds)
    let f = 1;
    if (srcSec < b.tIn + ramp) f = (srcSec - b.tIn) / ramp;        // ease in
    else if (srcSec > b.tOut - ramp) f = (b.tOut - srcSec) / ramp; // ease out
    f = Math.max(0, Math.min(1, f));
    f = f * f * (3 - 2 * f); // smoothstep
    const scale = 1 + ((b.scale || 1) - 1) * f;
    return { cx: b.cx, cy: b.cy, scale };
  }
  return null;
}

// The source rect to sample for a given source time, combining crop (fixed) and zoom (animated). The
// compositor draws this rect to the full output canvas; output dims stay constant (zoom magnifies,
// it does not resize). Returns {x,y,w,h} in source pixels, clamped inside the crop rect.
export function effectiveSrcRect(t, srcSec, srcW, srcH) {
  const base = cropRect(t, srcW, srcH);
  const z = zoomAt(t, srcSec);
  if (!z || !(z.scale > 1.0001)) return base;
  const w = base.w / z.scale;
  const h = base.h / z.scale;
  const focusX = base.x + clamp(z.cx, 0, 1) * base.w;
  const focusY = base.y + clamp(z.cy, 0, 1) * base.h;
  const x = clamp(focusX - w / 2, base.x, base.x + base.w - w);
  const y = clamp(focusY - h / 2, base.y, base.y + base.h - h);
  return { x, y, w, h };
}
