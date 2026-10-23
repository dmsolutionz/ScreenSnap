// The editor shell: the shadow-DOM UI (header, tool options bar, tool rail, stage, layers panel, status bar)
// and its wiring, keyboard shortcuts, tool / color / weight switching and the backdrop controls.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { BACKDROPS, DEFAULT_BACKDROP, GREEN, HOST_ID, RAIL, TOOLS, TOOL_KEYS, bdSwatchCss, escapeHtml, ico } = NS;

  Object.assign(NS.Editor.prototype, {

    buildDOM() {
      const host = document.createElement("div");
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: "open" });
      const tool = (id) => { const [, icon, label, key] = TOOLS.find((t) => t[0] === id); return `<button class="tool ${id === this.tool ? "on" : ""}" data-tool="${id}" title="${label} (${key.toUpperCase()})">${ico(icon, id === this.tool ? GREEN : "#71717a")}</button>`; };
      root.innerHTML = `
        <style>${NS.editorCss()}</style>
        <div class="ed">
          <div class="top">
            <span class="title">Annotate · ${escapeHtml(this.filename.split("/").pop())}</span>
            <div class="bdrop">
              <button class="bd-toggle" id="bdToggle" title="Backdrop">${ico("rect", "#3f3f46", 14)}Backdrop</button>
              <div class="bd-opts" id="bdOpts">
                <span class="bd-bgs" id="bdBgs">${BACKDROPS.map(([id, label, val]) => `<button class="bd-bg" data-bg="${id}" title="${escapeHtml(label)}" style="background:${bdSwatchCss(val)}"></button>`).join("")}</span>
                <span class="bd-pad">Pad<input type="range" id="bdPad" min="2" max="16" step="1" value="7"></span>
              </div>
            </div>
            <button class="tb ghost" id="copy">${ico("copy", "#3f3f46", 14)}Copy</button>
            <button class="tb save" id="save">${ico("down", "#fff", 14)}Save PNG</button>
            <button class="xbtn" id="close">${ico("x", "#6b7280", 15)}</button>
          </div>
          <div class="opts" id="opts"></div>
          <div class="body">
            <div class="palette" id="palette">${RAIL.map((g) => g.map(tool).join("")).join(`<div class="sep"></div>`)}</div>
            <div class="stage" id="stage"><canvas id="cv"></canvas><div class="readout" id="readout"></div>
              <div class="loupe" id="loupe"><canvas width="88" height="88"></canvas><span><i></i><b></b></span></div></div>
            <div class="layers" id="layers">
              <div class="ly-head"><span class="ttl">Layers</span><button class="ly-add" id="addImage" title="Add an image layer">${ico("image", "#3f3f46", 14)}Image</button></div>
              <div class="ly-list" id="lyList"></div>
            </div>
          </div>
          <input type="file" id="imgFile" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">

          <div class="status">
            <span class="dotc" id="st-dot"></span>
            <span id="st-tool"></span>
            <span class="sb"><button class="sbtn zoom" id="zoomPct" title="Zoom — click to fit (⌘0) · ⌘+ / ⌘− · ⌘1 = 100% · Space-drag pans">100%</button><button class="sbtn" id="undo2">${ico("undo", "#6b7280", 12)}Undo</button><button class="sbtn" id="redo2">${ico("redo", "#6b7280", 12)}Redo</button></span>
          </div>
        </div>`;
      (document.body || document.documentElement).appendChild(host);
      this.host = host; this.root = root;
      this.canvas = root.getElementById("cv");
      this.ctx = this.canvas.getContext("2d");
      this.stage = root.getElementById("stage");
      this.readout = root.getElementById("readout");
      this.loupe = root.getElementById("loupe");

      root.getElementById("palette").addEventListener("click", (e) => {
        const b = e.target.closest("[data-tool]");
        if (b) this.setTool(b.dataset.tool);
      });
      this.wireOptions(root.getElementById("opts"));
      this.wireZoom();
      root.getElementById("undo2").onclick = () => this.undo();
      root.getElementById("redo2").onclick = () => this.redo();
      root.getElementById("copy").onclick = () => this.copy();
      root.getElementById("save").onclick = () => this.save();
      root.getElementById("close").onclick = () => this.destroy(true);

      // Backdrop controls
      root.getElementById("bdToggle").onclick = () => this.toggleBackdrop();
      root.getElementById("bdBgs").addEventListener("click", (e) => {
        const b = e.target.closest("[data-bg]");
        if (b) this.setBackdropBg(b.dataset.bg);
      });
      root.getElementById("bdPad").addEventListener("input", (e) => this.setBackdropPad(e.target.value));
      this.syncBackdropUI();

      // Layers panel: row clicks (select / toggle / reorder / delete) are delegated.
      this.lyList = root.getElementById("lyList");
      this.lyList.addEventListener("click", (e) => this.onLayerClick(e));
      this.lyList.addEventListener("dblclick", (e) => this.onLayerDblClick(e));
      this.lyList.addEventListener("pointerdown", (e) => this.onLayerDown(e));
      this.lyList.addEventListener("pointermove", (e) => this.onLayerMove(e));
      this.lyList.addEventListener("pointerup", () => this.onLayerUp());
      this.lyList.addEventListener("pointercancel", () => this.onLayerUp());
      this.lyList.addEventListener("pointerleave", () => this.setHover(null));
      // Add-image affordance → hidden file input → load + place a new image layer.
      this.imgFile = root.getElementById("imgFile");
      root.getElementById("addImage").onclick = () => this.imgFile.click();
      this.imgFile.addEventListener("change", () => {
        const f = this.imgFile.files && this.imgFile.files[0];
        this.imgFile.value = ""; // reset so picking the same file again still fires `change`
        if (f) this.addImageFile(f);
      });
      this.renderLayers();

      this.onKey = (e) => this.key(e);
      window.addEventListener("keydown", this.onKey, true);
      this.canvas.addEventListener("pointerdown", (e) => this.down(e));
      this.canvas.addEventListener("pointermove", (e) => (this.drag ? this.move(e) : this.hoverAt(e)));
      this.canvas.addEventListener("pointerup", () => this.up());
      this.canvas.addEventListener("pointercancel", () => this.up());
      this.canvas.addEventListener("pointerleave", () => { this.hideLoupe(); if (!this.drag) this.setHover(null); });
      // Double-click a text item to re-open its inline editor (any tool — it's an edit gesture).
      this.canvas.addEventListener("dblclick", (e) => this.onCanvasDblClick(e));
      this.onResize = () => this.render();
      window.addEventListener("resize", this.onResize);
    },

    // Keyboard, photocraft/Photoshop-style: tool letters, arrows nudge (⇧ ×10), Delete removes, ⌘/Ctrl+Z
    // (⇧ redo), ⌘D duplicates, ⌘] / ⌘[ bring forward / send back, ⌘+ / ⌘− / ⌘0 / ⌘1 zoom, Space pans, Esc
    // steps back (crop frame → selection → close). Keys the editor acts on are swallowed so they neither
    // scroll nor drive the page under the overlay. Keys typed into the editor's own fields (text frame,
    // W × H, sliders) are theirs.
    key(e) {
      if (this.editingText) return; // let the text input handle its own keys (incl. its own ⌘Z)
      const field = e.composedPath ? e.composedPath()[0] : e.target;
      if (field && field.tagName === "INPUT" && this.root.contains(field)) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      const eat = () => { e.preventDefault(); e.stopPropagation(); };
      const step = e.shiftKey ? 10 : 1;
      const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
      if (this.tool === "crop") {
        if (k === "Enter") { eat(); return this.applyCrop(); }
        // Esc resets an edited frame first, then leaves the tool — it never closes the editor from here.
        if (k === "Escape") { eat(); return this.cropDirty() ? this.resetCropFrame() : this.cancelCrop(); }
        if (arrow && !mod) { eat(); return this.nudgeCrop(arrow[0], arrow[1]); }
        if (mod && k.toLowerCase() === "z" && !e.shiftKey && this.cropDirty()) { eat(); return this.resetCropFrame(); }
        if (!mod && k.toLowerCase() === "x") { eat(); return this.swapCrop(); } // portrait ⇄ landscape (photocraft)
      }
      if (this.tool === "pick" && k === "Escape") { eat(); return this.setTool(this.pickPrev || "select"); } // cancel the eyedropper
      if (mod && !e.altKey && this.zoomKey(k)) return eat();  // ⌘+ / ⌘− / ⌘0 fit / ⌘1 100 %
      if (k === " " && !mod) { eat(); return this.setSpace(true); } // held: Space-drag pans
      if (k === "Escape") { eat(); return this.selected != null ? this.select(null) : this.destroy(true); }
      if (mod && k.toLowerCase() === "z") { eat(); return e.shiftKey ? this.redo() : this.undo(); }
      if (mod && k.toLowerCase() === "d" && this.selected != null) { eat(); return this.duplicateSelected(); }
      if (mod && (k === "]" || k === "[") && this.selected != null) { eat(); return this.moveLayer(this.selected, k === "]" ? 1 : -1); } // forward / back
      if ((k === "Delete" || k === "Backspace") && this.selected != null) { eat(); return this.deleteSelected(); }
      if (arrow && !mod && this.selected != null) { eat(); return this.nudgeSelected(arrow[0], arrow[1]); }
      const tool = !mod && !e.altKey && TOOL_KEYS[k.toLowerCase()];
      if (tool) { eat(); if (tool !== this.tool) this.setTool(tool); }
    },

    setTool(t) {
      // An open text frame commits first. The selection survives a tool switch (it stays editable with
      // any tool) except into Crop, which works on the whole image.
      this.closeTextInput(true);
      if (this.tool === "crop" && t !== "crop") { this.commitCrop(); this.pendingCrop = null; }
      if (t === "crop" && this.tool !== "crop") { this.prevTool = this.tool; this.pendingCrop = this.cropBase(); }
      if (t === "pick" && this.tool !== "pick") this.pickPrev = this.tool; // the eyedropper hands back to it
      if (t !== "pick") this.hideLoupe();
      this.tool = t;
      if (t === "crop") this.selected = null;
      this.hover = null;
      for (const b of this.root.querySelectorAll("[data-tool]")) {
        const on = b.dataset.tool === t;
        b.classList.toggle("on", on);
        b.querySelector("svg")?.setAttribute("stroke", on ? GREEN : "#71717a");
      }
      this.canvas.style.cursor = this.toolCursor();
      this.updateStatus();
      this.render();
    },
    toolCursor() { return this.tool === "select" ? "default" : this.tool === "text" ? "text" : this.tool === "step" ? "copy" : "crosshair"; },
    select(i) { this.selected = i; this.hover = null; this.render(); },
    // Colour / stroke apply to the next item AND to the selected one (one undo step each — `run` coalesces
    // a picker drag), so recolouring a just-placed arrow is one click. The open text frame follows along.
    setColor(c, run) {
      this.color = c;
      const s = this.selected != null ? this.shapes[this.selected] : null;
      if (s && "color" in s && s.color !== c) { if (run) this.pushHistoryOnce(run); else { this.pushHistory(); this.redoStack = []; } s.color = c; }
      this.layoutTextFrame();
      this.render();
      this.updateStatus();
    },
    setWeight(w) {
      this.weightId = w;
      const s = this.selected != null ? this.shapes[this.selected] : null;
      if (s && s.type === "text") { this.pushHistory(); this.redoStack = []; s.size = this.textPx(); }
      else if (s && s.type === "step") { // a badge resizes about its centre
        this.pushHistory(); this.redoStack = [];
        const d = this.stepPx(), cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        Object.assign(s, { x: cx - d / 2, y: cy - d / 2, w: d, h: d });
      }
      else if (s && "width" in s) { this.pushHistory(); this.redoStack = []; s.width = this.weightPx(); }
      this.layoutTextFrame();
      this.render();
    },
    updateStatus() {
      const r = this.root;
      r.getElementById("st-dot").style.background = this.color;
      r.getElementById("st-tool").textContent = (TOOLS.find((t) => t[0] === this.tool) || [, , this.tool])[2];
    },

    // ── backdrop (the pretty-screenshot wrap) ──
    bdLookup(id) { return BACKDROPS.find((b) => b[0] === id); },
    toggleBackdrop() {
      this.pushHistory();
      this.backdrop = this.backdrop ? null : { ...DEFAULT_BACKDROP };
      this.redoStack = [];
      this.syncBackdropUI();
      this.render();
    },
    setBackdropBg(id) {
      if (!this.bdLookup(id)) return;
      this.pushHistory();
      if (!this.backdrop) this.backdrop = { ...DEFAULT_BACKDROP };
      this.backdrop.bg = id;
      this.redoStack = [];
      this.syncBackdropUI();
      this.render();
    },
    setBackdropPad(pct) {
      const pad = Math.max(0.01, Math.min(0.3, Number(pct) / 100));
      if (!this.backdrop) { this.backdrop = { ...DEFAULT_BACKDROP }; this.redoStack = []; }
      this.backdrop.pad = pad;
      this.syncBackdropUI();
      this.render();
    },
    // Reflect backdrop state into the toolbar (toggle highlight, options visibility, active bg, pad slider).
    syncBackdropUI() {
      const r = this.root, on = !!this.backdrop;
      r.getElementById("bdToggle").classList.toggle("on", on);
      r.getElementById("bdOpts").classList.toggle("show", on);
      const bg = on ? this.backdrop.bg : null;
      for (const b of r.querySelectorAll("[data-bg]")) b.classList.toggle("on", b.dataset.bg === bg);
      if (on) r.getElementById("bdPad").value = Math.round(this.backdrop.pad * 100);
    },
  });
})();
