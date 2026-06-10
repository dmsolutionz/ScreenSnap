// The sidebar layers panel: an "Add image / logo" button and a live list of layers from the store.
// onAddImage() resolves a chosen image File -> ImageBitmap (the controller picks the file and decodes
// it). Re-renders on every store change. Each row shows a type label, an eye visibility toggle, an
// opacity slider, reorder up/down buttons, and a delete button. The list is drawn top-to-bottom with
// the TOP of the list = TOP of the draw stack (last in the store's array). Runs on the editor page,
// so normal DOM is fine.
import { escapeHtml } from "./shapes.js";

// { el, store, onAddImage }
export function createLayersPanel({ el, store, onAddImage }) {
  const doc = el.ownerDocument;

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

    const r = doc.createElement("div");
    r.className = "ss-layer-row";
    r.dataset.id = id;
    r.innerHTML = `
      <button class="ss-layer-eye" data-eye title="${visible ? "Hide" : "Show"}">${visible ? "👁" : "🚫"}</button>
      <span class="ss-layer-name">${escapeHtml(label(l))}</span>
      <input class="ss-layer-op" type="range" min="0" max="1" step="0.05" value="${opacity}" title="Opacity" aria-label="Opacity" />
      <div class="ss-layer-order">
        <button class="ss-layer-up" data-up title="Move up" ${idx === total - 1 ? "disabled" : ""}>▲</button>
        <button class="ss-layer-down" data-down title="Move down" ${idx === 0 ? "disabled" : ""}>▼</button>
      </div>
      <button class="ss-layer-del" data-del title="Delete">×</button>`;

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

    return r;
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
