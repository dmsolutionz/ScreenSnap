// screensnap. popup — UI + message dispatch. Ports the screensnap design to vanilla DOM.
// All capture/record work happens in the service worker + offscreen document; the popup just
// reflects live state (GET_STATE / STATE_CHANGED) and can close at any time without interrupting.
import { MSG, PHASE, SOURCE, getSettings, setSettings, elapsedMs, fmtClock } from "../lib/messages.js";

const app = document.getElementById("app");
const send = (m) => chrome.runtime.sendMessage(m);

let settings = { ...{} };
let localTab = "capture";
let rec = { phase: PHASE.IDLE };
let captured = null; // { thumb, filename, width, height }
let doneInfo = null; // { filename, durationMs, note }
let capturing = null; // mode currently being captured
let bubPos = "br";
let prevPhase = PHASE.IDLE;
let timer = null;

// ── icons ────────────────────────────────────────────────────────────────────
const P = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  cross: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="1" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="23"/><line x1="1" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="23" y2="12"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  tab: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M7 4v5"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  vol: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  stop: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  chev: '<polyline points="9 18 15 12 9 6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
};
const ico = (n, { sz = 16, c = "currentColor", sw = 1.75 } = {}) =>
  `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;

const MONO = "'Geist Mono',monospace";
const clockStr = (ms) => fmtClock((ms || 0) / 1000);
const shortName = (f) => (f || "").split("/").pop();

// ── partials ───────────────────────────────────────────────────────────────────
function wordmark() {
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="width:24px;height:24px;border-radius:7px;background:#111;border:1px solid rgba(255,255,255,0.09);display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="1" y="3" width="20" height="13" rx="2" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/><circle cx="18.5" cy="6.5" r="3.5" fill="#22c55e"/><circle cx="18.5" cy="6.5" r="1.5" fill="#050505"/></svg>
    </div>
    <span style="font-weight:600;font-size:13px;letter-spacing:-0.025em;color:#fff">screensnap<span style="color:#22c55e">.</span></span>
  </div>`;
}
function recBadge() {
  const paused = !!rec.paused;
  const dot = paused
    ? '<div style="width:5px;height:5px;border-radius:1px;background:#f59e0b"></div>'
    : '<div style="width:5px;height:5px;border-radius:50%;background:#ef4444;animation:recPulse 1.2s ease-in-out infinite"></div>';
  return `<div style="display:flex;align-items:center;gap:5px;background:rgba(239,68,68,0.09);border:1px solid rgba(239,68,68,0.22);border-radius:999px;padding:3px 9px">
    ${dot}<span style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:${paused ? "#f59e0b" : "#ef4444"}">${paused ? "paused" : "rec"}</span></div>`;
}
function pingDot(s = 7) {
  return `<div style="position:relative;width:${s}px;height:${s}px;flex-shrink:0">
    <div style="position:absolute;inset:0;border-radius:50%;background:rgba(239,68,68,0.5);animation:pingRing 1.5s ease-out infinite"></div>
    <div style="position:absolute;inset:0;border-radius:50%;background:#ef4444"></div></div>`;
}
function tabsBar() {
  return `<div style="display:flex;padding:0 16px;border-bottom:1px solid rgba(255,255,255,0.07)">
    ${["capture", "record"]
      .map(
        (t) =>
          `<button class="tab-t" data-act="tab" data-tab="${t}" style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.09em;color:${
            localTab === t ? "#fff" : "#555"
          };background:none;border:none;padding:9px 0;margin-right:20px;cursor:pointer;border-bottom:2px solid ${
            localTab === t ? "#22c55e" : "transparent"
          };margin-bottom:-1px">${t}</button>`
      )
      .join("")}
  </div>`;
}
function toggle(on, key) {
  return `<div class="tg" data-act="toggle" data-key="${key}" style="width:34px;height:18px;border-radius:9px;background:${
    on ? "#22c55e" : "rgba(255,255,255,0.11)"
  };cursor:pointer;position:relative;flex-shrink:0">
    <div style="position:absolute;width:13px;height:13px;border-radius:50%;background:#fff;top:2.5px;left:${
      on ? "18.5px" : "2.5px"
    };transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div></div>`;
}
function camCircle(size, paused) {
  const overlay = paused
    ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.48)">${ico(
        "pause",
        { sz: Math.round(size * 0.28), c: "rgba(255,255,255,0.65)" }
      )}</div>`
    : `<div style="position:absolute;top:5px;right:5px;width:7px;height:7px;border-radius:50%;background:#ef4444;animation:recPulse 1.2s ease-in-out infinite"></div>`;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;position:relative;overflow:hidden;border:2px solid rgba(34,197,94,0.4);box-shadow:0 0 0 3px rgba(34,197,94,0.07)">
    <div style="position:absolute;inset:0;background:radial-gradient(circle at 42% 38%,#243824 0%,#0d1a0d 55%,#050505 100%)"></div>
    <div style="position:absolute;top:${Math.round(size * 0.16)}px;left:50%;transform:translateX(-50%);width:${Math.round(
    size * 0.38
  )}px;height:${Math.round(size * 0.38)}px;border-radius:50%;background:rgba(255,255,255,0.11)"></div>
    <div style="position:absolute;bottom:-4px;left:-4px;right:-4px;height:${Math.round(
      size * 0.48
    )}px;border-radius:50% 50% 0 0;background:rgba(255,255,255,0.07)"></div>${overlay}</div>`;
}

// ── views ────────────────────────────────────────────────────────────────────
function captureRow(mode, icon, label, desc, last) {
  const hot = capturing === mode;
  return `<div class="pr" data-act="cap" data-mode="${mode}" style="display:flex;align-items:center;gap:12px;padding:11px 16px;cursor:pointer;border-bottom:${
    last ? "none" : "1px solid rgba(255,255,255,0.05)"
  };background:${hot ? "rgba(34,197,94,0.06)" : "transparent"}">
    <div style="width:32px;height:32px;border-radius:8px;flex-shrink:0;background:#0f0f0f;border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center">${ico(
      icon,
      { sz: 14, c: hot ? "#22c55e" : "#555" }
    )}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:500;color:#e5e7eb">${label}</div>
      <div style="font-family:${MONO};font-size:10px;color:#4b5563;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px">${
    hot ? "Capturing…" : desc
  }</div>
    </div>${ico("chev", { sz: 13, c: "#2a2a2a" })}</div>`;
}
function captureTab() {
  return `<div>
    ${captureRow("visible", "camera", "Visible Tab", "PNG · instant", false)}
    ${captureRow("fullpage", "page", "Full Page", "PNG · scroll + stitch", false)}
    ${captureRow("area", "cross", "Select Area", "PNG · draw a region", true)}
  </div>`;
}
function recordRow(src, icon, label, desc, accent) {
  return `<div class="rb" data-act="rec" data-src="${src}" style="display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid ${
    accent ? "rgba(34,197,94,0.24)" : "rgba(255,255,255,0.08)"
  };border-radius:10px;margin:0 14px 8px;cursor:pointer;background:${accent ? "rgba(34,197,94,0.04)" : "transparent"}">
    <div style="width:36px;height:36px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${
      accent ? "rgba(34,197,94,0.10)" : "#0f0f0f"
    };border:1px solid ${accent ? "rgba(34,197,94,0.28)" : "rgba(255,255,255,0.08)"}">${ico(icon, {
    sz: 16,
    c: accent ? "#22c55e" : "#555",
  })}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:500;color:#e5e7eb;margin-bottom:2px">${label}</div>
      <div style="font-family:${MONO};font-size:10px;color:#4b5563;text-transform:uppercase;letter-spacing:0.06em">${desc}</div>
    </div>${ico("chev", { sz: 13, c: "#2a2a2a" })}</div>`;
}
function audioRow(icon, label, key) {
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:${key === "withSystemAudio" ? "9px" : "0"}">
    ${ico(icon, { sz: 13, c: "#444" })}<span style="flex:1;font-size:12px;color:#9ca3af">${label}</span>${toggle(
    !!settings[key],
    key
  )}</div>`;
}
function recordTab() {
  return `<div style="padding-top:12px;padding-bottom:4px">
    ${recordRow("tab", "tab", "Current Tab", "No picker · tab audio", true)}
    ${recordRow("screen", "monitor", "Screen / Window", "Native picker · any source", false)}
    ${recordRow("videocircle", "video", "Video Circle", "Webcam bubble · sys audio", false)}
    <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px">
      <div style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#333;margin-bottom:10px">Audio</div>
      ${audioRow("vol", "System audio", "withSystemAudio")}
      ${audioRow("mic", "Microphone", "withMic")}
    </div>
  </div>`;
}
function capturedView() {
  return `<div style="padding:14px 16px 18px">
    <div style="width:100%;height:118px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);margin-bottom:11px;background:#0f0f0f;display:flex;align-items:center;justify-content:center">
      <img src="${captured.thumb}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;display:block"/>
    </div>
    <div style="font-family:${MONO};font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px;text-align:center">${shortName(
    captured.filename
  )} · ${captured.width}×${captured.height}</div>
    <button class="prim-b" data-act="annotate" style="width:100%;padding:10px;background:#22c55e;border:none;border-radius:8px;color:#000;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:8px">${ico(
    "pencil",
    { sz: 13, c: "#000" }
  )}Annotate &amp; save</button>
    <button class="ghost-b" data-act="save" style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:8px;color:#e5e7eb;font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;margin-bottom:8px">${ico(
    "down",
    { sz: 13, c: "#9ca3af" }
  )}Save PNG directly</button>
    <div style="display:flex;gap:7px">
      <button class="ghost-b" data-act="copy" style="flex:1;padding:7px;background:none;border:1px solid rgba(255,255,255,0.07);border-radius:7px;color:#6b7280;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">${ico(
        "copy",
        { sz: 11, c: "#6b7280" }
      )}<span data-copylabel>Copy</span></button>
      <button class="ghost-b" data-act="shot-discard" style="flex:1;padding:7px;background:none;border:none;color:#383838;font-size:11px;cursor:pointer;border-radius:7px">Discard</button>
    </div>
  </div>`;
}
function codecLabel() {
  return (rec.mime || "").includes("mp4") ? "MP4 · H.264" : "WebM · VP9";
}
function srcName() {
  return rec.source === SOURCE.SCREEN ? "Screen" : rec.source === SOURCE.VIDEO_CIRCLE ? "Video circle" : "Current tab";
}
function audioChips() {
  const chip = (l) =>
    `<span style="font-family:${MONO};font-size:9px;color:rgba(34,197,94,0.85);background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.18);border-radius:4px;padding:2px 7px">${l}</span>`;
  const chips = [];
  if (rec.withSystemAudio) chips.push(chip("sys audio"));
  if (rec.withMic) chips.push(chip("mic"));
  if (!chips.length) return "";
  return `<div style="display:flex;gap:4px;margin-top:10px">${chips.join("")}</div>`;
}
function recRegular() {
  return `<div style="padding:28px 20px 22px;display:flex;flex-direction:column;align-items:center">
    <div id="timer" style="font-family:${MONO};font-size:46px;font-weight:500;letter-spacing:-0.04em;line-height:1;color:${
    rec.paused ? "#555" : "#fff"
  }">${clockStr(elapsedMs(rec))}</div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:10px">
      ${rec.paused ? `<span style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#555">Paused</span>` : `${pingDot()}<span style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280">${srcName()} · ${codecLabel()}</span>`}
    </div>
    ${audioChips()}
    <button class="stop-b" data-act="stop" style="margin-top:22px;width:100%;padding:11px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:9px;color:#ef4444;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">${ico(
    "stop",
    { sz: 12, c: "#ef4444" }
  )}Stop &amp; save as MP4</button>
    <div style="display:flex;gap:16px;margin-top:8px">
      <button class="ghost-b" data-act="pause" style="padding:5px 12px;background:none;border:none;color:#9ca3af;font-size:11px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:5px">${
        rec.paused ? `${ico("play", { sz: 10, c: "#22c55e" })}Resume` : `${ico("pause", { sz: 10, c: "currentColor" })}Pause`
      }</button>
      <button class="ghost-b" data-act="discard" style="padding:5px 12px;background:none;border:none;color:#383838;font-size:11px;cursor:pointer;border-radius:6px">Discard</button>
    </div>
  </div>`;
}
function recVideoCircle() {
  const grid = [
    ["tl", "↖"],
    ["tr", "↗"],
    ["bl", "↙"],
    ["br", "↘"],
  ]
    .map(
      ([pos, arrow]) =>
        `<div data-act="bubble-pos" data-pos="${pos}" style="height:28px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;background:${
          bubPos === pos ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.04)"
        };border:1px solid ${
          bubPos === pos ? "rgba(34,197,94,0.35)" : "rgba(255,255,255,0.07)"
        }"><span style="font-size:11px">${arrow}</span><div style="width:5px;height:5px;border-radius:50%;background:${
          bubPos === pos ? "#22c55e" : "rgba(255,255,255,0.15)"
        }"></div></div>`
    )
    .join("");
  return `<div style="padding:16px 16px 18px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;align-items:center;gap:14px">
      ${camCircle(66, rec.paused)}
      <div style="flex:1">
        <div id="timer" style="font-family:${MONO};font-size:32px;font-weight:500;letter-spacing:-0.035em;line-height:1;color:${
    rec.paused ? "#555" : "#fff"
  }">${clockStr(elapsedMs(rec))}</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:7px">
          ${rec.paused ? `<span style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#555">Paused</span>` : `${pingDot(6)}<span style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280">Video circle · sys audio</span>`}
        </div>
      </div>
    </div>
    <div>
      <div style="font-family:${MONO};font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:#333;margin-bottom:7px">Bubble position</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;width:88px">${grid}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="ghost-b" data-act="pause" style="flex:1;padding:9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);border-radius:9px;color:#e5e7eb;font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px">${
        rec.paused ? `${ico("play", { sz: 11, c: "#22c55e" })}Resume` : `${ico("pause", { sz: 11, c: "currentColor" })}Pause`
      }</button>
      <button class="stop-b" data-act="stop" style="flex:1;padding:9px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:9px;color:#ef4444;font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px">${ico(
    "stop",
    { sz: 11, c: "#ef4444" }
  )}Stop &amp; save</button>
    </div>
    <button class="ghost-b" data-act="discard" style="align-self:center;padding:4px 12px;background:none;border:none;color:#333;font-size:11px;cursor:pointer;border-radius:6px">Discard</button>
  </div>`;
}
function savingView() {
  const footage = clockStr(rec.recordedDurationMs);
  return `<div style="padding:36px 20px 30px;display:flex;flex-direction:column;align-items:center;gap:10px">
    <div style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280">Finalizing · ${footage} recorded</div>
    <div style="width:100%;height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">
      <div style="height:100%;width:40%;background:#22c55e;border-radius:2px;position:relative;overflow:hidden">
        <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.4),transparent);animation:shimmer 1.2s ease-in-out infinite"></div>
      </div>
    </div>
    <div style="font-family:${MONO};font-size:9px;color:#383838;text-transform:uppercase;letter-spacing:0.06em">Writing native MP4 to Downloads…</div>
  </div>`;
}
function doneView() {
  const note = doneInfo.note
    ? `<div style="font-family:${MONO};font-size:9px;color:#f59e0b;margin-top:6px;text-align:center;max-width:240px">${doneInfo.note}</div>`
    : "";
  return `<div style="padding:34px 20px 26px;display:flex;flex-direction:column;align-items:center">
    <div style="width:44px;height:44px;border-radius:50%;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.22);display:flex;align-items:center;justify-content:center">${ico(
      "check",
      { sz: 20, c: "#22c55e" }
    )}</div>
    <div style="font-size:14px;font-weight:500;color:#e5e7eb;margin-top:14px">Saved to Downloads</div>
    <div style="font-family:${MONO};font-size:10px;color:#6b7280;margin-top:5px">${shortName(doneInfo.filename)}</div>
    <div style="font-family:${MONO};font-size:10px;color:#383838;margin-top:3px">${clockStr(doneInfo.durationMs)} · ${
    shortName(doneInfo.filename).endsWith(".mp4") ? "H.264 + AAC" : "VP9 + Opus"
  }</div>${note}
    <button class="prim-b" data-act="done" style="margin-top:18px;padding:9px 28px;background:#22c55e;border:none;border-radius:8px;color:#000;font-size:12px;font-weight:600;cursor:pointer">Done</button>
  </div>`;
}

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  const phase = rec.phase || PHASE.IDLE;
  const recording = phase === PHASE.RECORDING;
  const converting = phase === PHASE.TRANSCODING || phase === PHASE.SAVING;
  const showTabs = phase === PHASE.IDLE && !doneInfo;

  let body;
  if (doneInfo) body = doneView();
  else if (converting) body = savingView();
  else if (recording) body = rec.source === SOURCE.VIDEO_CIRCLE ? recVideoCircle() : recRegular();
  else if (captured && localTab === "capture") body = capturedView();
  else if (localTab === "capture") body = captureTab();
  else body = recordTab();

  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.07)">
      ${wordmark()}${recording ? recBadge() : ""}
    </div>
    ${showTabs ? tabsBar() : ""}
    ${body}`;
  manageTimer();
}

function manageTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (rec.phase === PHASE.RECORDING && !rec.paused) {
    timer = setInterval(() => {
      const t = document.getElementById("timer");
      if (t) t.textContent = clockStr(elapsedMs(rec));
    }, 500);
  }
}

// ── actions ──────────────────────────────────────────────────────────────────
app.addEventListener("click", async (e) => {
  const node = e.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;

  if (act === "tab") {
    localTab = node.dataset.tab;
    captured = null;
    return render();
  }
  if (act === "toggle") {
    const key = node.dataset.key;
    settings = await setSettings({ [key]: !settings[key] });
    return render();
  }
  if (act === "cap") return doCapture(node.dataset.mode);
  if (act === "rec") return doRecord(node.dataset.src);
  if (act === "stop") return void send({ type: MSG.STOP_RECORDING });
  if (act === "discard") return void send({ type: MSG.CANCEL_RECORDING });
  if (act === "pause") return void send({ type: rec.paused ? MSG.RESUME_RECORDING : MSG.PAUSE_RECORDING });
  if (act === "bubble-pos") {
    bubPos = node.dataset.pos;
    send({ type: "bubble-pos", pos: bubPos });
    return render();
  }
  if (act === "annotate") {
    await send({ type: MSG.SHOT_ANNOTATE });
    window.close(); // editor opens on the page
    return;
  }
  if (act === "save") {
    await send({ type: MSG.SHOT_SAVE });
    captured = null;
    localTab = "capture";
    return render();
  }
  if (act === "copy") return doCopy(node);
  if (act === "shot-discard") {
    await send({ type: MSG.SHOT_DISCARD });
    captured = null;
    return render();
  }
  if (act === "done") {
    doneInfo = null;
    localTab = "record";
    return render();
  }
});

async function doCapture(mode) {
  capturing = mode;
  render();
  const typeMap = { visible: MSG.CAPTURE_VISIBLE, fullpage: MSG.CAPTURE_FULLPAGE, area: MSG.CAPTURE_AREA };
  let res;
  try {
    res = await send({ type: typeMap[mode] });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  capturing = null;
  if (res && res.captured) {
    captured = { thumb: res.thumb, filename: res.filename, width: res.width, height: res.height };
  } else if (res && !res.ok && res.error) {
    captured = null;
    render();
    return flashError(res.error);
  }
  render();
}

async function doRecord(src) {
  const options = { recordSource: src, withMic: !!settings.withMic, withSystemAudio: !!settings.withSystemAudio };
  let res;
  try {
    res = await send({ type: MSG.START_RECORDING, options });
  } catch (e) {
    return flashError(String((e && e.message) || e));
  }
  if (res && res.recorderWindow) return window.close(); // screen → recorder window takes over
  if (res && res.ok === false) return flashError(res.error || "Couldn't start recording");
  // tab / video-circle: recording state arrives via STATE_CHANGED
}

async function doCopy(btn) {
  const label = btn.querySelector("[data-copylabel]");
  try {
    const res = await send({ type: MSG.SHOT_COPY });
    if (!res || !res.dataUrl) throw new Error();
    const blob = await (await fetch(res.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (label) label.textContent = "Copied ✓";
  } catch {
    if (label) label.textContent = "Blocked";
  }
  if (label) setTimeout(() => (label.textContent = "Copy"), 1300);
}

function flashError(msg) {
  // lightweight inline error toast
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText =
    "position:fixed;left:12px;right:12px;bottom:12px;background:#ef4444;color:#fff;font-size:11px;font-family:'Geist',sans-serif;padding:8px 10px;border-radius:8px;text-align:center;z-index:9";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ── state sync ───────────────────────────────────────────────────────────────
function onState(state) {
  const next = state || { phase: PHASE.IDLE };
  const phase = next.phase || PHASE.IDLE;

  if (phase === PHASE.RECORDING) captured = null; // a recording supersedes a pending capture

  // recording finished → show the done card (only when something was actually saved)
  if (prevPhase && prevPhase !== PHASE.IDLE && phase === PHASE.IDLE) {
    if (next.error) flashError(next.error);
    else if (next.lastSaved) doneInfo = { filename: next.lastSaved, durationMs: next.recordedDurationMs, note: next.note };
    if (next.lastSaved || next.error) localTab = "record";
  }
  rec = next;
  prevPhase = phase;
  render();
}

async function init() {
  settings = await getSettings();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.STATE_CHANGED) onState(msg.state);
  });
  try {
    const res = await send({ type: MSG.GET_STATE });
    rec = res?.state || { phase: PHASE.IDLE };
    prevPhase = rec.phase || PHASE.IDLE;
  } catch {
    rec = { phase: PHASE.IDLE };
  }
  render();
}

init();
