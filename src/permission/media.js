// Microphone / camera permission page. Opened in a small window by the service worker because an extension
// popup can't reliably show the prompt (it closes when the prompt steals focus). The grant is for the
// extension origin, so the offscreen document's getUserMedia(mic/cam) works afterwards. Which kind to
// request comes from ?kind=mic|cam. Reports the result back to the service worker and closes itself.
const kind = new URLSearchParams(location.search).get("kind") === "cam" ? "cam" : "mic";
const isCam = kind === "cam";
const status = document.getElementById("status");
const report = (granted) => { try { chrome.runtime.sendMessage({ type: "media-permission-result", kind, granted }); } catch {} };

document.getElementById("title").textContent = isCam ? "Allow camera access" : "Allow microphone access";
document.getElementById("desc").innerHTML = isCam
  ? "screensnap shows your webcam as a corner bubble in the recording — all local. Click <b>Allow</b> in the prompt — this window closes itself."
  : "screensnap records your mic locally so it can be added to your recordings. Click <b>Allow</b> in the prompt — this window closes itself.";
document.getElementById("icon-mic").style.display = isCam ? "none" : "";
document.getElementById("icon-cam").style.display = isCam ? "" : "none";

const labelOk = isCam ? "Camera enabled." : "Microphone enabled.";
const labelNo = isCam ? "Camera blocked — recording will continue without it." : "Microphone blocked — recording will continue without it.";

(async () => {
  // Already granted (e.g. the cached flag was cleared) — confirm and close fast, no second prompt.
  try {
    const p = await navigator.permissions.query({ name: isCam ? "camera" : "microphone" });
    if (p.state === "granted") { report(true); status.textContent = labelOk; return setTimeout(() => window.close(), 200); }
  } catch {}

  try {
    const stream = await navigator.mediaDevices.getUserMedia(isCam ? { video: true } : { audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
    report(true);
    status.textContent = labelOk;
  } catch {
    report(false);
    status.textContent = labelNo;
  }
  setTimeout(() => window.close(), 700);
})();
