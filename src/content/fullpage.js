// Page-injected helpers for full-page screenshots.
//
// These run in the page (via chrome.scripting.executeScript({func})), so each function MUST be
// fully self-contained: no imports, no closure variables, only its arguments + DOM globals.
// State that must survive between injections is stashed on `window.__screensnapFullpage` (the
// extension's isolated world persists across executeScript calls in the same frame).
//
// The service worker calls: preparePageForCapture() -> gotoTile() per tile -> restorePageAfterCapture().

export function preparePageForCapture() {
  const de = document.documentElement;
  const body = document.body;

  const state = { scrollX: window.scrollX, scrollY: window.scrollY, sticky: [], styleEl: null };

  // Hide scrollbars without changing layout/scroll metrics.
  const style = document.createElement("style");
  style.textContent =
    "::-webkit-scrollbar{display:none !important} html{scrollbar-width:none !important}";
  (document.head || de).appendChild(style);
  state.styleEl = style;

  // Record fixed/sticky elements so we can hide them on tiles after the first (avoids the
  // classic "header repeated down the whole screenshot" artifact).
  for (const el of document.querySelectorAll("*")) {
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") state.sticky.push({ el, visibility: el.style.visibility });
  }

  window.__screensnapFullpage = state;

  const pageW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0, de.clientWidth);
  const pageH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, de.clientHeight);
  return { pageW, pageH, viewW: de.clientWidth, viewH: de.clientHeight, dpr: window.devicePixelRatio || 1 };
}

export function gotoTile(x, y, hideSticky) {
  const state = window.__screensnapFullpage;
  if (state) {
    for (const s of state.sticky) s.el.style.visibility = hideSticky ? "hidden" : s.visibility || "";
  }
  window.scrollTo(x, y);
  // Return the *actual* scroll position (browsers clamp at the page edges).
  return { scrollX: window.scrollX, scrollY: window.scrollY };
}

export function restorePageAfterCapture() {
  const state = window.__screensnapFullpage;
  if (!state) return;
  for (const s of state.sticky) s.el.style.visibility = s.visibility || "";
  if (state.styleEl && state.styleEl.parentNode) state.styleEl.parentNode.removeChild(state.styleEl);
  window.scrollTo(state.scrollX, state.scrollY);
  delete window.__screensnapFullpage;
}
