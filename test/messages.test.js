// Unit tests for the pure logic in src/lib/messages.js — zero deps, runs under `node --test`.
// These functions back the recording timer, download filenames, and settings, so their edge cases
// (pause math, hour rollover, default merge precedence) are worth pinning down. DOM-heavy content
// scripts and the offscreen MediaRecorder engine can't be unit-tested without a banned headless dep,
// so the strategy is to keep pure logic here in src/lib/ and test that.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  elapsedMs, fmtClock, stamp, mergeSettings, DEFAULT_SETTINGS,
  normalizeCountdown, bubbleSizePx, bubbleRadius, clampToViewport, BUBBLE_SIZES, restartOptions,
  SOURCE,
} from "../src/lib/messages.js";

test("elapsedMs: zero when no state or no startedAt", () => {
  assert.equal(elapsedMs(null, 1000), 0);
  assert.equal(elapsedMs({}, 1000), 0);
  assert.equal(elapsedMs({ startedAt: 0 }, 1000), 0); // falsy startedAt → treated as not started
});

test("elapsedMs: running time is now - startedAt", () => {
  assert.equal(elapsedMs({ startedAt: 1000 }, 6000), 5000);
});

test("elapsedMs: subtracts paused total while running", () => {
  assert.equal(elapsedMs({ startedAt: 1000, pausedTotalMs: 2000 }, 6000), 3000);
});

test("elapsedMs: freezes at pausedAt while paused (ignores now)", () => {
  const s = { startedAt: 1000, paused: true, pausedAt: 4000, pausedTotalMs: 0 };
  assert.equal(elapsedMs(s, 99999), 3000); // 4000 - 1000, regardless of `now`
});

test("elapsedMs: paused with prior paused spans subtracted", () => {
  const s = { startedAt: 1000, paused: true, pausedAt: 8000, pausedTotalMs: 2000 };
  assert.equal(elapsedMs(s, 99999), 5000); // 8000 - 1000 - 2000
});

test("elapsedMs: never negative", () => {
  assert.equal(elapsedMs({ startedAt: 5000, pausedTotalMs: 999999 }, 6000), 0);
});

test("fmtClock: always HH:MM:SS, zero-padded", () => {
  assert.equal(fmtClock(0), "00:00:00");
  assert.equal(fmtClock(5), "00:00:05");
  assert.equal(fmtClock(65), "00:01:05");
  assert.equal(fmtClock(3600), "01:00:00");
  assert.equal(fmtClock(3661), "01:01:01");
  assert.equal(fmtClock(36000), "10:00:00");
});

test("fmtClock: floors fractional seconds and clamps negatives to zero", () => {
  assert.equal(fmtClock(9.9), "00:00:09");
  assert.equal(fmtClock(-10), "00:00:00");
});

test("stamp: filesystem-safe YYYY-MM-DD_HH-MM-SS shape", () => {
  assert.match(stamp(), /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
  assert.doesNotMatch(stamp(), /[\/:\\ ]/); // no path/colon/space chars that break filenames
});

test("mergeSettings: fills in defaults when nothing stored", () => {
  assert.deepEqual(mergeSettings(undefined, undefined), { ...DEFAULT_SETTINGS });
  assert.deepEqual(mergeSettings(null, null), { ...DEFAULT_SETTINGS });
});

test("mergeSettings: stored overrides defaults; patch overrides stored", () => {
  const stored = { withMic: false, videoFps: 60 };
  assert.equal(mergeSettings(stored, undefined).withMic, false);
  assert.equal(mergeSettings(stored, undefined).videoFps, 60);
  assert.equal(mergeSettings(stored, { videoFps: 24 }).videoFps, 24); // patch wins
  assert.equal(mergeSettings(stored, { videoFps: 24 }).withMic, false); // untouched stored kept
});

test("mergeSettings: unknown keys pass through (forward-compatible)", () => {
  assert.equal(mergeSettings({ futureFlag: 7 }, undefined).futureFlag, 7);
  assert.equal(mergeSettings(undefined, { futureFlag: 9 }).futureFlag, 9);
});

test("mergeSettings: does not mutate inputs or DEFAULT_SETTINGS", () => {
  const stored = { withMic: false };
  const snapshot = { ...DEFAULT_SETTINGS };
  mergeSettings(stored, { videoFps: 60 });
  assert.deepEqual(stored, { withMic: false });
  assert.deepEqual(DEFAULT_SETTINGS, snapshot); // frozen + untouched
});

test("mergeSettings: includes the new recording defaults", () => {
  const s = mergeSettings(undefined, undefined);
  assert.equal(s.countdownSec, 3);
  assert.equal(s.bubbleShape, "circle");
  assert.equal(s.bubbleSize, "md");
  assert.equal(s.bubbleCorner, "br");
});

test("normalizeCountdown: accepts allowed values, coerces strings, falls back to 3", () => {
  assert.equal(normalizeCountdown(0), 0);
  assert.equal(normalizeCountdown(3), 3);
  assert.equal(normalizeCountdown(5), 5);
  assert.equal(normalizeCountdown(10), 10);
  assert.equal(normalizeCountdown("5"), 5); // coerced
  assert.equal(normalizeCountdown(4), 3); // not allowed → default
  assert.equal(normalizeCountdown(-1), 3);
  assert.equal(normalizeCountdown(NaN), 3);
  assert.equal(normalizeCountdown(undefined), 3);
});

test("bubbleSizePx: maps presets, falls back to md for unknown", () => {
  assert.equal(bubbleSizePx("sm"), BUBBLE_SIZES.sm);
  assert.equal(bubbleSizePx("md"), BUBBLE_SIZES.md);
  assert.equal(bubbleSizePx("lg"), BUBBLE_SIZES.lg);
  assert.equal(bubbleSizePx("bogus"), BUBBLE_SIZES.md);
  assert.equal(bubbleSizePx(undefined), BUBBLE_SIZES.md);
});

test("bubbleRadius: circle is half the diameter, square is a small corner", () => {
  assert.equal(bubbleRadius("circle", 140), 70);
  assert.equal(bubbleRadius("square", 140), Math.round(140 * 0.18));
  assert.equal(bubbleRadius("anything-else", 100), 50); // non-square treated as circle
});

test("restartOptions: carries settings + pins the tab, drops transient fields", () => {
  const state = {
    phase: "recording", recordingTabId: 42, source: "videocircle", withMic: false, withSystemAudio: true,
    videoFormat: "mp4", videoFps: 60, videoMaxHeight: 1440, countdownSec: 5, bubbleShape: "square",
    bubbleSize: "lg", camMirror: false,
    // transient — must NOT be carried:
    startedAt: 123456, paused: true, pausedAt: 200000, pausedTotalMs: 9999, clipId: "abc", micMuted: true, drawActive: true,
  };
  const o = restartOptions(state);
  assert.deepEqual(o, {
    tabId: 42, recordSource: "videocircle", withMic: false, withSystemAudio: true,
    videoFormat: "mp4", videoFps: 60, videoMaxHeight: 1440, countdownSec: 5,
    bubbleShape: "square", bubbleSize: "lg", camMirror: false,
  });
  // explicitly assert transients are absent
  for (const k of ["startedAt", "paused", "pausedAt", "pausedTotalMs", "clipId", "micMuted", "drawActive", "phase"]) {
    assert.ok(!(k in o), `restartOptions leaked transient field: ${k}`);
  }
});

test("restartOptions: tolerates missing state", () => {
  assert.equal(restartOptions(null).tabId, undefined);
  assert.equal(restartOptions(undefined).recordSource, undefined);
});

test("SOURCE: includes the screen kind alongside tab and video-circle", () => {
  assert.equal(SOURCE.SCREEN, "screen");
  assert.equal(SOURCE.TAB, "tab");
  assert.equal(SOURCE.VIDEO_CIRCLE, "videocircle");
});

test("clampToViewport: keeps a box inside the viewport with a margin", () => {
  // within bounds → unchanged
  assert.deepEqual(clampToViewport(100, 100, 140, 140, 1000, 800, 4), { x: 100, y: 100 });
  // past right/bottom → clamped to vw/vh - size - margin
  assert.deepEqual(clampToViewport(9999, 9999, 140, 140, 1000, 800, 4), { x: 1000 - 140 - 4, y: 800 - 140 - 4 });
  // past left/top → clamped to margin
  assert.deepEqual(clampToViewport(-50, -50, 140, 140, 1000, 800, 4), { x: 4, y: 4 });
  // default margin is 4
  assert.deepEqual(clampToViewport(-50, -50, 10, 10, 100, 100), { x: 4, y: 4 });
});
