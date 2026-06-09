// Injected annotation editor (self-contained content script). Opens after a capture when the user
// picks "Annotate & save". Renders the screensnap editor in a shadow root and sends the annotated
// PNG back to the service worker. Message strings mirror src/lib/messages.js (no imports here).
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
  const ico = (n, c = "#555", sz = 14, sw = 1.75) =>
    `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${PATH[n]}</svg>`;

  const TOOLS = [
    ["pencil", "pencil", "Draw"],
    ["arrow", "arrow", "Arrow"],
    ["rect", "rect", "Rectangle"],
    ["text", "type", "Text"],
    ["highlight", "highlight", "Highlight"],
    ["blur", "blur", "Blur / Redact"],
    ["eraser", "eraser", "Eraser"],
  ];
  const COLORS = ["#ef4444", "#fbbf24", "#22c55e", "#3b82f6", "#ffffff"];
  const WEIGHTS = [["sm", 1.5], ["md", 3], ["lg", 5.5]];
  const SANS = "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif";
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";

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
      this.drag = null;
      this.unit = Math.max(1, this.iw / 900); // scales stroke px to the capture's resolution
      this.buildBlur();
      this.buildDOM();
      this.render();
      this.updateStatus();
    }

    weightPx() {
      const base = { sm: 2, md: 4, lg: 7 }[this.weightId];
      return base * this.unit;
    }

    buildBlur() {
      const c = document.createElement("canvas");
      c.width = this.iw;
      c.height = this.ih;
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
          .back { position: fixed; inset: 0; z-index: 2147483647; background: rgba(5,5,5,0.78);
            display: flex; align-items: center; justify-content: center; font-family: ${SANS}; }
          .win { width: min(820px, 94vw); background: #050505; border: 1px solid rgba(255,255,255,0.12);
            border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,0.6); color: #fff; }
          .top { height: 44px; background: #0f0f0f; border-bottom: 1px solid rgba(255,255,255,0.07);
            display: flex; align-items: center; padding: 0 14px; gap: 10px; }
          .lights { display: flex; gap: 6px; }
          .lights i { width: 10px; height: 10px; border-radius: 50%; opacity: 0.85; display: block; }
          .fname { flex: 1; font-family: ${MONO}; font-size: 10px; color: #444; text-transform: uppercase; letter-spacing: 0.07em; margin-left: 8px; }
          button { all: unset; cursor: pointer; font-family: ${SANS}; }
          .tb { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 7px; font-size: 11px; }
          .ghost { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: #9ca3af; }
          .ghost:hover { background: rgba(255,255,255,0.09); color: #fff; }
          .save { background: #22c55e; color: #000; font-weight: 600; padding: 5px 13px; }
          .save:hover { background: #16a34a; }
          .xbtn { width: 28px; height: 28px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
            border-radius: 7px; display: flex; align-items: center; justify-content: center; }
          .xbtn:hover { background: rgba(239,68,68,0.18); }
          .body { display: flex; }
          .palette { width: 52px; background: #0a0a0a; border-right: 1px solid rgba(255,255,255,0.06);
            padding: 10px 0; display: flex; flex-direction: column; align-items: center; gap: 1px; }
          .tool { width: 36px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
            border: 1px solid transparent; }
          .tool:hover { background: rgba(255,255,255,0.05); }
          .tool.on { background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.3); }
          .sep { width: 28px; height: 1px; background: rgba(255,255,255,0.07); margin: 8px 0; }
          .sw { width: 18px; height: 18px; border-radius: 50%; margin: 2px 0; border: 2px solid transparent; }
          .sw.on { border-color: rgba(255,255,255,0.75); outline: 2px solid rgba(34,197,94,0.55); outline-offset: 1px; }
          .wt { width: 34px; height: 22px; border-radius: 5px; display: flex; align-items: center; justify-content: center;
            padding: 0 5px; margin: 1px 0; border: 1px solid transparent; }
          .wt:hover { background: rgba(255,255,255,0.05); }
          .wt.on { background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.25); }
          .wt i { width: 100%; border-radius: 4px; display: block; }
          .stage { flex: 1; height: 420px; display: flex; align-items: center; justify-content: center;
            overflow: hidden; background: #111; position: relative; }
          canvas { display: block; cursor: crosshair; touch-action: none; box-shadow: 0 0 0 1px rgba(255,255,255,0.06); }
          .txtin { position: absolute; background: transparent; border: 1px dashed #22c55e; outline: none;
            color: #ef4444; padding: 0; margin: 0; font-family: ${SANS}; }
          .status { height: 34px; background: #0a0a0a; border-top: 1px solid rgba(255,255,255,0.06);
            display: flex; align-items: center; padding: 0 14px; gap: 10px; font-family: ${MONO};
            font-size: 9px; color: #444; text-transform: uppercase; letter-spacing: 0.08em; }
          .dotc { width: 8px; height: 8px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.15); }
          .status .sb { margin-left: auto; display: flex; gap: 6px; }
          .sbtn { display: flex; align-items: center; gap: 5px; padding: 3px 9px; border: 1px solid rgba(255,255,255,0.07);
            border-radius: 5px; color: #555; font-size: 10px; }
          .sbtn:hover { background: rgba(255,255,255,0.06); color: #fff; }
        </style>
        <div class="back">
          <div class="win">
            <div class="top">
              <span class="lights"><i style="background:#ef4444"></i><i style="background:#f59e0b"></i><i style="background:#22c55e"></i></span>
              <span class="fname">Annotate · ${escapeHtml(this.filename.split("/").pop())}</span>
              <button class="tb ghost" id="copy">${ico("copy", "#9ca3af", 11)}Copy</button>
              <button class="tb save" id="save">${ico("down", "#000", 11)}Save PNG</button>
              <button class="xbtn" id="close">${ico("x", "#555", 12)}</button>
            </div>
            <div class="body">
              <div class="palette" id="palette"></div>
              <div class="stage" id="stage"><canvas id="cv"></canvas></div>
            </div>
            <div class="status">
              <span class="dotc" id="st-dot"></span>
              <span id="st-tool"></span><span style="color:#333">·</span>
              <span id="st-weight"></span><span style="color:#333">·</span>
              <span id="st-color"></span>
              <span class="sb"><button class="sbtn" id="undo2">${ico("undo", "#555", 10)}Undo</button><button class="sbtn" id="redo2">${ico("redo", "#555", 10)}Redo</button></span>
            </div>
          </div>
        </div>`;
      (document.body || document.documentElement).appendChild(host);
      this.host = host;
      this.root = root;
      this.canvas = root.getElementById("cv");
      this.ctx = this.canvas.getContext("2d");
      this.stage = root.getElementById("stage");

      const pal = root.getElementById("palette");
      let html = "";
      for (const [id, icon] of TOOLS)
        html += `<button class="tool ${id === this.tool ? "on" : ""}" data-tool="${id}" title="${id}">${ico(icon, id === this.tool ? "#22c55e" : "#555")}</button>`;
      html += `<div class="sep"></div>`;
      for (const c of COLORS) html += `<button class="sw ${c === this.color ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`;
      html += `<div class="sep"></div>`;
      for (const [id, h] of WEIGHTS)
        html += `<button class="wt ${id === this.weightId ? "on" : ""}" data-weight="${id}"><i style="height:${h}px;background:${id === this.weightId ? "#22c55e" : "#555"}"></i></button>`;
      html += `<div class="sep"></div>`;
      html += `<button class="tool" id="undo" title="Undo">${ico("undo", "#555", 13)}</button>`;
      html += `<button class="tool" id="redo" title="Redo">${ico("redo", "#555", 13)}</button>`;
      pal.innerHTML = html;

      pal.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.tool) this.setTool(b.dataset.tool);
        else if (b.dataset.color) this.setColor(b.dataset.color);
        else if (b.dataset.weight) this.setWeight(b.dataset.weight);
        else if (b.id === "undo") this.undo();
        else if (b.id === "redo") this.redo();
      });
      root.getElementById("undo2").onclick = () => this.undo();
      root.getElementById("redo2").onclick = () => this.redo();
      root.getElementById("copy").onclick = () => this.copy();
      root.getElementById("save").onclick = () => this.save();
      root.getElementById("close").onclick = () => this.destroy(true);

      this.onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); this.destroy(true); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      };
      window.addEventListener("keydown", this.onKey, true);
      this.canvas.addEventListener("pointerdown", (e) => this.down(e));
      this.canvas.addEventListener("pointermove", (e) => this.move(e));
      this.canvas.addEventListener("pointerup", () => this.up());
    }

    setTool(t) {
      this.tool = t;
      for (const b of this.root.querySelectorAll("[data-tool]")) {
        const on = b.dataset.tool === t;
        b.classList.toggle("on", on);
        b.querySelector("svg")?.setAttribute("stroke", on ? "#22c55e" : "#555");
      }
      this.updateStatus();
    }
    setColor(c) {
      this.color = c;
      for (const b of this.root.querySelectorAll("[data-color]")) b.classList.toggle("on", b.dataset.color === c);
      this.updateStatus();
    }
    setWeight(w) {
      this.weightId = w;
      for (const b of this.root.querySelectorAll("[data-weight]")) {
        const on = b.dataset.weight === w;
        b.classList.toggle("on", on);
        b.querySelector("i").style.background = on ? "#22c55e" : "#555";
      }
      this.updateStatus();
    }
    updateStatus() {
      const r = this.root;
      r.getElementById("st-dot").style.background = this.color;
      r.getElementById("st-tool").textContent = (TOOLS.find((t) => t[0] === this.tool) || [, , this.tool])[2];
      r.getElementById("st-weight").textContent = { sm: "2 px", md: "4 px", lg: "7 px" }[this.weightId];
      r.getElementById("st-color").textContent = this.color;
    }

    fit() {
      const rect = this.stage.getBoundingClientRect();
      const scale = Math.min((rect.width - 24) / this.iw, (rect.height - 24) / this.ih, 1);
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
      if (this.tool === "text") return this.placeText(p, e);
      if (this.tool === "eraser") return this.erase(p);
      const w = this.weightPx();
      if (this.tool === "pencil" || this.tool === "highlight") this.drag = { tool: this.tool, color: this.color, width: w, points: [p] };
      else this.drag = { tool: this.tool, color: this.color, width: w, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
    move(e) {
      if (!this.drag) return;
      const p = this.toImg(e);
      if (this.drag.points) this.drag.points.push(p);
      else { this.drag.x2 = p.x; this.drag.y2 = p.y; }
      this.render();
    }
    up() {
      if (!this.drag) return;
      const s = this.toShape(this.drag);
      this.drag = null;
      if (s) { this.pushHistory(); this.shapes.push(s); this.redoStack = []; }
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
    erase(p) {
      const tol = 8 * this.unit;
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        if (this.hit(this.shapes[i], p, tol)) {
          this.pushHistory();
          this.shapes.splice(i, 1);
          this.redoStack = [];
          this.render();
          return;
        }
      }
    }
    hit(s, p, tol) {
      if (s.type === "rect" || s.type === "blur") return p.x >= s.x - tol && p.x <= s.x + s.w + tol && p.y >= s.y - tol && p.y <= s.y + s.h + tol;
      if (s.type === "text") return p.x >= s.x - tol && p.x <= s.x + s.size * s.text.length * 0.62 + tol && p.y >= s.y - s.size && p.y <= s.y + tol;
      if (s.type === "arrow") return distToSeg(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < (s.width || 6) + tol;
      if (s.points) return s.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < (s.width || 6) + tol);
      return false;
    }

    placeText(p, e) {
      const input = document.createElement("input");
      input.className = "txtin";
      const sizeImg = Math.max(16, this.weightPx() * 6);
      const r = this.canvas.getBoundingClientRect();
      const sx = r.width / this.iw;
      input.style.left = this.canvas.offsetLeft + p.x * sx + "px";
      input.style.top = this.canvas.offsetTop + (p.y - sizeImg * 0.8) * sx + "px";
      input.style.color = this.color;
      input.style.fontSize = sizeImg * sx + "px";
      this.stage.appendChild(input);
      input.focus();
      const commit = () => {
        const text = input.value.trim();
        input.remove();
        if (text) {
          this.pushHistory();
          this.shapes.push({ type: "text", color: this.color, size: sizeImg, x: p.x, y: p.y, text });
          this.redoStack = [];
          this.render();
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { input.value = ""; input.blur(); }
      });
    }

    render() {
      this.fit();
      const ctx = this.ctx;
      this.canvas.width = this.iw;
      this.canvas.height = this.ih;
      ctx.drawImage(this.img, 0, 0);
      for (const s of this.shapes) this.drawShape(s);
      if (this.drag) {
        const s = this.toShape(this.drag);
        if (s) this.drawShape(s);
      }
    }
    drawShape(s) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width || 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (s.type === "rect") ctx.strokeRect(s.x, s.y, s.w, s.h);
      else if (s.type === "arrow") this.drawArrow(s);
      else if (s.type === "pencil") this.drawPath(s);
      else if (s.type === "highlight") { ctx.globalAlpha = 0.35; ctx.lineWidth = (s.width || 6) * 2.4; this.drawPath(s); }
      else if (s.type === "text") { ctx.font = `600 ${s.size}px ${SANS}`; ctx.textBaseline = "alphabetic"; ctx.fillText(s.text, s.x, s.y); }
      else if (s.type === "blur") ctx.drawImage(this.blurCanvas, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
      ctx.restore();
    }
    drawPath(s) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    }
    drawArrow(s) {
      const ctx = this.ctx;
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = Math.max((s.width || 6) * 3, 14 * this.unit);
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }

    snapshot() { return JSON.stringify(this.shapes); }
    pushHistory() { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 80) this.undoStack.shift(); }
    undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.shapes = JSON.parse(this.undoStack.pop()); this.render(); }
    redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.shapes = JSON.parse(this.redoStack.pop()); this.render(); }

    async copy() {
      try {
        const blob = await new Promise((r) => this.canvas.toBlob(r, "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        this.flash("copy", "Copied ✓");
      } catch { this.flash("copy", "Blocked"); }
    }
    save() {
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

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
})();
