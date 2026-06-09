// Page-injected interactive area picker for "selected area" screenshots.
//
// Runs in the page via chrome.scripting.executeScript({func: selectArea}). It returns a Promise
// that executeScript awaits: resolves to { x, y, w, h, dpr } in CSS viewport pixels on selection,
// or null if cancelled (Esc / tiny drag). MUST stay self-contained (no imports/closures).
//
// The overlay is fully torn down before the promise resolves, so it never appears in the capture
// the service worker takes immediately afterwards.

export function selectArea() {
  return new Promise((resolve) => {
    const OVERLAY_ID = "__clippy_area_overlay";
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "transparent",
      userSelect: "none",
    });

    // The selection rect uses a huge spread box-shadow to dim everything OUTSIDE it.
    const sel = document.createElement("div");
    Object.assign(sel.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      border: "1.5px solid #4F46E5",
      boxShadow: "0 0 0 100vmax rgba(17,24,39,0.45)",
      pointerEvents: "none",
    });

    const hint = document.createElement("div");
    hint.textContent = "Drag to select  ·  Esc to cancel";
    Object.assign(hint.style, {
      position: "fixed",
      top: "14px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#111827",
      color: "#fff",
      font: "12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif",
      padding: "6px 10px",
      borderRadius: "8px",
      pointerEvents: "none",
      boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
    });

    overlay.appendChild(sel);
    document.documentElement.append(overlay, hint);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      hint.remove();
    };
    const finish = (rect) => {
      cleanup();
      resolve(rect);
    };

    const setRect = (x, y, w, h) => {
      Object.assign(sel.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    };

    const onDown = (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      setRect(startX, startY, 0, 0);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      setRect(
        Math.min(e.clientX, startX),
        Math.min(e.clientY, startY),
        Math.abs(e.clientX - startX),
        Math.abs(e.clientY - startY)
      );
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      if (w < 5 || h < 5) return finish(null);
      finish({ x, y, w, h, dpr: window.devicePixelRatio || 1 });
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };

    overlay.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
  });
}
