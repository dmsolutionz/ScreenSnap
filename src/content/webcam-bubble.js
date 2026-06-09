// Injected webcam bubble for Video Circle recording (self-contained). Shows a draggable circular
// webcam feed + control pill on the page; the page (this tab) is what gets recorded, so the bubble
// appears in the capture — Loom-style. Repositions on "bubble-pos" messages from the popup.
// Message strings mirror src/lib/messages.js.
(() => {
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
  const SANS = "'Geist',system-ui,-apple-system,sans-serif";
  const send = (type) => chrome.runtime.sendMessage({ type });

  if (!window.__screensnapBubListener) {
    window.__screensnapBubListener = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !window.__screensnapBub) return;
      if (msg.type === "state-changed") window.__screensnapBub.onState(msg.state);
      else if (msg.type === "bubble-pos") window.__screensnapBub.setPos(msg.pos);
    });
  }
  if (window.__screensnapBub) {
    window.__screensnapBub.requestState();
    return;
  }
  window.__screensnapBub = new Bubble();

  function elapsed(s, now) {
    if (!s || !s.startedAt) return 0;
    const end = s.paused && s.pausedAt ? s.pausedAt : now;
    return Math.max(0, end - s.startedAt - (s.pausedTotalMs || 0));
  }
  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const p = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0"));
    return (s >= 3600 ? p : p.slice(1)).join(":");
  }

  function Bubble() {
    const ID = "__screensnap_bubble_host";
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .circle { width: 96px; height: 96px; border-radius: 50%; position: relative; overflow: hidden; cursor: grab;
          border: 2.5px solid rgba(34,197,94,0.55); box-shadow: 0 8px 32px rgba(0,0,0,0.65), 0 0 0 4px rgba(34,197,94,0.09); }
        .circle video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; background:
          radial-gradient(circle at 42% 38%,#243824 0%,#0d1a0d 55%,#050505 100%); }
        .rec { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: #ef4444;
          box-shadow: 0 0 6px rgba(239,68,68,0.5); animation: rp 1.2s infinite; }
        .paused .rec { animation: none; background: #f59e0b; border-radius: 1px; }
        @keyframes rp { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
        .pill { background: rgba(5,5,5,0.92); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 26px; padding: 7px 14px; display: flex; gap: 10px; align-items: center;
          box-shadow: 0 8px 24px rgba(0,0,0,0.55); user-select: none; }
        .time { font-family: ${MONO}; font-size: 12px; font-weight: 500; color: #e5e7eb; min-width: 38px; }
        .sep { width: 1px; height: 14px; background: rgba(255,255,255,0.1); }
        button { all: unset; cursor: pointer; padding: 3px 5px; border-radius: 5px; display: flex; align-items: center; gap: 4px; font-family: ${SANS}; font-size: 11px; }
        button:hover { background: rgba(255,255,255,0.06); }
      </style>
      <div class="wrap" id="wrap">
        <div class="circle" id="circle"><video id="vid" autoplay muted playsinline></video><div class="rec" id="rec"></div></div>
        <div class="pill">
          <span class="time" id="time">00:00</span>
          <span class="sep"></span>
          <button id="pause" style="color:#9ca3af"></button>
          <span class="sep"></span>
          <button id="stop" style="color:#ef4444"></button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const wrap = root.getElementById("wrap");
    const circle = root.getElementById("circle");
    const vid = root.getElementById("vid");
    const timeEl = root.getElementById("time");
    const pauseBtn = root.getElementById("pause");
    const stopBtn = root.getElementById("stop");
    let state = null;
    let camStream = null;
    let dragged = false;

    const PAUSE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    const PLAY = '<svg width="10" height="10" viewBox="0 0 24 24" fill="#22c55e" stroke="#22c55e"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    const STOP = '<svg width="10" height="10" viewBox="0 0 24 24" fill="#ef4444"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
    stopBtn.innerHTML = `${STOP}<span>Stop</span>`;
    pauseBtn.innerHTML = `${PAUSE}<span>Pause</span>`;

    pauseBtn.onclick = () => send(state && state.paused ? "resume-recording" : "pause-recording");
    stopBtn.onclick = () => send("stop-recording");

    // webcam
    navigator.mediaDevices
      .getUserMedia({ video: { width: 480, height: 480, facingMode: "user" }, audio: false })
      .then((s) => { camStream = s; vid.srcObject = s; })
      .catch(() => { /* camera denied — keep the gradient placeholder, recording still works */ });

    // position: default bottom-right; respond to popup grid + dragging
    this.setPos = (pos) => {
      if (dragged) return; // explicit drag wins
      const map = {
        tl: { top: "18px", left: "18px", right: "auto", bottom: "auto" },
        tr: { top: "18px", right: "18px", left: "auto", bottom: "auto" },
        bl: { bottom: "18px", left: "18px", right: "auto", top: "auto" },
        br: { bottom: "18px", right: "18px", left: "auto", top: "auto" },
      };
      Object.assign(wrap.style, map[pos] || map.br);
    };
    this.setPos("br");

    let drag = null;
    circle.addEventListener("pointerdown", (e) => { const r = wrap.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; circle.setPointerCapture(e.pointerId); circle.style.cursor = "grabbing"; });
    circle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      dragged = true;
      wrap.style.left = Math.max(4, Math.min(window.innerWidth - wrap.offsetWidth - 4, e.clientX - drag.dx)) + "px";
      wrap.style.top = Math.max(4, Math.min(window.innerHeight - wrap.offsetHeight - 4, e.clientY - drag.dy)) + "px";
      wrap.style.right = "auto"; wrap.style.bottom = "auto";
    });
    circle.addEventListener("pointerup", () => { drag = null; circle.style.cursor = "grab"; });

    const interval = setInterval(() => { if (state) timeEl.textContent = fmt(elapsed(state, Date.now())); }, 500);

    this.onState = (s) => {
      state = s;
      const phase = s && s.phase;
      if (!phase || phase === "idle") return this.destroy();
      wrap.classList.toggle("paused", !!s.paused);
      pauseBtn.innerHTML = s.paused ? `${PLAY}<span style="color:#22c55e">Resume</span>` : `${PAUSE}<span>Pause</span>`;
      const finalizing = phase === "transcoding" || phase === "saving";
      pauseBtn.style.display = finalizing ? "none" : "";
      timeEl.textContent = finalizing ? "Saving…" : fmt(elapsed(s, Date.now()));
    };
    this.requestState = () => chrome.runtime.sendMessage({ type: "get-state" }, (res) => { if (!chrome.runtime.lastError && res && res.state) this.onState(res.state); });
    this.destroy = () => {
      clearInterval(interval);
      try { camStream?.getTracks().forEach((t) => t.stop()); } catch {}
      host.remove();
      window.__screensnapBub = null;
    };
    this.requestState();
  }
})();
