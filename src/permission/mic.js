// Microphone permission page. Opened in a small window by the service worker because an extension
// popup can't reliably show the prompt (it closes when the prompt steals focus). The grant is for
// the extension origin, so the offscreen document's getUserMedia(mic) works afterwards. Reports the
// result back to the service worker and closes itself.
const status = document.getElementById("status");
const report = (granted) => { try { chrome.runtime.sendMessage({ type: "mic-permission-result", granted }); } catch {} };

(async () => {
  // Already granted (e.g. the cached flag was cleared) — confirm and close fast, no second prompt.
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    if (p.state === "granted") { report(true); status.textContent = "Microphone enabled."; return setTimeout(() => window.close(), 200); }
  } catch {}

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
    report(true);
    status.textContent = "Microphone enabled.";
  } catch {
    report(false);
    status.textContent = "Microphone blocked — recording will continue without it.";
  }
  setTimeout(() => window.close(), 700);
})();
