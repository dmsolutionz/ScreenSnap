// Chroma key — the RENDER half. One shared keyer keys any drawable (the preview's <video>, an export's
// decoded VideoSample, a clip layer's frame) into a transparent-background image the compositor draws
// like any other. WebGL fragment shader (browser-native, no WASM) with the exact chroma.js math; when a
// WebGL context can't be had it falls back to keyPixels() on the CPU.
//
// Both scratch surfaces are grow-only and a keyed item is rendered into their BOTTOM-LEFT w×h corner (the
// WebGL viewport origin), so base + clips of different sizes in one frame never reallocate a canvas. The
// returned { canvas, sx, sy, sw, sh } is valid until the next key() call — draw it immediately.
import { keyUVFor, keyPixels, detectScreen } from "./chroma.js";
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "../vendor/mediabunny.mjs";

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// gl_FragCoord / size addresses the scratch canvas texel for texel: with UNPACK_FLIP_Y the canvas's top row
// lands at t=1, which is also the top row of the GL canvas, so input and output stay pixel-aligned.
const FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform vec2 u_key;
uniform float u_sim;
uniform float u_smooth;
uniform float u_spill;
vec2 uvOf(vec3 c) {
  return vec2(-0.100644 * c.r - 0.338572 * c.g + 0.439216 * c.b + 0.501961,
               0.439216 * c.r - 0.398942 * c.g - 0.040274 * c.b + 0.501961);
}
void main() {
  vec4 px = texture2D(u_tex, gl_FragCoord.xy / u_size);
  vec3 c = px.rgb;
  float base = distance(uvOf(c), u_key) - u_sim;
  float a = pow(clamp(base / u_smooth, 0.0, 1.0), 1.5);
  float s = pow(clamp(base / u_spill, 0.0, 1.0), 1.5);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, s);
  a *= px.a;
  gl_FragColor = vec4(c * a, a);
}`;

const MAX_DIM = 4096;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement("canvas"), { width: w, height: h });
}

export function createKeyer() {
  let scratch = null, sctx = null;
  let glc = null, gl = null, prog = null, loc = null, tex = null;
  let glFailed = false;

  function grow(c, w, h) {
    if (c.width < w) c.width = Math.min(MAX_DIM, Math.max(w, Math.ceil(c.width * 1.25)));
    if (c.height < h) c.height = Math.min(MAX_DIM, Math.max(h, Math.ceil(c.height * 1.25)));
  }

  function initGL() {
    if (gl || glFailed) return !!gl;
    try {
      glc = makeCanvas(2, 2);
      gl = glc.getContext("webgl", { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: false });
      if (!gl) throw new Error("no webgl");
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      loc = {};
      for (const n of ["u_tex", "u_size", "u_key", "u_sim", "u_smooth", "u_spill"]) loc[n] = gl.getUniformLocation(prog, n);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.uniform1i(loc.u_tex, 0);
      return true;
    } catch (err) {
      console.warn("[screensnap] WebGL chroma key unavailable, using the CPU keyer:", err);
      glFailed = true;
      gl = null;
      return false;
    }
  }

  // draw(ctx, w, h): paint the source into a w×h box at the context's origin. cfg: chroma config.
  function key(draw, w, h, cfg) {
    w = Math.max(1, Math.min(MAX_DIM, Math.round(w)));
    h = Math.max(1, Math.min(MAX_DIM, Math.round(h)));
    if (!scratch) { scratch = makeCanvas(w, h); sctx = scratch.getContext("2d", { willReadFrequently: false }); }
    grow(scratch, w, h);
    const H = scratch.height;
    sctx.save();
    sctx.clearRect(0, 0, scratch.width, H);
    sctx.translate(0, H - h); // bottom-left corner (see header)
    draw(sctx, w, h);
    sctx.restore();

    if (initGL()) {
      if (glc.width !== scratch.width || glc.height !== scratch.height) { glc.width = scratch.width; glc.height = scratch.height; }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
      const uv = keyUVFor(cfg.key);
      gl.uniform2f(loc.u_size, scratch.width, scratch.height);
      gl.uniform2f(loc.u_key, uv[0], uv[1]);
      gl.uniform1f(loc.u_sim, cfg.similarity);
      gl.uniform1f(loc.u_smooth, Math.max(1e-4, cfg.smoothness));
      gl.uniform1f(loc.u_spill, Math.max(1e-4, cfg.spill));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return { canvas: glc, sx: 0, sy: glc.height - h, sw: w, sh: h };
    }
    const img = sctx.getImageData(0, H - h, w, h);
    keyPixels(img.data, cfg);
    sctx.putImageData(img, 0, H - h);
    return { canvas: scratch, sx: 0, sy: H - h, sw: w, sh: h };
  }

  return { key };
}

let shared = null;
export function sharedKeyer() { return shared || (shared = createKeyer()); }

// Decode ONE frame of a video blob (at `atSec`, clamped into the clip) and look for a green / blue screen
// in it. -> detectScreen() result or null. Never throws: detection is a convenience, not a gate.
export async function detectScreenInBlob(blob, atSec = 1) {
  let sample = null;
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const dur = await track.computeDuration();
    const sink = new VideoSampleSink(track);
    sample = await sink.getSample(Math.max(0, Math.min(atSec, dur - 0.05)));
    if (!sample) return null;
    const sw = await track.getDisplayWidth(), sh = await track.getDisplayHeight();
    const w = 96, h = Math.max(8, Math.round((96 * sh) / Math.max(1, sw)));
    const c = makeCanvas(w, h);
    const cx = c.getContext("2d", { willReadFrequently: true });
    sample.draw(cx, 0, 0, w, h);
    return detectScreen(cx.getImageData(0, 0, w, h).data, w, h);
  } catch (err) {
    console.warn("[screensnap] green-screen detection skipped:", err);
    return null;
  } finally {
    if (sample) { try { sample.close(); } catch {} }
  }
}
