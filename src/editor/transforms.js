// Pure transform math: trim / resolution / speed. No DOM, no Mediabunny. The pipeline drives every
// per-frame decision through these so the export stays a thin loop. v1 is identity/passthrough but
// the maths is already correct for trim, scale, and speed remapping. Every fn is pure and total:
// divides guard against zero/NaN speed, and trim is clamped within [0, duration].

export function defaultTransforms(meta) {
  const dur = Math.max(0, (meta && meta.durationSec) || 0);
  return { trimIn: 0, trimOut: dur, outScale: null, speed: 1 };
}

// Round a value to the nearest EVEN integer (>= 2). H.264 chroma subsampling requires even dims.
function toEven(n) {
  let v = Math.round(n);
  if (!Number.isFinite(v) || v < 2) v = 2;
  if (v % 2) v += 1;
  return v;
}

// outScale null => source dims unchanged. {maxHeight} => scale down to fit that height (never up),
// preserving aspect. Both dims forced to nearest even int (H.264 needs even dimensions).
export function outputDims(srcW, srcH, outScale) {
  let w = srcW;
  let h = srcH;
  if (outScale && outScale.maxHeight && srcH > outScale.maxHeight) {
    const scale = outScale.maxHeight / srcH;
    h = outScale.maxHeight;
    w = srcW * scale;
  }
  return { w: toEven(w), h: toEven(h) };
}

// trimIn <= srcSec < trimOut. speed-independent: trim is in source time.
export function keepFrame(srcSec, t) {
  return srcSec >= t.trimIn && srcSec < t.trimOut;
}

// Guard speed against 0/NaN so output timestamps stay finite.
function safeSpeed(t) {
  const s = t && t.speed;
  return s && s > 0 ? s : 1;
}

export function outTimestamp(srcSec, t) {
  return (srcSec - t.trimIn) / safeSpeed(t);
}

// Fall back to a 30fps frame duration when the source sample reports no duration.
export function outFrameDuration(srcDurSec, t) {
  return (srcDurSec || 1 / 30) / safeSpeed(t);
}

export function outDuration(t) {
  return (t.trimOut - t.trimIn) / safeSpeed(t);
}

// Audio is only carried straight through at 1x speed. Any speed change would require resampling /
// pitch handling we don't do in v1, so we export video-only in that case (surfaced in the UI).
export function audioEnabled(t) {
  return safeSpeed(t) === 1;
}
