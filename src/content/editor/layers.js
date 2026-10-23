// The layers panel (list over a locked Background row; select, hover-outline, show / hide, drag to reorder,
// duplicate, delete, re-edit text) and adding image layers.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { GREEN, LAYER_ICON, escapeHtml, ico, newAssetId, stepNumbers } = NS;

  Object.assign(NS.Editor.prototype, {

    // ── layers panel ──
    // Human label + (for text) a content snippet, used both in the panel and as a row title.
    layerLabel(s) {
      const NAMES = { text: "Text", arrow: "Arrow", rect: "Rectangle", highlight: "Highlight", blur: "Blur", pencil: "Pencil", image: "Image", step: "Step", spot: "Spotlight" };
      if (s.type === "step") return `Step ${stepNumbers(this.shapes)[this.shapes.indexOf(s)] || ""}`.trim();
      return NAMES[s.type] || s.type;
    },
    layerSnippet(s) {
      if (s.type !== "text") return "";
      const t = (s.text || "").replace(/\s+/g, " ").trim();
      return t.length > 22 ? t.slice(0, 22) + "…" : t;
    },
    // Re-paint the list from this.shapes, TOP-of-stack first (reverse array order), with the screenshot
    // itself as a locked "Background" row at the bottom (Photoshop-style: it can't be moved, hidden or
    // deleted; clicking it deselects). Each item row carries its array index in data-i; the eye / duplicate
    // / × controls carry data-act; rows reorder by dragging (onLayerDown). render() calls this on every repaint, so the rows are only rebuilt when
    // what they show changes, and a newly selected row is scrolled into view.
    renderLayers() {
      const list = this.lyList;
      if (!list) return;
      const key = JSON.stringify([this.selected, this.shapes.map((s) => [s.type, !!s.hidden, this.layerSnippet(s), this.layerLabel(s)])]);
      if (key === this.layersKey) return;
      const selChanged = !this.layersKey || JSON.parse(this.layersKey)[0] !== this.selected;
      this.layersKey = key;
      const last = this.shapes.length - 1;
      let html = this.shapes.length ? "" : `<div class="ly-empty">Draw something or add an image —<br>every mark is its own layer.</div>`;
      for (let i = last; i >= 0; i--) {
        const s = this.shapes[i];
        const sel = i === this.selected;
        const snip = this.layerSnippet(s);
        const name = s.type === "text"
          ? `${escapeHtml(snip || "(empty)")}<span class="sub"> · Text</span>`
          : escapeHtml(this.layerLabel(s));
        const glyph = LAYER_ICON[s.type] || "rect";
        html += `<div class="ly-row ${sel ? "on" : ""} ${s.hidden ? "hid" : ""}" data-i="${i}" title="${escapeHtml(this.layerLabel(s) + (snip ? ": " + snip : ""))} — drag to reorder">
          <span class="ly-grip">${ico("grip", "currentColor", 12, 2.4)}</span>
          <span class="ly-glyph">${ico(glyph, sel ? GREEN : "#71717a", 13, 1.8)}</span>
          <span class="ly-name">${name}</span>
          <span class="ly-act">
            <button class="ly-ib" data-act="vis" title="${s.hidden ? "Show" : "Hide"}">${ico(s.hidden ? "eyeoff" : "eye", "#9aa0ab", 14)}</button>
            <button class="ly-ib" data-act="dup" title="Duplicate (⌘D)">${ico("copy", "#9aa0ab", 13)}</button>
            <button class="ly-ib del" data-act="del" title="Delete (⌫)">${ico("x", "#9aa0ab", 14)}</button>
          </span></div>`;
      }
      html += `<div class="ly-row bg" data-bg="1" title="The screenshot — locked">
          <span class="ly-thumb"><img alt="" src="${this.backgroundThumb()}"></span>
          <span class="ly-name">Background</span>
          <span class="ly-lock" title="Locked">${ico("lock", "#9aa0ab", 13)}</span></div>
        <div class="ly-drop" id="lyDrop"></div>`;
      list.innerHTML = html;
      if (selChanged && this.selected != null) list.querySelector(`.ly-row[data-i="${this.selected}"]`)?.scrollIntoView({ block: "nearest" });
    },
    // A small cover-cropped thumbnail of the screenshot for the Background row, made once.
    backgroundThumb() {
      if (!this.bgThumb) {
        const c = document.createElement("canvas"), W = 60, H = 44;
        c.width = W; c.height = H;
        const k = Math.max(W / this.iw, H / this.ih);
        c.getContext("2d").drawImage(this.img, (W - this.iw * k) / 2, (H - this.ih * k) / 2, this.iw * k, this.ih * k);
        this.bgThumb = c.toDataURL("image/png");
      }
      return this.bgThumb;
    },
    // Hovering a row outlines its item on the canvas (with any tool).
    onLayerHover(e) {
      const row = e.target.closest(".ly-row[data-i]");
      this.setHover(row ? Number(row.dataset.i) : null);
    },
    // Resolve the clicked row's shape index; act on the specific control or select the row.
    onLayerClick(e) {
      if (this.rowDragged) { this.rowDragged = false; return; } // the click that ends a row drag
      const row = e.target.closest(".ly-row"); if (!row) return;
      if (row.dataset.bg) { this.closeTextInput(true); return this.select(null); } // the locked Background: deselect
      const i = Number(row.dataset.i);
      if (Number.isNaN(i) || !this.shapes[i]) return;
      const btn = e.target.closest("[data-act]");
      if (!btn) { this.selectLayer(i); return; }
      const act = btn.dataset.act;
      if (act === "vis") this.toggleLayerHidden(i);
      else if (act === "dup") { this.selected = i; this.duplicateSelected(); }
      else if (act === "del") this.deleteLayer(i);
    },
    // Double-clicking a text row re-opens its inline editor (mirrors the on-canvas dbl-click path).
    onLayerDblClick(e) {
      const row = e.target.closest(".ly-row"); if (!row) return;
      if (e.target.closest("[data-act]")) return; // ignore dbl-clicks on the action buttons
      const i = Number(row.dataset.i);
      if (this.shapes[i] && this.shapes[i].type === "text") { this.selectLayer(i); this.editText(i); }
    },
    // Selecting from the panel selects the item on the canvas, handles up — editable with whatever tool is
    // active (only Crop, which works on the whole image, hands over to Move).
    selectLayer(i) {
      this.closeTextInput(true);
      if (this.tool === "crop") this.setTool("select");
      this.select(i);
    },
    toggleLayerHidden(i) {
      const s = this.shapes[i]; if (!s) return;
      this.pushHistory();
      s.hidden = !s.hidden;
      this.redoStack = [];
      this.render();
    },
    // Reorder by ±1 in the z-stack (⌘] / ⌘[): +1 = toward the top (later in array), −1 = down.
    moveLayer(i, dir) { this.moveLayerTo(i, i + dir); },
    // Move item i to array index j (one undo step); the moved item ends up selected.
    moveLayerTo(i, j) {
      j = Math.max(0, Math.min(this.shapes.length - 1, j));
      if (i === j || !this.shapes[i]) return;
      this.pushHistory(); this.redoStack = [];
      const [s] = this.shapes.splice(i, 1);
      this.shapes.splice(j, 0, s);
      this.select(j);
    },
    // Drag a row to reorder: it only becomes a drag past a few px (so a click still selects); a green line
    // shows where it will land; the Background row stays at the bottom.
    onLayerDown(e) {
      const row = e.target.closest(".ly-row[data-i]");
      if (!row || e.button !== 0 || e.target.closest("[data-act]")) return;
      this.rowDrag = { i: Number(row.dataset.i), y: e.clientY, row, on: false, to: null, pointerId: e.pointerId };
    },
    onLayerMove(e) {
      const d = this.rowDrag;
      if (!d) return this.onLayerHover(e);
      if (!d.on && Math.abs(e.clientY - d.y) < 5) return;
      // Capture only once it IS a drag — capturing on the press would retarget a plain click to the list.
      if (!d.on) { d.on = true; d.row.classList.add("dragging"); this.lyList.setPointerCapture(d.pointerId); }
      // The gap the pointer is nearest, counted in display order (top row = 0); then as an array index.
      const rows = [...this.lyList.querySelectorAll(".ly-row[data-i]")], n = rows.length;
      let g = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      if (g < 0) g = n;
      const from = n - 1 - d.i, at = g > from ? g - 1 : g;
      d.to = n - 1 - at;
      const lb = this.lyList.getBoundingClientRect(), edge = g < n ? rows[g].getBoundingClientRect().top - 3 : rows[n - 1].getBoundingClientRect().bottom + 1;
      Object.assign(this.lyList.querySelector("#lyDrop").style, { display: "block", top: edge - lb.top + this.lyList.scrollTop + "px" });
    },
    onLayerUp() {
      const d = this.rowDrag;
      this.rowDrag = null;
      if (!d || !d.on) return;
      this.rowDragged = true; // swallow the click that follows the drop
      setTimeout(() => { this.rowDragged = false; }, 0);
      d.row.classList.remove("dragging");
      this.lyList.querySelector("#lyDrop").style.display = "none";
      if (d.to != null && d.to !== d.i) this.moveLayerTo(d.i, d.to);
    },
    deleteLayer(i) {
      if (!this.shapes[i]) return;
      this.pushHistory();
      this.shapes.splice(i, 1);
      // Keep this.selected valid relative to the removed index.
      if (this.selected === i) this.selected = null;
      else if (this.selected != null && this.selected > i) this.selected -= 1;
      this.redoStack = [];
      this.render();
    },

    // ── image layers ──
    // Decode a picked file into an ImageBitmap, register it in the asset map under a fresh id, and
    // push a new image shape sized to ~40% of the natural width (never upscaled), centered-ish.
    async addImageFile(file) {
      let bm;
      try {
        bm = await createImageBitmap(file); // GIFs decode to their first frame — fine for a static PNG export
      } catch { return; }
      const nw = bm.width, nh = bm.height;
      if (!nw || !nh) return;
      // Target ~40% of the image's natural width, but never wider than the content (and never upscaled).
      let w = nw * 0.4;
      w = Math.min(w, nw, this.curW() * 0.9);
      const scale = w / nw;
      const h = nh * scale;
      // Center over the current (cropped) content region, in absolute source-image coords.
      const x = this.cropOx() + (this.curW() - w) / 2;
      const y = this.cropOy() + (this.curH() - h) / 2;
      const assetId = newAssetId();
      this.assets.set(assetId, bm);
      this.pushHistory();
      this.shapes.push({ type: "image", assetId, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      this.selected = this.shapes.length - 1; // placed selected, handles up, with whatever tool is active
      this.redoStack = [];
      if (this.tool === "crop") this.setTool("select");
      this.render();
    },
  });
})();
