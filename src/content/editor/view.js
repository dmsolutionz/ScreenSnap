// Rendering: how the image + items are painted (shape drawing), the view geometry (fit / scale, pointer →
// image mapping, backdrop padding, crop-mode view) and the editing overlays (crop frame, transform box,
// rollover, smart guides).
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { BACKDROPS, GRAB_PX, GREEN, GUIDE, HANDLES, HANDLE_PX, LH, ROTATABLE, ROT_OFF, SANS, bbox, centerOf, rotOf, stepNumbers, textLines } = NS;
  // Text is measured on one shared scratch context, so hit-testing, the transform box and resizing all
  // agree on its width; installed as geometry's text-width hook.
  const MEASURE = document.createElement("canvas").getContext("2d");
  NS.geo.measure = (size, str) => { MEASURE.font = `600 ${size}px ${SANS}`; return MEASURE.measureText(str).width; };

  // ── pure geometry/drawing (operate on image coords) ──
  function drawShape(ctx, s, unit, blurCanvas, assets, num) {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width || 6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.opacity != null) ctx.globalAlpha = s.opacity; // per-item opacity (multiplies a highlight's own)
    turn(ctx, s); // a turned item is drawn in its own frame
    if (s.type === "rect") ctx.strokeRect(s.x, s.y, s.w, s.h);
    else if (s.type === "arrow") drawArrow(ctx, s, unit);
    else if (s.type === "pencil") drawPath(ctx, s);
    else if (s.type === "highlight") { ctx.globalAlpha *= 0.35; ctx.lineWidth = (s.width || 6) * 2.4; drawPath(ctx, s); }
    // Text: one fillText per laid-out line, each centred in its LH-tall line box — the inline editor's
    // line-height places glyphs the same way, so editing and the committed result line up.
    else if (s.type === "text") {
      ctx.font = `600 ${s.size}px ${SANS}`; ctx.textBaseline = "middle";
      textLines(s).forEach((ln, i) => ctx.fillText(ln, s.x, s.y + (i + 0.5) * LH * s.size));
    }
    else if (s.type === "blur") ctx.drawImage(blurCanvas, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    // Image layers: look the decoded bitmap up by assetId (geometry/z-order live in the shape, pixels
    // live in the un-serialized assets map). If the bitmap is missing, skip silently.
    else if (s.type === "image") { const bm = assets && assets.get(s.assetId); if (bm) ctx.drawImage(bm, s.x, s.y, s.w, s.h); }
    // Step badge: a filled disc with its number (by stacking order) in black or white, whichever reads.
    else if (s.type === "step") {
      const r = Math.min(s.w, s.h) / 2, cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.09); ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
      ctx.fillStyle = isLight(s.color) ? "#111111" : "#ffffff";
      ctx.font = `700 ${Math.round(r * (num > 9 ? 0.95 : 1.15))}px ${SANS}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(num || "?"), cx, cy + r * 0.04);
    }
    ctx.restore();
  }
  // Perceived lightness of a #rrggbb colour — picks the step number's ink.
  function isLight(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return false;
    const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 165;
  }
  // Turn the context about the item's box centre by its angle (no-op for unturned / unturnable items).
  function turn(ctx, s) {
    const a = rotOf(s);
    if (!a) return;
    const c = centerOf(bbox(s));
    ctx.translate(c.x, c.y); ctx.rotate(a); ctx.translate(-c.x, -c.y);
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

  Object.assign(NS.Editor.prototype, {

    // Effective drawing surface: the applied crop, or the full image when uncropped. While the Crop tool
    // is up the view is the WHOLE image (no backdrop), so the frame can be moved or grown back past an
    // applied crop; `exporting` forces the export view for Save / Copy.
    cropEditing() { return this.tool === "crop" && !this.exporting; },
    viewCrop() { return this.cropEditing() ? null : this.crop; },
    curW() { const c = this.viewCrop(); return c ? c.w : this.iw; },
    curH() { const c = this.viewCrop(); return c ? c.h : this.ih; },
    cropOx() { const c = this.viewCrop(); return c ? c.x : 0; },
    cropOy() { const c = this.viewCrop(); return c ? c.y : 0; },
    // Grab reach for handles / edges, in image px (GRAB_PX on screen at the current scale).
    grab() { return GRAB_PX / this.scale; },

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
      // A user zoom (zoom.js) overrides the fit until ⌘0 / the readout fits again.
      const scale = this.zoom != null ? this.zoom : Math.min(fitScale(cw, ch), fitScale(this.iw, this.ih));
      this.scale = scale;
      this.canvas.style.width = Math.round(cw * scale) + "px";
      this.canvas.style.height = Math.round(ch * scale) + "px";
      this.syncZoomReadout();
    },
    toImg(e) {
      // Map pointer → full-canvas pixels, drop the backdrop padding to reach content pixels, then
      // offset by the crop origin into full source-image coords (where shapes are always stored).
      const r = this.canvas.getBoundingClientRect();
      const pad = this.bdPadPx();
      return {
        x: ((e.clientX - r.left) / r.width) * this.fullW() - pad + this.cropOx(),
        y: ((e.clientY - r.top) / r.height) * this.fullH() - pad + this.cropOy(),
      };
    },
    // Backdrop padding in source-image px (a fraction of the content width). Content = cropped region.
    bdPadPx() { return this.backdrop && !this.cropEditing() ? Math.round(this.curW() * this.backdrop.pad) : 0; },
    // Full canvas dimensions including the backdrop padding around the content.
    fullW() { return this.curW() + 2 * this.bdPadPx(); },
    fullH() { return this.curH() + 2 * this.bdPadPx(); },

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
      // The text being edited is shown by its inline editor instead (text.js), so it isn't painted twice.
      const editing = this.textSession ? this.textSession.idx : -1;
      const nums = stepNumbers(this.shapes);
      const paint = (s, i) => { if (!s.hidden && i !== editing && s.type !== "spot") drawShape(ctx, s, this.unit, this.blurCanvas, this.assets, nums[i]); };
      // Spotlights: everything outside all of them dims, at the place of the LOWEST one in the stack — so
      // items below it dim with the screenshot and items above it stay crisp (a new spotlight goes to the
      // bottom: it dims just the screenshot). The base is re-drawn clipped to the union of the spotlights.
      const spots = this.shapes.map((s, i) => (s.type === "spot" && !s.hidden ? i : -1)).filter((i) => i >= 0);
      this.shapes.forEach((s, i) => {
        if (i === spots[0]) this.paintSpotlights(ctx, spots, (j) => j < i && paint(this.shapes[j], j));
        paint(s, i);
      });
      if (this.drag && !this.drag.kind) { const s = this.toShape(this.drag); if (s) drawShape(ctx, s, this.unit, this.blurCanvas, this.assets, s.type === "step" ? nums.filter((n) => n).length + 1 : null); }
      // Editing affordances (never in an export): the crop frame in Crop mode; otherwise the rollover
      // outline (pointer over an item with Move, or over its layer row with any tool), the selected
      // item's transform box (any tool — a just-placed item stays editable) and smart guides.
      if (!this.exporting && this.cropEditing()) {
        const f = this.pendingCrop;
        if (f && f.w > 0 && f.h > 0) this.drawCropOverlay(ctx, f);
      } else if (!this.exporting && this.tool !== "pick") { // the eyedropper samples the bare composite
        const hov = this.hover != null ? this.shapes[this.hover] : null;
        if (hov && !hov.hidden && this.hover !== this.selected) this.drawRollover(hov);
        if (this.selected != null && this.shapes[this.selected] && this.selected !== editing) this.drawSelection(this.shapes[this.selected]);
        if (this.guides.length) this.drawGuides();
      }
      ctx.restore();
      // Re-paint the layers list to mirror the current stack / selection / visibility.
      this.renderLayers();
      // …and the options bar (the active tool's / selected item's settings, live values).
      this.syncOptions();
      if (this.textSession) this.layoutTextFrame();
    },

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
    },

    // The spotlight dim: darken the whole image, then re-draw the base (the screenshot + `drawBelow`'s
    // items) clipped to the union of the spotlights' rounded rects, so overlapping spotlights simply merge.
    paintSpotlights(ctx, spots, drawBelow) {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${this.spotDim})`;
      ctx.fillRect(0, 0, this.iw, this.ih);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      for (const i of spots) { const s = this.shapes[i]; roundRectPath(ctx, s.x, s.y, s.w, s.h, Math.min(14 * this.unit, s.w / 4, s.h / 4)); }
      ctx.clip();
      ctx.drawImage(this.img, 0, 0);
      for (let j = 0; j < spots[0]; j++) drawBelow(j);
      ctx.restore();
    },
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
    },
    // One square handle, HANDLE_PX on screen whatever the zoom (the canvas is image-resolution and
    // CSS-scaled, so screen px are 1 / scale image px).
    drawHandle(x, y, edge = GREEN) {
      const ctx = this.ctx, k = 1 / this.scale, hs = HANDLE_PX * k;
      ctx.save();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = edge; ctx.lineWidth = 1.5 * k; ctx.setLineDash([]);
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.restore();
    },
    // The transform box: the item's bounds with square handles (text: corners scale it, the side handles
    // set its wrap width — no top / bottom, its height follows the lines), or an arrow's endpoints.
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
      // Drawn in the item's own frame, so a turned item's box, handles and rotate knob turn with it.
      turn(ctx, s);
      const b = bbox(s);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (ROTATABLE.has(s.type)) {
        const cx = b.x + b.w / 2, ry = b.y - ROT_OFF * k;
        ctx.beginPath(); ctx.moveTo(cx, b.y); ctx.lineTo(cx, ry); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, ry, (HANDLE_PX / 2 + 0.5) * k, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke();
      }
      for (const [hx, hy] of HANDLES) if (s.type !== "text" || hx) this.drawHandle(b.x + ((hx + 1) / 2) * b.w, b.y + ((hy + 1) / 2) * b.h);
      ctx.restore();
    },
    drawRollover(s) {
      const ctx = this.ctx, k = 1 / this.scale;
      ctx.save();
      ctx.strokeStyle = GREEN; ctx.globalAlpha = 0.7; ctx.lineWidth = k;
      if (s.type === "arrow") { ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke(); }
      else { turn(ctx, s); const b = bbox(s); ctx.strokeRect(b.x, b.y, b.w, b.h); }
      ctx.restore();
    },
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
    },
  });

  Object.assign(NS, { MEASURE, drawShape, drawPath, drawArrow, roundRectPath });
})();
