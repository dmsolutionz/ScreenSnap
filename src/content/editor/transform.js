// Pointer gestures: drawing new items, the Move tool's select / move / resize / endpoint drags, smart-guide
// snapping, arrow-key nudges, hover feedback (cursor + rollover), the size readout, delete. The selected
// item stays editable under every tool, so a just-placed item can be adjusted without switching to Move.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { HANDLES, HANDLE_PX, MIN_BOX, MIN_CROP, NUDGE_RUN_MS, ROTATABLE, ROTATE_CURSOR, ROT_OFF, SNAP_PX, aabb, bbox, boxHit, centerOf, clone, hit, inBox, inkHit, normAngle, placeRotated, resizeBox, resizeCursor, resizeCursorAt, resizeShape, rotOf, rotatePt, sameRect, snapAngle, snapDelta, toLocal, translate } = NS;

  Object.assign(NS.Editor.prototype, {

    // Drags carry a `kind` for gestures on existing things ("move" / "resize" / "endpoint" on the selected
    // item, "crop-*" on the crop frame, "text-new" placing text); drawing a new item is a kind-less drag
    // with the tool's fields.
    down(e) {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      // A press outside an open text frame commits it — and only that (photocraft: no new text from it).
      if (this.textSession) return this.closeTextInput(true);
      const p = this.toImg(e);
      if (this.tool === "crop") return this.cropDown(p);
      if (this.tool === "select") return this.selectDown(p, e);
      if (this.tool === "pick") return this.pickDown(p);
      // Any other tool: the selected item stays live — its handles and its ink edit it right away (re-aim
      // a just-placed arrow, nudge a box) without switching to Move; a press anywhere else makes something new.
      if (this.pressSelected(p, e)) return;
      if (this.tool === "text") return this.textDown(p);
      if (this.tool === "step") return this.placeStep(p);
      const w = this.weightPx();
      this.select(null);
      if (this.tool === "pencil" || this.tool === "highlight") this.drag = { tool: this.tool, color: this.color, width: w, points: [p] };
      else this.drag = { tool: this.tool, color: this.color, width: w, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    },
    move(e) {
      const d = this.drag;
      if (!d) return;
      const p = this.toImg(e);
      if (d.kind && d.kind.startsWith("crop")) return this.cropMove(d, p, e);
      if (d.kind === "text-new") { d.x2 = p.x; d.y2 = p.y; return; }
      if (d.kind) return this.transformMove(d, p, e);
      if (d.points) d.points.push(p);
      else { d.x2 = p.x; d.y2 = p.y; }
      this.render();
    },
    up() {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.guides = [];
      this.hideReadout();
      if (d.kind && d.kind.startsWith("crop")) {
        // A click (or a too-small drag) where a new frame would start keeps the frame it would replace.
        const f = this.pendingCrop;
        if (d.kind === "crop-draw" && (!f || f.w < MIN_CROP || f.h < MIN_CROP)) this.pendingCrop = d.prev;
        return this.render();
      }
      if (d.kind === "text-new") return this.placeText(d);
      if (d.kind) {
        if (d.moved) this.redoStack = []; // a real transform happened (history pushed on its first movement)
      } else {
        // A finished item is selected straight away, handles up, so it can be adjusted with the same tool.
        // A spotlight goes to the BOTTOM of the stack, so by default it dims only the screenshot.
        const s = this.toShape(d);
        if (s) {
          this.pushHistory(); this.redoStack = [];
          if (s.type === "spot") { this.shapes.unshift(s); this.selected = 0; }
          else { this.shapes.push(s); this.selected = this.shapes.length - 1; }
        }
      }
      this.render();
    },

    // ── select / move / resize, photocraft-style ──
    // Move tool: a press on the selected item's handles transforms it; on an item selects it and moves it
    // (⌥ moves a copy); on empty space inside the selected item's box still moves it (strokes are thin);
    // elsewhere deselects.
    selectDown(p, e) {
      if (this.pressSelected(p, e, false)) return;
      const sel = this.selected != null ? this.shapes[this.selected] : null;
      const top = this.topAt(p);
      const idx = top != null ? top : sel && !sel.hidden && inBox(bbox(sel), toLocal(sel, p)) ? this.selected : null;
      if (idx != null) this.drag = { kind: "move", idx, start: p, orig: clone(this.shapes[idx]), box0: bbox(this.shapes[idx]), dup: e.altKey };
      this.select(idx);
    },
    // A press on the selected item: its handles start a resize / endpoint drag; with a drawing tool its ink
    // (a rectangle's outline, a stroke, a filled box) starts a move. Returns true when it took the press.
    // The Move tool handles item bodies itself (selectDown), so `ink` is off there.
    pressSelected(p, e, ink = true) {
      const sel = this.selected != null ? this.shapes[this.selected] : null;
      if (!sel || sel.hidden) return false;
      const h = this.handleAt(sel, p);
      if (h) {
        this.drag = { kind: h.end ? "endpoint" : h.rot ? "rotate" : "resize", ...h, idx: this.selected, start: p, orig: clone(sel), box0: bbox(sel) };
        return true;
      }
      if (!ink || !this.onInk(sel, p) || (this.tool === "text" && sel.type === "text")) return false; // Text edits text on a press
      this.drag = { kind: "move", idx: this.selected, start: p, orig: clone(sel), box0: bbox(sel), dup: e.altKey };
      return true;
    },
    onInk(s, p) { return inkHit(s, p, 5 / this.scale); },
    // The handle of selected item s under p: { hx, hy } on its box, { end } on an arrow's endpoint, or null.
    // With Move the whole edge of the box grabs (photocraft); with a drawing tool only the handle squares
    // do, so drawing right next to a selected item still draws. Text has no top / bottom handles (its
    // height follows its lines): its corners scale it and its sides set the wrap width.
    handleAt(s, p) {
      const tol = this.grab();
      if (s.type === "arrow") {
        if (Math.hypot(p.x - s.x2, p.y - s.y2) <= tol) return { end: 2 };
        if (Math.hypot(p.x - s.x1, p.y - s.y1) <= tol) return { end: 1 };
        return null;
      }
      // Turned items: test in their own frame. The round rotate handle sits above the top edge.
      const b = bbox(s), q = toLocal(s, p), k = 1 / this.scale;
      if (ROTATABLE.has(s.type) && Math.hypot(q.x - (b.x + b.w / 2), q.y - (b.y - ROT_OFF * k)) <= (HANDLE_PX / 2 + 4) * k) return { rot: true };
      if (this.tool !== "select") {
        const r = (HANDLE_PX / 2 + 3) * k;
        for (const [hx, hy] of HANDLES) {
          if (s.type === "text" && !hx) continue;
          const x = b.x + ((hx + 1) / 2) * b.w, y = b.y + ((hy + 1) / 2) * b.h;
          if (Math.abs(q.x - x) <= r && Math.abs(q.y - y) <= r) return { hx, hy };
        }
        return null;
      }
      const h = boxHit(b, q, tol);
      return h && h !== "inside" && !(s.type === "text" && !h.hx) ? h : null;
    },
    // Cursor for a handle: resize arrows turned with the item, the rotate cursor, or move for endpoints.
    handleCursor(s, h) {
      if (h.end) return "move";
      if (h.rot) return ROTATE_CURSOR;
      return resizeCursorAt(h.hx, h.hy, rotOf(s));
    },
    // Live transform of the selected item. History is snapshotted on the FIRST real movement (not a bare
    // click), so click-to-select neither adds a no-op undo entry nor wipes redo; one gesture = one step.
    transformMove(d, p, e) {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) * this.scale < 1) return; // sub-pixel jitter on a click isn't a move
        d.moved = true;
        this.pushHistory();
        if (d.dup) { this.shapes.splice(d.idx + 1, 0, clone(d.orig)); d.idx += 1; this.selected = d.idx; } // ⌥-drag: move a copy
      }
      let s;
      if (d.kind === "move") {
        // ⇧ locks the move to the dominant axis; smart guides snap the free axes (⌘/Ctrl held: no snapping).
        const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx), lockY = e.shiftKey && !lockX;
        if (lockX) dx = 0;
        if (lockY) dy = 0;
        this.guides = [];
        if (!(e.ctrlKey || e.metaKey)) {
          const ab = d.ab || (d.ab = aabb(d.orig)); // a turned item snaps by its drawn bounds
          const c = this.snapMove({ ...ab, x: ab.x + dx, y: ab.y + dy }, d.idx, !lockX, !lockY);
          dx += c.x; dy += c.y;
        }
        s = translate(d.orig, dx, dy);
      } else if (d.kind === "rotate") {
        // Turn about the box centre by the pointer's sweep; ⇧ snaps to 15° steps (photocraft).
        const c = centerOf(d.box0);
        let a = (d.orig.rot || 0) + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.start.y - c.y, d.start.x - c.x);
        a = e.shiftKey ? snapAngle(a, 15) : normAngle(a);
        s = { ...d.orig, rot: Math.abs(a) < 1e-9 ? 0 : a };
        this.showReadout(e, null, null, Math.round((a * 180) / Math.PI) + "°");
      } else if (d.kind === "endpoint") {
        // Drag one end of an arrow; ⇧ snaps the segment to 45° steps about the other end.
        const o = d.orig, ax = d.end === 1 ? o.x2 : o.x1, ay = d.end === 1 ? o.y2 : o.y1;
        let q = p;
        if (e.shiftKey) {
          const step = Math.PI / 4, a = Math.round(Math.atan2(p.y - ay, p.x - ax) / step) * step, len = Math.hypot(p.x - ax, p.y - ay);
          q = { x: ax + len * Math.cos(a), y: ay + len * Math.sin(a) };
        }
        s = d.end === 1 ? { ...o, x1: q.x, y1: q.y } : { ...o, x2: q.x, y2: q.y };
      } else {
        // Resize: text corners scale it uniformly and its sides set the wrap width; images keep their
        // proportions unless ⇧ (Photoshop CC's default, which photocraft follows); boxes and strokes are
        // free unless ⇧. ⌥ resizes about the centre.
        // A turned item resizes in its own frame (the drag turned back into it), then is placed back so
        // the held side stays put on screen.
        const t = d.orig.type, b0 = d.box0, a = rotOf(d.orig);
        const dl = a ? rotatePt({ x: dx, y: dy }, { x: 0, y: 0 }, -a) : { x: dx, y: dy };
        if (t === "text" && !d.hy) {
          const box = placeRotated(b0, resizeBox(b0, d.hx, 0, { x: dl.x, y: 0 }, { alt: e.altKey, min: d.orig.size }), a);
          s = { ...d.orig, x: box.x, y: box.y, w: box.w };
        } else {
          const keep = t === "text" || t === "step" || (t === "image" ? !e.shiftKey : e.shiftKey);
          const ratio = keep && b0.w > 0 && b0.h > 0 ? b0.w / b0.h : null;
          const box = placeRotated(b0, resizeBox(b0, d.hx, d.hy, dl, { ratio, alt: e.altKey, min: MIN_BOX }), a);
          s = resizeShape(d.orig, b0, box);
          this.showReadout(e, box.w, box.h);
        }
      }
      this.shapes[d.idx] = s;
      this.render();
    },
    // Smart guides: a moving item's edges / centre snap to the visible image's edges / centre and to the
    // other items' edges / centres within SNAP_PX screen px. Returns the correction to add on each free
    // axis and records the guide lines render() draws.
    snapMove(b, skip, snapX, snapY) {
      const thr = SNAP_PX / this.scale;
      const xs = [this.cropOx(), this.cropOx() + this.curW() / 2, this.cropOx() + this.curW()];
      const ys = [this.cropOy(), this.cropOy() + this.curH() / 2, this.cropOy() + this.curH()];
      this.shapes.forEach((s, i) => {
        if (i === skip || s.hidden) return;
        const o = aabb(s);
        xs.push(o.x, o.x + o.w / 2, o.x + o.w);
        ys.push(o.y, o.y + o.h / 2, o.y + o.h);
      });
      const r = snapDelta(b, xs, ys, thr, snapX, snapY);
      this.guides.push(...r.guides);
      return { x: r.x, y: r.y };
    },
    // Arrow-key nudge of the selected item, 1 image px (⇧ 10). A run of nudges (each within NUDGE_RUN_MS
    // of the last, nothing else recorded in between) is ONE undo step, like photocraft's nudge bundling,
    // so a held arrow key undoes in one go.
    nudgeSelected(dx, dy) {
      const i = this.selected, now = Date.now(), run = this.nudgeRun;
      if (!(run && run.idx === i && run.seq === this.histSeq && now - run.t < NUDGE_RUN_MS)) { this.pushHistory(); this.redoStack = []; }
      this.nudgeRun = { idx: i, seq: this.histSeq, t: now };
      this.shapes[i] = translate(this.shapes[i], dx, dy);
      this.render();
    },

    // Pointer feedback with no button down: the cursor says what a press would do (resize / move / draw),
    // and with the Move tool the item a click would pick gets a thin rollover outline (photocraft's
    // "highlight on rollover"). With a drawing tool only the selected item reacts (its handles and ink),
    // so drawing stays the default. Repaints only when the rollover item changes.
    hoverAt(e) {
      if (this.textSession) return;
      const p = this.toImg(e);
      if (this.tool === "pick") { this.canvas.style.cursor = "crosshair"; return this.updateLoupe(e, p); }
      let cursor = this.toolCursor(), hov = null;
      const sel = this.selected != null ? this.shapes[this.selected] : null;
      if (this.tool === "crop" && this.pendingCrop) {
        const h = boxHit(this.pendingCrop, p, this.grab());
        if (h && h !== "inside") cursor = resizeCursor(h.hx, h.hy);
        else if (h === "inside" && !sameRect(this.pendingCrop, this.fullRect())) cursor = "move";
      } else if (this.tool === "select") {
        const h = sel && !sel.hidden ? this.handleAt(sel, p) : null;
        if (h) cursor = this.handleCursor(sel, h);
        else {
          const top = this.topAt(p);
          if (top != null) { cursor = "move"; if (top !== this.selected) hov = top; }
          else if (sel && !sel.hidden && inBox(bbox(sel), toLocal(sel, p))) cursor = "move";
        }
      } else if (sel && !sel.hidden) {
        const h = this.handleAt(sel, p);
        if (h) cursor = this.handleCursor(sel, h);
        else if (this.onInk(sel, p) && !(this.tool === "text" && sel.type === "text")) cursor = "move";
      }
      this.canvas.style.cursor = cursor;
      this.setHover(hov);
    },
    setHover(i) { if (i === this.hover) return; this.hover = i; this.render(); },

    // W × H beside the pointer while a crop frame or an item is being sized (photocraft's sizing readout),
    // or the angle while one turns.
    showReadout(e, w, h, text) {
      const r = this.stage.getBoundingClientRect(), el = this.readout;
      el.textContent = text || `${Math.round(w)} × ${Math.round(h)}`;
      el.style.display = "block";
      el.style.left = Math.round(e.clientX - r.left + this.stage.scrollLeft + 14) + "px";
      el.style.top = Math.round(e.clientY - r.top + this.stage.scrollTop + 16) + "px";
    },
    hideReadout() { if (this.readout) this.readout.style.display = "none"; },

    topAt(p) {
      const tol = 9 * this.unit;
      // Hidden layers aren't pickable on-canvas (they're invisible); use the panel to select them.
      for (let i = this.shapes.length - 1; i >= 0; i--) if (!this.shapes[i].hidden && hit(this.shapes[i], p, tol)) return i;
      return null;
    },
    // Step tool: a press drops the next numbered badge centred on the pointer and keeps hold of it, so the
    // same press can drag it into place (one undo step). It stays selected for resizing / recolouring.
    placeStep(p) {
      const d = this.stepPx();
      this.pushHistory(); this.redoStack = [];
      this.shapes.push({ type: "step", color: this.color, x: p.x - d / 2, y: p.y - d / 2, w: d, h: d });
      const i = this.shapes.length - 1;
      this.drag = { kind: "move", idx: i, start: p, orig: clone(this.shapes[i]), box0: bbox(this.shapes[i]), moved: true };
      this.select(i);
    },
    // A copy of the selected item, offset a little down-right and stacked right above it (⌘D / Duplicate).
    duplicateSelected() {
      const i = this.selected, s = i != null ? this.shapes[i] : null;
      if (!s) return;
      this.pushHistory(); this.redoStack = [];
      const off = 12 * this.unit;
      this.shapes.splice(i + 1, 0, translate(s, off, off));
      this.select(i + 1);
    },
    deleteSelected() {
      if (this.selected == null) return;
      this.pushHistory();
      this.shapes.splice(this.selected, 1);
      this.selected = null;
      this.hover = null;
      this.redoStack = [];
      this.render();
    },

    toShape(d) {
      if (d.points) return d.points.length < 2 ? null : { type: d.tool, color: d.color, width: d.width, points: d.points };
      const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2), w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
      if (d.tool === "arrow") return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4 ? null : { type: "arrow", color: d.color, width: d.width, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
      if (w < 4 || h < 4) return null;
      if (d.tool === "blur") return { type: "blur", x, y, w, h };
      if (d.tool === "spot") return { type: "spot", x, y, w, h };
      return { type: d.tool, color: d.color, width: d.width, x, y, w, h };
    },
  });
})();
