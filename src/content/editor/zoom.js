// Zoom & pan. Ctrl/⌘ + scroll (or a trackpad pinch) zooms at the pointer; ⌘+ / ⌘− step, ⌘0 fits, ⌘1 is 100 %
// (one image pixel per screen pixel); Space-drag or a middle-button drag pans. The zoom % in the status bar
// shows the level and fits on click. Zooming only changes how large the canvas is drawn on screen — its
// backing store stays at image resolution — so pointer mapping (toImg), handles and guides (sized in
// screen px), the text frame (laid out from this.scale) and the export are all unaffected.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { clamp } = NS;
  const MIN_ZOOM = 0.02, MAX_ZOOM = 8; // CSS px per image px
  const STEP = 1.25;

  Object.assign(NS.Editor.prototype, {

    wireZoom() {
      const stage = this.stage;
      // Ctrl/⌘ + wheel (a pinch arrives as ctrl+wheel too) zooms at the pointer — and never zooms the page.
      stage.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return; // a plain wheel scrolls the stage
        e.preventDefault();
        const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
        this.zoomTo(this.scale * Math.exp(-dy * 0.0015), e.clientX, e.clientY);
      }, { passive: false });
      // Panning wins over every tool: listen in the capture phase so the canvas never sees the press.
      stage.addEventListener("pointerdown", (e) => {
        if (!(this.spaceDown || e.button === 1)) return;
        e.preventDefault(); e.stopPropagation();
        this.pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add("panning");
      }, true);
      stage.addEventListener("pointermove", (e) => {
        if (!this.pan) return;
        stage.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
        stage.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      });
      const endPan = () => { if (this.pan) { this.pan = null; stage.classList.remove("panning"); } };
      stage.addEventListener("pointerup", endPan);
      stage.addEventListener("pointercancel", endPan);
      stage.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
      this.onKeyUp = (e) => { if (e.key === " ") this.setSpace(false); };
      window.addEventListener("keyup", this.onKeyUp, true);
      this.onBlurWin = () => this.setSpace(false);
      window.addEventListener("blur", this.onBlurWin);
      this.root.getElementById("zoomPct").onclick = () => this.zoomFit();
    },
    // Space held = pan mode (grab cursor), as in photocraft / Photoshop.
    setSpace(on) {
      if (this.spaceDown === on) return;
      this.spaceDown = on;
      this.stage.classList.toggle("pan", on);
    },
    // Zoom keys, from key(): returns true when it handled one.
    zoomKey(k) {
      if (k === "=" || k === "+") this.zoomTo(this.scale * STEP);
      else if (k === "-" || k === "_") this.zoomTo(this.scale / STEP);
      else if (k === "0") this.zoomFit();
      else if (k === "1") this.zoomTo(1 / (window.devicePixelRatio || 1));
      else return false;
      return true;
    },
    // Set an absolute zoom (CSS px per image px), keeping the image point under (cx, cy) — the stage's
    // centre by default — where it is on screen.
    zoomTo(scale, cx, cy) {
      const sr = this.stage.getBoundingClientRect();
      if (cx == null) { cx = sr.left + this.stage.clientWidth / 2; cy = sr.top + this.stage.clientHeight / 2; }
      const r0 = this.canvas.getBoundingClientRect();
      const fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height;
      this.zoom = clamp(scale, MIN_ZOOM, MAX_ZOOM);
      this.render();
      const r1 = this.canvas.getBoundingClientRect();
      this.stage.scrollLeft += r1.left + fx * r1.width - cx;
      this.stage.scrollTop += r1.top + fy * r1.height - cy;
    },
    zoomFit() { this.zoom = null; this.render(); },
    // The status-bar readout: 100 % = one image pixel per device pixel.
    syncZoomReadout() {
      const el = this.root && this.root.getElementById("zoomPct");
      if (el) el.textContent = Math.round(this.scale * (window.devicePixelRatio || 1) * 100) + "%";
    },
  });
})();
