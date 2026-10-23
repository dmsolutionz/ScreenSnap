// Guard for the split annotation editor: the service worker injects src/content/editor/*.js as an ordered
// list of plain scripts, then src/content/editor-overlay.js boots the editor. A file added to (or dropped
// from) the directory without updating that list would silently break Annotate, so pin them together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const sw = readFileSync(new URL("src/background/service-worker.js", root), "utf8");
const match = sw.match(/files: \[([^\]]*editor-overlay\.js[^\]]*)\]/);
const listed = match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

test("the service worker injects the annotation editor as an ordered file list", () => {
  assert.ok(listed.length > 1, "editor file list not found in service-worker.js");
  assert.equal(listed.at(-1), "src/content/editor-overlay.js", "the boot file must be injected last");
  assert.equal(listed[0], "src/content/editor/core.js", "core (the namespace + constants) must load first");
});

test("every src/content/editor/ file is injected exactly once, and every listed file exists", () => {
  const dir = readdirSync(new URL("src/content/editor/", root)).filter((f) => f.endsWith(".js")).map((f) => `src/content/editor/${f}`);
  assert.deepEqual([...listed.slice(0, -1)].sort(), dir.sort());
  assert.equal(new Set(listed).size, listed.length, "a file is listed twice");
  for (const f of listed) assert.ok(existsSync(new URL(f, root)), `${f} is listed but missing`);
});

test("each part registers into the shared namespace (plain script, no module syntax)", () => {
  for (const f of listed) {
    const src = readFileSync(new URL(f, root), "utf8");
    assert.match(src, /__screensnapEditorNS/, `${f} doesn't use the shared namespace`);
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, `${f} uses module syntax, which executeScript can't load`);
  }
});
