// Injected floating control for TAB recording (self-contained). A draggable screensnap pill with
// a live timer, pause/resume, and stop. Screen recording uses the separate recorder window instead;
// Video Circle uses webcam-bubble.js. Message strings mirror src/lib/messages.js.
(() => {
  const send = (type) => chrome.runtime.sendMessage({ type });
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
  const SANS = "'Geist',system-ui,-apple-system,sans-serif";

  if (!window.__screensnapRecListener) {
    window.__screensnapRecListener = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "state-changed" && window.__screensnapRec) window.__screensnapRec.onState(msg.state);
    });
  }
  if (window.__screensnapRec) {
    window.__screensnapRec.requestState();
    return;
  }
  window.__screensnapRec = new Control();

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
  const icoBtn = (svg, label, color) =>
    `<span style="display:flex;align-items:center;gap:4px;color:${color}"><svg width="10" height="10" viewBox="0 0 24 24" fill="${
      label === "Stop" ? color : "none"
    }" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${svg}</svg><span style="font-family:${SANS};font-size:11px">${label}</span></span>`;

  function Control() {
    const ID = "__screensnap_rec_host";
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .pill { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          display: flex; gap: 10px; align-items: center; background: rgba(5,5,5,0.92);
          backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.12); border-radius: 26px;
          padding: 7px 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.55); user-select: none; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; animation: rp 1.2s infinite; flex: 0 0 auto; }
        .paused .dot { animation: none; background: #f59e0b; border-radius: 1px; }
        @keyframes rp { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
        .time { font-family: ${MONO}; font-size: 12px; font-weight: 500; color: #e5e7eb; letter-spacing: -0.01em; min-width: 38px; }
        .grip { display: flex; align-items: center; gap: 9px; cursor: grab; }
        .sep { width: 1px; height: 14px; background: rgba(255,255,255,0.1); }
        button { all: unset; cursor: pointer; padding: 3px 5px; border-radius: 5px; }
        button:hover { background: rgba(255,255,255,0.06); }
      </style>
      <div class="pill" id="pill">
        <span class="grip" id="grip"><span class="dot"></span><span class="time" id="time">00:00</span></span>
        <span class="sep"></span>
        <button id="pause"></button>
        <span class="sep"></span>
        <button id="stop"></button>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const pill = root.getElementById("pill");
    const timeEl = root.getElementById("time");
    const pauseBtn = root.getElementById("pause");
    const stopBtn = root.getElementById("stop");
    const grip = root.getElementById("grip");
    let state = null;

    const PAUSE_SVG = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    const PLAY_SVG = '<polygon points="5 3 19 12 5 21 5 3"/>';
    const STOP_SVG = '<rect x="3" y="3" width="18" height="18" rx="2"/>';
    stopBtn.innerHTML = icoBtn(STOP_SVG, "Stop", "#ef4444");

    pauseBtn.onclick = () => send(state && state.paused ? "resume-recording" : "pause-recording");
    stopBtn.onclick = () => send("stop-recording");

    let drag = null;
    grip.addEventListener("pointerdown", (e) => { const r = pill.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; grip.setPointerCapture(e.pointerId); grip.style.cursor = "grabbing"; });
    grip.addEventListener("pointermove", (e) => {
      if (!drag) return;
      pill.style.left = Math.max(4, Math.min(window.innerWidth - pill.offsetWidth - 4, e.clientX - drag.dx)) + "px";
      pill.style.top = Math.max(4, Math.min(window.innerHeight - pill.offsetHeight - 4, e.clientY - drag.dy)) + "px";
      pill.style.right = "auto"; pill.style.bottom = "auto";
    });
    grip.addEventListener("pointerup", () => { drag = null; grip.style.cursor = "grab"; });

    const interval = setInterval(() => { if (state) timeEl.textContent = fmt(elapsed(state, Date.now())); }, 500);

    this.onState = (s) => {
      state = s;
      const phase = s && s.phase;
      if (!phase || phase === "idle") return this.destroy();
      pill.classList.toggle("paused", !!s.paused);
      pauseBtn.innerHTML = s.paused ? icoBtn(PLAY_SVG, "Resume", "#22c55e") : icoBtn(PAUSE_SVG, "Pause", "#9ca3af");
      const finalizing = phase === "transcoding" || phase === "saving";
      pauseBtn.style.display = finalizing ? "none" : "";
      timeEl.textContent = finalizing ? "Saving…" : fmt(elapsed(s, Date.now()));
    };
    this.requestState = () => chrome.runtime.sendMessage({ type: "get-state" }, (res) => { if (!chrome.runtime.lastError && res && res.state) this.onState(res.state); });
    this.destroy = () => { clearInterval(interval); host.remove(); window.__screensnapRec = null; };
    this.requestState();
  }
})();
