// Output frame clock shared by the MP4 and GIF exports. Screen capture is variable-frame-rate: Chrome
// only emits a frame when something on screen changes, so a static stretch can be one source frame
// followed by seconds of nothing. Emitting exactly one output frame per source frame meant overlays
// with a time range, zoom eases, and the frame actually on screen at a trim/cut start were never drawn
// in those stretches (the preview, which redraws every rAF, showed them). This walks the decoded
// frames and yields OUTPUT frames instead:
//   - every kept source frame is yielded at its own output time (originals are never dropped/retimed),
//   - a frame whose hold would exceed ~1.5 steps is re-yielded every `step` (held), each with the
//     source time of its own slot so layer ranges / zoom resolve per slot,
//   - the frame on screen when a kept segment starts (decoded before trimIn or inside a cut) is placed
//     at that segment's start, and the last frame holds out to the end of the output.
// Each yielded { sample, srcSec, outTs, dur } is only valid until the consumer asks for the next one;
// the generator owns every sample's lifetime (closed even when the consumer throws / aborts).
import { segmentsOf, keepFrame, outTimestamp, srcTimestamp } from "./transforms.js";

export async function* outputFrames({ vSink, transforms, totalOut, step = 1 / 30, signal }) {
  const segs = segmentsOf(transforms);
  let held = null;    // { sample, srcSec, outTs } — last placed frame; yielded once its hold length is known
  let preroll = null; // latest decoded frame that was NOT kept: what's on screen when the next segment opens
  let incoming = null;

  // Yield `held` from its start until output time `until`, repeating it every `step` across a long gap
  // (the final slot absorbs a remainder under 1.5 steps, so a regular 30fps source yields 1:1).
  async function* flush(until) {
    const h = held;
    held = null;
    try {
      let t = h.outTs, src = h.srcSec;
      for (;;) {
        const nt = t + step;
        const end = nt < until - step * 0.5 ? nt : until;
        if (end - t > 1e-6) yield { sample: h.sample, srcSec: src, outTs: t, dur: end - t };
        if (end >= until) break;
        t = end;
        src = srcTimestamp(t, transforms);
      }
    } finally {
      h.sample.close();
    }
  }

  // Close out everything placed before the next kept frame (at nextSrc / nextOut, or the output end).
  async function* place(nextSrc, nextOut) {
    if (preroll) {
      // The preroll is on screen from its own timestamp until nextSrc, so it first becomes visible at
      // the first kept segment start at/after it — if that's meaningfully before the next kept frame.
      const p = preroll;
      const s = segs.find((g) => g.in >= p.timestamp - 1e-6);
      const pOut = s ? outTimestamp(s.in, transforms) : Infinity;
      if (s && s.in < nextSrc && nextOut - pOut > step * 0.5) {
        if (held) yield* flush(pOut); // preroll still owns p here, so an abort mid-flush closes it
        preroll = null;
        held = { sample: p, srcSec: s.in, outTs: pOut };
      } else {
        preroll = null;
        p.close();
      }
    }
    if (held) yield* flush(nextOut);
  }

  try {
    for await (const sample of vSink.samples(transforms.trimIn, transforms.trimOut)) {
      incoming = sample;
      if (signal && signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const srcSec = sample.timestamp;
      if (!keepFrame(srcSec, transforms)) {
        if (preroll) preroll.close();
        preroll = incoming;
        incoming = null;
        continue;
      }
      const outTs = outTimestamp(srcSec, transforms);
      yield* place(srcSec, outTs);
      held = { sample: incoming, srcSec, outTs };
      incoming = null;
    }
    // The last frame holds to the end of the output, so the video track ends exactly at totalOut.
    yield* place(Infinity, held ? Math.max(totalOut, held.outTs + 1e-3) : totalOut);
  } finally {
    for (const s of [incoming, held && held.sample, preroll]) if (s) { try { s.close(); } catch {} }
  }
}
