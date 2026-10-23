// Tool options bar: one thin row under the header showing ONLY what the active tool — or the selected item —
// can change: colour + stroke for shapes, colour + size for text, ratio / exact W × H / swap / Apply for Crop,
// and for a selected item its opacity + Duplicate / Delete. Where there's nothing to set it shows a one-line
// hint instead. Built per subject (tool or item kind) and only rebuilt when the subject changes; live values
// (active swatch, stroke, opacity, crop size) are synced in place on every render, never stealing focus.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { COLORS, RATIOS, WEIGHTS, escapeHtml, ico } = NS;
  const STROKE = new Set(["pencil", "arrow", "rect", "highlight"]);   // kinds with a stroke weight
  const COLORED = new Set(["pencil", "arrow", "rect", "highlight", "text", "step"]);
  const WEIGHT_NAMES = { sm: "Thin", md: "Medium", lg: "Thick" };
  const SIZE_NAMES = { sm: "Small", md: "Medium", lg: "Large" };
  const HINTS = {
    select: "Click an item to select it · drag its handles to resize · <kbd>⇧</kbd> keeps proportions · <kbd>⌥</kbd>-drag duplicates",
    blur: "Drag over anything private — names, emails, keys. It stays blurred in the export.",
    image: "Drag to move · corners keep proportions (<kbd>⇧</kbd> frees them)",
    step: "Click to drop the next number · they renumber as you reorder or delete",
    spot: "Drag a rectangle to spotlight — everything else dims",
    pick: "Click anywhere to pick its colour · <kbd>Esc</kbd> to cancel",
  };

  Object.assign(NS.Editor.prototype, {

    wireOptions(bar) {
      this.opts = bar;
      // Buttons here mustn't take focus from an open text frame (that would commit it mid-edit).
      bar.addEventListener("mousedown", (e) => { if (this.textSession && !e.target.closest("input")) e.preventDefault(); });
      bar.addEventListener("click", (e) => this.onOptionsClick(e));
      bar.addEventListener("input", (e) => this.onOptionsInput(e));
      bar.addEventListener("change", (e) => this.onOptionsChange(e));
      bar.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target.classList.contains("num")) { e.preventDefault(); e.target.blur(); } // blur → change → apply
      });
    },

    // What the bar is about: the crop frame or the eyedropper, else the selected item, else the active tool.
    optionsSubject() {
      if (this.tool === "crop") return { kind: "crop", key: "crop" };
      if (this.tool === "pick") return { kind: "pick", key: "pick" };
      const s = this.selected != null ? this.shapes[this.selected] : null;
      return s ? { kind: s.type, item: s, key: `item:${s.type}:${this.selected}` } : { kind: this.tool, key: `tool:${this.tool}` };
    },
    // Called at the end of every render(): rebuild the bar when its subject changed, else refresh values.
    syncOptions() {
      if (!this.opts) return;
      const sub = this.optionsSubject();
      if (sub.key !== this.optsKey) { this.optsKey = sub.key; this.opts.innerHTML = this.optionsHtml(sub); }
      this.refreshOptions(sub);
    },
    optionsHtml(sub) {
      const { kind, item } = sub, parts = [];
      if (kind === "crop") {
        parts.push(`<div class="grp">${RATIOS.map(([label]) => `<button class="chip" data-ratio="${label}">${escapeHtml(label)}</button>`).join("")}</div>`,
          `<div class="grp"><span class="lbl">W</span><input class="num" id="cropW" type="number" min="1" max="${this.iw}" step="1">
            <span class="lbl">×&nbsp;H</span><input class="num" id="cropH" type="number" min="1" max="${this.ih}" step="1"><span class="lbl">px</span>
            <button class="obtn" data-act="swap" title="Swap width and height (X)">${ico("swap", "#3f3f46", 14)}</button></div>`,
          `<div class="grp"><button class="obtn ok" id="cropOk">${ico("check", "#fff", 14)}Apply crop</button><button class="obtn" id="cropNo">Cancel</button>
            <span class="hint"><kbd>↵</kbd> apply · <kbd>Esc</kbd> cancel</span></div>`);
        return parts.join(`<span class="vsep"></span>`);
      }
      if (COLORED.has(kind)) {
        parts.push(`<div class="grp">${COLORS.map((c) => `<button class="sw" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
          <label class="sw custom" title="Custom colour"><input type="color" id="optColor"></label></div>`);
      }
      if (STROKE.has(kind)) {
        parts.push(`<div class="grp"><span class="lbl">Stroke</span>${WEIGHTS.map(([id, h]) => `<button class="wt" data-weight="${id}" title="${WEIGHT_NAMES[id]}"><i style="height:${h}px"></i></button>`).join("")}</div>`);
      } else if (kind === "text") {
        parts.push(`<div class="grp"><span class="lbl">Size</span>${[["sm", 10], ["md", 13], ["lg", 16]].map(([id, px]) => `<button class="wt" data-weight="${id}" title="${SIZE_NAMES[id]}"><b style="font-size:${px}px">A</b></button>`).join("")}</div>`);
      } else if (kind === "step") {
        parts.push(`<div class="grp"><span class="lbl">Size</span>${[["sm", 10], ["md", 14], ["lg", 18]].map(([id, px]) => `<button class="wt" data-weight="${id}" title="${SIZE_NAMES[id]}"><i style="width:${px}px;height:${px}px;border-radius:50%"></i></button>`).join("")}</div>`);
      } else if (kind === "spot") {
        parts.push(`<div class="grp"><span class="lbl">Dim</span><input class="rng" id="optDim" type="range" min="15" max="90" step="1"><span class="val" id="optDimVal"></span></div>`);
      } else if (kind === "pick") {
        parts.push(`<div class="grp"><span class="lbl">Colour</span><span class="sw" id="pickSwatch"></span></div>`);
      }
      if (item) {
        if (kind !== "spot") parts.push(`<div class="grp"><span class="lbl">Opacity</span><input class="rng" id="optOpacity" type="range" min="10" max="100" step="1"><span class="val" id="optOpacityVal"></span></div>`);
        parts.push(`<div class="grp"><button class="obtn" data-act="dup" title="Duplicate (⌘D)">${ico("copy", "#3f3f46", 13)}Duplicate</button>
            <button class="obtn danger" data-act="del" title="Delete (⌫)">${ico("trash", "#3f3f46", 13)}Delete</button></div>`);
      }
      if (!parts.length || HINTS[kind]) parts.push(`<span class="hint">${HINTS[kind] || ""}</span>`);
      return parts.join(`<span class="vsep"></span>`);
    },
    // Live values: the active swatch / stroke / size (the selected item's, else the tool's), opacity, and
    // the crop frame's W × H — skipping a field that has focus so typing in it is never overwritten.
    refreshOptions(sub) {
      const bar = this.opts, item = sub.item, focused = this.root.activeElement;
      const color = item && item.color ? item.color : this.color;
      for (const b of bar.querySelectorAll("[data-color]")) b.classList.toggle("on", b.dataset.color.toLowerCase() === String(color).toLowerCase());
      const custom = bar.querySelector("#optColor");
      if (custom && custom !== focused && /^#[0-9a-f]{6}$/i.test(color)) custom.value = color;
      const wid = item ? this.weightIdOf(item) : this.weightId;
      for (const b of bar.querySelectorAll("[data-weight]")) b.classList.toggle("on", b.dataset.weight === wid);
      const op = bar.querySelector("#optOpacity");
      if (op && item) {
        const v = Math.round((item.opacity ?? 1) * 100);
        if (op !== focused) op.value = v;
        bar.querySelector("#optOpacityVal").textContent = v + "%";
      }
      const dim = bar.querySelector("#optDim");
      if (dim) {
        const v = Math.round(this.spotDim * 100);
        if (dim !== focused) dim.value = v;
        bar.querySelector("#optDimVal").textContent = v + "%";
      }
      const ps = bar.querySelector("#pickSwatch");
      if (ps) ps.style.background = this.color;
      if (sub.kind === "crop") {
        this.syncRatioChips();
        const f = this.pendingCrop || this.cropBase();
        for (const [id, v] of [["cropW", f.w], ["cropH", f.h]]) { const el = bar.querySelector("#" + id); if (el && el !== focused) el.value = v; }
      }
    },
    // The stroke / size preset nearest an item's own (so the bar shows what the item actually has).
    weightIdOf(s) {
      const val = s.type === "text" ? s.size : s.type === "step" ? s.w : s.width;
      if (val == null) return this.weightId;
      const preset = (id) => (s.type === "text" ? this.textPx(id) : s.type === "step" ? this.stepPx(id) : this.weightPx(id));
      let best = this.weightId, bd = Infinity;
      for (const [id] of WEIGHTS) { const d = Math.abs(preset(id) - val); if (d < bd) { bd = d; best = id; } }
      return best;
    },

    onOptionsClick(e) {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.color) return this.setColor(b.dataset.color);
      if (b.dataset.weight) return this.setWeight(b.dataset.weight);
      if (b.dataset.ratio) return this.setCropRatio(b.dataset.ratio);
      if (b.id === "cropOk") return this.applyCrop();
      if (b.id === "cropNo") return this.cancelCrop();
      const act = b.dataset.act;
      if (act === "swap") return this.swapCrop();
      if (act === "dup") return this.duplicateSelected();
      if (act === "del") return this.deleteSelected();
    },
    // Continuous inputs (the opacity slider, the custom colour picker) coalesce into one undo step per drag.
    onOptionsInput(e) {
      const t = e.target;
      if (t.id === "optOpacity") return this.setOpacity(Number(t.value) / 100);
      if (t.id === "optColor") return this.setColor(t.value, "color-picker");
      if (t.id === "optDim") return this.setSpotDim(Number(t.value) / 100);
    },
    onOptionsChange(e) {
      const t = e.target;
      if (t.id === "optOpacity" || t.id === "optColor" || t.id === "optDim") { this.histRun = null; return; } // the drag ended
      if (t.id === "cropW" || t.id === "cropH") {
        const w = Number(this.opts.querySelector("#cropW").value), h = Number(this.opts.querySelector("#cropH").value);
        this.setCropSize(w, h, t.id === "cropW" ? "w" : "h");
      }
    },

    // How dark everything outside the spotlights gets (one document-wide level, undoable per drag).
    setSpotDim(v) {
      this.pushHistoryOnce("spot-dim");
      this.spotDim = Math.max(0.15, Math.min(0.9, v));
      this.render();
    },
    // Opacity of the selected item (10–100 %), baked into the export like everything else.
    setOpacity(v) {
      const s = this.selected != null ? this.shapes[this.selected] : null;
      if (!s) return;
      this.pushHistoryOnce("opacity:" + this.selected);
      s.opacity = Math.max(0.1, Math.min(1, v));
      this.render();
    },
  });
})();
