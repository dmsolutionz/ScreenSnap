// New projects: clips laid end to end, and the generated blank base sized to hold them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sequenceClips, blankLength, MAX_PROJECT_SEC } from "../src/editor/blank-project.js";

test("sequenceClips: back-to-back ranges from 0, total = sum of lengths", () => {
  const { ranges, totalSec } = sequenceClips([{ durationSec: 2 }, { durationSec: 3.5 }, { durationSec: 1 }]);
  assert.deepEqual(ranges, [{ inSec: 0, outSec: 2 }, { inSec: 2, outSec: 5.5 }, { inSec: 5.5, outSec: 6.5 }]);
  assert.equal(totalSec, 6.5);
  assert.deepEqual(sequenceClips([]), { ranges: [], totalSec: 0 });
});

test("blankLength: whole frames that cover the content, at least one, capped", () => {
  assert.equal(blankLength(6.5), 7);
  assert.equal(blankLength(30), 30);
  assert.equal(blankLength(0), 1);
  assert.equal(blankLength(1e9), MAX_PROJECT_SEC);
});
