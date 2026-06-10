// buildShell mounts the editor chrome into a root element and hands back the slots the controller
// wires up: the stage <canvas>, the sidebar / timeline / toolbar / status containers, and a tiny
// event bus. FROZEN interface — feature modules rely on these exact slot references and bus shape.

function makeBus() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      const set = map.get(evt);
      if (set) for (const fn of [...set]) { try { fn(payload); } catch {} }
    },
  };
}

export function buildShell(rootEl) {
  rootEl.innerHTML = `
    <div class="ss-ed">
      <div class="ss-toolbar" id="ss-toolbar"></div>
      <div class="ss-main">
        <div class="ss-stage" id="ss-stage">
          <canvas id="ss-canvas" class="ss-canvas"></canvas>
        </div>
        <div class="ss-sidebar" id="ss-sidebar"></div>
      </div>
      <div class="ss-timeline" id="ss-timeline"></div>
      <div class="ss-status" id="ss-status"></div>
    </div>`;

  const stageCanvas = rootEl.querySelector("#ss-canvas");
  const sidebarEl = rootEl.querySelector("#ss-sidebar");
  const timelineEl = rootEl.querySelector("#ss-timeline");
  const toolbarEl = rootEl.querySelector("#ss-toolbar");
  const statusEl = rootEl.querySelector("#ss-status");

  return { stageCanvas, sidebarEl, timelineEl, toolbarEl, statusEl, bus: makeBus() };
}
