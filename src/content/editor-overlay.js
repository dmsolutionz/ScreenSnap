// Injected annotation editor (self-contained content script). Full-screen, light theme. Opens after
// a capture when the user picks "Annotate & save". Items can be drawn AND, with the Move tool,
// selected/dragged/deleted after the fact. Sends the annotated PNG back to the service worker.
// Message strings mirror src/lib/messages.js (no imports here).
(() => {
  const HOST_ID = "__screensnap_editor";

  chrome.runtime.sendMessage({ type: "editor-get-image" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok || !res.dataUrl) return;
    const img = new Image();
    img.onload = () => {
      // Re-injection (Annotate again while an editor is open) REPLACES the open editor with the latest
      // capture: tear the old one down fully — listeners + canvases — without a cancel (the pending
      // capture is the new one now), so there's only ever one editor and one Escape → one cancel. The
      // stray-host sweep catches a host orphaned by an older content-script world (extension reload).
      if (window.__screensnapEditor) window.__screensnapEditor.destroy(false);
      document.getElementById(HOST_ID)?.remove();
      window.__screensnapEditor = new Editor(img, res.filename);
    };
    img.src = res.dataUrl;
  });

  const PATH = {
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    rect: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    blur: '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="14" y1="3" x2="14" y2="21"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.3 4.1"/><path d="M6.6 6.6A17.6 17.6 0 0 0 2 11s3.5 7 10 7a10.9 10.9 0 0 0 4.1-.8"/><path d="m10 10a3 3 0 0 0 4 4"/><line x1="2" y1="2" x2="22" y2="22"/>',
    chevup: '<polyline points="18 15 12 9 6 15"/>',
    chevdown: '<polyline points="6 9 12 15 18 9"/>',
  };
  const ico = (n, c = "#71717a", sz = 17, sw = 1.7) =>
    `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${PATH[n]}</svg>`;

  // Layer-row glyph per shape type (a PATH key). Falls back to "rect" for anything unmapped.
  const LAYER_ICON = { text: "type", arrow: "arrow", rect: "rect", highlight: "highlight", blur: "blur", pencil: "pencil", image: "image" };
  // Stable id for image assets. Prefer crypto.randomUUID; fall back to a monotonic counter.
  let assetCounter = 0;
  const newAssetId = () =>
    (crypto && crypto.randomUUID) ? crypto.randomUUID() : `asset-${Date.now()}-${assetCounter++}`;

  // [id, icon, label, shortcut key] — single-letter tool keys, Photoshop's letters where they map.
  const TOOLS = [
    ["select", "move", "Move", "v"],
    ["pencil", "pencil", "Draw", "p"],
    ["arrow", "arrow", "Arrow", "a"],
    ["rect", "rect", "Rectangle", "r"],
    ["text", "type", "Text", "t"],
    ["highlight", "highlight", "Highlight", "h"],
    ["blur", "blur", "Blur / Redact", "b"],
    ["eraser", "eraser", "Eraser", "e"],
    ["crop", "crop", "Crop", "c"],
  ];
  const TOOL_KEYS = Object.fromEntries(TOOLS.map(([id, , , k]) => [k, id]));
  // Transform / crop handle geometry, in SCREEN px (converted at the current scale).
  const HANDLE_PX = 8;   // handle square size
  const GRAB_PX = 8;     // reach of a handle / frame edge
  const SNAP_PX = 8;     // smart-guide snap distance
  const MIN_BOX = 4;     // smallest box (image px) a resize leaves
  const MIN_CROP = 8;    // smallest crop frame (image px)
  const NUDGE_RUN_MS = 1000; // arrow nudges closer together than this are one undo step
  const GUIDE = "#d946ef"; // smart guides: magenta, as in Photoshop / photocraft, distinct from the green selection
  // Handle positions as (hx, hy): -1 left/top, 0 middle, 1 right/bottom.
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const resizeCursor = (hx, hy) => (hx && hy ? (hx === hy ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize");
  const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
  const WEIGHTS = [["sm", 2], ["md", 3.5], ["lg", 6]];
  // Crop aspect-ratio presets — [label, ratio]; ratio = width/height in image px, null = free.
  const RATIOS = [["Free", null], ["16:9", 16 / 9], ["1:1", 1], ["9:16", 9 / 16], ["4:3", 4 / 3]];
  // Backdrop background presets — gradients (top→bottom stops) and solids. Keyed by id.
  const BACKDROPS = [
    ["violet", "Violet", ["#8b5cf6", "#ec4899"]],
    ["sky", "Sky", ["#38bdf8", "#2563eb"]],
    ["amber", "Amber", ["#f59e0b", "#ef4444"]],
    ["mint", "Mint", ["#34d399", "#16a34a"]],
    ["slate", "Slate", ["#64748b", "#1e293b"]],
    ["dark", "Dark", "#18181b"],
    ["light", "Light", "#f3f4f6"],
    ["white", "White", "#ffffff"],
  ];
  const DEFAULT_BACKDROP = { pad: 0.07, radius: 0.03, shadow: true, bg: "violet" };
  // CSS background for a backdrop swatch chip: a CSS gradient for [a,b] stops, or the solid color.
  const bdSwatchCss = (val) => Array.isArray(val) ? `linear-gradient(135deg, ${val[0]}, ${val[1]})` : val;
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
      this.textFinish = null;  // commit/cancel fn of the one open inline text box (see closeTextInput)
      this.destroyed = false;
      this.scale = 1;
      this.hover = null;       // Move-tool rollover item (index), outlined thinly
      this.guides = [];        // smart-guide lines of the move in progress: { x } | { y }
      this.histSeq = 0;        // bumps on every history event (nudge runs coalesce while it holds)
      this.nudgeRun = null;
      this.prevTool = null;    // the tool to return to when Crop is applied / cancelled
      this.exporting = false;
      this.crop = null;        // applied, non-destructive crop region in source-image coords {x,y,w,h}
      this.pendingCrop = null; // unconfirmed crop rect {x,y,w,h} awaiting Apply/Cancel
      this.cropRatio = null;   // null = free; else a number (w/h), e.g. 16/9 — constrains crop drags & preset fits
      this.backdrop = null;    // null = off; else { pad, radius, shadow, bg } — pad/radius are fractions of content width
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
          .stage { flex: 1; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; background: #e9ebef; position: relative; text-align: center; padding: 24px; }
          canvas { display: inline-block; vertical-align: top; box-shadow: 0 4px 24px rgba(0,0,0,0.12); background: #fff; }
          .txtin { position: absolute; background: transparent; border: 1px dashed ${GREEN}; outline: none;
            padding: 0 2px; margin: 0; font-family: ${SANS}; font-weight: 600; line-height: 1.1; }
          .readout { position: absolute; display: none; z-index: 6; pointer-events: none; padding: 3px 7px; border-radius: 6px;
            background: #1b1d21; color: #fff; font: 500 11px ${MONO}; white-space: nowrap; }
          .cropbar { position: absolute; display: none; gap: 6px; z-index: 5; padding: 5px;
            background: #1b1d21; border: 1px solid #2c2f36; border-radius: 10px;
            box-shadow: 0 6px 22px rgba(0,0,0,0.28); }
          .cropbar.show { display: flex; }
          .cropbar button { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 7px;
            font-size: 13px; font-weight: 500; color: #e7e8ea; }
          .cropbar .ok { background: ${GREEN}; color: #fff; }
          .cropbar .ok:hover { background: #15803d; }
          .cropbar .no { background: #2a2d33; }
          .cropbar .no:hover { background: #34373e; }
          .cropbar .ratios { display: flex; gap: 4px; padding-right: 4px; margin-right: 2px; border-right: 1px solid #2c2f36; }
          .chip { padding: 6px 9px; border-radius: 6px; font-size: 12px; font-weight: 500; color: #b6b8bd;
            background: #2a2d33; border: 1px solid transparent; }
          .chip:hover { background: #34373e; color: #e7e8ea; }
          .chip.on { background: rgba(22,163,74,0.18); border-color: ${GREEN}; color: #fff; }
          .bdrop { display: flex; align-items: center; gap: 8px; }
          .bd-toggle { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px;
            font-size: 13px; font-weight: 500; background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46; }
          .bd-toggle:hover { background: #e9eaee; }
          .bd-toggle.on { background: rgba(22,163,74,0.12); border-color: rgba(22,163,74,0.4); color: ${GREEN}; }
          .bd-opts { display: none; align-items: center; gap: 7px; }
          .bd-opts.show { display: flex; }
          .bd-bgs { display: flex; gap: 5px; }
          .bd-bg { width: 22px; height: 22px; border-radius: 6px; border: 2px solid #e4e6eb; padding: 0; }
          .bd-bg.on { border-color: ${GREEN}; outline: 1px solid ${GREEN}; outline-offset: 1px; }
          .bd-pad { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #6b7280; font-family: ${MONO};
            text-transform: uppercase; letter-spacing: 0.04em; }
          .bd-pad input[type=range] { width: 78px; accent-color: ${GREEN}; cursor: pointer; }
          .status { height: 38px; flex: 0 0 auto; background: #f7f7f9; border-top: 1px solid #e6e7eb;
            display: flex; align-items: center; padding: 0 16px; gap: 11px; font-family: ${MONO}; font-size: 11px;
            color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
          .dotc { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.15); }
          .sb { margin-left: auto; display: flex; gap: 7px; }
          .sbtn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border: 1px solid #e4e6eb; border-radius: 7px; color: #6b7280; font-size: 11px; background: #fff; }
          .sbtn:hover { background: #eef0f3; color: #18181b; }
          /* ── Layers side panel ── */
          .layers { width: 232px; flex: 0 0 auto; background: #f7f7f9; border-left: 1px solid #e6e7eb;
            display: flex; flex-direction: column; min-height: 0; }
          .ly-head { flex: 0 0 auto; height: 44px; display: flex; align-items: center; gap: 8px;
            padding: 0 12px; border-bottom: 1px solid #e6e7eb; font-family: ${MONO}; font-size: 11px;
            color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
          .ly-head .ttl { flex: 1; }
          .ly-add { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-radius: 7px;
            font-size: 12px; font-weight: 500; background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46;
            font-family: ${SANS}; letter-spacing: 0; text-transform: none; }
          .ly-add:hover { background: #e9eaee; }
          .ly-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
          .ly-empty { padding: 18px 12px; text-align: center; font-size: 12px; color: #9aa0ab; line-height: 1.5; }
          .ly-row { display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-radius: 8px;
            border: 1px solid #e6e7eb; background: #fff; cursor: pointer; }
          .ly-row:hover { background: #eef0f3; }
          .ly-row.on { border-color: ${GREEN}; background: rgba(22,163,74,0.08); }
          .ly-row.hid .ly-name, .ly-row.hid .ly-glyph { opacity: 0.4; }
          .ly-glyph { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: #f1f2f4;
            display: flex; align-items: center; justify-content: center; }
          .ly-name { flex: 1; min-width: 0; font-size: 12.5px; color: #18181b; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis; }
          .ly-name .sub { color: #9aa0ab; }
          .ly-act { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; }
          .ly-ib { width: 23px; height: 23px; border-radius: 6px; display: flex; align-items: center;
            justify-content: center; color: #9aa0ab; }
          .ly-ib:hover { background: rgba(0,0,0,0.06); color: #18181b; }
          .ly-ib:disabled { opacity: 0.3; cursor: default; }
          .ly-ib.del:hover { background: rgba(220,38,38,0.12); }
        </style>
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
          <div class="body">
            <div class="palette" id="palette"></div>
            <div class="stage" id="stage"><canvas id="cv"></canvas><div class="cropbar" id="cropbar"><span class="ratios" id="ratios">${RATIOS.map(([label]) => `<button class="chip" data-ratio="${label}">${escapeHtml(label)}</button>`).join("")}</span><button class="ok" id="cropOk">${ico("crop", "#fff", 14)}Apply crop</button><button class="no" id="cropNo">${ico("x", "#e7e8ea", 14)}Cancel</button></div><div class="readout" id="readout"></div></div>
            <div class="layers" id="layers">
              <div class="ly-head"><span class="ttl">Layers</span><button class="ly-add" id="addImage" title="Add an image layer">${ico("image", "#3f3f46", 14)}Image</button></div>
              <div class="ly-list" id="lyList"></div>
            </div>
          </div>
          <input type="file" id="imgFile" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">

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
      for (const [id, icon, label, key] of TOOLS) html += `<button class="tool ${id === this.tool ? "on" : ""}" data-tool="${id}" title="${label} (${key.toUpperCase()})">${ico(icon, id === this.tool ? GREEN : "#71717a")}</button>`;
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
      this.cropbar = root.getElementById("cropbar");
      this.readout = root.getElementById("readout");
      root.getElementById("cropOk").onclick = () => this.applyCrop();
      root.getElementById("cropNo").onclick = () => this.cancelCrop();
      root.getElementById("ratios").addEventListener("click", (e) => {
        const b = e.target.closest("[data-ratio]");
        if (b) this.setCropRatio(b.dataset.ratio);
      });
      this.syncRatioChips();

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
      this.canvas.addEventListener("pointerleave", () => { if (!this.drag) this.setHover(null); });
      // Double-click a text item to re-open its inline editor (any tool — it's an edit gesture).
      this.canvas.addEventListener("dblclick", (e) => this.onCanvasDblClick(e));
      this.onResize = () => this.render();
      window.addEventListener("resize", this.onResize);
    }

    // Keyboard, photocraft/Photoshop-style: tool letters, arrows nudge (⇧ ×10), Delete removes, ⌘/Ctrl+Z
    // (⇧ redo), Esc steps back (crop frame → selection → close). Keys the editor acts on are swallowed so
    // they neither scroll nor drive the page under the overlay.
    key(e) {
      if (this.editingText) return; // let the text input handle its own keys (incl. its own ⌘Z)
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
      }
      if (k === "Escape") { eat(); return this.selected != null ? this.select(null) : this.destroy(true); }
      if (mod && k.toLowerCase() === "z") { eat(); return e.shiftKey ? this.redo() : this.undo(); }
      if ((k === "Delete" || k === "Backspace") && this.selected != null) { eat(); return this.deleteSelected(); }
      if (arrow && !mod && this.selected != null) { eat(); return this.nudgeSelected(arrow[0], arrow[1]); }
      const tool = !mod && !e.altKey && TOOL_KEYS[k.toLowerCase()];
      if (tool) { eat(); if (tool !== this.tool) this.setTool(tool); }
    }

    setTool(t) {
      // Leaving Crop commits an edited frame (as photocraft / Photoshop do; it's undoable). Entering it
      // shows the frame over the WHOLE image, starting from the applied crop, so it can be re-adjusted.
      if (this.tool === "crop" && t !== "crop") { this.commitCrop(); this.pendingCrop = null; this.clearCropUI(); }
      if (t === "crop" && this.tool !== "crop") { this.prevTool = this.tool; this.pendingCrop = this.cropBase(); }
      this.tool = t;
      if (t !== "select") this.selected = null;
      this.hover = null;
      for (const b of this.root.querySelectorAll("[data-tool]")) {
        const on = b.dataset.tool === t;
        b.classList.toggle("on", on);
        b.querySelector("svg")?.setAttribute("stroke", on ? GREEN : "#71717a");
      }
      this.canvas.style.cursor = this.toolCursor();
      this.updateStatus();
      this.render();
      if (t === "crop") this.showCropUI();
    }
    toolCursor() { return this.tool === "select" ? "default" : this.tool === "text" ? "text" : "crosshair"; }
    select(i) { this.selected = i; this.hover = null; this.render(); }
    setColor(c) { this.color = c; for (const b of this.root.querySelectorAll("[data-color]")) b.classList.toggle("on", b.dataset.color === c); if (this.selected != null) { this.pushHistory(); this.shapes[this.selected].color = c; this.render(); } this.updateStatus(); }
    setWeight(w) { this.weightId = w; for (const b of this.root.querySelectorAll("[data-weight]")) { const on = b.dataset.weight === w; b.classList.toggle("on", on); b.querySelector("i").style.background = on ? GREEN : "#9aa0ab"; } this.updateStatus(); }
    updateStatus() {
      const r = this.root;
      r.getElementById("st-dot").style.background = this.color;
      r.getElementById("st-tool").textContent = (TOOLS.find((t) => t[0] === this.tool) || [, , this.tool])[2];
      r.getElementById("st-weight").textContent = { sm: "2 px", md: "4 px", lg: "7 px" }[this.weightId];
      r.getElementById("st-color").textContent = this.color;
    }

    // Effective drawing surface: the applied crop, or the full image when uncropped. While the Crop tool
    // is up the view is the WHOLE image (no backdrop), so the frame can be moved or grown back past an
    // applied crop; `exporting` forces the export view for Save / Copy.
    cropEditing() { return this.tool === "crop" && !this.exporting; }
    viewCrop() { return this.cropEditing() ? null : this.crop; }
    curW() { const c = this.viewCrop(); return c ? c.w : this.iw; }
    curH() { const c = this.viewCrop(); return c ? c.h : this.ih; }
    cropOx() { const c = this.viewCrop(); return c ? c.x : 0; }
    cropOy() { const c = this.viewCrop(); return c ? c.y : 0; }
    // Grab reach for handles / edges, in image px (GRAB_PX on screen at the current scale).
    grab() { return GRAB_PX / this.scale; }

    fit() {
      // clientWidth/Height exclude the scrollbar (the stage reserves its gutter), so a width-fit tall
      // shot doesn't overflow sideways once its vertical scrollbar appears. 48 = the stage padding.
      const availW = this.stage.clientWidth - 48, availH = this.stage.clientHeight - 48;
      if (!(availW > 0 && availH > 0)) return; // not laid out: keep the last scale, never a bogus one
      // Tall full-page shots fit to WIDTH and scroll vertically (so they stay readable, not tiny);
      // normal/area shots are contained so they fit without scrolling.
      const fitScale = (w, h) => Math.min(availW / w, h > w * 2.2 ? 1 : availH / h, 1);
      // Fit the whole canvas (content + backdrop padding) so the displayed scale stays uniform.
      const cw = this.fullW(), ch = this.fullH();
      // Cropping must NOT magnify the content beyond how the full image was shown — otherwise cropping
      // a downscaled screenshot suddenly zooms in. Cap at the uncropped image's fit scale (same tall
      // rule, or a tall shot would be capped to fit its HEIGHT) so a crop just reframes.
      const scale = Math.min(fitScale(cw, ch), fitScale(this.iw, this.ih));
      this.scale = scale;
      this.canvas.style.width = Math.round(cw * scale) + "px";
      this.canvas.style.height = Math.round(ch * scale) + "px";
    }
    toImg(e) {
      // Map pointer → full-canvas pixels, drop the backdrop padding to reach content pixels, then
      // offset by the crop origin into full source-image coords (where shapes are always stored).
      const r = this.canvas.getBoundingClientRect();
      const pad = this.bdPadPx();
      return {
        x: ((e.clientX - r.left) / r.width) * this.fullW() - pad + this.cropOx(),
        y: ((e.clientY - r.top) / r.height) * this.fullH() - pad + this.cropOy(),
      };
    }

    // Drags carry a `kind` for gestures on existing things ("move" / "resize" / "endpoint" on the selected
    // item, "crop-*" on the crop frame); drawing a new item is a kind-less drag with the tool's fields.
    down(e) {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.toImg(e);
      if (this.tool === "crop") return this.cropDown(p);
      if (this.tool === "select") return this.selectDown(p, e);
      if (this.tool === "text") {
        // A click on existing text with the Text tool edits it, as Photoshop's Type tool does.
        const i = this.topAt(p);
        return i != null && this.shapes[i].type === "text" ? this.editText(i) : this.placeText(p, e);
      }
      if (this.tool === "eraser") return this.erase(p);
      const w = this.weightPx();
      this.selected = null;
      if (this.tool === "pencil" || this.tool === "highlight") this.drag = { tool: this.tool, color: this.color, width: w, points: [p] };
      else this.drag = { tool: this.tool, color: this.color, width: w, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    }
    move(e) {
      const d = this.drag;
      if (!d) return;
      const p = this.toImg(e);
      if (d.kind && d.kind.startsWith("crop")) return this.cropMove(d, p, e);
      if (d.kind) return this.transformMove(d, p, e);
      if (d.points) d.points.push(p);
      else { d.x2 = p.x; d.y2 = p.y; }
      this.render();
    }
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
        this.render();
        return this.showCropUI();
      }
      if (d.kind) {
        if (d.moved) this.redoStack = []; // a real transform happened (history pushed on its first movement)
      } else {
        const s = this.toShape(d);
        if (s) { this.pushHistory(); this.shapes.push(s); this.selected = null; this.redoStack = []; }
      }
      this.render();
    }

    // ── Move tool: select / move / resize, photocraft-style ──
    // A press on the selected item's handles transforms it; on an item selects it and moves it (⌥ moves a
    // copy); on empty space inside the selected item's box still moves it (strokes are thin); elsewhere
    // deselects.
    selectDown(p, e) {
      const sel = this.selected != null ? this.shapes[this.selected] : null;
      const h = sel && !sel.hidden ? this.handleAt(sel, p) : null;
      if (h) {
        this.drag = { kind: h.end ? "endpoint" : "resize", ...h, idx: this.selected, start: p, orig: clone(sel), box0: bbox(sel) };
        return;
      }
      const top = this.topAt(p);
      const idx = top != null ? top : sel && !sel.hidden && inBox(bbox(sel), p) ? this.selected : null;
      if (idx != null) this.drag = { kind: "move", idx, start: p, orig: clone(this.shapes[idx]), box0: bbox(this.shapes[idx]), dup: e.altKey };
      this.select(idx);
    }
    // The handle of selected item s under p: { hx, hy } on its box (corners only for text, whose corners
    // scale it), { end } on an arrow's endpoint, or null.
    handleAt(s, p) {
      const tol = this.grab();
      if (s.type === "arrow") {
        if (Math.hypot(p.x - s.x2, p.y - s.y2) <= tol) return { end: 2 };
        if (Math.hypot(p.x - s.x1, p.y - s.y1) <= tol) return { end: 1 };
        return null;
      }
      const h = boxHit(bbox(s), p, tol, s.type !== "text");
      return h && h !== "inside" ? h : null;
    }
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
          const c = this.snapMove({ ...d.box0, x: d.box0.x + dx, y: d.box0.y + dy }, d.idx, !lockX, !lockY);
          dx += c.x; dy += c.y;
        }
        s = translate(d.orig, dx, dy);
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
        // Resize: text always scales uniformly; images keep their proportions unless ⇧ (Photoshop CC's
        // default, which photocraft follows); boxes and strokes are free unless ⇧. ⌥ resizes about the centre.
        const t = d.orig.type, b0 = d.box0;
        const keep = t === "text" || (t === "image" ? !e.shiftKey : e.shiftKey);
        const ratio = keep && b0.w > 0 && b0.h > 0 ? b0.w / b0.h : null;
        const box = resizeBox(b0, d.hx, d.hy, { x: dx, y: dy }, { ratio, alt: e.altKey, min: MIN_BOX });
        s = resizeShape(d.orig, b0, box);
        this.showReadout(e, box.w, box.h);
      }
      this.shapes[d.idx] = s;
      this.render();
    }
    // Smart guides: a moving item's edges / centre snap to the visible image's edges / centre and to the
    // other items' edges / centres within SNAP_PX screen px. Returns the correction to add on each free
    // axis and records the guide lines render() draws.
    snapMove(b, skip, snapX, snapY) {
      const thr = SNAP_PX / this.scale;
      const xs = [this.cropOx(), this.cropOx() + this.curW() / 2, this.cropOx() + this.curW()];
      const ys = [this.cropOy(), this.cropOy() + this.curH() / 2, this.cropOy() + this.curH()];
      this.shapes.forEach((s, i) => {
        if (i === skip || s.hidden) return;
        const o = bbox(s);
        xs.push(o.x, o.x + o.w / 2, o.x + o.w);
        ys.push(o.y, o.y + o.h / 2, o.y + o.h);
      });
      const best = (from, to) => {
        let m = null;
        for (const c of from) for (const t of to) { const dv = t - c; if (Math.abs(dv) <= thr && (!m || Math.abs(dv) < Math.abs(m.dv))) m = { dv, t }; }
        return m;
      };
      const bx = snapX ? best([b.x, b.x + b.w / 2, b.x + b.w], xs) : null;
      const by = snapY ? best([b.y, b.y + b.h / 2, b.y + b.h], ys) : null;
      if (bx) this.guides.push({ x: bx.t });
      if (by) this.guides.push({ y: by.t });
      return { x: bx ? bx.dv : 0, y: by ? by.dv : 0 };
    }
    // Arrow-key nudge of the selected item, 1 image px (⇧ 10). A run of nudges (each within NUDGE_RUN_MS
    // of the last, nothing else recorded in between) is ONE undo step, like photocraft's nudge bundling,
    // so a held arrow key undoes in one go.
    nudgeSelected(dx, dy) {
      const i = this.selected, now = Date.now(), run = this.nudgeRun;
      if (!(run && run.idx === i && run.seq === this.histSeq && now - run.t < NUDGE_RUN_MS)) { this.pushHistory(); this.redoStack = []; }
      this.nudgeRun = { idx: i, seq: this.histSeq, t: now };
      this.shapes[i] = translate(this.shapes[i], dx, dy);
      this.render();
    }

    // Pointer feedback with no button down: the cursor says what a press would do (resize / move / draw),
    // and with the Move tool the item a click would pick gets a thin rollover outline (photocraft's
    // "highlight on rollover"). Repaints only when the rollover item changes.
    hoverAt(e) {
      const p = this.toImg(e);
      let cursor = this.toolCursor(), hov = null;
      if (this.tool === "crop" && this.pendingCrop) {
        const h = boxHit(this.pendingCrop, p, this.grab());
        if (h && h !== "inside") cursor = resizeCursor(h.hx, h.hy);
        else if (h === "inside" && !sameRect(this.pendingCrop, this.fullRect())) cursor = "move";
      } else if (this.tool === "select") {
        const sel = this.selected != null ? this.shapes[this.selected] : null;
        const h = sel && !sel.hidden ? this.handleAt(sel, p) : null;
        if (h) cursor = h.end ? "move" : resizeCursor(h.hx, h.hy);
        else {
          const top = this.topAt(p);
          if (top != null) { cursor = "move"; if (top !== this.selected) hov = top; }
          else if (sel && !sel.hidden && inBox(bbox(sel), p)) cursor = "move";
        }
      }
      this.canvas.style.cursor = cursor;
      this.setHover(hov);
    }
    setHover(i) { if (i === this.hover) return; this.hover = i; this.render(); }

    // W × H beside the pointer while a crop frame or an item is being sized (photocraft's sizing readout).
    showReadout(e, w, h) {
      const r = this.stage.getBoundingClientRect(), el = this.readout;
      el.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      el.style.display = "block";
      el.style.left = Math.round(e.clientX - r.left + this.stage.scrollLeft + 14) + "px";
      el.style.top = Math.round(e.clientY - r.top + this.stage.scrollTop + 16) + "px";
    }
    hideReadout() { if (this.readout) this.readout.style.display = "none"; }

    // Top-most text item under the pointer → re-open its inline editor. Other shape types are ignored
    // (a double-click on them does nothing special).
    onCanvasDblClick(e) {
      if (this.editingText || this.tool === "crop") return;
      const p = this.toImg(e);
      const tol = 9 * this.unit;
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (s.hidden) continue;
        if (s.type === "text" && hit(s, p, tol)) { this.selected = i; this.editText(i); return; }
      }
    }

    // ── crop (non-destructive) ──
    // The Crop tool always shows a frame over the whole image: the applied crop if there is one, else a
    // frame around everything (photocraft / Photoshop do the same). Drag inside it to move it (clamped to
    // the image), drag an edge or corner to resize it (a ratio preset — or ⇧ — keeps its proportions, ⌥
    // resizes about the centre), drag outside it — or inside the untouched full frame — to draw a new one
    // (⇧ square). Arrows nudge it. Apply / ↵ commits it as this.crop, Cancel discards the edit, Esc resets
    // an edited frame and then leaves the tool, and switching tools commits an edited frame.
    fullRect() { return { x: 0, y: 0, w: this.iw, h: this.ih }; }
    cropBase() { return this.crop ? { ...this.crop } : this.fullRect(); }
    cropDirty() { return !!this.pendingCrop && !sameRect(this.pendingCrop, this.cropBase()); }
    commitCrop() {
      if (!this.cropDirty()) return;
      this.pushHistory();
      const c = this.pendingCrop;
      this.crop = sameRect(c, this.fullRect()) ? null : { x: c.x, y: c.y, w: c.w, h: c.h };
      this.redoStack = [];
    }
    resetCropFrame() { this.pendingCrop = this.cropBase(); this.render(); this.showCropUI(); }
    cropDown(p) {
      const f = this.pendingCrop || (this.pendingCrop = this.cropBase());
      const h = boxHit(f, p, this.grab());
      if (h && h !== "inside") this.drag = { kind: "crop-resize", hx: h.hx, hy: h.hy, start: p, orig: { ...f } };
      else if (h === "inside" && !sameRect(f, this.fullRect())) this.drag = { kind: "crop-move", start: p, orig: { ...f } };
      else {
        const x = clamp(p.x, 0, this.iw), y = clamp(p.y, 0, this.ih);
        this.drag = { kind: "crop-draw", x1: x, y1: y, x2: x, y2: y, prev: { ...f } };
      }
      this.clearCropUI(); // the Apply bar steps aside during the gesture and comes back on release
    }
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
    }
    nudgeCrop(dx, dy) {
      const f = this.pendingCrop || this.cropBase();
      this.pendingCrop = { ...f, x: clamp(f.x + dx, 0, this.iw - f.w), y: clamp(f.y + dy, 0, this.ih - f.h) };
      this.render();
      this.positionCropUI();
    }

    // Normalize a crop drag into {x,y,w,h}, clamped to the source image bounds.
    // With a fixed ratio, the rect grows from the drag's anchor corner (x1,y1) toward the
    // pointer (x2,y2): width is taken from the drag, height derived as w/ratio (or vice-versa,
    // whichever stays in bounds), then clamped so the ratio-locked rect never leaves the image.
    cropRect(d, ratio = this.cropRatio) {
      if (ratio) return this.cropRectRatio(d, ratio);
      let x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2);
      let w = Math.abs(d.x2 - d.x1), h = Math.abs(d.y2 - d.y1);
      x = Math.max(0, Math.min(x, this.iw)); y = Math.max(0, Math.min(y, this.ih));
      w = Math.min(w, this.iw - x); h = Math.min(h, this.ih - y);
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }
    cropRectRatio(d, ratio) {
      const ax = d.x1, ay = d.y1;                 // fixed anchor corner
      const dirX = d.x2 >= ax ? 1 : -1, dirY = d.y2 >= ay ? 1 : -1;
      let w = Math.abs(d.x2 - ax);
      let h = w / ratio;
      // Cap the rect so it fits inside the image when grown in the current drag direction.
      const maxW = dirX > 0 ? this.iw - ax : ax;
      const maxH = dirY > 0 ? this.ih - ay : ay;
      if (w > maxW) { w = maxW; h = w / ratio; }
      if (h > maxH) { h = maxH; w = h * ratio; }
      const x = dirX > 0 ? ax : ax - w;
      const y = dirY > 0 ? ay : ay - h;
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    showCropUI() { this.cropbar.classList.add("show"); this.positionCropUI(); }
    clearCropUI() { if (this.cropbar) this.cropbar.classList.remove("show"); }
    // Float the Apply/Cancel bar just below the selection's bottom-right (in stage coords),
    // clamped so it never spills outside the visible canvas.
    positionCropUI() {
      const c = this.pendingCrop; if (!c || !this.cropbar || !this.cropEditing()) return;
      const sc = this.scale, ox = this.cropOx(), oy = this.cropOy(), pad = this.bdPadPx();
      // Canvas display now starts with the backdrop padding, so content px shift by (pad * sc).
      const left0 = this.canvas.offsetLeft + pad * sc, top0 = this.canvas.offsetTop + pad * sc;
      const selRight = left0 + (c.x - ox + c.w) * sc;
      const selBottom = top0 + (c.y - oy + c.h) * sc;
      const barW = this.cropbar.offsetWidth || 200, barH = this.cropbar.offsetHeight || 36;
      let bx = selRight - barW, by = selBottom + 8 * this.unit * sc;
      // If it would fall below the content, tuck it inside the bottom of the selection instead.
      const contentBottom = top0 + this.curH() * sc;
      if (by + barH > contentBottom) by = selBottom - barH - 8;
      bx = Math.max(left0 + 4, Math.min(bx, left0 + this.curW() * sc - barW - 4));
      this.cropbar.style.left = Math.round(bx) + "px";
      this.cropbar.style.top = Math.round(by) + "px";
    }

    // Apply the frame non-destructively: it becomes (or replaces) this.crop, which render()/save()
    // honor, in one undo step; the frame is in absolute source-image coords, so re-adjusting an applied
    // crop needs no extra math. Then back to the tool used before Crop. Cancel drops the edit.
    applyCrop() { this.commitCrop(); this.leaveCrop(); }
    cancelCrop() { this.pendingCrop = this.cropBase(); this.leaveCrop(); }
    leaveCrop() { this.setTool(this.prevTool && this.prevTool !== "crop" ? this.prevTool : "select"); }

    // ── crop aspect-ratio presets ──
    // Look up a ratio (number|null) by its preset label.
    ratioFor(label) { const r = RATIOS.find((x) => x[0] === label); return r ? r[1] : null; }
    syncRatioChips() {
      const active = (RATIOS.find((r) => r[1] === this.cropRatio) || RATIOS[0])[0];
      for (const b of this.root.querySelectorAll("[data-ratio]")) b.classList.toggle("on", b.dataset.ratio === active);
    }
    // Set the active aspect-ratio for cropping (switching to the Crop tool if needed). A preset refits
    // the frame to the largest rect of that ratio centred in it — never adding area, as photocraft's
    // presets don't — and then holds while the frame is drawn or resized. Free leaves the frame as-is.
    setCropRatio(label) {
      this.cropRatio = this.ratioFor(label);
      this.syncRatioChips();
      if (this.tool !== "crop") this.setTool("crop");
      if (this.cropRatio != null) {
        const f = this.pendingCrop || this.cropBase(), r = this.cropRatio;
        const w = Math.min(f.w, f.h * r), h = w / r;
        this.pendingCrop = intRect({ x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h }, this.iw, this.ih);
      }
      this.render();
      this.showCropUI();
    }

    // ── backdrop (the pretty-screenshot wrap) ──
    bdLookup(id) { return BACKDROPS.find((b) => b[0] === id); }
    toggleBackdrop() {
      this.pushHistory();
      this.backdrop = this.backdrop ? null : { ...DEFAULT_BACKDROP };
      this.redoStack = [];
      this.syncBackdropUI();
      this.render();
    }
    setBackdropBg(id) {
      if (!this.bdLookup(id)) return;
      this.pushHistory();
      if (!this.backdrop) this.backdrop = { ...DEFAULT_BACKDROP };
      this.backdrop.bg = id;
      this.redoStack = [];
      this.syncBackdropUI();
      this.render();
    }
    setBackdropPad(pct) {
      const pad = Math.max(0.01, Math.min(0.3, Number(pct) / 100));
      if (!this.backdrop) { this.backdrop = { ...DEFAULT_BACKDROP }; this.redoStack = []; }
      this.backdrop.pad = pad;
      this.syncBackdropUI();
      this.render();
    }
    // Reflect backdrop state into the toolbar (toggle highlight, options visibility, active bg, pad slider).
    syncBackdropUI() {
      const r = this.root, on = !!this.backdrop;
      r.getElementById("bdToggle").classList.toggle("on", on);
      r.getElementById("bdOpts").classList.toggle("show", on);
      const bg = on ? this.backdrop.bg : null;
      for (const b of r.querySelectorAll("[data-bg]")) b.classList.toggle("on", b.dataset.bg === bg);
      if (on) r.getElementById("bdPad").value = Math.round(this.backdrop.pad * 100);
    }
    // Backdrop padding in source-image px (a fraction of the content width). Content = cropped region.
    bdPadPx() { return this.backdrop && !this.cropEditing() ? Math.round(this.curW() * this.backdrop.pad) : 0; }
    // Full canvas dimensions including the backdrop padding around the content.
    fullW() { return this.curW() + 2 * this.bdPadPx(); }
    fullH() { return this.curH() + 2 * this.bdPadPx(); }

    topAt(p) {
      const tol = 9 * this.unit;
      // Hidden layers aren't pickable on-canvas (they're invisible); use the panel to select them.
      for (let i = this.shapes.length - 1; i >= 0; i--) if (!this.shapes[i].hidden && hit(this.shapes[i], p, tol)) return i;
      return null;
    }
    erase(p) {
      const idx = this.topAt(p);
      if (idx != null) { this.pushHistory(); this.shapes.splice(idx, 1); this.selected = null; this.hover = null; this.redoStack = []; this.render(); }
    }
    deleteSelected() {
      if (this.selected == null) return;
      this.pushHistory();
      this.shapes.splice(this.selected, 1);
      this.selected = null;
      this.hover = null;
      this.redoStack = [];
      this.render();
    }

    // ── layers panel ──
    // Human label + (for text) a content snippet, used both in the panel and as a row title.
    layerLabel(s) {
      const NAMES = { text: "Text", arrow: "Arrow", rect: "Rectangle", highlight: "Highlight", blur: "Blur", pencil: "Pencil", image: "Image" };
      return NAMES[s.type] || s.type;
    }
    layerSnippet(s) {
      if (s.type !== "text") return "";
      const t = (s.text || "").replace(/\s+/g, " ").trim();
      return t.length > 22 ? t.slice(0, 22) + "…" : t;
    }
    // Re-paint the list from this.shapes, TOP-of-stack first (reverse array order). Each row carries
    // its array index in data-i; the eye/up/down/× controls carry data-act.
    renderLayers() {
      const list = this.lyList;
      if (!list) return;
      if (!this.shapes.length) { list.innerHTML = `<div class="ly-empty">No layers yet.<br>Draw something or add an image.</div>`; return; }
      const last = this.shapes.length - 1;
      let html = "";
      for (let i = last; i >= 0; i--) {
        const s = this.shapes[i];
        const sel = i === this.selected;
        const snip = this.layerSnippet(s);
        const name = s.type === "text"
          ? `${escapeHtml(snip || "(empty)")}<span class="sub"> · Text</span>`
          : escapeHtml(this.layerLabel(s));
        const glyph = LAYER_ICON[s.type] || "rect";
        html += `<div class="ly-row ${sel ? "on" : ""} ${s.hidden ? "hid" : ""}" data-i="${i}" title="${escapeHtml(this.layerLabel(s) + (snip ? ": " + snip : ""))}">
          <span class="ly-glyph">${ico(glyph, sel ? GREEN : "#71717a", 13, 1.8)}</span>
          <span class="ly-name">${name}</span>
          <span class="ly-act">
            <button class="ly-ib" data-act="vis" title="${s.hidden ? "Show" : "Hide"}">${ico(s.hidden ? "eyeoff" : "eye", "#9aa0ab", 14)}</button>
            <button class="ly-ib" data-act="up" title="Bring forward" ${i === last ? "disabled" : ""}>${ico("chevup", "#9aa0ab", 14)}</button>
            <button class="ly-ib" data-act="down" title="Send backward" ${i === 0 ? "disabled" : ""}>${ico("chevdown", "#9aa0ab", 14)}</button>
            <button class="ly-ib del" data-act="del" title="Delete">${ico("x", "#9aa0ab", 14)}</button>
          </span></div>`;
      }
      list.innerHTML = html;
    }
    // Resolve the clicked row's shape index; act on the specific control or select the row.
    onLayerClick(e) {
      const row = e.target.closest(".ly-row"); if (!row) return;
      const i = Number(row.dataset.i);
      if (Number.isNaN(i) || !this.shapes[i]) return;
      const btn = e.target.closest("[data-act]");
      if (!btn) { this.selectLayer(i); return; }
      const act = btn.dataset.act;
      if (act === "vis") this.toggleLayerHidden(i);
      else if (act === "up") this.moveLayer(i, +1);
      else if (act === "down") this.moveLayer(i, -1);
      else if (act === "del") this.deleteLayer(i);
    }
    // Double-clicking a text row re-opens its inline editor (mirrors the on-canvas dbl-click path).
    onLayerDblClick(e) {
      const row = e.target.closest(".ly-row"); if (!row) return;
      if (e.target.closest("[data-act]")) return; // ignore dbl-clicks on the action buttons
      const i = Number(row.dataset.i);
      if (this.shapes[i] && this.shapes[i].type === "text") { this.selectLayer(i); this.editText(i); }
    }
    // Selecting from the panel switches to the Move tool so the highlighted item is draggable, and
    // syncs this.selected so the canvas selection box matches the highlighted row.
    selectLayer(i) {
      if (this.tool !== "select") this.setTool("select");
      this.selected = i;
      this.render();
    }
    toggleLayerHidden(i) {
      const s = this.shapes[i]; if (!s) return;
      this.pushHistory();
      s.hidden = !s.hidden;
      this.redoStack = [];
      this.render();
    }
    // Reorder by ±1 in the z-stack (array order). +1 = toward the top (later in array), −1 = down.
    // Keeps this.selected pinned to the moved item so it stays highlighted after the swap.
    moveLayer(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= this.shapes.length) return;
      this.pushHistory();
      const [s] = this.shapes.splice(i, 1);
      this.shapes.splice(j, 0, s);
      if (this.selected === i) this.selected = j;
      else if (this.selected === j) this.selected = i;
      this.redoStack = [];
      this.render();
    }
    deleteLayer(i) {
      if (!this.shapes[i]) return;
      this.pushHistory();
      this.shapes.splice(i, 1);
      // Keep this.selected valid relative to the removed index.
      if (this.selected === i) this.selected = null;
      else if (this.selected != null && this.selected > i) this.selected -= 1;
      this.redoStack = [];
      this.render();
    }

    // ── re-editable text ──
    // Re-open the inline editor over an existing text shape, pre-filled with its content. Commits the
    // edited text back into the SAME shape (position/color/size preserved). Empty → the shape is left
    // unchanged (we don't delete on clear here; the × / Delete handle removal). Escape cancels.
    editText(i) {
      this.closeTextInput(true); // one box at a time — commit any open one before this one goes live
      const s = this.shapes[i];
      if (!s || s.type !== "text") return;
      this.editingText = true;
      this.selected = i;
      const sc = this.scale;
      const pad = this.bdPadPx();
      const input = document.createElement("input");
      input.className = "txtin";
      input.value = s.text || "";
      input.style.left = this.canvas.offsetLeft + (pad + s.x - this.cropOx()) * sc + "px";
      input.style.top = this.canvas.offsetTop + (pad + s.y - this.cropOy()) * sc + "px";
      input.style.color = s.color;
      input.style.fontSize = s.size * sc + "px";
      // Hide the original while editing so the live <input> doesn't double up with the painted glyphs.
      s.hidden = true;
      this.render();
      this.stage.appendChild(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      let done = false;
      const finish = (commit) => {
        if (done) return; done = true;
        if (this.textFinish === finish) this.textFinish = null;
        this.editingText = !!this.textFinish;
        const text = input.value.trim();
        input.remove();
        s.hidden = false; // restore visibility regardless of outcome
        if (commit && text && text !== s.text) {
          this.pushHistory();
          s.text = text;
          this.redoStack = [];
        }
        this.render();
      };
      this.textFinish = finish;
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    }
    // Commit (or drop) the open inline text box, if any. Only one may be live: a box opened while
    // another is up (click elsewhere with the Text tool) must close the old one FIRST — its late blur
    // would otherwise clear editingText under the new box, so Escape / Ctrl+Z typed there would reach
    // the editor (closing it, undoing the canvas) instead of the box.
    closeTextInput(commit) { const f = this.textFinish; this.textFinish = null; if (f) f(commit); }

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
      this.selected = this.shapes.length - 1;
      this.redoStack = [];
      if (this.tool !== "select") this.setTool("select");
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
      this.closeTextInput(true); // one box at a time — commit the open one before this one goes live
      this.editingText = true;
      this.selected = null;
      const size = this.textPx();
      const sc = this.scale;
      const input = document.createElement("input");
      input.className = "txtin";
      // position relative to the canvas within the (scrollable) stage — offset coords scroll with content.
      // p is in source-image space; subtract the crop origin and add the backdrop padding to land
      // in displayed-canvas space (the canvas now includes the padding around the content).
      const pad = this.bdPadPx();
      input.style.left = this.canvas.offsetLeft + (pad + p.x - this.cropOx()) * sc + "px";
      input.style.top = this.canvas.offsetTop + (pad + p.y - this.cropOy()) * sc + "px";
      input.style.color = this.color;
      input.style.fontSize = size * sc + "px";
      this.stage.appendChild(input);
      setTimeout(() => input.focus(), 0);
      let done = false;
      const finish = (commit) => {
        if (done) return; done = true;
        if (this.textFinish === finish) this.textFinish = null;
        this.editingText = !!this.textFinish;
        const text = commit ? input.value.trim() : "";
        input.remove();
        if (text) { this.pushHistory(); this.shapes.push({ type: "text", color: this.color, size, x: p.x, y: p.y, text }); this.redoStack = []; this.render(); }
      };
      this.textFinish = finish;
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    }

    render() {
      if (this.destroyed) return; // a late blur / toBlob after close must not repaint freed canvases
      this.fit();
      const ctx = this.ctx;
      const pad = this.bdPadPx();
      // Canvas spans content + backdrop padding; the content's top-left in canvas px is (pad,pad).
      this.canvas.width = this.fullW();
      this.canvas.height = this.fullH();

      // Paint the backdrop (background + shadowed rounded card) behind the content, if enabled. Crop
      // mode shows the bare image, so the frame reads against the real edges.
      const bd = this.backdrop && !this.cropEditing();
      if (bd) this.paintBackdrop(ctx, pad);

      ctx.save();
      // Content is clipped to a rounded-rect when a backdrop is on; the round corners read on the
      // image edges only (annotations inside stay sharp, the crop dim/guides draw on top, unclipped).
      if (bd) {
        const r = Math.round(this.curW() * this.backdrop.radius);
        ctx.beginPath();
        roundRectPath(ctx, pad, pad, this.curW(), this.curH(), r);
        ctx.clip();
      }
      // Translate so a source-image coordinate (x,y) lands at (pad + x - cropOx, pad + y - cropOy):
      // pad shifts past the backdrop margin, the crop origin keeps shapes in original image space.
      ctx.translate(pad - this.cropOx(), pad - this.cropOy());
      ctx.drawImage(this.img, 0, 0);
      // Hidden layers are skipped both on-canvas and (since save()/copy() re-render first) in export.
      for (const s of this.shapes) { if (!s.hidden) drawShape(ctx, s, this.unit, this.blurCanvas, this.assets); }
      if (this.drag && !this.drag.kind) { const s = this.toShape(this.drag); if (s) drawShape(ctx, s, this.unit, this.blurCanvas, this.assets); }
      // Editing affordances (never in an export): the crop frame in Crop mode; otherwise the rollover
      // outline, the selected item's transform box and any smart guides of the move in progress.
      if (!this.exporting && this.cropEditing()) {
        const f = this.pendingCrop;
        if (f && f.w > 0 && f.h > 0) this.drawCropOverlay(ctx, f);
      } else if (!this.exporting) {
        const hov = this.hover != null && this.tool === "select" ? this.shapes[this.hover] : null;
        if (hov && !hov.hidden && this.hover !== this.selected) this.drawRollover(hov);
        if (this.selected != null && this.shapes[this.selected]) this.drawSelection(this.shapes[this.selected]);
        if (this.guides.length) this.drawGuides();
      }
      ctx.restore();
      // Keep the floating Apply/Cancel buttons glued to the frame as it (or the view) changes.
      if (this.pendingCrop) this.positionCropUI();
      // Re-paint the layers list to mirror the current stack / selection / visibility.
      this.renderLayers();
    }

    // Fill the canvas with the chosen background (gradient or solid), then drop a soft shadow under
    // the content card by filling its rounded-rect once with a shadow set (then clearing the shadow,
    // so the actual image draws crisply on top in render()).
    paintBackdrop(ctx, pad) {
      const bd = this.backdrop, entry = this.bdLookup(bd.bg) || BACKDROPS[0];
      const val = entry[2];
      const W = this.fullW(), H = this.fullH();
      ctx.save();
      if (Array.isArray(val)) {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, val[0]); g.addColorStop(1, val[1]);
        ctx.fillStyle = g;
      } else ctx.fillStyle = val;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      if (bd.shadow) {
        const r = Math.round(this.curW() * bd.radius);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = Math.max(12, pad * 0.7);
        ctx.shadowOffsetY = Math.max(6, pad * 0.35);
        // Fill the card footprint to cast the shadow; the image overpaints it in render().
        ctx.fillStyle = "#000";
        ctx.beginPath();
        roundRectPath(ctx, pad, pad, this.curW(), this.curH(), r);
        ctx.fill();
        ctx.restore();
      }
    }

    // Dim everything outside the crop rect and draw a crisp border + rule-of-thirds guides.
    // Drawn in source-image space (the ctx is already translated by the crop origin).
    drawCropOverlay(ctx, c) {
      const W = this.iw, H = this.ih, u = this.unit;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      // four bands around the selection
      ctx.fillRect(0, 0, W, c.y);                         // top
      ctx.fillRect(0, c.y + c.h, W, H - (c.y + c.h));     // bottom
      ctx.fillRect(0, c.y, c.x, c.h);                     // left
      ctx.fillRect(c.x + c.w, c.y, W - (c.x + c.w), c.h); // right
      // rule-of-thirds guides
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = Math.max(1, u * 0.75);
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        const gx = c.x + (c.w * i) / 3, gy = c.y + (c.h * i) / 3;
        ctx.moveTo(gx, c.y); ctx.lineTo(gx, c.y + c.h);
        ctx.moveTo(c.x, gy); ctx.lineTo(c.x + c.w, gy);
      }
      ctx.stroke();
      // crisp 1px-ish border
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, u);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      // 8 resize handles (the whole edge grabs; these show where)
      for (const [hx, hy] of HANDLES) this.drawHandle(c.x + ((hx + 1) / 2) * c.w, c.y + ((hy + 1) / 2) * c.h, "#18181b");
      ctx.restore();
    }
    // One square handle, HANDLE_PX on screen whatever the zoom (the canvas is image-resolution and
    // CSS-scaled, so screen px are 1 / scale image px).
    drawHandle(x, y, edge = GREEN) {
      const ctx = this.ctx, k = 1 / this.scale, hs = HANDLE_PX * k;
      ctx.save();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = edge; ctx.lineWidth = 1.5 * k; ctx.setLineDash([]);
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.restore();
    }
    // The transform box: the item's bounds with square handles (corners only for text, whose corners
    // scale it), or an arrow's two endpoint handles.
    drawSelection(s) {
      const ctx = this.ctx, k = 1 / this.scale;
      ctx.save();
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.5 * k;
      if (s.type === "arrow") {
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.restore();
        this.drawHandle(s.x1, s.y1); this.drawHandle(s.x2, s.y2);
        return;
      }
      const b = bbox(s);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.restore();
      for (const [hx, hy] of HANDLES) if (s.type !== "text" || (hx && hy)) this.drawHandle(b.x + ((hx + 1) / 2) * b.w, b.y + ((hy + 1) / 2) * b.h);
    }
    drawRollover(s) {
      const ctx = this.ctx, k = 1 / this.scale, b = bbox(s);
      ctx.save();
      ctx.strokeStyle = GREEN; ctx.globalAlpha = 0.7; ctx.lineWidth = k;
      if (s.type === "arrow") { ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke(); }
      else ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.restore();
    }
    // Smart guides across the visible image, at the edge / centre lines a move snapped to.
    drawGuides() {
      const ctx = this.ctx, k = 1 / this.scale;
      const x0 = this.cropOx(), y0 = this.cropOy(), x1 = x0 + this.curW(), y1 = y0 + this.curH();
      ctx.save();
      ctx.strokeStyle = GUIDE; ctx.lineWidth = k;
      ctx.beginPath();
      for (const g of this.guides) {
        if (g.x != null) { ctx.moveTo(g.x, y0); ctx.lineTo(g.x, y1); }
        else { ctx.moveTo(x0, g.y); ctx.lineTo(x1, g.y); }
      }
      ctx.stroke();
      ctx.restore();
    }

    // History captures shapes + the applied crop + the backdrop together, so undo/redo restores all
    // three. (cropRatio is a transient tool setting, not part of the document, so it's not tracked.)
    // Image shapes serialize as { type:"image", assetId, x,y,w,h, hidden } — a string id + geometry,
    // never pixels — so JSON round-trips cleanly; drawShape re-resolves assetId → bitmap from
    // this.assets (which undo/redo never touch, so the bitmap survives across history). The per-shape
    // `hidden` flag is plain data and round-trips automatically.
    snapshot() { return JSON.stringify({ shapes: this.shapes, crop: this.crop, backdrop: this.backdrop }); }
    restore(json) { const s = JSON.parse(json); this.shapes = s.shapes; this.crop = s.crop || null; this.backdrop = s.backdrop || null; this.syncBackdropUI(); }
    // histSeq counts history events, so a nudge run can tell nothing else was recorded since it began.
    pushHistory() { this.histSeq++; this.undoStack.push(this.snapshot()); if (this.undoStack.length > 80) this.undoStack.shift(); }
    undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); this.afterHistory(); }
    redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); this.afterHistory(); }
    // In Crop mode the frame follows the restored crop; elsewhere there is no frame.
    afterHistory() {
      this.histSeq++;
      this.selected = null; this.hover = null;
      if (this.tool === "crop") this.pendingCrop = this.cropBase();
      else { this.pendingCrop = null; this.clearCropUI(); }
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
      this.textFinish = null; // an open text box dies with the host
      window.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("resize", this.onResize);
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

  // ── pure geometry/drawing (operate on image coords) ──
  function drawShape(ctx, s, unit, blurCanvas, assets) {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width || 6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.type === "rect") ctx.strokeRect(s.x, s.y, s.w, s.h);
    else if (s.type === "arrow") drawArrow(ctx, s, unit);
    else if (s.type === "pencil") drawPath(ctx, s);
    else if (s.type === "highlight") { ctx.globalAlpha = 0.35; ctx.lineWidth = (s.width || 6) * 2.4; drawPath(ctx, s); }
    else if (s.type === "text") { ctx.font = `600 ${s.size}px ${SANS}`; ctx.textBaseline = "top"; ctx.fillText(s.text, s.x, s.y); }
    else if (s.type === "blur") ctx.drawImage(blurCanvas, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    // Image layers: look the decoded bitmap up by assetId (geometry/z-order live in the shape, pixels
    // live in the un-serialized assets map). If the bitmap is missing, skip silently.
    else if (s.type === "image") { const bm = assets && assets.get(s.assetId); if (bm) ctx.drawImage(bm, s.x, s.y, s.w, s.h); }
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
  // Text is measured on one shared scratch context, so hit-testing, the transform box and resizing all
  // agree on its width (hit() used to fall back to a character-count guess).
  const MEASURE = document.createElement("canvas").getContext("2d");
  function bbox(s) {
    if (s.type === "rect" || s.type === "blur" || s.type === "image") return { x: s.x, y: s.y, w: s.w, h: s.h };
    if (s.type === "arrow") return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    if (s.type === "text") { MEASURE.font = `600 ${s.size}px ${SANS}`; return { x: s.x, y: s.y, w: MEASURE.measureText(s.text).width, h: s.size }; }
    const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function hit(s, p, tol) {
    if (s.type === "rect" || s.type === "blur" || s.type === "image") return p.x >= s.x - tol && p.x <= s.x + s.w + tol && p.y >= s.y - tol && p.y <= s.y + s.h + tol;
    if (s.type === "text") { const b = bbox(s); return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol; }
    if (s.type === "arrow") return distToSeg(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < (s.width || 6) + tol;
    if (s.points) return s.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < (s.width || 6) + tol);
    return false;
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
  // scale their points (stroke width kept), text scales its font size (it only resizes uniformly).
  function resizeShape(s, b0, b) {
    const c = clone(s);
    if (c.type === "text") { c.size = Math.max(4, s.size * (b.h / (b0.h || 1))); c.x = b.x; c.y = b.y; return c; }
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
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  // Add a rounded-rect sub-path to ctx's current path. Uses native ctx.roundRect (Chrome 124+) and
  // falls back to a manual arc-cornered path so it still works if roundRect is unavailable.
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
})();
