// Injected annotation editor — the entry point. Full-screen, light theme. Opens after a capture when the
// user picks "Annotate & save". Items can be drawn AND, with the Move tool, selected/dragged/deleted after
// the fact. Sends the annotated PNG back to the service worker. Message strings mirror src/lib/messages.js
// (no imports here).
//
// Content scripts injected with executeScript can't be ES modules, so the editor is split by concern into
// plain scripts under src/content/editor/ that all register into one namespace on the extension's
// isolated world (globalThis.__screensnapEditorNS). The service worker injects them in order — core,
// geometry, styles, editor, view, shell, options, zoom, crop, transform, text, layers, eyedropper — and
// then THIS file, which boots the editor. Re-injecting the set while an editor is open just redefines the
// code and replaces the editor.
(() => {
  const NS = globalThis.__screensnapEditorNS;
  const { HOST_ID, Editor } = NS;

  chrome.runtime.sendMessage({ type: "editor-get-image" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok || !res.dataUrl) return;
    const img = new Image();
    img.onload = () => {
      // Re-injection (Annotate again while an editor is open) REPLACES the open editor with the latest
      // capture: tear the old one down fully — listeners + canvases — without a cancel (the pending
      // capture is the new one now), so there's only ever one editor and one Escape → one cancel. The
      // stray-host sweep catches a host orphaned by an older content-script world (extension reload).
      if (window.__screensnapEditor) window.__screensnapEditor.destroy(false);
      document.getElementById(HOST_ID)?.remove();
      window.__screensnapEditor = new Editor(img, res.filename);
    };
    img.src = res.dataUrl;
  });
})();
