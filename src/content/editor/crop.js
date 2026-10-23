// Crop (non-destructive): the frame's gestures (draw / move / resize / nudge), ratio presets, exact W × H and
// orientation swap (from the options bar), and committing the frame as the applied crop.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { MIN_CROP, RATIOS, boxHit, clamp, dragRect, intRect, ratioFit, resizeBox, sameRect } = NS;

  Object.assign(NS.Editor.prototype, {

    // ── crop (non-destructive) ──
    // The Crop tool always shows a frame over the whole image: the applied crop if there is one, else a
    // frame around everything (photocraft / Photoshop do the same). Drag inside it to move it (clamped to
    // the image), drag an edge or corner to resize it (a ratio preset — or ⇧ — keeps its proportions, ⌥
    // resizes about the centre), drag outside it — or inside the untouched full frame — to draw a new one
    // (⇧ square). Arrows nudge it. Apply / ↵ commits it as this.crop, Cancel discards the edit, Esc resets
    // an edited frame and then leaves the tool, and switching tools commits an edited frame.
    fullRect() { return { x: 0, y: 0, w: this.iw, h: this.ih }; },
    cropBase() { return this.crop ? { ...this.crop } : this.fullRect(); },
    cropDirty() { return !!this.pendingCrop && !sameRect(this.pendingCrop, this.cropBase()); },
    commitCrop() {
      if (!this.cropDirty()) return;
      this.pushHistory();
      const c = this.pendingCrop;
      this.crop = sameRect(c, this.fullRect()) ? null : { x: c.x, y: c.y, w: c.w, h: c.h };
      this.redoStack = [];
    },
    resetCropFrame() { this.pendingCrop = this.cropBase(); this.render(); },
    cropDown(p) {
      const f = this.pendingCrop || (this.pendingCrop = this.cropBase());
      const h = boxHit(f, p, this.grab());
      if (h && h !== "inside") this.drag = { kind: "crop-resize", hx: h.hx, hy: h.hy, start: p, orig: { ...f } };
      else if (h === "inside" && !sameRect(f, this.fullRect())) this.drag = { kind: "crop-move", start: p, orig: { ...f } };
      else {
        const x = clamp(p.x, 0, this.iw), y = clamp(p.y, 0, this.ih);
        this.drag = { kind: "crop-draw", x1: x, y1: y, x2: x, y2: y, prev: { ...f } };
      }
    },
    cropMove(d, p, e) {
      const W = this.iw, H = this.ih;
      let r;
      if (d.kind === "crop-draw") { d.x2 = p.x; d.y2 = p.y; r = this.cropRect(d, this.cropRatio || (e.shiftKey ? 1 : null)); }
      else {
        const dx = p.x - d.start.x, dy = p.y - d.start.y;
        if (d.kind === "crop-move") r = { ...d.orig, x: clamp(d.orig.x + dx, 0, W - d.orig.w), y: clamp(d.orig.y + dy, 0, H - d.orig.h) };
        else {
          const ratio = this.cropRatio || (e.shiftKey ? d.orig.w / d.orig.h : null);
          r = resizeBox(d.orig, d.hx, d.hy, { x: dx, y: dy }, { ratio, alt: e.altKey, bounds: { w: W, h: H }, min: MIN_CROP });
        }
      }
      this.pendingCrop = intRect(r, W, H);
      if (d.kind !== "crop-move") this.showReadout(e, this.pendingCrop.w, this.pendingCrop.h);
      this.render();
    },
    nudgeCrop(dx, dy) {
      const f = this.pendingCrop || this.cropBase();
      this.pendingCrop = { ...f, x: clamp(f.x + dx, 0, this.iw - f.w), y: clamp(f.y + dy, 0, this.ih - f.h) };
      this.render();
    },

    // A crop drag (anchor x1,y1 → pointer x2,y2) as a frame inside the image; see geometry's dragRect.
    cropRect(d, ratio = this.cropRatio) { return dragRect(d, ratio, this.iw, this.ih); },

    // Apply the frame non-destructively: it becomes (or replaces) this.crop, which render()/save()
    // honor, in one undo step; the frame is in absolute source-image coords, so re-adjusting an applied
    // crop needs no extra math. Then back to the tool used before Crop. Cancel drops the edit.
    applyCrop() { this.commitCrop(); this.leaveCrop(); },
    cancelCrop() { this.pendingCrop = this.cropBase(); this.leaveCrop(); },
    leaveCrop() { this.setTool(this.prevTool && this.prevTool !== "crop" ? this.prevTool : "select"); },

    // ── crop aspect-ratio presets ──
    // Look up a ratio (number|null) by its preset label.
    ratioFor(label) { const r = RATIOS.find((x) => x[0] === label); return r ? r[1] : null; },
    // Highlight the preset in force (none after a swap to a ratio without a chip, e.g. 3:4).
    syncRatioChips() {
      const hit = RATIOS.find((r) => (r[1] == null ? this.cropRatio == null : this.cropRatio != null && Math.abs(r[1] - this.cropRatio) < 1e-6));
      for (const b of this.root.querySelectorAll("[data-ratio]")) b.classList.toggle("on", !!hit && b.dataset.ratio === hit[0]);
    },
    // Set the active aspect-ratio for cropping (switching to the Crop tool if needed). A preset refits
    // the frame to the largest rect of that ratio centred in it — never adding area, as photocraft's
    // presets don't — and then holds while the frame is drawn or resized. Free leaves the frame as-is.
    setCropRatio(label) {
      this.cropRatio = this.ratioFor(label);
      this.syncRatioChips();
      if (this.tool !== "crop") this.setTool("crop");
      if (this.cropRatio != null) {
        this.pendingCrop = ratioFit(this.pendingCrop || this.cropBase(), this.cropRatio, this.iw, this.ih);
      }
      this.render();
    },

    // Exact size from the options bar's W × H (image px): kept centred on the frame, clamped to the image,
    // and with a ratio in force the other side follows the one typed (`changed` = "w" | "h").
    setCropSize(w, h, changed) {
      if (!(w > 0) || !(h > 0)) return this.render(); // an invalid entry just snaps back
      const f = this.pendingCrop || this.cropBase(), r = this.cropRatio;
      w = Math.round(Math.min(w, this.iw)); h = Math.round(Math.min(h, this.ih));
      if (r) {
        if (changed === "w") h = Math.round(w / r); else w = Math.round(h * r);
        if (h > this.ih) { h = this.ih; w = Math.round(h * r); }
        if (w > this.iw) { w = this.iw; h = Math.round(w / r); }
      }
      this.pendingCrop = intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, this.iw, this.ih);
      this.render();
    },
    // Portrait ⇄ landscape about the frame's centre (X, or the swap button); a ratio in force flips with
    // it. A frame that wouldn't fit turned is scaled down to fit, proportions kept.
    swapCrop() {
      const f = this.pendingCrop || this.cropBase();
      if (this.cropRatio) this.cropRatio = 1 / this.cropRatio;
      let w = f.h, h = f.w;
      const k = Math.min(1, this.iw / w, this.ih / h);
      w *= k; h *= k;
      this.pendingCrop = intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, this.iw, this.ih);
      this.render();
    },
  });
})();
