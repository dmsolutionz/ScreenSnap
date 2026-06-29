// Injected on-page pen/draw overlay for recording (self-contained). A full-viewport canvas you draw on
// while narrating; strokes AUTO-FADE after ~5s so they never clutter the capture (like Loom — which gates
// this behind its paid desktop app; screensnap ships it free). It's part of the recorded tab's DOM, so the
// strokes appear in the capture by design. Toggled from the control bar (set-draw) and re-injected on
// navigation by the service worker while state.drawActive. Esc or the toolbar's ✓ exits draw mode.
// Strings mirror src/lib/messages.js (content scripts can't import the module).
(() => {
  const SANS = "'Geist',system-ui,-apple-system,sans-serif";
  const FADE_MS = 5000;
  const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff"];
  const sendMsg = (m) => { try { chrome.runtime.sendMessage(m); } catch {} };

  if (!window.__screensnapDrawListener) {
    window.__screensnapDrawListener = true;
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender.id !== chrome.runtime.id) return;
      if (!msg || !window.__screensnapDraw) return;
      if (msg.type === "state-changed") window.__screensnapDraw.onState(msg.state);
    });
  }
  if (window.__screensnapDraw) { window.__screensnapDraw.requestState(); return; }
  window.__screensnapDraw = new Draw();

  function Draw() {
    const ID = "__screensnap_draw_host";
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .cv { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
        .cv.on { pointer-events: auto; cursor: crosshair; }
        .tb { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483646; display: none; align-items: center; gap: 8px;
          background: #fff; border: 1px solid #e4e6eb; border-radius: 14px; padding: 7px 9px; box-shadow: 0 10px 30px rgba(17,24,39,0.20); user-select: none; }
        .tb.on { display: flex; }
        .sw { width: 22px; height: 22px; border-radius: 50%; cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(17,24,39,0.18); }
        .sw.sel { box-shadow: 0 0 0 2px #18181b; }
        .sep { width: 1px; height: 22px; background: #e4e6eb; margin: 0 2px; }
        button { all: unset; cursor: pointer; font: 500 12px ${SANS}; color: #3f3f46; padding: 6px 10px; border-radius: 8px; }
        button:hover { background: #f3f4f6; color: #18181b; }
        .done { color: #16a34a; font-weight: 600; }
      </style>
      <canvas class="cv" id="cv"></canvas>
      <div class="tb" id="tb"></div>`;
    (document.body || document.documentElement).appendChild(host);

    const cv = root.getElementById("cv");
    const tb = root.getElementById("tb");
    const ctx = cv.getContext("2d");
    let active = false, drawing = false, strokes = [], color = COLORS[0], width = 4, raf = null, dpr = 1, cur = null;

    // toolbar: color swatches + clear + done
    const swatches = COLORS.map((c) => { const b = document.createElement("div"); b.className = "sw" + (c === color ? " sel" : ""); b.style.background = c; b.title = c; b.onclick = () => { color = c; [...tb.querySelectorAll(".sw")].forEach((s, i) => s.classList.toggle("sel", COLORS[i] === color)); }; return b; });
    swatches.forEach((s) => tb.appendChild(s));
    const sep = document.createElement("span"); sep.className = "sep"; tb.appendChild(sep);
    const clearBtn = document.createElement("button"); clearBtn.textContent = "Clear"; clearBtn.onclick = () => { strokes = []; }; tb.appendChild(clearBtn);
    const doneBtn = document.createElement("button"); doneBtn.className = "done"; doneBtn.textContent = "✓ Done"; doneBtn.onclick = () => sendMsg({ type: "set-draw", on: false }); tb.appendChild(doneBtn);

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
      cv.style.width = window.innerWidth + "px";
      cv.style.height = window.innerHeight + "px";
    };
    resize();
    window.addEventListener("resize", resize);

    const pos = (e) => ({ x: e.clientX, y: e.clientY });
    cv.addEventListener("pointerdown", (e) => { if (!active) return; drawing = true; cur = { color, width, pts: [pos(e)], done: null }; strokes.push(cur); cv.setPointerCapture(e.pointerId); ensureRaf(); });
    cv.addEventListener("pointermove", (e) => { if (!active || !drawing || !cur) return; cur.pts.push(pos(e)); });
    const endStroke = () => { if (cur) { cur.done = Date.now(); cur = null; } drawing = false; };
    cv.addEventListener("pointerup", endStroke);
    cv.addEventListener("pointercancel", endStroke);
    const onKey = (e) => { if (active && e.key === "Escape") { e.preventDefault(); sendMsg({ type: "set-draw", on: false }); } };
    window.addEventListener("keydown", onKey, true);

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const now = Date.now();
      strokes = strokes.filter((s) => s.done == null || now - s.done < FADE_MS);
      for (const s of strokes) {
        const alpha = s.done == null ? 1 : Math.max(0, 1 - (now - s.done) / FADE_MS);
        if (alpha <= 0 || s.pts.length === 0) continue;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.lineJoin = ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.pts[0].x, s.pts[0].y);
        for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
        if (s.pts.length === 1) ctx.lineTo(s.pts[0].x + 0.1, s.pts[0].y + 0.1); // a dot
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (strokes.length || drawing) raf = requestAnimationFrame(draw);
      else { raf = null; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
    };
    const ensureRaf = () => { if (!raf) raf = requestAnimationFrame(draw); };

    this.onState = (s) => {
      const phase = s && s.phase;
      if (!phase || phase === "idle") return this.destroy();
      active = !!s.drawActive;
      cv.classList.toggle("on", active);
      tb.classList.toggle("on", active);
      if (active) ensureRaf();
    };
    this.requestState = () => chrome.runtime.sendMessage({ type: "get-state" }, (res) => { if (!chrome.runtime.lastError && res && res.state) this.onState(res.state); });
    this.destroy = () => { if (raf) cancelAnimationFrame(raf); window.removeEventListener("resize", resize); window.removeEventListener("keydown", onKey, true); host.remove(); window.__screensnapDraw = null; };
    this.requestState();
  }
})();
