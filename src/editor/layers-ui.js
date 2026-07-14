// The sidebar layers panel: an "Add image / logo" button and a live list of layers from the store.
// onAddImage() resolves a chosen image File -> ImageBitmap (the controller picks the file and decodes
// it). Re-renders on every store change. Each row shows a type label, an eye visibility toggle, an
// opacity slider, reorder up/down buttons, a delete button, and a time-range control (a layer can be
// "Always visible" (range:null, the default) or "Timed" — shown only between its range.inSec/outSec,
// stamped from the current playhead via getCurrentTime()). The list is drawn top-to-bottom with the
// TOP of the list = TOP of the draw stack (last in the store's array). Runs on the editor page, so
// normal DOM is fine.
import { escapeHtml } from "./shapes.js";

const MIN_RANGE = 0.1; // smallest allowed (outSec - inSec), mirrors timeline.js's MIN_GAP

function fmtRangeTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// { el, store, onAddImage, getCurrentTime, getDurationSec }
//   getCurrentTime() -> current preview playhead (source seconds), used to stamp "Set in"/"Set out".
//   getDurationSec() -> clip duration (source seconds), used as the default range end.
export function createLayersPanel({ el, store, onAddImage, getCurrentTime, getDurationSec }) {
  const doc = el.ownerDocument;
  const now = () => (typeof getCurrentTime === "function" ? getCurrentTime() || 0 : 0);
  const dur = () => (typeof getDurationSec === "function" ? getDurationSec() || 0 : 0);

  el.innerHTML = `
    <div class="ss-panel">
      <div class="ss-panel-head">Layers</div>
      <button class="ss-btn ss-btn-ghost ss-add-image" id="ss-add-image">+ Add image / logo</button>
      <div class="ss-layer-list" id="ss-layer-list"></div>
    </div>`;

  const addBtn = el.querySelector("#ss-add-image");
  const list = el.querySelector("#ss-layer-list");

  function label(l) {
    if (l.kind === "image") return "Image";
    const s = l.shape || {};
    return s.type ? s.type.charAt(0).toUpperCase() + s.type.slice(1) : "Shape";
  }

  // Build a row for layer `l`. `idx` is its index in the store array (0 = bottom of stack), `total`
  // is the layer count — used to disable the reorder buttons at the ends of the stack.
  function row(l, idx, total) {
    const id = l.id;
    const visible = l.visible !== false;
    const opacity = typeof l.opacity === "number" ? l.opacity : 1;
    const range = l.range || null;

    const r = doc.createElement("div");
    r.className = "ss-layer-row";
    r.style.cssText = "display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:8px 10px;border:1px solid var(--chrome-line);border-radius:7px;";
    r.dataset.id = id;
    r.innerHTML = `
      <div class="ss-layer-row-top" style="display:flex;align-items:center;gap:8px;">
        <button class="ss-layer-eye" data-eye title="${visible ? "Hide" : "Show"}">${visible ? "👁" : "🚫"}</button>
        <span class="ss-layer-name">${escapeHtml(label(l))}</span>
        <input class="ss-layer-op" type="range" min="0" max="1" step="0.05" value="${opacity}" title="Opacity" aria-label="Opacity" />
        <div class="ss-layer-order">
          <button class="ss-layer-up" data-up title="Move up" ${idx === total - 1 ? "disabled" : ""}>▲</button>
          <button class="ss-layer-down" data-down title="Move down" ${idx === 0 ? "disabled" : ""}>▼</button>
        </div>
        <button class="ss-layer-del" data-del title="Delete">×</button>
      </div>
      <div class="ss-layer-range" data-range style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--chrome-muted);"></div>`;

    // Some of the row controls aren't in editor.css yet; keep them styled inline so the panel stays
    // coherent with the dark chrome / green accent without touching the shared stylesheet.
    const eye = r.querySelector("[data-eye]");
    eye.style.cssText =
      "width:24px;height:24px;border:none;background:transparent;font-size:13px;line-height:1;cursor:pointer;border-radius:5px;opacity:" +
      (visible ? "1" : "0.5");
    eye.addEventListener("click", () => store.update(id, { visible: !visible }));

    const slider = r.querySelector(".ss-layer-op");
    slider.style.cssText = "flex:0 0 56px;width:56px;accent-color:var(--green);cursor:pointer;";
    slider.addEventListener("input", () => store.update(id, { opacity: Number(slider.value) }));

    const order = r.querySelector(".ss-layer-order");
    order.style.cssText = "display:flex;flex-direction:column;gap:1px;";
    for (const b of order.querySelectorAll("button")) {
      b.style.cssText =
        "width:18px;height:11px;padding:0;border:none;background:transparent;color:var(--chrome-muted);font-size:8px;line-height:1;cursor:pointer;";
      b.addEventListener("mouseenter", () => { if (!b.disabled) b.style.color = "var(--chrome-fg)"; });
      b.addEventListener("mouseleave", () => { b.style.color = "var(--chrome-muted)"; });
    }
    const up = r.querySelector("[data-up]");
    const down = r.querySelector("[data-down]");
    // "Up" in the list = nearer the top of the stack = higher array index; "down" the reverse.
    up.addEventListener("click", () => { if (!up.disabled) store.move(id, idx + 1); });
    down.addEventListener("click", () => { if (!down.disabled) store.move(id, idx - 1); });
    for (const b of [up, down]) if (b.disabled) { b.style.opacity = "0.3"; b.style.cursor = "default"; }

    r.querySelector("[data-del]").addEventListener("click", () => store.remove(id));

    renderRange(r.querySelector("[data-range]"), id, range);

    return r;
  }

  // The time-range sub-row: "Always visible" (range:null) vs "Timed" (range:{inSec,outSec}), stamped
  // from the current playhead. Rebuilt in place on every store change so it always reflects live data.
  function renderRange(el, id, range) {
    el.textContent = "";
    const toggle = doc.createElement("button");
    toggle.className = "ss-layer-range-toggle";
    toggle.style.cssText =
      "border:none;background:transparent;color:var(--chrome-muted);font-size:11px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px;white-space:nowrap;";
    toggle.textContent = range ? "⏱ Timed" : "Always visible";
    toggle.title = range ? "Click to make always visible" : "Click to show only during part of the clip";
    toggle.addEventListener("click", () => {
      if (range) store.update(id, { range: null });
      else {
        const inSec = now();
        const outSec = Math.max(inSec + MIN_RANGE, dur() || inSec + MIN_RANGE);
        store.update(id, { range: { inSec, outSec } });
      }
    });
    el.appendChild(toggle);
    if (!range) return;

    const label = doc.createElement("span");
    label.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    label.textContent = `${fmtRangeTime(range.inSec)}–${fmtRangeTime(range.outSec)}`;
    el.appendChild(label);

    const mkBtn = (text, title, onClick) => {
      const b = doc.createElement("button");
      b.textContent = text;
      b.title = title;
      b.style.cssText =
        "border:none;background:transparent;color:var(--chrome-muted);font-size:10px;line-height:1;cursor:pointer;padding:3px 5px;border-radius:4px;white-space:nowrap;";
      b.addEventListener("click", onClick);
      return b;
    };
    el.appendChild(mkBtn("Set in", "Set the start to the current playhead", () => {
      const inSec = Math.min(now(), range.outSec - MIN_RANGE);
      store.update(id, { range: { inSec: Math.max(0, inSec), outSec: range.outSec } });
    }));
    el.appendChild(mkBtn("Set out", "Set the end to the current playhead", () => {
      const outSec = Math.max(now(), range.inSec + MIN_RANGE);
      store.update(id, { range: { inSec: range.inSec, outSec } });
    }));
    const clear = mkBtn("×", "Clear — show for the whole clip", () => store.update(id, { range: null }));
    clear.style.color = "var(--chrome-fg)";
    el.appendChild(clear);
  }

  function renderList(layers) {
    list.textContent = "";
    if (!layers.length) {
      const empty = doc.createElement("div");
      empty.className = "ss-layer-empty";
      empty.textContent = "No layers yet";
      list.appendChild(empty);
      return;
    }
    const total = layers.length;
    // Top of the list = top of the draw stack (last in the array), so iterate the store in reverse.
    for (let idx = total - 1; idx >= 0; idx--) {
      list.appendChild(row(layers[idx], idx, total));
    }
  }

  addBtn.addEventListener("click", async () => {
    if (typeof onAddImage === "function") await onAddImage();
  });

  const unsub = store.subscribe(renderList);
  renderList(store.layers);

  return {
    destroy() {
      unsub();
      el.innerHTML = "";
    },
  };
}
