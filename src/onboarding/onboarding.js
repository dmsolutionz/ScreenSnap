// First-run welcome page. Lets the user grant "all sites" access up front (the click is the user gesture
// chrome.permissions.request requires — it can't be requested silently at install), so recordings never
// hit a mid-flow permission prompt. Declining is fine: the popup re-requests at record-start if needed.
const allowBtn = document.getElementById("allow");
const laterBtn = document.getElementById("later");
const status = document.getElementById("status");

function showGranted() {
  status.style.display = "inline";
  allowBtn.disabled = true;
  allowBtn.textContent = "Allowed ✓";
}

// Reflect prior state (e.g. reinstall, or the user already granted it).
chrome.permissions.contains({ origins: ["<all_urls>"] }, (has) => {
  if (!chrome.runtime.lastError && has) showGranted();
});

allowBtn.addEventListener("click", () => {
  chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => {
    if (!chrome.runtime.lastError && granted) showGranted();
  });
});

laterBtn.addEventListener("click", () => {
  // Close this tab; the permission can still be requested later at record time or re-granted here.
  chrome.tabs.getCurrent((tab) => { if (tab && tab.id != null) chrome.tabs.remove(tab.id); else window.close(); });
});
