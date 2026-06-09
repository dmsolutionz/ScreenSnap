// Injected annotation editor (self-contained content script). Full-screen, light theme. Opens after
// a capture when the user picks "Annotate & save". Items can be drawn AND, with the Move tool,
// selected/dragged/deleted after the fact. Sends the annotated PNG back to the service worker.
// Message strings mirror src/lib/messages.js (no imports here).
(() => {
  const HOST_ID = "__screensnap_editor";
  document.getElementById(HOST_ID)?.remove();

  chrome.runtime.sendMessage({ type: "editor-get-image" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok || !res.dataUrl) return;
    const img = new Image();
    img.onload = () => new Editor(img, res.filename);
    img.src = res.dataUrl;
  });

  const PATH = {
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    rect: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    blur: '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="14" y1="3" x2="14" y2="21"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  };
  const ico = (n, c = "#71717a", sz = 17, sw = 1.7) =>
    `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${PATH[n]}</svg>`;

  const TOOLS = [
    ["select", "move", "Move"],
    ["pencil", "pencil", "Draw"],
    ["arrow", "arrow", "Arrow"],
    ["rect", "rect", "Rectangle"],
    ["text", "type", "Text"],
    ["highlight", "highlight", "Highlight"],
    ["blur", "blur", "Blur / Redact"],
    ["eraser", "eraser", "Eraser"],
  ];
  const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
  const WEIGHTS = [["sm", 2], ["md", 3.5], ["lg", 6]];
  const SANS = "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif";
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
  const GREEN = "#16a34a";

  class Editor {
    constructor(img, filename) {
      this.img = img;
      this.filename = filename || "screenshot.png";
      this.iw = img.naturalWidth;
      this.ih = img.naturalHeight;
      this.shapes = [];
      this.undoStack = [];
      this.redoStack = [];
      this.tool = "rect";
      this.color = "#ef4444";
      this.weightId = "md";
      this.selected = null;
      this.drag = null;
      this.editingText = false;
      this.unit = Math.max(1, this.iw / 900);
      this.buildBlur();
      this.buildDOM();
      this.render();
      this.updateStatus();
    }

    weightPx() { return ({ sm: 2, md: 4, lg: 7 }[this.weightId]) * this.unit; }
    textPx() { return ({ sm: 18, md: 26, lg: 40 }[this.weightId]) * this.unit; }

    buildBlur() {
      const c = document.createElement("canvas");
      c.width = this.iw; c.height = this.ih;
      const x = c.getContext("2d");
      x.filter = `blur(${Math.max(6, Math.round(this.iw / 110))}px)`;
      x.drawImage(this.img, 0, 0);
      this.blurCanvas = c;
    }

    buildDOM() {
      const host = document.createElement("div");
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .ed { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column;
            background: #fff; color: #18181b; font-family: ${SANS}; }
          .top { height: 52px; flex: 0 0 auto; background: #fff; border-bottom: 1px solid #e6e7eb;
            display: flex; align-items: center; padding: 0 16px; gap: 12px; }
          .title { flex: 1; font-family: ${MONO}; font-size: 12px; color: #9aa0ab; text-transform: uppercase; letter-spacing: 0.06em; }
          button { all: unset; cursor: pointer; font-family: ${SANS}; }
          .tb { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; }
          .ghost { background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46; }
          .ghost:hover { background: #e9eaee; }
          .save { background: ${GREEN}; color: #fff; }
          .save:hover { background: #15803d; }
          .xbtn { width: 34px; height: 34px; background: #f3f4f6; border: 1px solid #e4e6eb; border-radius: 8px;
            display: flex; align-items: center; justify-content: center; }
          .xbtn:hover { background: rgba(220,38,38,0.1); }
          .body { flex: 1; display: flex; min-height: 0; }
          .palette { width: 60px; flex: 0 0 auto; background: #f7f7f9; border-right: 1px solid #e6e7eb;
            padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 3px; overflow-y: auto; }
          .tool { width: 42px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; border: 1px solid transparent; }
          .tool:hover { background: rgba(0,0,0,0.04); }
          .tool.on { background: rgba(22,163,74,0.12); border-color: rgba(22,163,74,0.3); }
          .sep { width: 30px; height: 1px; background: #e4e6eb; margin: 9px 0; }
          .sw { width: 22px; height: 22px; border-radius: 50%; margin: 3px 0; border: 2px solid transparent; }
          .sw.on { border-color: #fff; outline: 2px solid ${GREEN}; outline-offset: 1px; }
          .wt { width: 40px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; padding: 0 7px; margin: 2px 0; border: 1px solid transparent; }
          .wt:hover { background: rgba(0,0,0,0.04); }
          .wt.on { background: rgba(22,163,74,0.1); border-color: rgba(22,163,74,0.25); }
          .wt i { width: 100%; border-radius: 4px; display: block; }
          .stage { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: #e9ebef; position: relative; text-align: center; padding: 24px; }
          canvas { display: inline-block; vertical-align: top; box-shadow: 0 4px 24px rgba(0,0,0,0.12); background: #fff; }
          .txtin { position: absolute; background: transparent; border: 1px dashed ${GREEN}; outline: none;
            padding: 0 2px; margin: 0; font-family: ${SANS}; font-weight: 600; line-height: 1.1; }
          .status { height: 38px; flex: 0 0 auto; background: #f7f7f9; border-top: 1px solid #e6e7eb;
            display: flex; align-items: center; padding: 0 16px; gap: 11px; font-family: ${MONO}; font-size: 11px;
            color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
          .dotc { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.15); }
          .sb { margin-left: auto; display: flex; gap: 7px; }
          .sbtn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border: 1px solid #e4e6eb; border-radius: 7px; color: #6b7280; font-size: 11px; background: #fff; }
          .sbtn:hover { background: #eef0f3; color: #18181b; }
        </style>
        <div class="ed">
          <div class="top">
            <span class="title">Annotate · ${escapeHtml(this.filename.split("/").pop())}</span>
            <button class="tb ghost" id="copy">${ico("copy", "#3f3f46", 14)}Copy</button>
            <button class="tb save" id="save">${ico("down", "#fff", 14)}Save PNG</button>
            <button class="xbtn" id="close">${ico("x", "#6b7280", 15)}</button>
          </div>
          <div class="body">
            <div class="palette" id="palette"></div>
            <div class="stage" id="stage"><canvas id="cv"></canvas></div>
          </div>
          <div class="status">
            <span class="dotc" id="st-dot"></span>
            <span id="st-tool"></span><span style="color:#cbd0d8">·</span>
            <span id="st-weight"></span><span style="color:#cbd0d8">·</span>
            <span id="st-color"></span>
            <span class="sb"><button class="sbtn" id="undo2">${ico("undo", "#6b7280", 12)}Undo</button><button class="sbtn" id="redo2">${ico("redo", "#6b7280", 12)}Redo</button></span>
          </div>
        </div>`;
      (document.body || document.documentElement).appendChild(host);
      this.host = host; this.root = root;
      this.canvas = root.getElementById("cv");
      this.ctx = this.canvas.getContext("2d");
      this.stage = root.getElementById("stage");

      const pal = root.getElementById("palette");
      let html = "";
      for (const [id, icon] of TOOLS) html += `<button class="tool ${id === this.tool ? "on" : ""}" data-tool="${id}" title="${TOOLS.find((t) => t[0] === id)[2]}">${ico(icon, id === this.tool ? GREEN : "#71717a")}</button>`;
      html += `<div class="sep"></div>`;
      for (const c of COLORS) html += `<button class="sw ${c === this.color ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`;
      html += `<div class="sep"></div>`;
      for (const [id, h] of WEIGHTS) html += `<button class="wt ${id === this.weightId ? "on" : ""}" data-weight="${id}"><i style="height:${h}px;background:${id === this.weightId ? GREEN : "#9aa0ab"}"></i></button>`;
      pal.innerHTML = html;

      pal.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.tool) this.setTool(b.dataset.tool);
        else if (b.dataset.color) this.setColor(b.dataset.color);
        else if (b.dataset.weight) this.setWeight(b.dataset.weight);
      });
      root.getElementById("undo2").onclick = () => this.undo();
      root.getElementById("redo2").onclick = () => this.redo();
      root.getElementById("copy").onclick = () => this.copy();
      root.getElementById("save").onclick = () => this.save();
      root.getElementById("close").onclick = () => this.destroy(true);

      this.onKey = (e) => {
        if (this.editingText) return; // let the text input handle its own keys
        if (e.key === "Escape") { e.preventDefault(); this.destroy(true); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
        else if ((e.key === "Delete" || e.key === "Backspace") && this.selected != null) { e.preventDefault(); this.deleteSelected(); }
      };
      window.addEventListener("keydown", this.onKey, true);
      this.canvas.addEventListener("pointerdown", (e) => this.down(e));
      this.canvas.addEventListener("pointermove", (e) => this.move(e));
      this.canvas.addEventListener("pointerup", () => this.up());
      window.addEventListener("resize", () => this.render());
    }

    setTool(t) {
      this.tool = t;
      if (t !== "select") this.selected = null;
      for (const b of this.root.querySelectorAll("[data-tool]")) {
        const on = b.dataset.tool === t;
        b.classList.toggle("on", on);
        b.querySelector("svg")?.setAttribute("stroke", on ? GREEN : "#71717a");
      }
      this.canvas.style.cursor = t === "select" ? "default" : t === "text" ? "text" : "crosshair";
      this.updateStatus();
      this.render();
    }
    setColor(c) { this.color = c; for (const b of this.root.querySelectorAll("[data-color]")) b.classList.toggle("on", b.dataset.color === c); if (this.selected != null) { this.pushHistory(); this.shapes[this.selected].color = c; this.render(); } this.updateStatus(); }
    setWeight(w) { this.weightId = w; for (const b of this.root.querySelectorAll("[data-weight]")) { const on = b.dataset.weight === w; b.classList.toggle("on", on); b.querySelector("i").style.background = on ? GREEN : "#9aa0ab"; } this.updateStatus(); }
    updateStatus() {
      const r = this.root;
      r.getElementById("st-dot").style.background = this.color;
      r.getElementById("st-tool").textContent = (TOOLS.find((t) => t[0] === this.tool) || [, , this.tool])[2];
      r.getElementById("st-weight").textContent = { sm: "2 px", md: "4 px", lg: "7 px" }[this.weightId];
      r.getElementById("st-color").textContent = this.color;
    }

    fit() {
      const rect = this.stage.getBoundingClientRect();
      const pad = 48;
      // Tall full-page shots fit to WIDTH and scroll vertically (so they stay readable, not tiny);
      // normal/area shots are contained so they fit without scrolling.
      const tall = this.ih > this.iw * 2.2;
      const scale = tall
        ? Math.min((rect.width - pad) / this.iw, 1)
        : Math.min((rect.width - pad) / this.iw, (rect.height - pad) / this.ih, 1);
      this.scale = scale;
      this.canvas.style.width = Math.round(this.iw * scale) + "px";
      this.canvas.style.height = Math.round(this.ih * scale) + "px";
    }
    toImg(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * this.iw, y: ((e.clientY - r.top) / r.height) * this.ih };
    }

    down(e) {
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.toImg(e);
      if (this.tool === "select") {
        const idx = this.topAt(p);
        this.selected = idx;
        if (idx != null) { this.pushHistory(); this.drag = { move: true, idx, start: p, orig: JSON.parse(JSON.stringify(this.shapes[idx])) }; }
        return this.render();
      }
      if (this.tool === "text") return this.placeText(p, e);
      if (this.tool === "eraser") return this.erase(p);
      const w = this.weightPx();
      this.selected = null;
      if (this.tool === "pencil" || this.tool === "highlight") this.drag = { tool: this.tool, color: this.color, width: w, points: [p] };
      else this.drag = { tool: this.tool, color: this.color, width: w, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
    move(e) {
      if (!this.drag) return;
      const p = this.toImg(e);
      if (this.drag.move) {
        const dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
        this.shapes[this.drag.idx] = translate(this.drag.orig, dx, dy);
      } else if (this.drag.points) this.drag.points.push(p);
      else { this.drag.x2 = p.x; this.drag.y2 = p.y; }
      this.render();
    }
    up() {
      if (!this.drag) return;
      if (!this.drag.move) {
        const s = this.toShape(this.drag);
        if (s) { this.pushHistory(); this.shapes.push(s); this.selected = null; }
      }
      this.drag = null;
      this.redoStack = [];
      this.render();
    }

    topAt(p) {
      const tol = 9 * this.unit;
      for (let i = this.shapes.length - 1; i >= 0; i--) if (hit(this.shapes[i], p, tol)) return i;
      return null;
    }
    erase(p) {
      const idx = this.topAt(p);
      if (idx != null) { this.pushHistory(); this.shapes.splice(idx, 1); this.selected = null; this.redoStack = []; this.render(); }
    }
    deleteSelected() {
      if (this.selected == null) return;
      this.pushHistory();
      this.shapes.splice(this.selected, 1);
      this.selected = null;
      this.redoStack = [];
      this.render();
    }

    toShape(d) {
      if (d.points) return d.points.length < 2 ? null : { type: d.tool, color: d.color, width: d.width, points: d.points };
      const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2), w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
      if (d.tool === "arrow") return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4 ? null : { type: "arrow", color: d.color, width: d.width, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
      if (w < 4 || h < 4) return null;
      if (d.tool === "blur") return { type: "blur", x, y, w, h };
      return { type: d.tool, color: d.color, width: d.width, x, y, w, h };
    }

    placeText(p, e) {
      this.editingText = true;
      this.selected = null;
      const size = this.textPx();
      const sc = this.scale;
      const input = document.createElement("input");
      input.className = "txtin";
      // position relative to the canvas within the (scrollable) stage — offset coords scroll with content
      input.style.left = this.canvas.offsetLeft + p.x * sc + "px";
      input.style.top = this.canvas.offsetTop + p.y * sc + "px";
      input.style.color = this.color;
      input.style.fontSize = size * sc + "px";
      this.stage.appendChild(input);
      setTimeout(() => input.focus(), 0);
      const commit = () => {
        const text = input.value.trim();
        input.remove();
        this.editingText = false;
        if (text) { this.pushHistory(); this.shapes.push({ type: "text", color: this.color, size, x: p.x, y: p.y, text }); this.redoStack = []; this.render(); }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") input.blur();
        else if (ev.key === "Escape") { input.value = ""; input.blur(); }
      });
    }

    render() {
      this.fit();
      const ctx = this.ctx;
      this.canvas.width = this.iw;
      this.canvas.height = this.ih;
      ctx.drawImage(this.img, 0, 0);
      for (const s of this.shapes) drawShape(ctx, s, this.unit, this.blurCanvas);
      if (this.drag && !this.drag.move) { const s = this.toShape(this.drag); if (s) drawShape(ctx, s, this.unit, this.blurCanvas); }
      if (this.selected != null && this.shapes[this.selected]) this.drawSelection(this.shapes[this.selected]);
    }
    drawSelection(s) {
      const b = bbox(s, this.ctx);
      const pad = 6 * this.unit;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = GREEN;
      ctx.setLineDash([7 * this.unit, 5 * this.unit]);
      ctx.lineWidth = 1.5 * this.unit;
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }

    snapshot() { return JSON.stringify(this.shapes); }
    pushHistory() { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 80) this.undoStack.shift(); }
    undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.shapes = JSON.parse(this.undoStack.pop()); this.selected = null; this.render(); }
    redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.shapes = JSON.parse(this.redoStack.pop()); this.selected = null; this.render(); }

    async copy() {
      try {
        const blob = await new Promise((r) => this.canvas.toBlob(r, "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        this.flash("copy", "Copied ✓");
      } catch { this.flash("copy", "Blocked"); }
    }
    save() {
      this.selected = null;
      this.render();
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
      window.removeEventListener("keydown", this.onKey, true);
      if (cancelled) chrome.runtime.sendMessage({ type: "editor-cancel" });
      this.host.remove();
    }
  }

  // ── pure geometry/drawing (operate on image coords) ──
  function drawShape(ctx, s, unit, blurCanvas) {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width || 6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.type === "rect") ctx.strokeRect(s.x, s.y, s.w, s.h);
    else if (s.type === "arrow") drawArrow(ctx, s, unit);
    else if (s.type === "pencil") drawPath(ctx, s);
    else if (s.type === "highlight") { ctx.globalAlpha = 0.35; ctx.lineWidth = (s.width || 6) * 2.4; drawPath(ctx, s); }
    else if (s.type === "text") { ctx.font = `600 ${s.size}px ${SANS}`; ctx.textBaseline = "top"; ctx.fillText(s.text, s.x, s.y); }
    else if (s.type === "blur") ctx.drawImage(blurCanvas, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    ctx.restore();
  }
  function drawPath(ctx, s) { ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y); for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y); ctx.stroke(); }
  function drawArrow(ctx, s, unit) {
    const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), head = Math.max((s.width || 6) * 3, 14 * unit);
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
    ctx.closePath(); ctx.fill();
  }
  function bbox(s, ctx) {
    if (s.type === "rect" || s.type === "blur") return { x: s.x, y: s.y, w: s.w, h: s.h };
    if (s.type === "arrow") return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    if (s.type === "text") { let w = s.size * s.text.length * 0.6; try { ctx.save(); ctx.font = `600 ${s.size}px ${SANS}`; w = ctx.measureText(s.text).width; ctx.restore(); } catch {} return { x: s.x, y: s.y, w, h: s.size }; }
    const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function hit(s, p, tol) {
    if (s.type === "rect" || s.type === "blur") return p.x >= s.x - tol && p.x <= s.x + s.w + tol && p.y >= s.y - tol && p.y <= s.y + s.h + tol;
    if (s.type === "text") { const b = bbox(s); return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol; }
    if (s.type === "arrow") return distToSeg(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < (s.width || 6) + tol;
    if (s.points) return s.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < (s.width || 6) + tol);
    return false;
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
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
})();
