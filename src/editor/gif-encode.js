// A from-scratch animated-GIF89a encoder: median-cut color quantization + LZW compression, no deps,
// no WASM. Turns a sequence of RGBA frames into one looping image/gif Blob so the editor can offer
// "Export as GIF" beside MP4. We build ONE global palette from a subsample of pixels across all frames
// (keeps quantization fast and avoids GIF disposal/transparency bookkeeping) then write each frame as a
// full-frame image referencing that table. Everything is pure + defensive: bad dims throw early, a
// nearest-color cache keeps mapping cheap, and we yield to the event loop per frame so big exports
// don't freeze the tab.

// ---- growable byte buffer ----------------------------------------------------------------------
// A thin auto-growing Uint8Array. Pushing one byte at a time into a plain number[] is fine but this
// keeps the LZW inner loop (the hot path) allocation-free.
class ByteBuf {
  constructor(cap = 1024) { this.buf = new Uint8Array(cap); this.len = 0; }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b) { this._ensure(1); this.buf[this.len++] = b & 0xff; }
  bytes(arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  // little-endian u16
  u16(n) { this.byte(n & 0xff); this.byte((n >> 8) & 0xff); }
  // ascii string (header / app id)
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  finish() { return this.buf.subarray(0, this.len); }
}

// ---- median-cut quantization -------------------------------------------------------------------
// Collect a representative sample of opaque pixels (packed 0xRRGGBB) and split the color space along
// its widest channel until we have <= maxColors buckets; each bucket's average is one palette entry.

// One sample box: indices into the shared sample array, plus its RGB extent (computed lazily).
function makeBox(samples, lo, hi) {
  return { lo, hi, rMin: 0, rMax: 0, gMin: 0, gMax: 0, bMin: 0, bMax: 0, samples };
}

function shrinkBox(box) {
  const s = box.samples;
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let i = box.lo; i < box.hi; i++) {
    const p = s[i];
    const r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  box.rMin = rMin; box.rMax = rMax; box.gMin = gMin; box.gMax = gMax; box.bMin = bMin; box.bMax = bMax;
  return box;
}

// Widest channel of a box: 0=r, 1=g, 2=b. Used to pick the split axis.
function widestChannel(box) {
  const dr = box.rMax - box.rMin, dg = box.gMax - box.gMin, db = box.bMax - box.bMin;
  if (dr >= dg && dr >= db) return 0;
  if (dg >= db) return 1;
  return 2;
}

// medianCut(samples, maxColors) -> Array<[r,g,b]>. samples: Int32Array/number[] of packed 0xRRGGBB.
function medianCut(samples, maxColors) {
  if (samples.length === 0) return [[0, 0, 0]];
  const boxes = [shrinkBox(makeBox(samples, 0, samples.length))];

  // Split the box with the largest extent until we hit the color cap or can't split further.
  while (boxes.length < maxColors) {
    // pick the splittable box with the greatest single-channel extent
    let target = -1, bestExtent = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.hi - bx.lo < 2) continue; // can't split a single sample
      const ch = widestChannel(bx);
      const ext = ch === 0 ? bx.rMax - bx.rMin : ch === 1 ? bx.gMax - bx.gMin : bx.bMax - bx.bMin;
      if (ext > bestExtent) { bestExtent = ext; target = i; }
    }
    if (target < 0 || bestExtent === 0) break; // every box is uniform / single-pixel

    const box = boxes[target];
    const ch = widestChannel(box);
    const shift = ch === 0 ? 16 : ch === 1 ? 8 : 0;
    // sort just this box's slice by the chosen channel, then split at the median index
    const slice = samples.subarray ? samples.subarray(box.lo, box.hi) : samples.slice(box.lo, box.hi);
    Array.prototype.sort.call(slice, (a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
    if (!samples.subarray) for (let i = 0; i < slice.length; i++) samples[box.lo + i] = slice[i];
    const mid = box.lo + ((box.hi - box.lo) >> 1);
    boxes[target] = shrinkBox(makeBox(samples, box.lo, mid));
    boxes.push(shrinkBox(makeBox(samples, mid, box.hi)));
  }

  // Average each box to its representative color.
  const palette = [];
  for (const box of boxes) {
    let r = 0, g = 0, b = 0;
    const n = box.hi - box.lo || 1;
    for (let i = box.lo; i < box.hi; i++) {
      const p = box.samples[i];
      r += (p >> 16) & 0xff; g += (p >> 8) & 0xff; b += p & 0xff;
    }
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  return palette.length ? palette : [[0, 0, 0]];
}

// Gather up to ~targetSamples packed-RGB samples evenly across every frame. We compute a global step
// so the total examined count lands near the target regardless of frame count / size.
function collectSamples(frames, width, height, targetSamples) {
  const pxPerFrame = width * height;
  const totalPx = pxPerFrame * frames.length;
  const step = Math.max(1, Math.floor(totalPx / targetSamples));
  const out = [];
  for (const frame of frames) {
    const d = frame.data;
    // walk this frame in `step`-pixel strides (step is in pixels; *4 for RGBA byte index)
    for (let px = 0; px < pxPerFrame; px += step) {
      const o = px * 4;
      if (d[o + 3] === 0) continue; // skip fully transparent (no alpha in GIF output anyway)
      out.push((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
    }
  }
  return out;
}

// If the source has few enough distinct colors, use them verbatim — lossless, no median-cut error.
// Returns a palette (Array<[r,g,b]>) or null if it would exceed maxColors.
function exactPaletteIfSmall(frames, width, height, maxColors) {
  const seen = new Set();
  const pxPerFrame = width * height;
  for (const frame of frames) {
    const d = frame.data;
    for (let px = 0; px < pxPerFrame; px++) {
      const o = px * 4;
      if (d[o + 3] === 0) continue;
      const packed = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      seen.add(packed);
      if (seen.size > maxColors) return null;
    }
  }
  const palette = [];
  for (const packed of seen) palette.push([(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff]);
  return palette.length ? palette : [[0, 0, 0]];
}

// ---- palette mapping ---------------------------------------------------------------------------
// Nearest palette index for a packed RGB, memoized in a Map (most images reuse very few distinct
// colors per region, so the cache hit-rate is high and this dominates encode speed).
function makeNearest(palette) {
  const cache = new Map();
  const pr = new Int32Array(palette.length);
  const pg = new Int32Array(palette.length);
  const pb = new Int32Array(palette.length);
  for (let i = 0; i < palette.length; i++) { pr[i] = palette[i][0]; pg[i] = palette[i][1]; pb[i] = palette[i][2]; }
  return (packed) => {
    const hit = cache.get(packed);
    if (hit !== undefined) return hit;
    const r = (packed >> 16) & 0xff, g = (packed >> 8) & 0xff, b = packed & 0xff;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pr.length; i++) {
      const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    cache.set(packed, best);
    return best;
  };
}

// RGBA frame -> Uint8Array of palette indices (one byte per pixel).
function indexFrame(data, width, height, nearest) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let px = 0; px < n; px++) {
    const o = px * 4;
    out[px] = nearest((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
  }
  return out;
}

// ---- LZW compression (GIF variant) -------------------------------------------------------------
// GIF LZW: a min code size (>= 2), Clear and EOI codes, codes packed LSB-first, code size growing as
// the dictionary fills up to 12 bits, dictionary reset on Clear. Output is the min-code-size byte
// followed by the packed codes chunked into <=255-byte sub-blocks (length-prefixed), 0x00 terminated.
function lzwEncode(out, indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  // bit accumulator -> packed bytes -> 255-byte sub-blocks
  let cur = 0;     // bits buffered (LSB-first)
  let curBits = 0; // how many valid bits in `cur`
  let block = new Uint8Array(255);
  let blockLen = 0;

  const flushBlock = () => {
    if (blockLen === 0) return;
    out.byte(blockLen);
    out.bytes(block.subarray(0, blockLen));
    blockLen = 0;
  };
  const emitByte = (b) => {
    block[blockLen++] = b;
    if (blockLen === 255) flushBlock();
  };
  const writeCode = (code, size) => {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) { emitByte(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  // dictionary: maps "prefixCode,nextIndex" -> code. Reset to the base alphabet after each Clear.
  let dict = new Map();
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const resetDict = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  out.byte(minCodeSize);   // LZW minimum code size byte precedes the data sub-blocks
  writeCode(clearCode, codeSize);
  resetDict();

  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 4096 + k; // 4096 = 2^12 >= max index+1, so (prefix,k) is unique
      const existing = dict.get(key);
      if (existing !== undefined) {
        prefix = existing;
      } else {
        writeCode(prefix, codeSize);
        if (nextCode < 4096) {
          dict.set(key, nextCode++);
          // grow the code size as the dictionary crosses each power-of-two boundary
          if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          // dictionary full: reset per spec
          writeCode(clearCode, codeSize);
          resetDict();
        }
        prefix = k;
      }
    }
    writeCode(prefix, codeSize);
  }

  writeCode(eoiCode, codeSize);
  if (curBits > 0) emitByte(cur & 0xff); // flush any remaining bits (pads with zeros)
  flushBlock();
  out.byte(0x00); // block terminator ends this frame's image data
}

// ---- GIF assembly ------------------------------------------------------------------------------
// Number of bits needed to address `n` palette entries (GIF tables are power-of-two sized, min 2).
function colorBitsFor(paletteLen) {
  let bits = 1;
  while ((1 << bits) < paletteLen) bits++;
  return Math.max(1, bits); // min 1 bit => 2-entry table (smallest legal GIF color table)
}

function writeGlobalColorTable(out, palette, tableSize) {
  for (let i = 0; i < tableSize; i++) {
    if (i < palette.length) { out.byte(palette[i][0]); out.byte(palette[i][1]); out.byte(palette[i][2]); }
    else { out.byte(0); out.byte(0); out.byte(0); } // pad unused slots
  }
}

// frames: Array<{ data: Uint8ClampedArray (RGBA, length = width*height*4), delayMs: number }>
// opts: { width, height, maxColors?=256, onProgress?(0..1), signal?: AbortSignal, loop?=0 }
//   loop: 0 = infinite (default). delayMs is per-frame display time.
// Returns: Blob of type 'image/gif'
export async function encodeGif(frames, opts) {
  const o = opts || {};
  const width = o.width | 0;
  const height = o.height | 0;
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("encodeGif: need at least one frame");
  if (width <= 0 || height <= 0) throw new Error("encodeGif: width/height must be positive");
  const expected = width * height * 4;
  for (const f of frames) {
    if (!f || !f.data || f.data.length !== expected) {
      throw new Error(`encodeGif: each frame.data must be RGBA of length ${expected} (got ${f && f.data && f.data.length})`);
    }
  }
  let maxColors = o.maxColors | 0;
  if (!maxColors || maxColors < 2) maxColors = 256;
  if (maxColors > 256) maxColors = 256;
  const loop = Number.isFinite(o.loop) ? (o.loop | 0) : 0;
  const onProgress = typeof o.onProgress === "function" ? o.onProgress : null;
  const signal = o.signal || null;
  const yieldToLoop = () => new Promise((r) => setTimeout(r));

  // --- build the single global palette -----------------------------------------------------------
  // Prefer an exact palette when the clip is genuinely low-color (lossless); otherwise median-cut a
  // representative subsample. ~40k samples is plenty to characterize the color distribution cheaply.
  let palette = exactPaletteIfSmall(frames, width, height, maxColors);
  if (!palette) {
    const samples = Int32Array.from(collectSamples(frames, width, height, 40000));
    palette = medianCut(samples, maxColors);
  }
  if (palette.length > 256) palette = palette.slice(0, 256);
  if (onProgress) onProgress(0.1); // palette pass ~ first slice of the work
  if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");

  const colorBits = colorBitsFor(palette.length); // bits to index the (padded) table
  const tableSize = 1 << colorBits;               // power-of-two entry count, 2..256
  // GIF requires LZW min code size >= 2 even for 2-color images.
  const minCodeSize = Math.max(2, colorBits);

  const nearest = makeNearest(palette);
  const out = new ByteBuf(64 * 1024);

  // --- header + logical screen descriptor --------------------------------------------------------
  out.str("GIF89a");
  out.u16(width);
  out.u16(height);
  // packed: GCT flag(1) | color resolution(3) | sort flag(1) | GCT size(3). size field = colorBits-1.
  out.byte(0x80 | ((colorBits - 1) << 4) | (colorBits - 1));
  out.byte(0);  // background color index
  out.byte(0);  // pixel aspect ratio (none)
  writeGlobalColorTable(out, palette, tableSize);

  // --- Netscape 2.0 looping extension (written once, before the frames) --------------------------
  out.byte(0x21); out.byte(0xff); // extension introducer + application label
  out.byte(11);                   // block size: "NETSCAPE2.0" is 11 bytes
  out.str("NETSCAPE2.0");
  out.byte(3);                    // sub-block size
  out.byte(1);                    // sub-block id
  out.u16(loop & 0xffff);         // loop count (0 = infinite)
  out.byte(0);                    // block terminator

  // --- per-frame: GCE + image descriptor + LZW data ----------------------------------------------
  for (let fi = 0; fi < frames.length; fi++) {
    if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    const frame = frames[fi];
    // delay in centiseconds; floor at 1 so viewers don't treat 0 as "as fast as possible" and stall.
    let delayCs = Math.round((frame.delayMs || 0) / 10);
    if (delayCs < 1) delayCs = 1;

    // Graphic Control Extension: disposal=1 (do not dispose), no user input, no transparency.
    out.byte(0x21); out.byte(0xf9); // extension introducer + graphic control label
    out.byte(4);                    // block size
    out.byte(0x04);                 // packed: disposal method 1 << 2, transparency off
    out.u16(delayCs);
    out.byte(0);                    // transparent color index (unused)
    out.byte(0);                    // block terminator

    // Image Descriptor: full-frame, no local color table, not interlaced.
    out.byte(0x2c);
    out.u16(0); out.u16(0);         // left, top
    out.u16(width); out.u16(height);
    out.byte(0);                    // packed: no LCT, no interlace

    const indices = indexFrame(frame.data, width, height, nearest);
    lzwEncode(out, indices, minCodeSize);

    if (onProgress) onProgress(0.1 + 0.9 * ((fi + 1) / frames.length));
    await yieldToLoop(); // keep the tab responsive across large exports
  }

  out.byte(0x3b); // trailer
  if (onProgress) onProgress(1);

  // Copy out of the growable buffer so the Blob owns a tight, standalone view.
  return new Blob([out.finish().slice()], { type: "image/gif" });
}
