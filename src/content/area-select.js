// Page-injected area picker (self-contained; runs via executeScript({func: selectArea})).
// Returns a Promise resolving to { x, y, w, h, dpr } in CSS viewport pixels, or null if cancelled.
// Styled to the screensnap design: green dashed marquee, live dimension badge, corner handles,
// and a dark instruction bar. Drag to draw, then Enter to capture / Esc to cancel.
export function selectArea() {
  return new Promise((resolve) => {
    const ID = "__screensnap_area";
    document.getElementById(ID)?.remove();
    const GREEN = "#22c55e";
    const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";

    const root = document.createElement("div");
    root.id = ID;
    Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", userSelect: "none" });

    const sel = document.createElement("div");
    Object.assign(sel.style, {
      position: "fixed", left: "0", top: "0", width: "0", height: "0", display: "none",
      border: `1.5px dashed ${GREEN}`, borderRadius: "2px", boxShadow: "0 0 0 100vmax rgba(0,0,0,0.54)",
    });
    const badge = document.createElement("div");
    Object.assign(badge.style, {
      position: "absolute", top: "-28px", right: "0", background: GREEN, color: "#000", borderRadius: "4px",
      padding: "3px 9px", font: `600 10px/1.2 ${MONO}`, whiteSpace: "nowrap", display: "none",
    });
    sel.appendChild(badge);
    for (const pos of [{ top: "-3px", left: "-3px" }, { top: "-3px", right: "-3px" }, { bottom: "-3px", left: "-3px" }, { bottom: "-3px", right: "-3px" }]) {
      const h = document.createElement("div");
      Object.assign(h.style, { position: "absolute", width: "6px", height: "6px", background: GREEN, borderRadius: "1px", ...pos });
      sel.appendChild(h);
    }

    const bar = document.createElement("div");
    bar.innerHTML = `<span>Drag to select</span><span style="color:#252525">·</span><span>release to capture</span><span style="color:#252525">·</span><span><kbd>Esc</kbd> Cancel</span>`;
    Object.assign(bar.style, {
      position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "14px",
      alignItems: "center", background: "rgba(5,5,5,0.88)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "8px", padding: "8px 18px", font: `10px/1 ${MONO}`, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em",
    });
    for (const kbd of bar.querySelectorAll("kbd"))
      Object.assign(kbd.style, { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "3px", padding: "1px 5px", fontSize: "9px", color: "#9ca3af" });

    root.append(sel, bar);
    document.documentElement.appendChild(root);

    let sx = 0, sy = 0, dragging = false;
    let rect = null;

    const apply = (x, y, w, h) => {
      rect = { x, y, w, h };
      Object.assign(sel.style, { display: "block", left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
      badge.style.display = "block";
      badge.textContent = `${Math.round(w)}×${Math.round(h)} px`;
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      root.remove();
    };
    const finish = (r) => { cleanup(); resolve(r); };

    const onDown = (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      apply(sx, sy, 0, 0);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      apply(Math.min(e.clientX, sx), Math.min(e.clientY, sy), Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
    };
    // Release immediately captures (drag view -> straight to capture). Tiny drags cancel.
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (rect && rect.w >= 5 && rect.h >= 5) finish({ ...rect, dpr: window.devicePixelRatio || 1 });
      else finish(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
    };

    root.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
  });
}
