// Recorder window — the separate floating mini-window for screen / window recording.
// Opened by the service worker when the user picks "Screen / Window" in the popup. Waiting state
// triggers the native picker (RW_CHOOSE); once recording it shows a live timer + pause/stop.
import { MSG, PHASE, elapsedMs, fmtClock } from "../lib/messages.js";

const app = document.getElementById("app");
const send = (m) => chrome.runtime.sendMessage(m);
const MONO = "'Geist Mono',ui-monospace,monospace";
let rec = { phase: PHASE.IDLE };
let timer = null;

const P = {
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  stop: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
};
const ico = (n, c, sz = 16, sw = 1.75) =>
  `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="${n === "stop" ? c : "none"}" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;

function header() {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0f0f0f;border-bottom:1px solid rgba(255,255,255,0.06)">
    <div style="display:flex;gap:6px">${["#ef4444", "#f59e0b", "#22c55e"]
      .map((c) => `<div style="width:10px;height:10px;border-radius:50%;background:${c};opacity:0.85"></div>`)
      .join("")}</div>
    <span style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.09em;color:#333">screensnap · recorder</span>
    <div style="width:46px"></div>
  </div>`;
}

function pingDot() {
  return `<div style="position:relative;width:6px;height:6px;flex-shrink:0"><div style="position:absolute;inset:0;border-radius:50%;background:rgba(239,68,68,0.45);animation:pingRing 1.5s ease-out infinite"></div><div style="position:absolute;inset:0;border-radius:50%;background:#ef4444"></div></div>`;
}

function render() {
  const phase = rec.phase || PHASE.IDLE;
  let body;
  if (phase === PHASE.RECORDING) {
    body = `<div style="padding:22px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div>
        <div id="timer" style="font-family:${MONO};font-size:36px;font-weight:500;letter-spacing:-0.03em;line-height:1;color:${
      rec.paused ? "#555" : "#fff"
    }">${fmtClock(elapsedMs(rec) / 1000)}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:7px">
          ${rec.paused ? `<span style="font-family:${MONO};font-size:9px;color:#555;text-transform:uppercase;letter-spacing:0.08em">Paused</span>` : `${pingDot()}<span style="font-family:${MONO};font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em">Screen · recording</span>`}
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="ghost" data-act="pause" style="padding:10px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e5e7eb;font:500 12px 'Geist',sans-serif;cursor:pointer;display:flex;align-items:center;gap:7px">${
        rec.paused ? `${ico("play", "#22c55e", 11)}Resume` : `${ico("pause", "currentColor", 11)}Pause`
      }</button>
        <button class="stop" data-act="stop" style="padding:10px 18px;background:rgba(239,68,68,0.09);border:1px solid rgba(239,68,68,0.22);border-radius:8px;color:#ef4444;font:500 12px 'Geist',sans-serif;cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap">${ico(
        "stop",
        "#ef4444",
        11
      )}Stop</button>
      </div>
    </div>`;
  } else if (phase === PHASE.PREPARING || phase === PHASE.SAVING || phase === PHASE.TRANSCODING) {
    body = `<div style="padding:34px 24px;display:flex;flex-direction:column;align-items:center;gap:12px">
      <div style="font-family:${MONO};font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.09em">${
      phase === PHASE.PREPARING ? "Starting…" : "Saving…"
    }</div></div>`;
  } else {
    body = `<div style="padding:32px 24px;display:flex;flex-direction:column;align-items:center;gap:14px">
      <div style="width:48px;height:48px;border-radius:12px;background:#161616;border:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center">${ico(
        "monitor",
        "#333",
        22
      )}</div>
      <button class="prim" data-act="choose" style="padding:10px 26px;background:#22c55e;border:none;border-radius:8px;color:#000;font:600 13px 'Geist',sans-serif;cursor:pointer">Choose screen to record</button>
      <span style="font-family:${MONO};font-size:9px;color:#333;text-transform:uppercase;letter-spacing:0.08em">Native system picker opens next</span>
    </div>`;
  }
  app.innerHTML = header() + body;
  manageTimer();
}

function manageTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (rec.phase === PHASE.RECORDING && !rec.paused) {
    timer = setInterval(() => {
      const t = document.getElementById("timer");
      if (t) t.textContent = fmtClock(elapsedMs(rec) / 1000);
    }, 500);
  }
}

app.addEventListener("click", (e) => {
  const node = e.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;
  if (act === "choose") send({ type: MSG.RW_CHOOSE });
  else if (act === "stop") send({ type: MSG.STOP_RECORDING });
  else if (act === "pause") send({ type: rec.paused ? MSG.RESUME_RECORDING : MSG.PAUSE_RECORDING });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === MSG.STATE_CHANGED) {
    rec = msg.state || { phase: PHASE.IDLE };
    render();
  }
});

(async () => {
  try {
    const res = await send({ type: MSG.GET_STATE });
    rec = res?.state || { phase: PHASE.IDLE };
  } catch {
    rec = { phase: PHASE.IDLE };
  }
  render();
})();
