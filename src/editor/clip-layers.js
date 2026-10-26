// Imported video clips as overlay layers (picture-in-picture, side-by-side, or a full-frame cutaway). The
// model follows FilmCraft's stacked video tracks: a clip sits on the timeline at `range` (main SOURCE
// seconds, like every other layer), plays its own file from `video.srcIn`, and draws at {x,y,w,h} in
// source px. Higher layers draw over lower ones (store order = track order, V1 at the bottom).
// Shared by the preview (time mapping only) and both exports (decoded frames via Mediabunny).
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "../vendor/mediabunny.mjs";

// The clip's own time at main source time srcSec, or null when the clip isn't on screen then.
export function clipTimeAt(layer, srcSec) {
  const r = layer && layer.range;
  const v = layer && layer.video;
  if (!r || !v || srcSec < r.inSec || srcSec >= r.outSec) return null;
  return Math.min(v.durationSec, (v.srcIn || 0) + (srcSec - r.inSec));
}

// Apply a timeline drag ({tIn,tOut} in main source seconds) to a clip layer. Moving keeps the clip's
// in-point; the left edge trims the clip's start (srcIn moves with it so the untouched frames stay put);
// the right edge trims its end. A clip can never run past either end of its own file.
// -> { range, video } patch for store.update.
export function clipRangePatch(layer, r, mode) {
  const v = layer.video;
  const cur = layer.range;
  let srcIn = v.srcIn || 0;
  let inSec = r.tIn, outSec = r.tOut;
  if (mode === "in") {
    let delta = inSec - cur.inSec;
    if (srcIn + delta < 0) delta = -srcIn; // no frames before the file's start
    srcIn += delta;
    inSec = cur.inSec + delta;
  } else if (mode === "move") {
    outSec = inSec + (cur.outSec - cur.inSec);
  }
  outSec = Math.min(outSec, inSec + (v.durationSec - srcIn));
  return { range: { inSec, outSec }, video: { ...v, srcIn } };
}

// Frame cursor over one clip's video track for export. Clip time only moves forward during an export
// (ripple cuts skip ahead), so a sequential samples() iterator is stepped rather than seeking per frame;
// a backwards step or a long jump restarts it. at() returns the frame on screen at clip time t — valid
// until the next at()/close().
function createCursor(track) {
  const sink = new VideoSampleSink(track);
  let it = null, cur = null, next = null;

  async function pull() {
    const r = await it.next();
    next = r.done ? null : r.value;
  }
  async function reset() {
    if (it) { try { await it.return(); } catch {} }
    for (const s of [cur, next]) if (s) { try { s.close(); } catch {} }
    it = null; cur = null; next = null;
  }
  return {
    async at(t) {
      if (!it || (cur && t < cur.timestamp - 1e-3) || (next && t - next.timestamp > 2)) {
        await reset();
        it = sink.samples(Math.max(0, t))[Symbol.asyncIterator]();
        await pull();
      }
      while (next && next.timestamp <= t + 1e-6) {
        if (cur) cur.close();
        cur = next;
        await pull();
      }
      return cur || next; // before the first frame: show the first frame rather than nothing
    },
    close: reset,
  };
}

// Open every visible clip layer for an export. framesAt(srcSec) -> Map(layerId -> VideoSample) for the
// clips on screen at that main source time; the compositor draws them via opts.clips.
export async function openClipFrames(layers) {
  const cursors = new Map();
  for (const l of layers) {
    if (!l || l.kind !== "video" || !l.video || !l.video.blob) continue;
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(l.video.blob) });
      const track = await input.getPrimaryVideoTrack();
      if (track) cursors.set(l.id, { layer: l, cursor: createCursor(track) });
    } catch (err) {
      console.warn("[screensnap] couldn't open video clip layer for export:", err);
    }
  }
  return {
    async framesAt(srcSec) {
      const out = new Map();
      for (const [id, { layer, cursor }] of cursors) {
        const ct = clipTimeAt(layer, srcSec);
        if (ct == null) continue;
        const s = await cursor.at(ct);
        if (s) out.set(id, s);
      }
      return out;
    },
    async close() {
      for (const { cursor } of cursors.values()) await cursor.close();
      cursors.clear();
    },
  };
}
