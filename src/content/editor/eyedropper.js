// Eyedropper (I): hovering shows a loupe — the pixels under the pointer, magnified, with the colour's hex —
// and a click takes that colour from the composited canvas (what you see, annotations included) as the
// current colour, recolouring the selected item too, then hands back to the tool you came from. Esc
// cancels. The editing overlays (selection box, rollover) are left out while it's active, so what it
// samples is exactly what exports.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const LOUPE = 11; // pixels across the loupe (the middle one is the pick)

  Object.assign(NS.Editor.prototype, {

    // The RGBA of display-canvas pixel (x, y). The pixel is copied into a 1x1 CPU-backed scratch canvas first:
    // reading the display canvas directly on every pointer move makes Chrome warn "Multiple readback operations
    // using getImageData" (it is GPU-backed), and asking for willReadFrequently on it would push all of its
    // drawing onto the CPU, which hurts on tall full-page captures.
    readPixel(x, y) {
      if (!this.pixelCtx) this.pixelCtx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
      this.pixelCtx.clearRect(0, 0, 1, 1);
      this.pixelCtx.drawImage(this.canvas, x, y, 1, 1, 0, 0, 1, 1);
      return this.pixelCtx.getImageData(0, 0, 1, 1).data;
    },

    // The canvas pixel under image point p — the display canvas is image-resolution, so this is the
    // pixel the export will have. null off the canvas.
    sampleAt(p) {
      const pad = this.bdPadPx();
      const x = Math.floor(pad + p.x - this.cropOx()), y = Math.floor(pad + p.y - this.cropOy());
      if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;
      const d = this.readPixel(x, y);
      return { x, y, hex: "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("") };
    },
    updateLoupe(e, p) {
      const el = this.loupe, smp = this.sampleAt(p);
      if (!smp) return this.hideLoupe();
      const lc = el.querySelector("canvas"), g = lc.getContext("2d"), cell = lc.width / LOUPE, half = (LOUPE - 1) / 2;
      g.imageSmoothingEnabled = false;
      g.fillStyle = "#e9ebef"; g.fillRect(0, 0, lc.width, lc.height);
      g.drawImage(this.canvas, smp.x - half, smp.y - half, LOUPE, LOUPE, 0, 0, lc.width, lc.height);
      g.lineWidth = 2; g.strokeStyle = "#fff"; g.strokeRect(half * cell, half * cell, cell, cell);
      g.lineWidth = 1; g.strokeStyle = "#18181b"; g.strokeRect(half * cell - 1.5, half * cell - 1.5, cell + 3, cell + 3);
      el.querySelector("b").textContent = smp.hex;
      el.querySelector("i").style.background = smp.hex;
      // Beside the pointer, flipped to the other side near the stage's visible edges (so it never clips
      // or makes the stage scroll).
      el.style.display = "block";
      const r = this.stage.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
      let x = e.clientX - r.left + 18, y = e.clientY - r.top + 18;
      if (x + w > this.stage.clientWidth - 4) x = e.clientX - r.left - 18 - w;
      if (y + h > this.stage.clientHeight - 4) y = e.clientY - r.top - 18 - h;
      el.style.left = Math.round(x + this.stage.scrollLeft) + "px";
      el.style.top = Math.round(y + this.stage.scrollTop) + "px";
    },
    hideLoupe() { if (this.loupe) this.loupe.style.display = "none"; },
    // A click: take the colour, give the selected item the same colour, and go back to the previous tool.
    pickDown(p) {
      const smp = this.sampleAt(p);
      this.hideLoupe();
      if (smp) this.setColor(smp.hex);
      this.setTool(this.pickPrev && this.pickPrev !== "pick" ? this.pickPrev : "select");
    },
  });
})();
