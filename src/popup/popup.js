// screensnap. popup — UI + message dispatch (light theme). Ports the screensnap design to vanilla
// DOM. All capture/record work happens in the service worker + offscreen document; the popup just
// reflects live state (GET_STATE / STATE_CHANGED) and can close at any time without interrupting.
import { MSG, PHASE, SOURCE, getSettings, setSettings, elapsedMs, fmtClock } from "../lib/messages.js";
import { driveStatus, DRIVE_ORIGINS } from "../lib/drive.js";

const app = document.getElementById("app");
const send = (m) => chrome.runtime.sendMessage(m);

let settings = {};
let localTab = "capture";
let rec = { phase: PHASE.IDLE };
let captured = null;
let doneInfo = null;
let capturing = null;
let bubPos = "br";
let drive = { supported: false, configured: false, connected: false, account: null };
let prevPhase = PHASE.IDLE;
let timer = null;

// light palette
const C = {
  line: "#eef0f3", fg: "#18181b", fg2: "#3f3f46", muted: "#6b7280", faint: "#9aa0ab", chev: "#c4c8d0",
  box: "#f3f4f6", boxLine: "#e4e6eb", icon: "#a1a7b3",
  green: "#16a34a", greenTint: "rgba(22,163,74,0.08)", greenLine: "rgba(22,163,74,0.30)", greenIcon: "rgba(22,163,74,0.10)", greenIconLine: "rgba(22,163,74,0.30)",
  red: "#dc2626", redTint: "rgba(220,38,38,0.08)", redLine: "rgba(220,38,38,0.22)", amber: "#d97706",
};
const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
const clockStr = (ms) => fmtClock((ms || 0) / 1000);
const shortName = (f) => (f || "").split("/").pop();
// Escape anything interpolated into innerHTML. Today these fields (filenames, notes) are all
// extension-controlled, but the popup is a privileged page — escape so a future state field that
// becomes page-influenced can't inject markup here.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

function wordmark() {
  return `<div style="display:flex;align-items:center;gap:9px">
    <div style="width:28px;height:28px;border-radius:8px;background:#fff;border:1px solid ${C.boxLine};display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="1" y="3" width="20" height="13" rx="2" stroke="${C.fg2}" stroke-width="1.6"/><circle cx="18.5" cy="6.5" r="3.5" fill="${C.green}"/><circle cx="18.5" cy="6.5" r="1.5" fill="#fff"/></svg>
    </div>
    <span style="font-weight:600;font-size:16px;letter-spacing:-0.025em;color:${C.fg}">screensnap<span style="color:${C.green}">.</span></span>
  </div>`;
}
function recBadge() {
  const paused = !!rec.paused;
  const dot = paused
    ? `<div style="width:6px;height:6px;border-radius:1px;background:${C.amber}"></div>`
    : `<div style="width:6px;height:6px;border-radius:50%;background:${C.red};animation:recPulse 1.2s ease-in-out infinite"></div>`;
  return `<div style="display:flex;align-items:center;gap:5px;background:${C.redTint};border:1px solid ${C.redLine};border-radius:999px;padding:4px 10px">
    ${dot}<span style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:${paused ? C.amber : C.red}">${paused ? "paused" : "rec"}</span></div>`;
}
function pingDot(s = 8) {
  return `<div style="position:relative;width:${s}px;height:${s}px;flex-shrink:0">
    <div style="position:absolute;inset:0;border-radius:50%;background:rgba(220,38,38,0.5);animation:pingRing 1.5s ease-out infinite"></div>
    <div style="position:absolute;inset:0;border-radius:50%;background:${C.red}"></div></div>`;
}
function tabsBar() {
  return `<div style="display:flex;padding:0 16px;border-bottom:1px solid ${C.line}">
    ${["capture", "record"]
      .map((t) => `<button class="tab-t" data-act="tab" data-tab="${t}" style="font-family:${MONO};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:${localTab === t ? C.fg : C.faint};background:none;border:none;padding:11px 0;margin-right:22px;cursor:pointer;border-bottom:2px solid ${localTab === t ? C.green : "transparent"};margin-bottom:-1px">${t}</button>`)
      .join("")}
  </div>`;
}
function toggle(on, key) {
  return `<div class="tg" data-act="toggle" data-key="${key}" style="width:38px;height:21px;border-radius:11px;background:${on ? C.green : "#d4d4d8"};cursor:pointer;position:relative;flex-shrink:0;transition:background .2s">
    <div style="position:absolute;width:15px;height:15px;border-radius:50%;background:#fff;top:3px;left:${on ? "20px" : "3px"};transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,0.25)"></div></div>`;
}
function camCircle(size, paused, hidden) {
  if (hidden) {
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;position:relative;overflow:hidden;border:2px solid ${C.boxLine};background:${C.box};display:flex;align-items:center;justify-content:center" title="Camera hidden">
      <svg width="${Math.round(size * 0.4)}" height="${Math.round(size * 0.4)}" viewBox="0 0 24 24" fill="none" stroke="${C.faint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="M23 7l-7 5 7 5V7z"/><line x1="1" y1="1" x2="23" y2="23"/></svg></div>`;
  }
  const overlay = paused
    ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.48)">${ico("pause", { sz: Math.round(size * 0.28), c: "rgba(255,255,255,0.75)" })}</div>`
    : `<div style="position:absolute;top:5px;right:5px;width:7px;height:7px;border-radius:50%;background:${C.red};animation:recPulse 1.2s ease-in-out infinite"></div>`;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;position:relative;overflow:hidden;border:2px solid ${C.greenLine};box-shadow:0 0 0 3px ${C.greenTint}">
    <div style="position:absolute;inset:0;background:radial-gradient(circle at 42% 38%,#243824 0%,#0d1a0d 55%,#050505 100%)"></div>
    <div style="position:absolute;top:${Math.round(size * 0.16)}px;left:50%;transform:translateX(-50%);width:${Math.round(size * 0.38)}px;height:${Math.round(size * 0.38)}px;border-radius:50%;background:rgba(255,255,255,0.13)"></div>
    <div style="position:absolute;bottom:-4px;left:-4px;right:-4px;height:${Math.round(size * 0.48)}px;border-radius:50% 50% 0 0;background:rgba(255,255,255,0.08)"></div>${overlay}</div>`;
}

// One row style shared by both tabs so Capture and Record look identical.
function navRow(attrs, icon, label, desc, hot) {
  return `<div class="rb" ${attrs} style="display:flex;align-items:center;gap:13px;padding:14px;border:1px solid ${hot ? C.greenLine : C.boxLine};border-radius:11px;margin:0 14px 9px;cursor:pointer;background:${hot ? C.greenTint : "#fff"}">
    <div style="width:40px;height:40px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${hot ? C.greenIcon : C.box};border:1px solid ${hot ? C.greenIconLine : C.boxLine}">${ico(icon, { sz: 17, c: hot ? C.green : C.icon })}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:500;color:${C.fg};margin-bottom:3px">${label}</div>
      <div style="font-family:${MONO};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:0.05em">${desc}</div>
    </div>${ico("chev", { sz: 14, c: C.chev })}</div>`;
}
function captureTab() {
  return `<div style="padding-top:13px">
    ${navRow(`data-act="cap" data-mode="visible"`, "camera", "Visible Tab", capturing === "visible" ? "Capturing…" : "PNG · instant", capturing === "visible")}
    ${navRow(`data-act="cap" data-mode="fullpage"`, "page", "Full Page", capturing === "fullpage" ? "Capturing…" : "PNG · scroll + stitch", capturing === "fullpage")}
  </div>`;
}
function audioRow(icon, label, key) {
  return `<div style="display:flex;align-items:center;gap:11px;margin-bottom:${key === "withSystemAudio" ? "11px" : "0"}">
    ${ico(icon, { sz: 15, c: C.icon })}<span style="flex:1;font-size:14px;color:${C.fg2}">${label}</span>${toggle(!!settings[key], key)}</div>`;
}
const sectionLabel = (t) => `<div style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${C.faint};margin-bottom:11px">${t}</div>`;
// Segmented control bound to a setting key. opts = [[value, label], …]; active = current setting value.
function segmented(key, opts) {
  return `<div style="display:flex;gap:6px">${opts
    .map(([val, label]) => {
      const on = String(settings[key]) === String(val);
      return `<button data-act="set" data-key="${key}" data-val="${val}" style="flex:1;padding:7px 0;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;border:1px solid ${on ? C.greenLine : C.boxLine};background:${on ? C.greenTint : "#fff"};color:${on ? C.green : C.fg2}">${label}</button>`;
    })
    .join("")}</div>`;
}
function recordTab() {
  return `<div style="padding-top:13px;padding-bottom:5px">
    ${navRow(`data-act="rec" data-src="tab"`, "tab", "Current Tab", "No picker · tab audio", false)}
    ${navRow(`data-act="rec" data-src="screen"`, "monitor", "Screen / Window", "Whole screen or any app", false)}
    ${navRow(`data-act="rec" data-src="videocircle"`, "video", "Screen + Cam", "Picker · webcam corner", false)}
    <div style="padding:13px 16px;border-top:1px solid ${C.line};margin-top:5px">
      ${sectionLabel("Audio")}
      ${audioRow("vol", "System audio", "withSystemAudio")}
      ${audioRow("mic", "Microphone", "withMic")}
    </div>
    <div style="padding:13px 16px;border-top:1px solid ${C.line}">
      ${sectionLabel("Countdown")}
      ${segmented("countdownSec", [[0, "Off"], [3, "3s"], [5, "5s"], [10, "10s"]])}
    </div>
    <div style="padding:13px 16px;border-top:1px solid ${C.line}">
      ${sectionLabel("Camera bubble")}
      <div style="margin-bottom:8px">${segmented("bubbleShape", [["circle", "● Circle"], ["square", "▢ Square"]])}</div>
      ${segmented("bubbleSize", [["sm", "Small"], ["md", "Medium"], ["lg", "Large"]])}
      <div style="display:flex;align-items:center;gap:11px;margin-top:11px">
        <span style="flex:1;font-size:13px;color:${C.fg2}">Mirror camera</span>${toggle(!!settings.camMirror, "camMirror")}
      </div>
    </div>
    ${driveSection()}
  </div>`;
}
// Opt-in Google Drive backup. Hidden entirely where the OAuth flow can't run (the Firefox build);
// shows a maintainer hint until an OAuth client id is wired up (docs/DRIVE_SETUP.md). Everything
// stays local unless the user connects here.
function driveSection() {
  if (!drive.supported) return "";
  let body;
  if (!drive.configured) {
    body = `<div style="font-size:12px;line-height:1.5;color:${C.muted}">Not available in this build — it needs a Google OAuth client id (see docs/DRIVE_SETUP.md).</div>`;
  } else if (!drive.connected) {
    body = `<button class="ghost-b" data-act="drive-connect" style="width:100%;padding:10px;background:#fff;border:1px solid ${C.boxLine};border-radius:9px;color:${C.fg};font-size:13px;font-weight:500;cursor:pointer">Connect Google Drive</button>
      <div style="font-size:11px;line-height:1.5;color:${C.faint};margin-top:8px">Optional. Uploads go to a private screensnap folder in your own Drive — no other servers involved.</div>`;
  } else {
    body = `<div style="display:flex;align-items:center;gap:11px;margin-bottom:11px">
        <span style="flex:1;font-size:14px;color:${C.fg2}">Auto-upload recordings</span>${toggle(!!settings.driveAutoUpload, "driveAutoUpload")}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};font-size:11px;color:${C.muted}">${esc(drive.account || "")}</span>
        <button class="ghost-b" data-act="drive-disconnect" style="padding:5px 10px;background:none;border:none;color:${C.faint};font-size:12px;cursor:pointer;border-radius:6px;flex-shrink:0">Disconnect</button>
      </div>`;
  }
  return `<div style="padding:13px 16px;border-top:1px solid ${C.line}">${sectionLabel("Google Drive backup")}${body}</div>`;
}
function capturedView() {
  return `<div style="padding:14px 16px 18px">
    <div style="width:100%;height:130px;border-radius:9px;overflow:hidden;border:1px solid ${C.boxLine};margin-bottom:11px;background:${C.box};display:flex;align-items:center;justify-content:center">
      <img src="${captured.thumb}" alt="" style="max-width:100%;max-height:100%;object-fit:contain;display:block"/>
    </div>
    <div style="font-family:${MONO};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:13px;text-align:center">${esc(shortName(captured.filename))} · ${captured.width}×${captured.height}</div>
    <button class="prim-b" data-act="annotate" style="width:100%;padding:12px;background:${C.green};border:none;border-radius:9px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:9px">${ico("pencil", { sz: 14, c: "#fff" })}Annotate &amp; save</button>
    <button class="ghost-b" data-act="save" style="width:100%;padding:11px;background:#fff;border:1px solid ${C.boxLine};border-radius:9px;color:${C.fg};font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:9px">${ico("down", { sz: 14, c: C.muted })}Save PNG directly</button>
    <div style="display:flex;gap:8px">
      <button class="ghost-b" data-act="copy" style="flex:1;padding:9px;background:#fff;border:1px solid ${C.boxLine};border-radius:8px;color:${C.fg2};font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px">${ico("copy", { sz: 12, c: C.muted })}<span data-copylabel>Copy</span></button>
      <button class="ghost-b" data-act="shot-discard" style="flex:1;padding:9px;background:#fff;border:1px solid ${C.boxLine};color:${C.muted};font-size:12px;cursor:pointer;border-radius:8px">Discard</button>
    </div>
  </div>`;
}
const codecLabel = () => ((rec.mime || "").includes("mp4") ? "MP4 · H.264" : "WebM · VP9");
const srcName = () => (rec.source === SOURCE.VIDEO_CIRCLE ? "Screen + Cam" : rec.source === SOURCE.SCREEN ? "Screen" : "Current tab");
function audioChips() {
  const chip = (l) => `<span style="font-family:${MONO};font-size:10px;color:${C.green};background:${C.greenTint};border:1px solid ${C.greenLine};border-radius:5px;padding:3px 8px">${l}</span>`;
  const chips = [];
  if (rec.withSystemAudio) chips.push(chip("sys audio"));
  if (rec.withMic) chips.push(chip("mic"));
  return chips.length ? `<div style="display:flex;gap:5px;margin-top:11px">${chips.join("")}</div>` : "";
}
function recRegular() {
  return `<div style="padding:30px 20px 22px;display:flex;flex-direction:column;align-items:center">
    <div id="timer" style="font-family:${MONO};font-size:46px;font-weight:500;letter-spacing:-0.04em;line-height:1;color:${rec.paused ? C.faint : C.fg}">${clockStr(elapsedMs(rec))}</div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:11px">
      ${rec.paused ? `<span style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:${C.faint}">Paused</span>` : `${pingDot()}<span style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:${C.muted}">${srcName()} · ${codecLabel()}</span>`}
    </div>
    ${audioChips()}
    <button class="stop-b" data-act="stop" style="margin-top:22px;width:100%;padding:13px;background:${C.redTint};border:1px solid ${C.redLine};border-radius:10px;color:${C.red};font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">${ico("stop", { sz: 13, c: C.red })}Stop &amp; save as MP4</button>
    <div style="display:flex;gap:18px;margin-top:10px">
      <button class="ghost-b" data-act="pause" style="padding:6px 12px;background:none;border:none;color:${C.fg2};font-size:12px;cursor:pointer;border-radius:7px;display:flex;align-items:center;gap:6px">${rec.paused ? `${ico("play", { sz: 11, c: C.green })}Resume` : `${ico("pause", { sz: 11, c: "currentColor" })}Pause`}</button>
      <button class="ghost-b" data-act="discard" style="padding:6px 12px;background:none;border:none;color:${C.faint};font-size:12px;cursor:pointer;border-radius:7px">Discard</button>
    </div>
  </div>`;
}
function recVideoCircle() {
  const grid = [["tl", "↖"], ["tr", "↗"], ["bl", "↙"], ["br", "↘"]]
    .map(([pos, arrow]) => `<div data-act="bubble-pos" data-pos="${pos}" style="height:30px;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;background:${bubPos === pos ? C.greenTint : C.box};border:1px solid ${bubPos === pos ? C.greenLine : C.boxLine}"><span style="font-size:12px;color:${C.fg2}">${arrow}</span><div style="width:5px;height:5px;border-radius:50%;background:${bubPos === pos ? C.green : "#cbd0d8"}"></div></div>`)
    .join("");
  const curSize = settings.bubbleSize || "md";
  const sizes = [["sm", "S"], ["md", "M"], ["lg", "L"]]
    .map(([sz, l]) => { const on = curSize === sz; return `<button data-act="bubble-size" data-size="${sz}" style="flex:1;padding:7px 0;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;border:1px solid ${on ? C.greenLine : C.boxLine};background:${on ? C.greenTint : "#fff"};color:${on ? C.green : C.fg2}">${l}</button>`; })
    .join("");
  return `<div style="padding:18px 16px;display:flex;flex-direction:column;gap:15px">
    <div style="display:flex;align-items:center;gap:14px">
      ${camCircle(66, rec.paused, rec.camHidden)}
      <div style="flex:1">
        <div id="timer" style="font-family:${MONO};font-size:34px;font-weight:500;letter-spacing:-0.035em;line-height:1;color:${rec.paused ? C.faint : C.fg}">${clockStr(elapsedMs(rec))}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
          ${rec.paused ? `<span style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:${C.faint}">Paused</span>` : `${pingDot(7)}<span style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.09em;color:${C.muted}">${srcName()} · ${codecLabel()}</span>`}
        </div>
        ${audioChips()}
      </div>
    </div>
    ${rec.camIsPip
      ? `<div style="display:flex;align-items:center;gap:9px;padding:11px 13px;border:1px solid ${C.boxLine};border-radius:10px;background:${C.box}">
          ${ico("monitor", { sz: 15, c: C.muted })}<span style="font-size:12px;line-height:1.4;color:${C.muted}">Your camera is the floating window — drag &amp; resize it on screen to place it.</span>
        </div>`
      : `<div style="display:flex;gap:16px">
      <div>
        <div style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${C.faint};margin-bottom:8px">Position</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;width:88px">${grid}</div>
      </div>
      <div style="flex:1">
        <div style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${C.faint};margin-bottom:8px">Size</div>
        <div style="display:flex;gap:5px">${sizes}</div>
      </div>
    </div>`}
    <div style="display:flex;gap:9px">
      <button class="ghost-b" data-act="pause" style="flex:1;padding:11px;background:#fff;border:1px solid ${C.boxLine};border-radius:10px;color:${C.fg};font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px">${rec.paused ? `${ico("play", { sz: 12, c: C.green })}Resume` : `${ico("pause", { sz: 12, c: "currentColor" })}Pause`}</button>
      <button class="stop-b" data-act="stop" style="flex:1;padding:11px;background:${C.redTint};border:1px solid ${C.redLine};border-radius:10px;color:${C.red};font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px">${ico("stop", { sz: 12, c: C.red })}Stop</button>
    </div>
    <button class="ghost-b" data-act="discard" style="align-self:center;padding:5px 12px;background:none;border:none;color:${C.faint};font-size:12px;cursor:pointer;border-radius:6px">Discard</button>
  </div>`;
}
function savingView() {
  return `<div style="padding:38px 20px 32px;display:flex;flex-direction:column;align-items:center;gap:11px">
    <div style="font-family:${MONO};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:${C.muted}">Finalizing · ${clockStr(rec.recordedDurationMs)} recorded</div>
    <div style="width:100%;height:4px;background:${C.box};border-radius:2px;overflow:hidden">
      <div style="height:100%;width:42%;background:${C.green};border-radius:2px;position:relative;overflow:hidden">
        <div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.6),transparent);animation:shimmer 1.2s ease-in-out infinite"></div>
      </div>
    </div>
    <div style="font-family:${MONO};font-size:11px;color:${C.faint};text-transform:uppercase;letter-spacing:0.05em">Writing native MP4 to Downloads…</div>
  </div>`;
}
// The Drive line on the done card: live upload progress / result from state.drive, or a manual
// "Upload to Drive" button when connected and no upload has been attempted for this take.
function driveDoneRow() {
  const d = rec.drive;
  const line = (color, text) => `<div style="font-family:${MONO};font-size:11px;color:${color};margin-top:9px;text-align:center;max-width:260px">${text}</div>`;
  if (d && d.status === "uploading") return line(C.muted, `Uploading to Drive… ${d.pct || 0}%`);
  if (d && d.status === "done") return line(C.green, `Uploaded to Drive ✓${d.link ? ` &nbsp;<a href="${esc(d.link)}" target="_blank" style="color:${C.muted}">Open</a>` : ""}`);
  if (d && d.status === "error") return line(C.red, `Drive upload failed — ${esc(d.error || "unknown error")}`);
  if (drive.connected && drive.configured && doneInfo.clipId) {
    return `<button class="ghost-b" data-act="drive-upload" style="margin-top:12px;padding:8px 18px;background:#fff;border:1px solid ${C.boxLine};border-radius:9px;color:${C.fg2};font-size:12px;font-weight:500;cursor:pointer">Upload to Drive</button>`;
  }
  return "";
}
function doneView() {
  const note = doneInfo.note ? `<div style="font-family:${MONO};font-size:11px;color:${C.amber};margin-top:7px;text-align:center;max-width:260px">${esc(doneInfo.note)}</div>` : "";
  return `<div style="padding:38px 20px 30px;display:flex;flex-direction:column;align-items:center">
    <div style="width:46px;height:46px;border-radius:50%;background:${C.greenTint};border:1px solid ${C.greenLine};display:flex;align-items:center;justify-content:center">${ico("check", { sz: 22, c: C.green })}</div>
    <div style="font-size:15px;font-weight:500;color:${C.fg};margin-top:15px">Saved to Downloads</div>
    <div style="font-family:${MONO};font-size:11px;color:${C.muted};margin-top:6px">${esc(shortName(doneInfo.filename))}</div>
    <div style="font-family:${MONO};font-size:11px;color:${C.faint};margin-top:3px">${clockStr(doneInfo.durationMs)} · ${shortName(doneInfo.filename).endsWith(".mp4") ? "H.264 + AAC" : "VP9 + Opus"}</div>${note}${driveDoneRow()}
    <button class="prim-b" data-act="done" style="margin-top:20px;padding:11px 30px;background:${C.green};border:none;border-radius:9px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Done</button>
    ${doneInfo.clipId ? `<button class="ghost-b" data-act="edit-video" style="margin-top:10px;padding:9px 22px;background:#fff;border:1px solid ${C.boxLine};border-radius:9px;color:${C.fg};font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:7px">${ico("video", { sz: 13, c: C.muted })}Edit video</button>` : ""}
  </div>`;
}

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

  app.innerHTML = `<div class="sheet">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid ${C.line}">
      ${wordmark()}${recording ? recBadge() : ""}
    </div>
    ${showTabs ? tabsBar() : ""}
    ${body}
  </div>`;
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

app.addEventListener("click", async (e) => {
  const node = e.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;
  if (act === "tab") { localTab = node.dataset.tab; captured = null; return render(); }
  if (act === "toggle") { const k = node.dataset.key; settings = await setSettings({ [k]: !settings[k] }); return render(); }
  if (act === "cap") return doCapture(node.dataset.mode);
  if (act === "rec") return doRecord(node.dataset.src);
  if (act === "stop") return void send({ type: MSG.STOP_RECORDING });
  if (act === "discard") return void send({ type: MSG.CANCEL_RECORDING });
  if (act === "pause") return void send({ type: rec.paused ? MSG.RESUME_RECORDING : MSG.PAUSE_RECORDING });
  if (act === "set") { const k = node.dataset.key; let v = node.dataset.val; if (v !== "" && !isNaN(v)) v = Number(v); settings = await setSettings({ [k]: v }); return render(); }
  if (act === "bubble-pos") { bubPos = node.dataset.pos; send({ type: MSG.SET_BUBBLE, pos: bubPos }); return render(); }
  if (act === "bubble-size") { settings.bubbleSize = node.dataset.size; send({ type: MSG.SET_BUBBLE, size: node.dataset.size }); return render(); }
  if (act === "annotate") { await send({ type: MSG.SHOT_ANNOTATE }); window.close(); return; }
  if (act === "save") { await send({ type: MSG.SHOT_SAVE }); captured = null; localTab = "capture"; return render(); }
  if (act === "copy") return doCopy(node);
  if (act === "shot-discard") { await send({ type: MSG.SHOT_DISCARD }); captured = null; return render(); }
  if (act === "done") { doneInfo = null; localTab = "record"; return render(); }
  if (act === "edit-video") { if (doneInfo && doneInfo.clipId) send({ type: MSG.EDITOR_OPEN_CLIP, clipId: doneInfo.clipId }); window.close(); return; }
  if (act === "drive-connect") return doDriveConnect(node);
  if (act === "drive-disconnect") { await send({ type: MSG.DRIVE_DISCONNECT }).catch(() => {}); drive = await driveStatus(); return render(); }
  if (act === "drive-upload") {
    node.textContent = "Starting…";
    node.style.pointerEvents = "none"; // progress takes over via STATE_CHANGED → rec.drive
    send({ type: MSG.DRIVE_UPLOAD_CLIP, clipId: doneInfo && doneInfo.clipId, fileName: doneInfo && doneInfo.filename });
    return;
  }
});

// Connect Google Drive: the optional identity permission + googleapis host need this click's
// gesture; the consent window then steals focus and closes the popup, so the service worker owns
// the rest of the flow — the next popup open (or this one, if it survives) shows the account.
async function doDriveConnect(btn) {
  try {
    const granted = await chrome.permissions.request({ permissions: ["identity"], origins: DRIVE_ORIGINS });
    if (!granted) return flashError("Google Drive needs those permissions to connect.");
  } catch (e) {
    return flashError(String((e && e.message) || e));
  }
  btn.textContent = "Opening Google sign-in…";
  try {
    const res = await send({ type: MSG.DRIVE_CONNECT });
    if (res && res.ok === false) return flashError(res.error || "Couldn't connect Google Drive.");
    drive = await driveStatus();
    render();
  } catch (e) {
    flashError(String((e && e.message) || e));
  }
}

async function doCapture(mode) {
  capturing = mode;
  render();
  const typeMap = { visible: MSG.CAPTURE_VISIBLE, fullpage: MSG.CAPTURE_FULLPAGE };
  let res;
  try { res = await send({ type: typeMap[mode] }); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  capturing = null;
  if (res && res.captured) captured = { thumb: res.thumb, filename: res.filename, width: res.width, height: res.height };
  else if (res && !res.ok && res.error) { captured = null; render(); return flashError(res.error); }
  render();
}
async function doRecord(src) {
  // Mic permission is handled by the service worker (it opens a dedicated page that can prompt — an
  // extension popup can't reliably prompt, it closes when the prompt steals focus). The on-page
  // control + countdown also live on the tab, so the popup can close freely after this.
  const options = { recordSource: src, withMic: !!settings.withMic, withSystemAudio: !!settings.withSystemAudio };
  // Only Current Tab capture relies on on-page overlays (control bar + pen) that need re-injecting after you
  // navigate to a *different* website mid-recording — which requires all-sites access. Ask once here (this
  // click's gesture); declining is fine (overlays then reappear on same-site reloads only, and the keyboard
  // shortcuts / toolbar still stop the recording everywhere). Granted once, it persists. Screen / Screen+Cam
  // are driven by Chrome's native picker and controlled from the toolbar / popup / shortcuts — no page access.
  if (src === SOURCE.TAB) {
    try {
      if (!(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) {
        await chrome.permissions.request({ origins: ["<all_urls>"] });
      }
    } catch {}
  }
  let res;
  try { res = await send({ type: MSG.START_RECORDING, options }); } catch (e) { return flashError(String((e && e.message) || e)); }
  if (res && res.ok === false) return flashError(res.error || "Couldn't start recording");
}
async function doCopy(btn) {
  const label = btn.querySelector("[data-copylabel]");
  try {
    const res = await send({ type: MSG.SHOT_COPY });
    if (!res || !res.dataUrl) throw new Error();
    const blob = await (await fetch(res.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (label) label.textContent = "Copied ✓";
  } catch { if (label) label.textContent = "Blocked"; }
  if (label) setTimeout(() => (label.textContent = "Copy"), 1300);
}
function flashError(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `position:fixed;left:12px;right:12px;bottom:12px;background:${C.red};color:#fff;font-size:12px;font-family:'Geist',sans-serif;padding:9px 11px;border-radius:9px;text-align:center;z-index:9`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function onState(state) {
  const next = state || { phase: PHASE.IDLE };
  const phase = next.phase || PHASE.IDLE;
  if (phase === PHASE.RECORDING) captured = null;
  if (prevPhase && prevPhase !== PHASE.IDLE && phase === PHASE.IDLE) {
    if (next.error) flashError(next.error);
    else if (next.lastSaved) doneInfo = { filename: next.lastSaved, durationMs: next.recordedDurationMs, note: next.note, clipId: next.clipId || null };
    if (next.lastSaved || next.error) localTab = "record";
  }
  rec = next;
  prevPhase = phase;
  render();
}

async function init() {
  settings = await getSettings();
  drive = await driveStatus().catch(() => drive);
  bubPos = settings.bubbleCorner || "br";
  chrome.runtime.onMessage.addListener((msg, sender) => { if (sender.id === chrome.runtime.id && msg && msg.type === MSG.STATE_CHANGED) onState(msg.state); });
  try {
    const res = await send({ type: MSG.GET_STATE });
    rec = res?.state || { phase: PHASE.IDLE };
    prevPhase = rec.phase || PHASE.IDLE;
  } catch { rec = { phase: PHASE.IDLE }; }
  render();
}
init();
