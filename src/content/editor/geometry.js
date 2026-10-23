// Pure geometry for the annotation editor — NO DOM, so test/editor-geometry.test.js can load it in a
// node:vm sandbox: item bounds + hit-tests, handle hit-testing, box resize (ratio / centre / bounds), shape
// fitting, translation, rotation, crop-rect math, text layout. Text is measured through a hook (an estimate here;
// view.js installs the real canvas measurement).
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  // Text measuring hook: a character-count estimate keeps this file DOM-free (and testable); view.js
  // replaces it with a real canvas measurement as soon as it loads, before any editor exists.
  const geo = { measure: (size, str) => size * String(str).length * 0.6 };
  const MIN_BOX = 4;     // smallest box (image px) a resize leaves
  const MIN_CROP = 8;    // smallest crop frame (image px)
  const LH = 1.25;       // text line height, × font size — shared by the canvas and the inline editor

  // Text layout: the lines a text item shows, each with its offset into s.text (so a click can place the
  // caret). Hard returns always break; with a wrap width s.w (a text BOX, as opposed to point text that
  // grows with its lines) words wrap greedily the way the inline editor's pre-wrap does, and a word wider
  // than the box breaks between characters.
  function textLayout(s) {
    const out = [], text = String(s.text || ""), fits = (str) => geo.measure(s.size, str) <= s.w;
    let start = 0;
    for (const para of text.split("\n")) {
      if (!s.w) { out.push({ text: para, start }); start += para.length + 1; continue; }
      let line = "", lineStart = start, pos = start;
      for (let tok of para.match(/\s+|\S+/g) || []) {
        if (/^\s/.test(tok)) { line += tok; pos += tok.length; continue; } // spaces hang at a line end
        if (line && !fits(line + tok)) { out.push({ text: line, start: lineStart }); line = ""; lineStart = pos; }
        while (!line && tok.length > 1 && !fits(tok)) {                   // a word wider than the box
          let n = 1;
          while (n < tok.length - 1 && fits(tok.slice(0, n + 1))) n++;
          out.push({ text: tok.slice(0, n), start: pos });
          pos += n; lineStart = pos; tok = tok.slice(n);
        }
        line += tok; pos += tok.length;
      }
      out.push({ text: line, start: lineStart });
      start += para.length + 1;
    }
    return out;
  }
  const textLines = (s) => textLayout(s).map((l) => l.text);
  function textBox(s) {
    const lines = textLines(s);
    const w = s.w || Math.max(0, ...lines.map((l) => geo.measure(s.size, l)));
    return { x: s.x, y: s.y, w, h: lines.length * LH * s.size };
  }
  // The character offset in s.text nearest point p (image px) — where a click in the text puts the caret.
  function textOffsetAt(s, p) {
    const lines = textLayout(s), lh = LH * s.size;
    const ln = lines[clamp(Math.floor((p.y - s.y) / lh), 0, lines.length - 1)];
    let best = 0, bestD = Infinity;
    for (let n = 0; n <= ln.text.length; n++) {
      const d = Math.abs(s.x + geo.measure(s.size, ln.text.slice(0, n)) - p.x);
      if (d < bestD) { bestD = d; best = n; }
    }
    return ln.start + best;
  }

  function bbox(s) {
    if (s.type === "rect" || s.type === "blur" || s.type === "image" || s.type === "step" || s.type === "spot") return { x: s.x, y: s.y, w: s.w, h: s.h };
    if (s.type === "arrow") return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    if (s.type === "text") return textBox(s);
    const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  // ── rotation ── Images, rectangles, text and step badges can turn about their box's centre (s.rot,
  // radians). Their x / y / w / h stay the UNROTATED box, so every hit-test and resize works in the item's
  // own frame: a point is turned back into it (toLocal) first.
  const ROTATABLE = new Set(["image", "rect", "text", "step"]);
  const rotOf = (s) => (ROTATABLE.has(s.type) && s.rot) || 0;
  const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  function rotatePt(p, c, a) {
    const cs = Math.cos(a), sn = Math.sin(a), dx = p.x - c.x, dy = p.y - c.y;
    return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
  }
  function toLocal(s, p) { const a = rotOf(s); return a ? rotatePt(p, centerOf(bbox(s)), -a) : p; }
  // Axis-aligned bounds of the item as drawn (rotation included) — for snapping and outlines.
  function aabb(s) {
    const b = bbox(s), a = rotOf(s);
    if (!a) return b;
    const c = centerOf(b), pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => rotatePt({ x, y }, c, a));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  // A box resized in a turned item's own frame (b0 → box), placed back so the held side stays where it is
  // on screen: the new centre is the old one plus the local centre shift, turned by the item's angle.
  function placeRotated(b0, box, a) {
    if (!a) return box;
    const c = rotatePt(centerOf(box), centerOf(b0), a);
    return { x: c.x - box.w / 2, y: c.y - box.h / 2, w: box.w, h: box.h };
  }
  // An angle (radians) to the nearest `step` degrees, normalised to (−π, π].
  function snapAngle(a, step) {
    const r = (step * Math.PI) / 180;
    return normAngle(Math.round(a / r) * r);
  }
  function normAngle(a) { a = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a === -Math.PI ? Math.PI : a; }

  function hit(s, p, tol) {
    p = toLocal(s, p);
    if (s.type === "rect" || s.type === "blur" || s.type === "image" || s.type === "text" || s.type === "step" || s.type === "spot") { const b = bbox(s); return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol; }
    if (s.type === "arrow") return distToSeg(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < (s.width || 6) + tol;
    if (s.points) return s.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < (s.width || 6) + tol);
    return false;
  }
  // The item's visible "ink" under p: like hit(), except a rectangle is only its outline — so with a
  // drawing tool, a press INSIDE a just-drawn rectangle still starts a new item (an arrow into the box)
  // instead of grabbing the rectangle.
  function inkHit(s, p, tol) {
    if (s.type !== "rect") return hit(s, p, tol);
    p = toLocal(s, p);
    const r = (s.width || 6) / 2 + tol;
    const outer = p.x >= s.x - r && p.x <= s.x + s.w + r && p.y >= s.y - r && p.y <= s.y + s.h + r;
    const inner = p.x > s.x + r && p.x < s.x + s.w - r && p.y > s.y + r && p.y < s.y + s.h - r;
    return outer && !inner;
  }
  // Step badges number themselves by stacking order: the bottom-most visible badge is 1. Returns the number
  // for each index (null for everything else), so deleting, reordering, hiding or undoing re-sequences them.
  function stepNumbers(shapes) {
    let n = 0;
    return shapes.map((s) => (s.type === "step" && !s.hidden ? ++n : null));
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  const inBox = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  // Whole-pixel copy of r, at least 1 px and kept inside a W × H image.
  function intRect(r, W, H) {
    const w = clamp(Math.round(r.w), 1, W), h = clamp(Math.round(r.h), 1, H);
    return { x: clamp(Math.round(r.x), 0, W - w), y: clamp(Math.round(r.y), 0, H - h), w, h };
  }
  // What part of box b point p is on: { hx, hy } for an edge or corner (-1 left/top, 1 right/bottom, 0 not
  // that axis), "inside", or null. Edges grab along their whole length within `tol` image px; on the inner
  // side the reach shrinks to a quarter of the side so a small box still has a middle to move it by.
  // With edges=false only corners count (text), and a pure edge falls through to inside / null.
  function boxHit(b, p, tol, edges = true) {
    const axis = (lo, hi, v, near) => {
      if (!near) return 0;
      const t = Math.max(0, Math.min(tol, (hi - lo) / 4));
      const atLo = v >= lo - tol && v <= lo + t, atHi = v <= hi + tol && v >= hi - t;
      if (atLo && atHi) return Math.abs(v - lo) <= Math.abs(v - hi) ? -1 : 1;
      return atLo ? -1 : atHi ? 1 : 0;
    };
    const nearX = p.x >= b.x - tol && p.x <= b.x + b.w + tol, nearY = p.y >= b.y - tol && p.y <= b.y + b.h + tol;
    const hx = axis(b.x, b.x + b.w, p.x, nearY), hy = axis(b.y, b.y + b.h, p.y, nearX);
    if ((hx || hy) && (edges || (hx && hy))) return { hx, hy };
    return p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h ? "inside" : null;
  }
  // Box b with handle (hx, hy) dragged by d. `ratio` (w / h) locks the proportions — a corner follows
  // whichever side was stretched more, an edge drags the other side along about its centre line; `alt`
  // resizes about the centre; `bounds` ({ w, h }) keeps the result inside the image by shrinking it (ratio
  // intact) instead of letting a side run off. Sides never go below `min`; no flipping past the anchor.
  function resizeBox(b, hx, hy, d, { ratio = null, alt = false, bounds = null, min = MIN_BOX } = {}) {
    // Per axis: the fixed coordinate, which way the side grows (1 / -1, or 0 = centred) and the new length.
    const axis = (lo, len, h, dv) => {
      if (h === 0) return { fix: lo + len / 2, dir: 0, len };
      if (alt) return { fix: lo + len / 2, dir: 0, len: Math.max(min, len + 2 * h * dv) };
      return h > 0 ? { fix: lo, dir: 1, len: Math.max(min, len + dv) } : { fix: lo + len, dir: -1, len: Math.max(min, len - dv) };
    };
    const ax = axis(b.x, b.w, hx, d.x), ay = axis(b.y, b.h, hy, d.y);
    let w = ax.len, h = ay.len;
    if (ratio) {
      if (hx && hy) { const s = Math.max(w / ratio, h); w = s * ratio; h = s; }
      else if (hx) h = w / ratio;
      else w = h * ratio;
    }
    if (bounds) {
      // Room from the fixed point in the growth direction (centred: twice the nearer side).
      const room = (a, total) => (a.dir > 0 ? total - a.fix : a.dir < 0 ? a.fix : 2 * Math.min(a.fix, total - a.fix));
      const mw = room(ax, bounds.w), mh = room(ay, bounds.h);
      if (ratio) { const s = Math.min(1, mw / w, mh / h); w *= s; h *= s; }
      else { w = Math.min(w, mw); h = Math.min(h, mh); }
    }
    const place = (a, len) => (a.dir > 0 ? a.fix : a.dir < 0 ? a.fix - len : a.fix - len / 2);
    return { x: place(ax, w), y: place(ay, h), w, h };
  }
  // Shape s (as it was when the resize began, bounds b0) fitted to new bounds b: boxes take b, strokes
  // scale their points (stroke width kept), text scales its font size (and a box's wrap width) — it
  // only resizes uniformly from a corner.
  function resizeShape(s, b0, b) {
    const c = clone(s);
    if (c.type === "text") { const k = b.h / (b0.h || 1); c.size = Math.max(4, s.size * k); if (s.w) c.w = s.w * k; c.x = b.x; c.y = b.y; return c; }
    if (c.points) {
      const sx = b0.w ? b.w / b0.w : 1, sy = b0.h ? b.h / b0.h : 1;
      c.points = s.points.map((p) => ({ x: b.x + (p.x - b0.x) * sx, y: b.y + (p.y - b0.y) * sy }));
      return c;
    }
    c.x = b.x; c.y = b.y; c.w = b.w; c.h = b.h;
    return c;
  }
  function translate(s, dx, dy) {
    const c = JSON.parse(JSON.stringify(s));
    if (c.points) c.points = c.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (c.x != null) { c.x += dx; c.y += dy; }
    if (c.x1 != null) { c.x1 += dx; c.y1 += dy; c.x2 += dx; c.y2 += dy; }
    return c;
  }
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Normalize a crop drag (anchor x1,y1 → pointer x2,y2) into {x,y,w,h}, clamped to the W × H image.
  // With a fixed ratio (w/h), the rect grows from the drag's anchor corner toward the pointer: width is
  // taken from the drag, height derived as w/ratio (or vice-versa, whichever stays in bounds), then
  // clamped so the ratio-locked rect never leaves the image.
  function dragRect(d, ratio, W, H) {
    if (ratio) {
      const ax = d.x1, ay = d.y1;                 // fixed anchor corner
      const dirX = d.x2 >= ax ? 1 : -1, dirY = d.y2 >= ay ? 1 : -1;
      let w = Math.abs(d.x2 - ax);
      let h = w / ratio;
      // Cap the rect so it fits inside the image when grown in the current drag direction.
      const maxW = dirX > 0 ? W - ax : ax;
      const maxH = dirY > 0 ? H - ay : ay;
      if (w > maxW) { w = maxW; h = w / ratio; }
      if (h > maxH) { h = maxH; w = h * ratio; }
      const x = dirX > 0 ? ax : ax - w;
      const y = dirY > 0 ? ay : ay - h;
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }
    // Clamp both edges, so a drag past the image's edge stops AT the edge (it used to keep the full drag
    // length from the clamped corner, pushing the frame past its anchor).
    const x = clamp(Math.min(d.x1, d.x2), 0, W), x2 = clamp(Math.max(d.x1, d.x2), 0, W);
    const y = clamp(Math.min(d.y1, d.y2), 0, H), y2 = clamp(Math.max(d.y1, d.y2), 0, H);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
  }
  // Largest rect of ratio r (w/h) centred in frame f — never adds area, as photocraft's presets don't.
  function ratioFit(f, r, W, H) {
    const w = Math.min(f.w, f.h * r), h = w / r;
    return intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, W, H);
  }
  // Smart-guide snap: the closest pairing (within thr) of box b's edges / centre with the target lines xs /
  // ys, per allowed axis. Returns the correction to add and the guide lines it snapped to.
  function snapDelta(b, xs, ys, thr, snapX = true, snapY = true) {
    const best = (from, to) => {
      let m = null;
      for (const c of from) for (const t of to) { const dv = t - c; if (Math.abs(dv) <= thr && (!m || Math.abs(dv) < Math.abs(m.dv))) m = { dv, t }; }
      return m;
    };
    const bx = snapX ? best([b.x, b.x + b.w / 2, b.x + b.w], xs) : null;
    const by = snapY ? best([b.y, b.y + b.h / 2, b.y + b.h], ys) : null;
    const guides = [];
    if (bx) guides.push({ x: bx.t });
    if (by) guides.push({ y: by.t });
    return { x: bx ? bx.dv : 0, y: by ? by.dv : 0, guides };
  }

  Object.assign(NS, { stepNumbers, ROTATABLE, rotOf, centerOf, rotatePt, toLocal, aabb, placeRotated, snapAngle, normAngle, LH, textLayout, textLines, textOffsetAt, inkHit, dragRect, ratioFit, snapDelta, geo, MIN_BOX, MIN_CROP, bbox, hit, clone, clamp, sameRect, inBox, intRect, boxHit, resizeBox, resizeShape, translate, distToSeg });
})();
