// Unit tests for the pure transform math in src/editor/transforms.js — zero deps, runs under
// `node --test`. The export pipeline drives every per-frame / per-bitrate decision through these, so
// the segment math (trim minus cuts, speed) and the export bitrate cap are pinned down here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTransforms, segmentsOf, outTimestamp, srcTimestamp, outDuration,
  videoBitrateFor, sourceVideoBitrate, capToSource, SRC_AUDIO_BPS,
} from "../src/editor/transforms.js";

test("segmentsOf: reversed + overlapping cuts merge, clipped to the trim window", () => {
  const t = { ...defaultTransforms({ durationSec: 10 }), cuts: [{ in: 3, out: 2 }, { in: 2.5, out: 4 }, { in: 8, out: 12 }] };
  assert.deepEqual(segmentsOf(t), [{ in: 0, out: 2 }, { in: 4, out: 8 }]);
  assert.equal(outDuration(t), 6);
  assert.equal(outDuration({ ...t, speed: 2 }), 3);
});

test("srcTimestamp inverts outTimestamp across cuts and speed", () => {
  const t = { ...defaultTransforms({ durationSec: 10 }), cuts: [{ in: 2, out: 4 }], speed: 2 };
  for (let o = 0; o < outDuration(t); o += 0.05) {
    assert.ok(Math.abs(outTimestamp(srcTimestamp(o, t), t) - o) < 1e-9, `round-trip at ${o}`);
  }
});

test("videoBitrateFor: bpp target clamped to floor / ceiling", () => {
  assert.equal(videoBitrateFor(1920, 1080), Math.round(0.12 * 1920 * 1080 * 30));
  assert.equal(videoBitrateFor(320, 180), 1.5e6);
  assert.equal(videoBitrateFor(7680, 4320), 20e6);
});

test("sourceVideoBitrate: file rate minus the audio allowance; 0 when unknown", () => {
  const bytes = (1.2e6 + SRC_AUDIO_BPS) * 60 / 8; // 60s of 1.2 Mbps video + 128 kbps audio
  assert.ok(Math.abs(sourceVideoBitrate(bytes, 60) - 1.2e6) < 1);
  assert.ok(Math.abs(sourceVideoBitrate(bytes, 60, false) - (1.2e6 + SRC_AUDIO_BPS)) < 1);
  assert.equal(sourceVideoBitrate(0, 60), 0);
  assert.equal(sourceVideoBitrate(1e6, 0), 0);
  assert.ok(sourceVideoBitrate(100, 60) > 0); // tiny files never go to 0 / negative
});

test("capToSource: a same-size export never exceeds the source rate (+15%)", () => {
  const src = 1.2e6;
  assert.equal(capToSource(videoBitrateFor(1920, 1080), src, 1), Math.round(src * 1.15));
  assert.equal(capToSource(1e6, src, 1), 1e6); // a target already under the cap is kept
});

test("capToSource: downscale / crop lowers the cap sublinearly; speed raises it", () => {
  const src = 4e6;
  const full = capToSource(20e6, src, 1);
  const quarter = capToSource(20e6, src, 0.25);
  assert.ok(quarter < full && quarter > full * 0.25, "sublinear drop");
  assert.equal(capToSource(20e6, src, 1, 2), Math.round(src * 1.15 * 2));
  assert.equal(capToSource(20e6, src, 1, 0.5), full); // slow-mo never lowers it below the 1x cap
});

test("capToSource: floor keeps tiny crops legible but never exceeds the source's own rate", () => {
  assert.equal(capToSource(20e6, 2e6, 0.0001), 300e3);
  assert.equal(capToSource(20e6, 100e3, 0.0001), Math.round(100e3 * 1.15));
  assert.equal(capToSource(7.5e6, 0, 1), 7.5e6); // unknown source rate → uncapped
});

test("piecesOf: segments divided at split points; splits in cuts or at edges are ignored", async () => {
  const { piecesOf } = await import("../src/editor/transforms.js");
  const t = { trimIn: 1, trimOut: 10, cuts: [{ in: 4, out: 5 }], splits: [3, 4.5, 7, 10] };
  assert.deepEqual(piecesOf(t), [{ in: 1, out: 3 }, { in: 3, out: 4 }, { in: 5, out: 7 }, { in: 7, out: 10 }]);
  assert.deepEqual(piecesOf({ trimIn: 0, trimOut: 5, cuts: [], splits: [] }), [{ in: 0, out: 5 }]);
});
