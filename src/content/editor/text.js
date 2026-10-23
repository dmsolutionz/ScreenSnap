// Text, photocraft-style. With the Text tool a click places point text (it grows with its lines) and a
// drag makes a wrapping text box of that width. Editing happens in a FRAME on the canvas: the live text in
// a transparent textarea (a light "Type something" placeholder until you type) inside an outline with
// handles. It grows as you type; the corner handles scale the font, the side handles set the wrap width
// (point text becomes a box), and dragging the frame's border — or ⌘/Ctrl-dragging anywhere in it — moves
// it, all without leaving the edit. Enter is a newline; ⌘/Ctrl+Enter, Esc (photocraft's default) or a
// click outside commits, and the text stays selected with its handles. One edit session = one undo step.
// Clicking existing text with the Text tool (or double-clicking it with Move) re-opens the frame, with
// the caret where you clicked.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { LH, SANS, bbox, clone, hit, placeRotated, resizeBox, resizeCursor, rotOf, rotatePt, textOffsetAt, toLocal } = NS;
  const PLACEHOLDER = "Type something";
  const BORDER = 8;   // px of grab zone around the frame that moves the text
  const DRAG_BOX = 12; // a Text-tool drag at least this wide (screen px) makes a text box, not point text

  Object.assign(NS.Editor.prototype, {

    // Top-most visible text item under p, or null.
    textAt(p) {
      const tol = 4 / this.scale;
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (!s.hidden && s.type === "text" && hit(s, p, tol)) return i;
      }
      return null;
    },
    // Double-click a text item (any tool but Crop) to edit it.
    onCanvasDblClick(e) {
      if (this.editingText || this.tool === "crop") return;
      const p = this.toImg(e), i = this.textAt(p);
      if (i != null) this.editText(i, p);
    },
    // A Text-tool press on the canvas (outside any open frame, which the caller already committed):
    // existing text → edit it; anywhere else → start placing new text (finished in up() → placeText).
    textDown(p) {
      const i = this.textAt(p);
      if (i != null) return this.editText(i, p);
      this.select(null);
      this.drag = { kind: "text-new", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    },
    // New text from a Text-tool click (point text, its first line centred on the click) or drag (a box).
    placeText(d) {
      const size = this.textPx(), wide = Math.abs(d.x2 - d.x1) * this.scale >= DRAG_BOX;
      const s = { type: "text", color: this.color, size, text: "", x: d.x1, y: d.y1 - (LH * size) / 2 };
      if (wide) { s.x = Math.min(d.x1, d.x2); s.y = Math.min(d.y1, d.y2); s.w = Math.max(Math.abs(d.x2 - d.x1), 2 * size); }
      const before = this.snapshot();
      this.shapes.push(s);
      this.openText(this.shapes.length - 1, { before, isNew: true });
    },
    // Re-open text item i in the frame, the caret at point p (or at the end).
    editText(i, p) {
      const target = this.shapes[i];
      if (!target || target.type !== "text") return;
      this.closeTextInput(true);
      i = this.shapes.indexOf(target);
      if (i < 0) return;
      this.openText(i, { before: this.snapshot(), isNew: false, caret: p ? textOffsetAt(target, toLocal(target, p)) : target.text.length });
    },

    openText(i, { before, isNew, caret }) {
      const s = this.shapes[i];
      this.selected = i; this.hover = null; this.editingText = true;
      const frame = document.createElement("div");
      frame.className = "tframe";
      const handles = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0], [1, 0]]
        .map(([hx, hy]) => `<i class="th" data-hx="${hx}" data-hy="${hy}" style="cursor:${resizeCursor(hx, hy)}"></i>`).join("");
      frame.innerHTML = `<textarea class="tta" spellcheck="false" placeholder="${PLACEHOLDER}"></textarea>${handles}`;
      const ta = frame.querySelector("textarea");
      ta.value = s.text;
      this.stage.appendChild(frame);
      const t = this.textSession = { idx: i, shape: s, before, isNew, orig: JSON.stringify(s), frame, ta, drag: null, done: false };
      ta.addEventListener("input", () => { s.text = ta.value; this.layoutTextFrame(); this.renderLayers(); });
      ta.addEventListener("keydown", (ev) => {
        ev.stopPropagation(); // typing never reaches the editor's (or the page's) shortcuts
        if (ev.key === "Escape" || (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey))) { ev.preventDefault(); this.closeTextInput(true); }
      });
      ta.addEventListener("blur", () => this.closeTextInput(true)); // a click anywhere outside commits
      // Presses on the handles / border must not take focus from the textarea (that would commit).
      frame.addEventListener("mousedown", (ev) => { if (ev.target !== ta || ev.metaKey || ev.ctrlKey) ev.preventDefault(); });
      frame.addEventListener("pointerdown", (ev) => this.textFrameDown(ev));
      frame.addEventListener("pointermove", (ev) => this.textFrameMove(ev));
      frame.addEventListener("pointerup", () => { t.drag = null; });
      frame.addEventListener("pointercancel", () => { t.drag = null; });
      this.layoutTextFrame();
      this.render();
      setTimeout(() => {
        if (t.done) return;
        ta.focus();
        const c = caret != null ? caret : ta.value.length;
        ta.setSelectionRange(c, c);
      }, 0);
    },

    // Place the frame over the item at the current scale (stage coords, so it scrolls with the canvas):
    // the textarea is exactly the text's box — LH-tall line boxes, the canvas's line layout — and the
    // frame adds the BORDER grab zone around it. Called on every keystroke, drag and render.
    layoutTextFrame() {
      const t = this.textSession;
      if (!t) return;
      const s = t.shape, sc = this.scale, pad = this.bdPadPx();
      const probe = { ...s, text: t.ta.value || PLACEHOLDER };
      const b = bbox(probe);
      const W = Math.ceil(b.w * sc + (s.w ? 0 : 0.6 * s.size * sc)), H = Math.ceil(Math.max(b.h, LH * s.size) * sc);
      const left = this.canvas.offsetLeft + (pad + s.x - this.cropOx()) * sc;
      const top = this.canvas.offsetTop + (pad + s.y - this.cropOy()) * sc;
      // A turned text edits turned: the frame turns about the box centre (CSS's default origin = its centre).
      const a = rotOf(s);
      Object.assign(t.frame.style, { left: left - BORDER + "px", top: top - BORDER + "px", width: W + 2 * BORDER + "px", height: H + 2 * BORDER + "px", transform: a ? `rotate(${a}rad)` : "" });
      Object.assign(t.ta.style, {
        left: BORDER + "px", top: BORDER + "px", width: W + "px", height: H + "px",
        font: `600 ${s.size * sc}px ${SANS}`, lineHeight: LH * s.size * sc + "px", color: s.color,
        whiteSpace: s.w ? "pre-wrap" : "pre", overflowWrap: s.w ? "anywhere" : "normal",
      });
      for (const h of t.frame.querySelectorAll(".th")) {
        const hx = +h.dataset.hx, hy = +h.dataset.hy;
        h.style.left = BORDER + ((hx + 1) / 2) * W + "px";
        h.style.top = BORDER + ((hy + 1) / 2) * H + "px";
      }
    },

    // Frame gestures: a handle resizes (corner: font size; side: wrap width), the border zone — or a
    // ⌘/Ctrl press anywhere in the frame — moves the text. Plain presses in the textarea are the
    // textarea's own (caret, selection).
    textFrameDown(ev) {
      const t = this.textSession;
      if (!t || ev.button !== 0) return;
      const h = ev.target.closest(".th"), mod = ev.metaKey || ev.ctrlKey;
      if (ev.target === t.ta && !mod) return;
      ev.preventDefault(); ev.stopPropagation();
      t.frame.setPointerCapture(ev.pointerId);
      const p = this.toImg(ev), s = t.shape;
      const box0 = bbox({ ...s, text: t.ta.value || PLACEHOLDER });
      t.drag = h ? { kind: "resize", hx: +h.dataset.hx, hy: +h.dataset.hy, start: p, orig: clone(s), box0 } : { kind: "move", start: p, orig: clone(s) };
    },
    textFrameMove(ev) {
      const t = this.textSession;
      if (!t) return;
      if (!t.drag) { t.ta.style.cursor = ev.metaKey || ev.ctrlKey ? "move" : "text"; return; }
      const d = t.drag, s = t.shape, p = this.toImg(ev), dx = p.x - d.start.x, dy = p.y - d.start.y;
      // Handles work in the text's own frame when it's turned (the drag turned back into it).
      const a = rotOf(d.orig), dl = a ? rotatePt({ x: dx, y: dy }, { x: 0, y: 0 }, -a) : { x: dx, y: dy };
      if (d.kind === "move") { s.x = d.orig.x + dx; s.y = d.orig.y + dy; }
      else if (d.hy) {
        // Corner: scale uniformly about the opposite corner (⌥: about the centre) — font size, and a
        // box's wrap width with it.
        const box = placeRotated(d.box0, resizeBox(d.box0, d.hx, d.hy, dl, { ratio: d.box0.w / d.box0.h, alt: ev.altKey, min: 4 }), a);
        const k = box.h / d.box0.h;
        s.size = Math.max(4, d.orig.size * k);
        if (d.orig.w) s.w = d.orig.w * k;
        s.x = box.x; s.y = box.y;
      } else {
        // Side: the wrap width; point text becomes a box here.
        const box = placeRotated(d.box0, resizeBox(d.box0, d.hx, 0, { x: dl.x, y: 0 }, { alt: ev.altKey, min: d.orig.size }), a);
        s.w = box.w; s.x = box.x; s.y = box.y;
      }
      this.layoutTextFrame();
    },

    // End the edit. commit=true keeps it (an emptied text is removed); false puts everything back as it
    // was when the frame opened. Either way the whole session is one undo step, and kept text stays
    // selected with its handles.
    closeTextInput(commit = true) {
      const t = this.textSession;
      if (!t || t.done) return;
      t.done = true;
      this.textSession = null;
      this.editingText = false;
      t.frame.remove();
      const s = t.shape;
      if (!commit) { this.restore(t.before); this.selected = null; this.render(); return; }
      s.text = t.ta.value.replace(/\s+$/, "");
      const i = this.shapes.indexOf(s);
      if (!s.text.trim()) {
        if (i >= 0) this.shapes.splice(i, 1);
        if (!t.isNew) this.pushHistorySnapshot(t.before); // clearing existing text deletes it (undoable)
        this.selected = null;
      } else {
        if (t.isNew || JSON.stringify(s) !== t.orig) this.pushHistorySnapshot(t.before);
        this.selected = i;
      }
      this.render();
    },
  });
})();
