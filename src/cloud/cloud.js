// Cloud setup window — owns the Google Drive connect/disconnect flow. Opened by the service
// worker (MSG.DRIVE_OPEN_SETUP) from the popup's settings tab or the editor's export menu. It is
// a real window, not a popup, because Google's consent window steals focus and an extension popup
// dies on blur; this page survives the whole dance and shows the outcome. Light theme, matching
// the popup's palette.
import { MSG, getSettings, setSettings } from "../lib/messages.js";
import { driveStatus, DRIVE_ORIGINS } from "../lib/drive.js";

const app = document.getElementById("app");
const send = (m) => chrome.runtime.sendMessage(m);

const C = {
  line: "#eef0f3", fg: "#18181b", fg2: "#3f3f46", muted: "#6b7280", faint: "#9aa0ab",
  box: "#f3f4f6", boxLine: "#e4e6eb",
  green: "#16a34a", greenTint: "rgba(22,163,74,0.08)", greenLine: "rgba(22,163,74,0.30)",
  red: "#dc2626",
};
const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let settings = {};
let drive = { supported: false, configured: false, connected: false, account: null };
let busy = false; // consent flow in flight
let err = "";

const check = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${C.green}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;
const cloudIcon = (c) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;

function toggle(on) {
  return `<div data-act="auto-toggle" style="width:38px;height:21px;border-radius:11px;background:${on ? C.green : "#d4d4d8"};cursor:pointer;position:relative;flex-shrink:0;transition:background .2s">
    <div style="position:absolute;width:15px;height:15px;border-radius:50%;background:#fff;top:3px;left:${on ? "20px" : "3px"};transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,0.25)"></div></div>`;
}
const bullet = (t) => `<div style="display:flex;gap:9px;align-items:flex-start;margin-bottom:9px">${check}<span style="flex:1;font-size:13px;line-height:1.5;color:${C.fg2}">${t}</span></div>`;

function body() {
  if (!drive.supported || !drive.configured) {
    return `<div style="font-size:13px;line-height:1.6;color:${C.muted}">Cloud backup isn't available in this build${drive.supported ? ", it needs a Google OAuth client id" : ""}.</div>`;
  }
  if (!drive.connected) {
    return `
      ${bullet("Finished recordings can upload themselves to a private <b>screensnap</b> folder in your own Google Drive.")}
      ${bullet("Straight from your browser to Google — no screensnap servers, no account with us, nothing to pay for.")}
      ${bullet("screensnap can only see files it created (Google's narrowest Drive permission), and you can disconnect anytime.")}
      <button class="prim" data-act="connect" ${busy ? "disabled" : ""} style="width:100%;margin-top:14px;padding:12px;background:${C.green};border:none;border-radius:9px;color:#fff;font-size:14px;font-weight:600;cursor:pointer">${busy ? "Waiting for Google sign-in…" : "Continue with Google"}</button>
      <div style="font-family:${MONO};font-size:11px;color:${busy ? C.muted : C.faint};margin-top:10px;text-align:center;min-height:16px">${busy ? "Finish the sign-in in the window that just opened." : "Nothing uploads until you turn it on."}</div>`;
  }
  return `
    <div style="display:flex;align-items:center;gap:9px;padding:12px 13px;border:1px solid ${C.greenLine};background:${C.greenTint};border-radius:10px">
      ${check}<div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:${C.fg}">Connected</div>
        <div style="font-family:${MONO};font-size:11px;color:${C.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(drive.account || "")}</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:11px;margin-top:16px">
      <div style="flex:1">
        <div style="font-size:14px;color:${C.fg}">Auto-upload recordings</div>
        <div style="font-size:12px;color:${C.muted};margin-top:2px">Every finished recording backs up on its own.</div>
      </div>${toggle(!!settings.driveAutoUpload)}
    </div>
    <div style="font-size:12px;line-height:1.5;color:${C.faint};margin-top:14px">Uploads land in the <b>screensnap</b> folder of this Drive, private to you. You can also upload single clips from the recording-done card or the editor's Export menu.</div>
    <button class="prim" data-act="done" style="width:100%;margin-top:18px;padding:11px;background:${C.green};border:none;border-radius:9px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Done</button>
    <button class="ghost" data-act="disconnect" style="width:100%;margin-top:8px;padding:9px;background:none;border:none;border-radius:8px;color:${C.faint};font-size:12px;cursor:pointer">Disconnect Google Drive</button>`;
}

function render() {
  app.innerHTML = `<div style="padding:22px 24px 24px">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:18px">
      <div style="width:30px;height:30px;border-radius:9px;background:#fff;border:1px solid ${C.boxLine};display:flex;align-items:center;justify-content:center">${cloudIcon(C.green)}</div>
      <div>
        <div style="font-size:15px;font-weight:600;letter-spacing:-0.02em;color:${C.fg}">Cloud setup</div>
        <div style="font-family:${MONO};font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:${C.faint}">screensnap<span style="color:${C.green}">.</span> google drive backup</div>
      </div>
    </div>
    ${body()}
    ${err ? `<div style="margin-top:12px;padding:9px 11px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.22);border-radius:8px;color:${C.red};font-size:12px;line-height:1.4">${esc(err)}</div>` : ""}
  </div>`;
}

app.addEventListener("click", async (e) => {
  const node = e.target.closest("[data-act]");
  if (!node) return;
  const act = node.dataset.act;
  if (act === "connect") return doConnect();
  if (act === "auto-toggle") { settings = await setSettings({ driveAutoUpload: !settings.driveAutoUpload }); return render(); }
  if (act === "disconnect") { err = ""; await send({ type: MSG.DRIVE_DISCONNECT }).catch(() => {}); return refresh(); }
  if (act === "done") return window.close();
});

async function doConnect() {
  err = "";
  busy = true;
  render();
  // googleapis host access is optional-but-recommended (a granted host permission makes the API
  // fetches immune to CORS quirks). Declining it is non-fatal — this click's gesture covers it.
  try { await chrome.permissions.request({ origins: DRIVE_ORIGINS }); } catch {}
  let res;
  try { res = await send({ type: MSG.DRIVE_CONNECT }); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  busy = false;
  if (!res || res.ok === false) err = (res && res.error) || "Google sign-in didn't complete.";
  await refresh();
}

async function refresh() {
  [settings, drive] = await Promise.all([getSettings(), driveStatus()]);
  render();
}
refresh();
