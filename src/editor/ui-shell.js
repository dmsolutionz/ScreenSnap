// buildShell mounts the editor chrome into a root element and hands back the slots the controller
// wires up: the stage <canvas>, the rail / inspector / timeline / toolbar / transport / status
// containers, and a tiny event bus. FROZEN interface — feature modules rely on these exact slot
// references and bus shape.

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
  // The Layers sidebar is gone — its controls moved into the timeline's track headers (unified-track
  // redesign). `railEl` is the left tool rail (filled in the tool-rail phase); it sits before the stage.
  rootEl.innerHTML = `
    <div class="ss-ed">
      <div class="ss-toolbar" id="ss-toolbar"></div>
      <div class="ss-inspector" id="ss-inspector"></div>
      <div class="ss-main">
        <div class="ss-rail" id="ss-rail"></div>
        <div class="ss-stage" id="ss-stage">
          <canvas id="ss-canvas" class="ss-canvas"></canvas>
        </div>
      </div>
      <div class="ss-transport" id="ss-transport"></div>
      <div class="ss-timeline" id="ss-timeline"></div>
      <div class="ss-status" id="ss-status"></div>
    </div>`;

  const stageCanvas = rootEl.querySelector("#ss-canvas");
  const railEl = rootEl.querySelector("#ss-rail");
  const inspectorEl = rootEl.querySelector("#ss-inspector");
  const timelineEl = rootEl.querySelector("#ss-timeline");
  const toolbarEl = rootEl.querySelector("#ss-toolbar");
  const statusEl = rootEl.querySelector("#ss-status");
  const transportEl = rootEl.querySelector("#ss-transport");

  return { stageCanvas, railEl, inspectorEl, timelineEl, toolbarEl, statusEl, transportEl, bus: makeBus() };
}
