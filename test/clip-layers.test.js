// Time mapping for imported video clip layers: where a clip is on screen, which of its frames shows, and
// how timeline drags retime / trim it without ever running past either end of the clip's own file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipTimeAt, clipRangePatch } from "../src/editor/clip-layers.js";

const clip = (over = {}) => ({
  kind: "video",
  range: { inSec: 4, outSec: 9 },
  video: { durationSec: 10, srcIn: 2, x: 0, y: 0, w: 100, h: 50 },
  ...over,
});

test("clipTimeAt: maps main source time into the clip from its in-point, null off its range", () => {
  const l = clip();
  assert.equal(clipTimeAt(l, 3.99), null);
  assert.equal(clipTimeAt(l, 4), 2);
  assert.equal(clipTimeAt(l, 6.5), 4.5);
  assert.equal(clipTimeAt(l, 9), null); // range end is exclusive, like every layer range
});

test("clipRangePatch: a move keeps the length and in-point", () => {
  const p = clipRangePatch(clip(), { tIn: 1, tOut: 6 }, "move");
  assert.deepEqual(p.range, { inSec: 1, outSec: 6 });
  assert.equal(p.video.srcIn, 2);
});

test("clipRangePatch: dragging the left edge trims the clip's start, frames stay put", () => {
  const l = clip();
  const p = clipRangePatch(l, { tIn: 5, tOut: 9 }, "in");
  assert.deepEqual(p.range, { inSec: 5, outSec: 9 });
  assert.equal(p.video.srcIn, 3);
  // The frame at main time 6 is the same before and after the trim.
  assert.equal(clipTimeAt({ ...l, ...p }, 6), clipTimeAt(l, 6));
});

test("clipRangePatch: the left edge can't reach before the file's first frame", () => {
  const p = clipRangePatch(clip(), { tIn: 0, tOut: 9 }, "in");
  assert.deepEqual(p.range, { inSec: 2, outSec: 9 });
  assert.equal(p.video.srcIn, 0);
});

test("clipRangePatch: the right edge can't run past the file's last frame", () => {
  const p = clipRangePatch(clip(), { tIn: 4, tOut: 30 }, "out");
  assert.deepEqual(p.range, { inSec: 4, outSec: 12 }); // 10s file from srcIn 2 = 8s of clip
});

test("clipTimeAt: a looping clip restarts from the file's start when it runs out", () => {
  const l = clip({ range: { inSec: 0, outSec: 30 }, video: { durationSec: 10, srcIn: 0, loop: true, x: 0, y: 0, w: 1, h: 1 } });
  assert.equal(clipTimeAt(l, 4), 4);
  assert.equal(clipTimeAt(l, 12), 2);
  assert.equal(clipTimeAt(l, 25.5), 5.5);
  assert.equal(clipTimeAt(l, 30), null);
});

test("clipRangePatch: a looping clip's edges aren't capped at the file length; its in-point wraps", () => {
  const l = clip({ range: { inSec: 0, outSec: 10 }, video: { durationSec: 10, srcIn: 0, loop: true, x: 0, y: 0, w: 1, h: 1 } });
  assert.deepEqual(clipRangePatch(l, { tIn: 0, tOut: 45 }, "out").range, { inSec: 0, outSec: 45 });
  const p = clipRangePatch(l, { tIn: 13, tOut: 20 }, "in");
  assert.deepEqual(p.range, { inSec: 13, outSec: 20 });
  assert.equal(p.video.srcIn, 3);
  // The frame at main time 15 is the same before and after the left-edge trim.
  const looped = { ...l, range: { inSec: 0, outSec: 30 } };
  assert.equal(clipTimeAt({ ...looped, ...p }, 15), clipTimeAt(looped, 15));
});
