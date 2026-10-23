// Page-injected helpers for full-page screenshots.
//
// These run in the page (via chrome.scripting.executeScript({func})), so each function MUST be
// fully self-contained: no imports, no closure variables, only its arguments + DOM globals.
// State that must survive between injections is stashed on `window.__screensnapFullpage` (the
// extension's isolated world persists across executeScript calls in the same frame).
//
// The service worker calls: preparePageForCapture() -> gotoTile() per tile -> restorePageAfterCapture().
//
// Two modes. "window": the document scrolls, so we scroll the window tile by tile (the classic case).
// "element": the document itself doesn't scroll but an inner box does — web apps like Gmail, Slack, Notion,
// dashboards, and pages that make <body> the scroller. There we scroll that element instead and the service
// worker stitches only its box, keeping the page shell (header, sidebars, footer) from the first tile.

export function preparePageForCapture() {
  const de = document.documentElement;
  const state = { scrollX: window.scrollX, scrollY: window.scrollY, hidden: [], styleEl: null, scroller: null, scrollerTop: 0 };

  // Hide scrollbars without changing layout/scroll metrics, and force instant scrolling: a page with
  // `scroll-behavior: smooth` (Bootstrap, Tailwind's scroll-smooth) otherwise animates every scrollTo, so the
  // position we read back is the OLD one and every tile after the first is dropped as a duplicate.
  // scrollbar-width is set too because Chrome ignores ::-webkit-scrollbar on elements that set it.
  const style = document.createElement("style");
  style.textContent =
    "::-webkit-scrollbar{display:none !important} *{scrollbar-width:none !important;scroll-behavior:auto !important}";
  (document.head || de).appendChild(style);
  state.styleEl = style;

  // Viewport from window.inner*, not documentElement.client*: in quirks mode (no <!DOCTYPE>) the latter is
  // the whole document's height, which made a long page look like a single tile. Scrollbars are hidden
  // above, so inner* is exactly the visible area.
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  // How far can the window really scroll? Probe instead of trusting scrollHeight: with
  // `html,body{height:100%} body{overflow:auto}` body.scrollHeight is huge but the window can't move, and an
  // overflow-x:hidden page can report a scrollWidth it will never scroll to.
  window.scrollTo({ left: 1e7, top: 1e7, behavior: "instant" });
  const maxX = Math.max(0, Math.round(window.scrollX));
  const maxY = Math.max(0, Math.round(window.scrollY));
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });

  // Find the biggest visible vertical scroller. It must sit fully inside the viewport vertically (we stitch
  // its on-screen box) and be big enough to be "the page" rather than a code block or a dropdown.
  let best = null, bestArea = 0, bestBox = null;
  for (const el of document.querySelectorAll("*")) {
    if (el === de || el.clientHeight < 120 || el.scrollHeight - el.clientHeight < 16) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
    const r = el.getBoundingClientRect();
    const top = r.top + el.clientTop, left = r.left + el.clientLeft;
    if (top < -1 || top + el.clientHeight > viewH + 1) continue;
    const x0 = Math.max(0, left), x1 = Math.min(viewW, left + el.clientWidth);
    const area = (x1 - x0) * el.clientHeight;
    if (x1 - x0 >= 120 && area > bestArea) { best = el; bestArea = area; bestBox = { x: x0, y: Math.max(0, top), w: x1 - x0, h: el.clientHeight }; }
  }

  window.__screensnapFullpage = state;

  // Prefer the inner scroller only when it has more to reveal than the window does — a normal article with
  // a scrollable sidebar keeps the window mode it always had.
  const innerExtent = best ? best.scrollHeight - best.clientHeight : 0;
  if (best && bestArea >= 0.2 * viewW * viewH && innerExtent > maxY) {
    state.scroller = best;
    state.scrollerTop = best.scrollTop;
    best.scrollTo({ top: 0, behavior: "instant" });
    return { mode: "element", viewW, viewH, dpr, rect: bestBox, maxTop: Math.round(innerExtent) };
  }
  return { mode: "window", pageW: viewW + maxX, pageH: viewH + maxY, viewW, viewH, dpr };
}

// Scroll to a tile and report where we actually landed (browsers clamp at the edges). Async: we wait for the
// page to react to the scroll before (re)scanning for fixed/sticky elements, because many headers only switch
// to position:fixed from a scroll handler — a one-time scan at prepare time missed those, so they repeated on
// every tile. Ancestors of the element scroller are never hidden (that would hide the content itself).
export async function gotoTile(x, y, hideSticky) {
  const state = window.__screensnapFullpage;
  const el = state && state.scroller;
  if (el) el.scrollTo({ top: y, behavior: "instant" });
  else window.scrollTo({ left: x, top: y, behavior: "instant" });
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 150); // rAF can be throttled; never stall the capture on it
  });
  if (state) {
    if (hideSticky) {
      const seen = new Set(state.hidden.map((h) => h.el));
      for (const node of document.querySelectorAll("*")) {
        if (seen.has(node)) continue;
        const pos = getComputedStyle(node).position;
        if (pos !== "fixed" && pos !== "sticky") continue;
        if (el && node.contains(el)) continue;
        state.hidden.push({ el: node, value: node.style.getPropertyValue("visibility"), priority: node.style.getPropertyPriority("visibility") });
        node.style.setProperty("visibility", "hidden", "important");
      }
    } else {
      for (const h of state.hidden) h.value ? h.el.style.setProperty("visibility", h.value, h.priority) : h.el.style.removeProperty("visibility");
      state.hidden = [];
    }
  }
  return el ? { scrollX: 0, scrollY: Math.round(el.scrollTop) } : { scrollX: window.scrollX, scrollY: window.scrollY };
}

export function restorePageAfterCapture() {
  const state = window.__screensnapFullpage;
  if (!state) return;
  for (const h of state.hidden) h.value ? h.el.style.setProperty("visibility", h.value, h.priority) : h.el.style.removeProperty("visibility");
  if (state.styleEl && state.styleEl.parentNode) state.styleEl.parentNode.removeChild(state.styleEl);
  if (state.scroller) state.scroller.scrollTo({ top: state.scrollerTop, behavior: "instant" });
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
  delete window.__screensnapFullpage;
}
