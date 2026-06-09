// Injected webcam bubble for Video Circle recording (self-contained). Loom-style: a large draggable
// circular webcam feed (default bottom-LEFT) with a 3-2-1 countdown, then a prominent Stop control.
// The page (this tab) is what gets recorded, so the bubble appears in the capture.
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
  if (window.__screensnapBub) { window.__screensnapBub.requestState(); return; }
  window.__screensnapBub = new Bubble();

  function elapsed(s, now) { if (!s || !s.startedAt) return 0; const end = s.paused && s.pausedAt ? s.pausedAt : now; return Math.max(0, end - s.startedAt - (s.pausedTotalMs || 0)); }
  function fmt(ms) { const s = Math.floor(ms / 1000); const p = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")); return (s >= 3600 ? p : p.slice(1)).join(":"); }

  function Bubble() {
    const ID = "__screensnap_bubble_host";
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; gap: 12px; }
        .circle { width: 140px; height: 140px; border-radius: 50%; position: relative; overflow: hidden; cursor: grab;
          border: 3px solid rgba(34,197,94,0.6); box-shadow: 0 10px 40px rgba(0,0,0,0.6), 0 0 0 5px rgba(34,197,94,0.1); }
        .circle video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block;
          background: radial-gradient(circle at 42% 38%,#243824 0%,#0d1a0d 55%,#050505 100%); }
        .rec { position: absolute; top: 9px; right: 9px; width: 11px; height: 11px; border-radius: 50%; background: #ef4444;
          box-shadow: 0 0 8px rgba(239,68,68,0.6); animation: rp 1.2s infinite; }
        .paused .rec { animation: none; background: #f59e0b; border-radius: 2px; }
        @keyframes rp { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
        .center { position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center;
          background: rgba(5,5,5,0.5); pointer-events: none; }
        .cnum { color: #fff; font: 700 160px ${SANS}; text-shadow: 0 4px 30px rgba(0,0,0,0.5); }
        @keyframes pop { 0% { transform: scale(1.6); opacity: 0; } 25% { opacity: 1; } 100% { transform: scale(1); opacity: 0.92; } }
        .pill { background: rgba(5,5,5,0.92); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 30px; padding: 9px 12px 9px 16px; display: flex; gap: 12px; align-items: center;
          box-shadow: 0 8px 24px rgba(0,0,0,0.55); user-select: none; }
        .time { font-family: ${MONO}; font-size: 14px; font-weight: 500; color: #e5e7eb; min-width: 42px; }
        .sep { width: 1px; height: 18px; background: rgba(255,255,255,0.12); }
        .pbtn { all: unset; cursor: pointer; padding: 5px 7px; border-radius: 6px; display: flex; align-items: center; gap: 5px; color: #9ca3af; font: 500 12px ${SANS}; }
        .pbtn:hover { background: rgba(255,255,255,0.06); }
        .stopbtn { all: unset; cursor: pointer; background: #ef4444; color: #fff; font: 600 13px ${SANS}; padding: 9px 18px;
          border-radius: 22px; display: flex; align-items: center; gap: 7px; }
        .stopbtn:hover { background: #dc2626; }
      </style>
      <div class="center" id="center"><div class="cnum" id="cnum">3</div></div>
      <div class="wrap" id="wrap">
        <div class="circle" id="circle"><video id="vid" autoplay muted playsinline></video><div class="rec" id="rec" style="display:none"></div></div>
        <div class="pill" id="pill" style="display:none">
          <span class="time" id="time">00:00</span>
          <button class="pbtn" id="pause"></button>
          <span class="sep"></span>
          <button class="stopbtn" id="stop"><svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>Stop recording</button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const wrap = root.getElementById("wrap");
    const circle = root.getElementById("circle");
    const vid = root.getElementById("vid");
    const recDot = root.getElementById("rec");
    const center = root.getElementById("center");
    const cnum = root.getElementById("cnum");
    const pill = root.getElementById("pill");
    const timeEl = root.getElementById("time");
    const pauseBtn = root.getElementById("pause");
    const stopBtn = root.getElementById("stop");
    let state = null, camStream = null, dragged = false, started = false;

    const PAUSE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    const PLAY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e" stroke="#22c55e"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    pauseBtn.innerHTML = `${PAUSE}<span>Pause</span>`;
    pauseBtn.onclick = () => send(state && state.paused ? "resume-recording" : "pause-recording");
    stopBtn.onclick = () => send("stop-recording");

    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 640, facingMode: "user" }, audio: false })
      .then((s) => { camStream = s; vid.srcObject = s; })
      .catch(() => {});

    // default bottom-LEFT
    this.setPos = (pos) => {
      if (dragged) return;
      const map = {
        tl: { top: "24px", left: "24px", right: "auto", bottom: "auto" },
        tr: { top: "24px", right: "24px", left: "auto", bottom: "auto" },
        bl: { bottom: "24px", left: "24px", right: "auto", top: "auto" },
        br: { bottom: "24px", right: "24px", left: "auto", top: "auto" },
      };
      Object.assign(wrap.style, map[pos] || map.bl);
    };
    this.setPos("bl");

    // 3-2-1 countdown, centred on the screen, then begin the actual recording
    let n = 3;
    const tick = () => { cnum.textContent = n; cnum.style.animation = "none"; void cnum.offsetWidth; cnum.style.animation = "pop 1s ease-out"; };
    tick();
    const cd = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(cd);
        center.remove();
        recDot.style.display = "";
        pill.style.display = "flex";
        send("videocircle-go"); // tells the service worker to start capturing now
      } else tick();
    }, 1000);

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

    const interval = setInterval(() => { if (state && started) timeEl.textContent = fmt(elapsed(state, Date.now())); }, 500);

    this.onState = (s) => {
      state = s;
      const phase = s && s.phase;
      if (!phase || phase === "idle") return this.destroy();
      if (phase === "recording") { started = true; pill.style.display = "flex"; root.getElementById("center")?.remove(); recDot.style.display = ""; }
      wrap.classList.toggle("paused", !!s.paused);
      pauseBtn.innerHTML = s.paused ? `${PLAY}<span style="color:#22c55e">Resume</span>` : `${PAUSE}<span>Pause</span>`;
      const finalizing = phase === "saving" || phase === "transcoding";
      pauseBtn.style.display = finalizing ? "none" : "";
      timeEl.textContent = finalizing ? "Saving…" : fmt(elapsed(s, Date.now()));
    };
    this.requestState = () => chrome.runtime.sendMessage({ type: "get-state" }, (res) => { if (!chrome.runtime.lastError && res && res.state) this.onState(res.state); });
    this.destroy = () => { clearInterval(interval); try { camStream?.getTracks().forEach((t) => t.stop()); } catch {} host.remove(); window.__screensnapBub = null; };
    this.requestState();
  }
})();
