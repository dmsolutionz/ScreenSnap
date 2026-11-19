// Chroma key (green / blue screen) — the PURE half: detection of a keyable backdrop in a sampled frame and
// the per-pixel key math. chroma-keyer.js runs the same math on the GPU (WebGL fragment shader) for the
// preview and exports, and falls back to keyPixels() below when WebGL isn't available. Import-free so it
// unit-tests under plain `node --test`.
//
// The key is measured in YCbCr chroma space (the (Cb,Cr) plane, brightness ignored), the classic OBS-style
// keyer: a pixel's alpha ramps from 0 → 1 as its chroma distance from the key colour goes from
// `similarity` to `similarity + smoothness`, and `spill` desaturates the green/blue fringe that bounces
// off the screen onto hair and shoulders. All three are 0..1 in that chroma-plane distance.
//
// The key colour is used for its HUE: keyUVFor() pushes it out to full saturation (a fixed distance from
// neutral grey) before distances are measured — what OBS gets by keying against pure #00ff00. A real
// screen is far less saturated than that, so measuring from the raw sampled colour would put neutral
// greys and skin inside the default similarity radius and key them out with the screen.

export const DEFAULT_CHROMA = Object.freeze({ similarity: 0.4, smoothness: 0.08, spill: 0.1 });

// rgb 0..1 -> [Cb, Cr] 0..1 (BT.601, the same constants the shader uses).
export function chromaUV(r, g, b) {
  return [
    -0.100644 * r - 0.338572 * g + 0.439216 * b + 0.501961,
    0.439216 * r - 0.398942 * g - 0.040274 * b + 0.501961,
  ];
}

const KEY_SAT = 0.5; // distance of the effective key from neutral (0.5, 0.5) in the chroma plane

// [r,g,b] 0..255 -> the effective key point in the chroma plane (see header). A near-neutral pick has no
// usable hue, so it's used as-is.
export function keyUVFor(key) {
  const k = key || [0, 255, 0];
  const [u, v] = chromaUV(k[0] / 255, k[1] / 255, k[2] / 255);
  const du = u - 0.5, dv = v - 0.5, len = Math.hypot(du, dv);
  if (len < 0.02) return [u, v];
  return [0.5 + (du / len) * KEY_SAT, 0.5 + (dv / len) * KEY_SAT];
}

// A full chroma config for a detected / picked key colour ([r,g,b] 0..255).
export function chromaConfig(key, over = {}) {
  return { on: true, key: key.map((v) => Math.round(v)), ...DEFAULT_CHROMA, ...over };
}

// Alpha (0..1) and spill factor (0 = fully desaturated, 1 = untouched) for one pixel, rgb 0..1.
export function keyAlpha(r, g, b, keyUV, cfg) {
  const [u, v] = chromaUV(r, g, b);
  const d = Math.hypot(u - keyUV[0], v - keyUV[1]);
  const base = d - cfg.similarity;
  const a = Math.pow(clamp01(base / Math.max(1e-4, cfg.smoothness)), 1.5);
  const s = Math.pow(clamp01(base / Math.max(1e-4, cfg.spill)), 1.5);
  return { a, s };
}

// Key an RGBA byte buffer in place (the CPU fallback). Output is straight (un-premultiplied) alpha, as
// putImageData expects.
export function keyPixels(data, cfg) {
  const keyUV = keyUVFor(cfg.key);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const { a, s } = keyAlpha(r, g, b, keyUV, cfg);
    if (s < 1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      data[i] = Math.round(255 * (lum + (r - lum) * s));
      data[i + 1] = Math.round(255 * (lum + (g - lum) * s));
      data[i + 2] = Math.round(255 * (lum + (b - lum) * s));
    }
    data[i + 3] = Math.round(data[i + 3] * a);
  }
  return data;
}

// Is this pixel screen-coloured? A keyable backdrop is a reasonably bright, clearly dominant green (or
// blue) — not a dark shadow, not a pale tint. -> "green" | "blue" | null
export function screenHue(r, g, b) {
  if (g > 60 && g > r * 1.3 && g > b * 1.3) return "green";
  if (b > 60 && b > r * 1.5 && b > g * 1.15) return "blue";
  return null;
}

// Look for a green / blue screen in a small RGBA frame sample (e.g. 96×54). A screen frames the subject,
// so it must dominate the BORDER (outer ~15%) and still be a sizeable share of the whole frame; the key is
// the median screen colour along the border (robust against a subject touching an edge).
// -> { kind, key:[r,g,b], coverage, border } or null.
export function detectScreen(data, w, h) {
  if (!(w > 2 && h > 2) || !data || data.length < w * h * 4) return null;
  const bx = Math.max(1, Math.round(w * 0.15)), by = Math.max(1, Math.round(h * 0.15));
  const count = { green: 0, blue: 0 }, borderCount = { green: 0, blue: 0 };
  const samples = { green: [], blue: [] };
  let borderTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const onBorder = x < bx || x >= w - bx || y < by || y >= h - by;
      if (onBorder) borderTotal++;
      const hue = screenHue(r, g, b);
      if (!hue) continue;
      count[hue]++;
      if (onBorder) { borderCount[hue]++; samples[hue].push([r, g, b]); }
    }
  }
  const kind = borderCount.green >= borderCount.blue ? "green" : "blue";
  const border = borderTotal ? borderCount[kind] / borderTotal : 0;
  const coverage = count[kind] / (w * h);
  if (border < 0.5 || coverage < 0.25) return null;
  return { kind, key: medianColor(samples[kind]), coverage, border };
}

function medianColor(list) {
  const pick = (k) => {
    const v = list.map((c) => c[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 0;
  };
  return [pick(0), pick(1), pick(2)];
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// "#rrggbb" <-> [r,g,b] for the key-colour picker.
export function rgbToHex(c) {
  return "#" + (c || [0, 0, 0]).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
