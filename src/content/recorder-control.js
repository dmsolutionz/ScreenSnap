// Injected on-page recording control bar (self-contained), Loom-style. Bottom-LEFT, light. It is
// *collapsed/auto-hidden* during recording so it stays OUT of the capture — `chrome.tabCapture` records
// the whole tab, so any visible on-page control would appear in the video (this is exactly how Loom keeps
// recordings clean: the bar hides, you stop with a keyboard shortcut, or reveal the bar by moving to the
// bottom-left corner when you actually need it). It owns the 3-2-1 countdown for Current Tab recording;
// screen / screen+cam have no on-page countdown (the native picker is the get-ready beat) and the bar there
// is controls-only and best-effort (only visible while the active tab is foreground). Re-injected on
// navigation by the service worker; skips the countdown on re-entry. Strings mirror src/lib/messages.js
// (content scripts can't import the module).
(() => {
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
  const SANS = "'Geist',system-ui,-apple-system,sans-serif";
  const send = (type) => chrome.runtime.sendMessage({ type });
  const sendMsg = (m) => { try { chrome.runtime.sendMessage(m); } catch {} };
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  const SC_STOP = isMac ? "⌥⇧S" : "Alt+Shift+S"; // ⌥⇧S

  if (!window.__screensnapCtlListener) {
    window.__screensnapCtlListener = true;
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender.id !== chrome.runtime.id) return; // only this extension's own service worker
      if (!msg || !window.__screensnapCtl) return;
      if (msg.type === "state-changed") window.__screensnapCtl.onState(msg.state);
    });
  }
  if (window.__screensnapCtl) { window.__screensnapCtl.requestState(); return; }
  window.__screensnapCtl = new Control();

  function elapsed(s, now) { if (!s || !s.startedAt) return 0; const end = s.paused && s.pausedAt ? s.pausedAt : now; return Math.max(0, end - s.startedAt - (s.pausedTotalMs || 0)); }
  function fmt(ms) { const s = Math.floor(ms / 1000); const p = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")); return (s >= 3600 ? p : p.slice(1)).join(":"); }

  function Control() {
    const ID = "__screensnap_control_host";
    document.getElementById(ID)?.remove();
    const host = document.createElement("div");
    host.id = ID;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        /* Hidden by default: it's only shown while THIS instance runs the countdown. A re-injected bar
           (mid-recording, after a navigation) never shows it, so the countdown overlay can't flash into
           the capture, and the controls-only bar for screen / screen+cam never shows a stray "3". */
        .center { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center;
          background: rgba(248,250,252,0.55); pointer-events: none; }
        .cnum { color: #18181b; font: 700 160px ${SANS}; text-shadow: 0 2px 24px rgba(255,255,255,0.7); }
        @keyframes pop { 0% { transform: scale(1.6); opacity: 0; } 25% { opacity: 1; } 100% { transform: scale(1); opacity: 0.92; } }
        @keyframes rp { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

        /* The dock sits bottom-left and slides fully OFF-SCREEN when collapsed, so nothing is captured. */
        .dock { position: fixed; left: 18px; bottom: 18px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
          transform: translateY(150%); opacity: 0; pointer-events: none; transition: transform .26s cubic-bezier(.2,.8,.2,1), opacity .2s ease; }
        .dock.show { transform: translateY(0); opacity: 1; pointer-events: auto; }

        .toast { font: 500 12px ${SANS}; color: #3f3f46; background: #fff; border: 1px solid #e4e6eb; border-radius: 8px;
          padding: 6px 10px; box-shadow: 0 6px 18px rgba(17,24,39,0.12); white-space: nowrap; display: none; }
        .toast b { color: #18181b; font-weight: 600; }
        .toast kbd { font-family: ${MONO}; font-size: 11px; background: #f3f4f6; border: 1px solid #e4e6eb; border-radius: 5px; padding: 1px 5px; color: #18181b; }

        .bar { display: flex; align-items: center; gap: 10px; background: #ffffff; border: 1px solid #e4e6eb;
          border-radius: 30px; padding: 8px 10px 8px 14px; box-shadow: 0 10px 30px rgba(17,24,39,0.18); user-select: none; }
        .rec { width: 10px; height: 10px; border-radius: 50%; background: #dc2626; box-shadow: 0 0 8px rgba(220,38,38,0.45); animation: rp 1.2s infinite; flex: none; }
        .bar.paused .rec { animation: none; background: #d97706; border-radius: 2px; }
        .time { font-family: ${MONO}; font-size: 14px; font-weight: 500; color: #18181b; min-width: 44px; }
        .sep { width: 1px; height: 20px; background: #e4e6eb; }
        button { font-family: inherit; }
        .ico { all: unset; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #6b7280; }
        .ico:hover { background: #f3f4f6; color: #18181b; }
        .ico.muted { color: #dc2626; }
        .ico.muted:hover { background: rgba(220,38,38,0.08); color: #dc2626; }
        .ico.on { color: #16a34a; background: rgba(22,163,74,0.1); }
        .ico.on:hover { background: rgba(22,163,74,0.16); color: #16a34a; }
        .stop { all: unset; cursor: pointer; background: #dc2626; color: #fff; font: 600 13px ${SANS}; padding: 9px 16px;
          border-radius: 21px; display: flex; align-items: center; gap: 7px; }
        .stop:hover { background: #b91c1c; }
      </style>
      <div class="center" id="center"><div class="cnum" id="cnum">3</div></div>
      <div class="dock" id="dock">
        <div class="toast" id="toast"></div>
        <div class="bar" id="bar">
          <span class="rec"></span>
          <span class="time" id="time">00:00</span>
          <button class="ico" id="mic" title="Mute mic" aria-label="Mute mic" style="display:none"></button>
          <button class="ico" id="cam" title="Hide camera" aria-label="Hide camera" style="display:none"></button>
          <button class="ico" id="draw" title="Draw on the page" aria-label="Draw"></button>
          <span class="sep"></span>
          <button class="ico" id="restart" title="Restart recording" aria-label="Restart">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v6h6"/><path d="M3.5 8a9 9 0 1 1-1.5 5"/></svg>
          </button>
          <button class="ico" id="pause" title="Pause" aria-label="Pause"></button>
          <button class="ico" id="cancel" title="Discard (delete, no save)" aria-label="Discard">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
          <span class="sep"></span>
          <button class="stop" id="stop"><svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>Stop</button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const center = root.getElementById("center");
    const cnum = root.getElementById("cnum");
    const dock = root.getElementById("dock");
    const toast = root.getElementById("toast");
    const bar = root.getElementById("bar");
    const timeEl = root.getElementById("time");
    const micBtn = root.getElementById("mic");
    const camBtn = root.getElementById("cam");
    const drawBtn = root.getElementById("draw");
    const restartBtn = root.getElementById("restart");
    const pauseBtn = root.getElementById("pause");
    const cancelBtn = root.getElementById("cancel");
    const stopBtn = root.getElementById("stop");
    let state = null, started = false;

    const CAM_ON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    const CAM_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="M23 7l-7 5 7 5V7z"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const PEN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>';

    const PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    const PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#16a34a" stroke="#16a34a"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
    const MIC_ON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
    const MIC_OFF = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="21" y2="21"/><path d="M9 9v3a3 3 0 0 0 5 2.1"/><path d="M15 10.5V5a3 3 0 0 0-5.6-1.5"/><path d="M5 11a7 7 0 0 0 10.8 5.9"/><path d="M19 11a7 7 0 0 1-.6 2.8"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
    pauseBtn.innerHTML = PAUSE;
    drawBtn.innerHTML = PEN;
    pauseBtn.onclick = () => send(state && state.paused ? "resume-recording" : "pause-recording");
    cancelBtn.onclick = () => send("cancel-recording");
    stopBtn.onclick = () => send("stop-recording");
    restartBtn.onclick = () => send("restart-recording");
    micBtn.onclick = () => sendMsg({ type: "set-mic-muted", muted: !(state && state.micMuted) });
    camBtn.onclick = () => sendMsg({ type: "set-bubble", hidden: !(state && state.camHidden) });
    drawBtn.onclick = () => sendMsg({ type: "set-draw", on: !(state && state.drawActive) });

    // ── reveal / auto-hide ───────────────────────────────────────────────────────
    // Hidden by default during recording so the capture stays clean. Reveal by moving the pointer into the
    // bottom-left corner (where the dock lives); hovering the dock keeps it open; it auto-collapses shortly
    // after the pointer leaves. Keyboard shortcut (handled by the service worker) stops without revealing.
    let hideTimer = null, hintShown = false;
    // One-time hint, shown only when the user first SUMMONS the bar (so it never lands in a clean capture
    // unless the user chose to reveal the controls). Teaches the stop shortcut.
    const showHintOnce = () => {
      if (hintShown) return;
      hintShown = true;
      toast.innerHTML = `<b>Recording</b> &nbsp;·&nbsp; <kbd>${SC_STOP}</kbd> to stop`;
      toast.style.display = "block";
    };
    const open = (lingerMs, hint) => { if (hint) showHintOnce(); dock.classList.add("show"); clearTimeout(hideTimer); hideTimer = setTimeout(close, lingerMs || 2400); };
    const close = () => { clearTimeout(hideTimer); dock.classList.remove("show"); };
    const inCorner = (e) => e.clientX < 360 && e.clientY > window.innerHeight - 150;
    const onMouseMove = (e) => { if (started && inCorner(e)) open(2400, true); };
    window.addEventListener("mousemove", onMouseMove, true);
    dock.addEventListener("pointerenter", () => { showHintOnce(); clearTimeout(hideTimer); dock.classList.add("show"); });
    dock.addEventListener("pointerleave", () => { clearTimeout(hideTimer); hideTimer = setTimeout(close, 1600); });

    // ── countdown (Current Tab recording only; screen / screen+cam use the native picker) ──
    // The .center overlay is hidden (not removed) when a countdown ends, so a RESTART can re-show it.
    let cd = null, countdownDone = false;
    const startCountdown = () => {
      if (cd || countdownDone) return;
      const allowed = [0, 3, 5, 10];
      let n = allowed.includes(state && state.countdownSec) ? state.countdownSec : 3;
      if (n <= 0) { countdownDone = true; center.style.display = "none"; send("rec-go"); return; } // instant start (overlay never shown)
      center.style.display = "flex"; // only show the overlay when a real countdown runs
      const tick = () => { cnum.textContent = n; cnum.style.animation = "none"; void cnum.offsetWidth; cnum.style.animation = "pop 1s ease-out"; };
      tick();
      cd = setInterval(() => {
        n -= 1;
        if (n <= 0) { clearInterval(cd); cd = null; countdownDone = true; center.style.display = "none"; send("rec-go"); }
        else tick();
      }, 1000);
    };

    const interval = setInterval(() => { if (state && started) timeEl.textContent = fmt(elapsed(state, Date.now())); }, 500);

    this.onState = (s) => {
      state = s;
      const phase = s && s.phase;
      if (!phase || phase === "idle") return this.destroy();
      if (phase === "preparing") {
        // Restart: a new take is beginning in this same page (no navigation → this singleton persisted).
        // Reset the latches so the countdown actually replays. Gate on `started` only (true only once
        // recording began) so this fires exactly once per restart, never mid-countdown.
        if (started) { started = false; countdownDone = false; if (cd) { clearInterval(cd); cd = null; } close(); }
        if (s.source === "tab") startCountdown(); // video-circle: bubble owns countdown
        return;
      }
      // recording / saving / transcoding
      if (cd) { clearInterval(cd); cd = null; }
      countdownDone = true;
      if (!started) { started = true; center.style.display = "none"; } // stay hidden; reveal is corner-hover only
      const finalizing = phase === "saving" || phase === "transcoding";
      // Screen-based capture (screen / screen+cam): the bar is a best-effort overlay on the active tab.
      // Restart needs a fresh source pick and the pen only marks the browser tab, so both are hidden there.
      const screenBased = s.source === "screen" || s.source === "videocircle";
      bar.classList.toggle("paused", !!s.paused);
      pauseBtn.innerHTML = s.paused ? PLAY : PAUSE;
      pauseBtn.title = s.paused ? "Resume" : "Pause";
      pauseBtn.style.display = finalizing ? "none" : "";
      cancelBtn.style.display = finalizing ? "none" : "";
      restartBtn.style.display = finalizing || screenBased ? "none" : "";
      micBtn.style.display = s.withMic && !finalizing ? "" : "none";
      micBtn.innerHTML = s.micMuted ? MIC_OFF : MIC_ON;
      micBtn.title = s.micMuted ? "Unmute mic" : "Mute mic";
      micBtn.classList.toggle("muted", !!s.micMuted);
      const isVC = s.source === "videocircle";
      camBtn.style.display = isVC && !finalizing ? "" : "none";
      camBtn.innerHTML = s.camHidden ? CAM_OFF : CAM_ON;
      camBtn.title = s.camHidden ? "Show camera" : "Hide camera";
      camBtn.classList.toggle("muted", !!s.camHidden);
      drawBtn.style.display = finalizing || screenBased ? "none" : "";
      drawBtn.classList.toggle("on", !!s.drawActive);
      drawBtn.title = s.drawActive ? "Stop drawing" : "Draw on the page";
      if (finalizing) { timeEl.textContent = "Saving…"; open(6000); return; }
      timeEl.textContent = fmt(elapsed(s, Date.now()));
    };
    this.requestState = () => chrome.runtime.sendMessage({ type: "get-state" }, (res) => { if (!chrome.runtime.lastError && res && res.state) this.onState(res.state); });
    this.destroy = () => { clearInterval(interval); clearInterval(cd); clearTimeout(hideTimer); window.removeEventListener("mousemove", onMouseMove, true); host.remove(); window.__screensnapCtl = null; };
    this.requestState(); // learn the current phase: countdown on first inject, collapsed bar after a reload
  }
})();
