// Director: scripted, frame-accurate capture of a live page. Time is VIRTUAL — every call below advances a
// clock by whole frames and writes one PNG per frame, so how long Chrome takes to screenshot never shows up
// in the video. Mouse movement is dispatched as real input events (hover states, drags and clicks all behave
// as they do for a person), and because headless captures carry no OS cursor, a synthetic cursor + click ripple
// is drawn into the page, positioned in the same frame as the input.
//
//   const d = createDirector(page, { fps: 30, outDir });
//   await d.install();                  // injects the cursor overlay
//   await d.hold(1);                    // a still second
//   await d.glide(x, y, 0.7);           // move the cursor
//   await d.click();                    // press + release with a ripple
//   await d.drag([[x,y],[x2,y2]], 1.2); // press at the first point, travel, release
//   await d.key("c");                   // a key press
//   await d.finish();                   // writes manifest.json (frame count, marks, click times)
import { writeFileSync, mkdirSync, linkSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const ease = {
  linear: (u) => u,
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  out: (u) => 1 - Math.pow(1 - u, 3),
};

// cursorScale shrinks/grows the synthetic cursor + ripple (1 = a 28px arrow; ~0.6 suits a 340px-wide popup).
// pace stretches every duration (2 = everything takes twice as long) to slow a whole scripted tour down.
// speech: { [caption text]: seconds } — how long the voiceover takes to say each say() line; the next line (and so
// the next step) waits until the previous one has been spoken, plus a breath, so the narration never has to rush.
export function createDirector(page, { fps = 30, outDir, cursor = true, start = [80, 80], cursorScale = 1, pace = 1, speech = null } = {}) {
  mkdirSync(join(outDir, "frames"), { recursive: true });
  let frameNo = 0;
  let pos = { x: start[0], y: start[1] };
  let down = false;
  let rippleAge = null; // seconds since the last press, or null
  let lastFile = null, dirty = true;
  const marks = {}, clicks = [], captions = [];

  const t = () => frameNo / fps;
  const name = (n) => join(outDir, "frames", `${String(n).padStart(6, "0")}.png`);

  async function install() {
    await page.evaluate(`(() => {
      if (document.getElementById('__cur')) return;
      const S = ${cursorScale};
      const el = document.createElement('div');
      el.id = '__cur';
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      el.innerHTML = '<svg id="__cur_arrow" width="' + (28 * S) + '" height="' + (30 * S) + '" viewBox="0 0 28 30" style="position:absolute;left:' + (-3 * S) + 'px;top:' + (-2 * S) + 'px;filter:drop-shadow(0 ' + (2 * S) + 'px ' + (3 * S) + 'px rgba(0,0,0,.35))"><path d="M4 2.5v21.2l5.3-4.9 3.6 8.1 3.6-1.6-3.6-8h7.4z" fill="#fff" stroke="#111" stroke-width="1.7" stroke-linejoin="round"/></svg><div id="__cur_ring" style="position:absolute;left:0;top:0;width:0;height:0;border-radius:50%;border:' + (3 * S) + 'px solid rgba(34,197,94,.9);transform:translate(-50%,-50%);opacity:0"></div>';
      document.documentElement.appendChild(el);
      window.__cursor = (x, y, age, visible) => {
        el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        el.style.display = visible ? 'block' : 'none';
        const ring = document.getElementById('__cur_ring');
        if (age == null || age > 0.5) { ring.style.opacity = 0; return; }
        const u = age / 0.5, s = (14 + 52 * (1 - Math.pow(1 - u, 3))) * S;
        ring.style.width = ring.style.height = s + 'px';
        ring.style.opacity = String(0.9 * (1 - u));
      };
    })()`);
  }

  // Capture one frame (or re-use the previous file when nothing changed since it was taken).
  async function snap({ force = false } = {}) {
    if (!dirty && !force && lastFile && rippleAge == null) {
      try { linkSync(lastFile, name(frameNo)); } catch { copyFileSync(lastFile, name(frameNo)); }
      frameNo++;
      return;
    }
    await page.evaluate(`(async () => {
      if (window.__cursor) window.__cursor(${pos.x}, ${pos.y}, ${rippleAge == null ? "null" : rippleAge}, ${cursor});
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`, true);
    const png = await page.screenshot();
    const file = name(frameNo);
    writeFileSync(file, png);
    lastFile = file;
    dirty = false;
    frameNo++;
    if (rippleAge != null) { rippleAge += 1 / fps; if (rippleAge > 0.5) rippleAge = null; }
  }

  const frames = (sec) => Math.max(1, Math.round(sec * pace * fps));
  const buttons = () => (down ? 1 : 0);
  async function moveTo(x, y) { pos = { x, y }; dirty = true; await page.mouse("mouseMoved", x, y, { buttons: buttons() }); }

  const api = {
    install, t, fps, marks, clicks,
    get pos() { return { ...pos }; },
    mark(label) { marks[label] = t(); return marks[label]; },
    // A caption for the film from this moment until the next one (and, optionally, the key-cap for a
    // shortcut being used), recorded on the same clock as the frames so it can never drift off its step.
    async say(text, key = null) {
      const prev = captions[captions.length - 1];
      const need = prev && speech && speech[prev.text] ? prev.t + speech[prev.text] + 0.45 : 0;
      if (t() < need) await api.hold((need - t()) / pace);
      captions.push({ t: t(), text, ...(key ? { key } : {}) });
    },
    // A still beat: the first frame is captured, the rest repeat it (unless a ripple is still animating).
    async hold(sec) { for (let i = 0; i < frames(sec); i++) await snap(); },
    // Run page-side work, then let the result show up in the very next frame.
    async act(fn) { await fn(page); dirty = true; await snap(); },
    async glide(x, y, sec, { curve = 0.12, easing = ease.inOut } = {}) {
      const from = { ...pos }, n = frames(sec), dx = x - from.x, dy = y - from.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len; // an arc, like a hand, instead of a ruler line
      for (let i = 1; i <= n; i++) {
        const u = easing(i / n), bow = Math.sin(Math.PI * u) * curve * len * (i === n ? 0 : 1);
        await moveTo(from.x + dx * u + nx * bow, from.y + dy * u + ny * bow);
        await snap();
      }
    },
    async click({ settle = 0.3 } = {}) {
      clicks.push({ t: t(), x: pos.x, y: pos.y });
      down = true; rippleAge = 0;
      await page.mouse("mousePressed", pos.x, pos.y, { buttons: 1 }); dirty = true;
      await snap();
      down = false;
      await page.mouse("mouseReleased", pos.x, pos.y, { buttons: 0 }); dirty = true;
      for (let i = 0; i < frames(settle); i++) await snap();
    },
    // Press at points[0], travel through the rest with the button held, release at the last point.
    async drag(points, sec, { easing = ease.inOut, curve = 0 } = {}) {
      await api.glide(points[0][0], points[0][1], 0.35, { curve: 0.08 });
      down = true;
      await page.mouse("mousePressed", pos.x, pos.y, { buttons: 1 }); dirty = true;
      await snap();
      const legs = points.length - 1, per = sec / legs;
      for (let l = 1; l <= legs; l++) {
        const a = { ...pos }, b = { x: points[l][0], y: points[l][1] }, n = frames(per);
        for (let i = 1; i <= n; i++) {
          const u = easing(i / n);
          await moveTo(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u + (curve ? Math.sin(Math.PI * u) * curve : 0));
          await snap();
        }
      }
      down = false;
      await page.mouse("mouseReleased", pos.x, pos.y, { buttons: 0 }); dirty = true;
      await snap();
    },
    async key(k, opts = {}) { await page.key(k, opts); dirty = true; await snap(); },
    async type(text, perKey = 0.07) {
      for (const ch of text) { await page.insertText(ch); dirty = true; for (let i = 0; i < frames(perKey); i++) await snap(); }
    },
    // Real time passes (e.g. an export running): sample the page every `every` seconds of wall clock and
    // give each sample `holdSec` of video time, so slow work plays back as a quick, readable progression.
    async fastForward(until, { every = 350, holdSec = 0.12, maxSec = 60 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxSec * 1000) {
        const done = await page.evaluate(until);
        dirty = true;
        for (let i = 0; i < frames(holdSec); i++) await snap({ force: i === 0 });
        if (done) return true;
        await new Promise((r) => setTimeout(r, every));
      }
      return false;
    },
    // A clean still of the current state (cursor hidden) for screenshots; does not advance the clock.
    async still(label) {
      mkdirSync(join(outDir, "stills"), { recursive: true });
      await page.evaluate(`(async () => { if (window.__cursor) window.__cursor(0, 0, null, false); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`, true);
      writeFileSync(join(outDir, "stills", `${label}.png`), await page.screenshot());
      dirty = true; // the cursor comes back on the next frame
    },
    frameCount: () => frameNo,
    async finish(extra = {}) {
      const manifest = { fps, frames: frameNo, duration: frameNo / fps, marks, clicks, captions, ...extra };
      writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      return manifest;
    },
    ease,
  };
  return api;
}
