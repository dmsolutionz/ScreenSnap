// The Editor class: construction, the blur source, undo / redo history, export (Save / Copy) and
// teardown. Behaviour lives in prototype mixins (view, shell, crop, transform, text, layers), added by the
// files injected after this one.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});

  class Editor {
    constructor(img, filename) {
      this.img = img;
      this.filename = filename || "screenshot.png";
      this.iw = img.naturalWidth;
      this.ih = img.naturalHeight;
      this.shapes = [];
      // Side store of decoded image bitmaps, keyed by a stable assetId. NOT cleared by undo/redo
      // (snapshots only serialize the assetId + geometry, never pixels), so image layers survive
      // history while staying JSON-serializable.
      this.assets = new Map();
      this.undoStack = [];
      this.redoStack = [];
      this.tool = "rect";
      this.color = "#ef4444";
      this.weightId = "md";
      this.selected = null;
      this.drag = null;
      this.editingText = false;
      this.textSession = null; // the open text frame, if any (text.js) — only one at a time
      this.destroyed = false;
      this.scale = 1;
      this.hover = null;       // rollover item (index): under the Move pointer, or under a hovered layer row
      this.guides = [];        // smart-guide lines of the move in progress: { x } | { y }
      this.histSeq = 0;        // bumps on every history event (nudge runs coalesce while it holds)
      this.nudgeRun = null;
      this.histRun = null;     // the continuous gesture (slider / picker) the last undo step belongs to
      this.prevTool = null;    // the tool to return to when Crop is applied / cancelled
      this.exporting = false;
      this.zoom = null;        // null = fit the stage; else CSS px per image px (zoom.js)
      this.spaceDown = false;  // Space held: drag pans
      this.pan = null;
      this.crop = null;        // applied, non-destructive crop region in source-image coords {x,y,w,h}
      this.pendingCrop = null; // unconfirmed crop rect {x,y,w,h} awaiting Apply/Cancel
      this.cropRatio = null;   // null = free; else a number (w/h), e.g. 16/9 — constrains crop drags & preset fits
      this.backdrop = null;    // null = off; else { pad, radius, shadow, bg } — pad/radius are fractions of content width
      this.spotDim = 0.55;     // how dark everything outside the spotlights gets (0–1); part of the document
      this.unit = Math.max(1, this.iw / 900);
      this.buildBlur();
      this.buildDOM();
      this.render();
      this.updateStatus();
    }

    // Stroke width / text size of a preset (sm | md | lg; the current one by default), scaled to the image.
    weightPx(id = this.weightId) { return ({ sm: 2, md: 4, lg: 7 }[id]) * this.unit; }
    textPx(id = this.weightId) { return ({ sm: 18, md: 26, lg: 40 }[id]) * this.unit; }
    stepPx(id = this.weightId) { return ({ sm: 30, md: 42, lg: 58 }[id]) * this.unit; } // step badge diameter

    buildBlur() {
      const c = document.createElement("canvas");
      c.width = this.iw; c.height = this.ih;
      const x = c.getContext("2d");
      x.filter = `blur(${Math.max(6, Math.round(this.iw / 110))}px)`;
      x.drawImage(this.img, 0, 0);
      this.blurCanvas = c;
    }

    // History captures shapes + the applied crop + the backdrop (+ the spotlight dim) together, so undo/redo
    // restores all of them. (cropRatio is a transient tool setting, not part of the document, so it's not tracked.)
    // Image shapes serialize as { type:"image", assetId, x,y,w,h, hidden } — a string id + geometry,
    // never pixels — so JSON round-trips cleanly; drawShape re-resolves assetId → bitmap from
    // this.assets (which undo/redo never touch, so the bitmap survives across history). The per-shape
    // `hidden` flag is plain data and round-trips automatically.
    snapshot() { return JSON.stringify({ shapes: this.shapes, crop: this.crop, backdrop: this.backdrop, spotDim: this.spotDim }); }
    restore(json) { const s = JSON.parse(json); this.shapes = s.shapes; this.crop = s.crop || null; this.backdrop = s.backdrop || null; this.spotDim = s.spotDim ?? 0.55; this.syncBackdropUI(); }
    // histSeq counts history events, so a nudge run can tell nothing else was recorded since it began.
    pushHistory() { this.histSeq++; this.undoStack.push(this.snapshot()); if (this.undoStack.length > 80) this.undoStack.shift(); }
    // One undo step per continuous gesture (a slider drag, the colour picker): push only if the last
    // history event wasn't this same run.
    pushHistoryOnce(key) {
      if (this.histRun && this.histRun.key === key && this.histRun.seq === this.histSeq) return;
      this.pushHistory(); this.redoStack = [];
      this.histRun = { key, seq: this.histSeq };
    }
    // Record a snapshot taken earlier (a text edit session records the state from before it opened).
    pushHistorySnapshot(json) { this.histSeq++; this.undoStack.push(json); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; }
    undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); this.afterHistory(); }
    redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); this.afterHistory(); }
    // In Crop mode the frame follows the restored crop; elsewhere there is no frame.
    afterHistory() {
      this.histSeq++;
      this.selected = null; this.hover = null;
      this.pendingCrop = this.tool === "crop" ? this.cropBase() : null;
      this.render();
    }

    // Paint the export view — applied crop + backdrop, no frame / handles / rollover / guides — and return
    // a function that restores the editing view. A frame edited in Crop is committed first (as leaving
    // the tool would), so Save / Copy take the crop the user is looking at; it stays undoable.
    exportView() {
      if (this.tool === "crop") { this.commitCrop(); this.pendingCrop = this.cropBase(); }
      const sel = this.selected, hov = this.hover;
      this.selected = null; this.hover = null; this.exporting = true;
      this.render();
      return () => { this.exporting = false; this.selected = sel; this.hover = hov; this.render(); };
    }
    async copy() {
      let restore = null;
      try {
        restore = this.exportView();
        const blob = await new Promise((r) => this.canvas.toBlob(r, "image/png"));
        restore(); restore = null;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        this.flash("copy", "Copied ✓");
      } catch { if (restore) restore(); this.flash("copy", "Blocked"); }
    }
    save() {
      this.exportView(); // no restore: the editor closes once the PNG is handed off
      const dataUrl = this.canvas.toDataURL("image/png");
      chrome.runtime.sendMessage({ type: "editor-save", dataUrl, filename: this.filename }, () => this.destroy(false));
    }
    flash(id, text) {
      const b = this.root.getElementById(id);
      const prev = b.innerHTML;
      b.textContent = text;
      setTimeout(() => (b.innerHTML = prev), 1200);
    }
    destroy(cancelled) {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this.textSession) { this.textSession.done = true; this.textSession = null; } // its frame dies with the host
      window.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("keyup", this.onKeyUp, true);
      window.removeEventListener("blur", this.onBlurWin);
      if (cancelled) chrome.runtime.sendMessage({ type: "editor-cancel" });
      this.host.remove();
      // Free the big pixel buffers now instead of whenever GC gets to them: a Retina full-page shot is
      // ~190 MB per canvas (main + blur), plus the decoded image and any image layers.
      this.canvas.width = this.canvas.height = 0;
      this.blurCanvas.width = this.blurCanvas.height = 0;
      for (const bm of this.assets.values()) bm.close?.();
      this.assets.clear();
      this.img = null;
      this.undoStack = []; this.redoStack = [];
      if (window.__screensnapEditor === this) window.__screensnapEditor = null;
    }
  }
  NS.Editor = Editor;
})();
