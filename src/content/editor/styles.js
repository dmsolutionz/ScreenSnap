// The annotation editor's stylesheet (shadow DOM, so nothing leaks to or from the page). Light theme, green
// accent, Geist. Kept apart from shell.js so the markup + wiring there stay readable.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});
  const { GREEN, MONO, SANS } = NS;

  NS.editorCss = () => `
    :host { all: initial; }
    .ed { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column;
      background: #fff; color: #18181b; font-family: ${SANS}; }
    .top { height: 52px; flex: 0 0 auto; background: #fff; border-bottom: 1px solid #e6e7eb;
      display: flex; align-items: center; padding: 0 16px; gap: 12px; }
    .title { flex: 1; font-family: ${MONO}; font-size: 12px; color: #9aa0ab; text-transform: uppercase; letter-spacing: 0.06em; }
    button { all: unset; cursor: pointer; font-family: ${SANS}; }
    .tb { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; }
    .ghost { background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46; }
    .ghost:hover { background: #e9eaee; }
    .save { background: ${GREEN}; color: #fff; }
    .save:hover { background: #15803d; }
    .xbtn { width: 34px; height: 34px; background: #f3f4f6; border: 1px solid #e4e6eb; border-radius: 8px;
      display: flex; align-items: center; justify-content: center; }
    .xbtn:hover { background: rgba(220,38,38,0.1); }

    /* ── Tool options bar: only the active tool's (or selected item's) settings ── */
    .opts { height: 44px; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 0 14px;
      background: #fafafb; border-bottom: 1px solid #e6e7eb; font-size: 12px; color: #3f3f46; overflow-x: auto; white-space: nowrap; }
    .opts .grp { display: flex; align-items: center; gap: 6px; }
    .opts .vsep { width: 1px; height: 22px; background: #e4e6eb; flex: none; }
    .opts .lbl { font-family: ${MONO}; font-size: 10.5px; color: #9aa0ab; text-transform: uppercase; letter-spacing: 0.06em; }
    .opts .hint { color: #9aa0ab; font-size: 12px; }
    .opts .hint kbd { font-family: ${MONO}; font-size: 10.5px; background: #fff; border: 1px solid #e4e6eb; border-radius: 4px; padding: 0 4px; color: #6b7280; }
    .sw { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(17,24,39,0.16); flex: none; }
    .sw.on { box-shadow: 0 0 0 2px ${GREEN}; }
    .sw.custom { position: relative; overflow: hidden; background: conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444); }
    .sw.custom input { position: absolute; inset: -6px; width: 34px; height: 34px; opacity: 0; cursor: pointer; border: 0; padding: 0; }
    .wt { width: 30px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; border: 1px solid transparent; }
    .wt:hover { background: rgba(0,0,0,0.04); }
    .wt.on { background: rgba(22,163,74,0.1); border-color: rgba(22,163,74,0.3); }
    .wt i { width: 16px; border-radius: 4px; display: block; background: #71717a; }
    .wt.on i { background: ${GREEN}; }
    .wt b { font: 600 11px ${SANS}; color: #71717a; }
    .wt.on b { color: ${GREEN}; }
    .chip { padding: 5px 9px; border-radius: 6px; font-size: 12px; font-weight: 500; color: #3f3f46; background: #f3f4f6; border: 1px solid #e4e6eb; }
    .chip:hover { background: #e9eaee; }
    .chip.on { background: rgba(22,163,74,0.12); border-color: rgba(22,163,74,0.4); color: ${GREEN}; }
    .obtn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 7px; font-size: 12px; font-weight: 500;
      color: #3f3f46; background: #f3f4f6; border: 1px solid #e4e6eb; }
    .obtn:hover { background: #e9eaee; }
    .obtn.ok { background: ${GREEN}; border-color: ${GREEN}; color: #fff; }
    .obtn.ok:hover { background: #15803d; }
    .obtn.danger:hover { background: rgba(220,38,38,0.1); color: #b91c1c; }
    .num { width: 62px; padding: 4px 6px; border: 1px solid #d9dce1; border-radius: 6px; font: 500 12px ${MONO}; color: #18181b; background: #fff; }
    .num:focus { outline: 2px solid rgba(22,163,74,0.35); border-color: ${GREEN}; }
    .rng { width: 96px; accent-color: ${GREEN}; cursor: pointer; }
    .val { font: 500 11px ${MONO}; color: #6b7280; min-width: 32px; }

    .body { flex: 1; display: flex; min-height: 0; }
    .palette { width: 60px; flex: 0 0 auto; background: #f7f7f9; border-right: 1px solid #e6e7eb;
      padding: 12px 0; display: flex; flex-direction: column; align-items: center; gap: 3px; overflow-y: auto; }
    .tool { width: 42px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; border: 1px solid transparent; flex: none; }
    .tool:hover { background: rgba(0,0,0,0.04); }
    .tool.on { background: rgba(22,163,74,0.12); border-color: rgba(22,163,74,0.3); }
    .sep { width: 30px; height: 1px; background: #e4e6eb; margin: 6px 0; flex: none; }
    .stage { flex: 1; min-width: 0; min-height: 0; overflow: auto; scrollbar-gutter: stable; background: #e9ebef; position: relative; text-align: center; padding: 24px; }
    .stage.pan, .stage.pan canvas { cursor: grab !important; }
    .stage.panning, .stage.panning canvas { cursor: grabbing !important; }
    canvas { display: inline-block; vertical-align: top; box-shadow: 0 4px 24px rgba(0,0,0,0.12); background: #fff; }
    /* Text frame (text.js): a transparent textarea over the text's own box, an outline + handles, and an
       8px transparent border zone around it that moves the text. */
    .tframe { position: absolute; z-index: 4; cursor: move; }
    .tframe::before { content: ""; position: absolute; inset: 7px; border: 1px solid ${GREEN}; pointer-events: none; }
    .tta { position: absolute; margin: 0; padding: 0; border: 0; outline: none; resize: none; overflow: hidden;
      background: transparent; cursor: text; text-align: left; }
    .tta::placeholder { color: currentColor; opacity: 0.45; }
    .th { position: absolute; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; box-sizing: border-box;
      background: #fff; border: 1.5px solid ${GREEN}; z-index: 2; }
    .readout { position: absolute; display: none; z-index: 6; pointer-events: none; padding: 3px 7px; border-radius: 6px;
      background: #1b1d21; color: #fff; font: 500 11px ${MONO}; white-space: nowrap; }
    .loupe { position: absolute; display: none; z-index: 7; pointer-events: none; padding: 4px; border-radius: 10px;
      background: #fff; box-shadow: 0 6px 20px rgba(17,24,39,0.22); border: 1px solid #e4e6eb; text-align: center; }
    .loupe canvas { display: block; width: 88px; height: 88px; border-radius: 7px; box-shadow: none; image-rendering: pixelated; }
    .loupe span { display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 4px; font: 500 11px ${MONO}; color: #3f3f46; }
    .loupe i { width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.15); }

    .bdrop { display: flex; align-items: center; gap: 8px; }
    .bd-toggle { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px;
      font-size: 13px; font-weight: 500; background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46; }
    .bd-toggle:hover { background: #e9eaee; }
    .bd-toggle.on { background: rgba(22,163,74,0.12); border-color: rgba(22,163,74,0.4); color: ${GREEN}; }
    .bd-opts { display: none; align-items: center; gap: 7px; }
    .bd-opts.show { display: flex; }
    .bd-bgs { display: flex; gap: 5px; }
    .bd-bg { width: 22px; height: 22px; border-radius: 6px; border: 2px solid #e4e6eb; padding: 0; }
    .bd-bg.on { border-color: ${GREEN}; outline: 1px solid ${GREEN}; outline-offset: 1px; }
    .bd-pad { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #6b7280; font-family: ${MONO};
      text-transform: uppercase; letter-spacing: 0.04em; }
    .bd-pad input[type=range] { width: 78px; accent-color: ${GREEN}; cursor: pointer; }
    .status { height: 38px; flex: 0 0 auto; background: #f7f7f9; border-top: 1px solid #e6e7eb;
      display: flex; align-items: center; padding: 0 16px; gap: 11px; font-family: ${MONO}; font-size: 11px;
      color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
    .dotc { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.15); }
    .sb { margin-left: auto; display: flex; gap: 7px; }
    .sbtn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border: 1px solid #e4e6eb; border-radius: 7px; color: #6b7280; font-size: 11px; background: #fff; }
    .sbtn:hover { background: #eef0f3; color: #18181b; }
    .sbtn.zoom { min-width: 44px; justify-content: center; font-family: ${MONO}; }

    /* ── Layers side panel ── */
    .layers { width: 232px; flex: 0 0 auto; background: #f7f7f9; border-left: 1px solid #e6e7eb;
      display: flex; flex-direction: column; min-height: 0; }
    .ly-head { flex: 0 0 auto; height: 44px; display: flex; align-items: center; gap: 8px;
      padding: 0 12px; border-bottom: 1px solid #e6e7eb; font-family: ${MONO}; font-size: 11px;
      color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; }
    .ly-head .ttl { flex: 1; }
    .ly-add { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-radius: 7px;
      font-size: 12px; font-weight: 500; background: #f3f4f6; border: 1px solid #e4e6eb; color: #3f3f46;
      font-family: ${SANS}; letter-spacing: 0; text-transform: none; }
    .ly-add:hover { background: #e9eaee; }
    .ly-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; position: relative; }
    .ly-empty { padding: 18px 12px; text-align: center; font-size: 12px; color: #9aa0ab; line-height: 1.5; }
    .ly-row { display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-radius: 8px;
      border: 1px solid #e6e7eb; background: #fff; cursor: pointer; user-select: none; }
    .ly-row:hover { background: #eef0f3; }
    .ly-row.on { border-color: ${GREEN}; background: rgba(22,163,74,0.08); }
    .ly-row.hid .ly-name, .ly-row.hid .ly-glyph { opacity: 0.4; }
    .ly-row.dragging { opacity: 0.45; }
    .ly-grip { flex: 0 0 auto; width: 10px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: grab; color: #c4c8cf; }
    .ly-row:hover .ly-grip { color: #9aa0ab; }
    .ly-drop { position: absolute; left: 8px; right: 8px; height: 2px; border-radius: 2px; background: ${GREEN}; display: none; pointer-events: none; }
    .ly-glyph { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 6px; background: #f1f2f4;
      display: flex; align-items: center; justify-content: center; }
    .ly-name { flex: 1; min-width: 0; font-size: 12.5px; color: #18181b; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis; }
    .ly-name .sub { color: #9aa0ab; }
    .ly-act { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; }
    .ly-ib { width: 23px; height: 23px; border-radius: 6px; display: flex; align-items: center;
      justify-content: center; color: #9aa0ab; }
    .ly-ib:hover { background: rgba(0,0,0,0.06); color: #18181b; }
    .ly-ib:disabled { opacity: 0.3; cursor: default; }
    .ly-ib.del:hover { background: rgba(220,38,38,0.12); }
    .ly-row.bg { cursor: default; background: #fbfbfc; }
    .ly-thumb { flex: 0 0 auto; width: 30px; height: 22px; border-radius: 5px; overflow: hidden; background: #e9ebef;
      box-shadow: 0 0 0 1px rgba(17,24,39,0.1); }
    .ly-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ly-lock { flex: 0 0 auto; width: 23px; display: flex; align-items: center; justify-content: center; }
  `;
})();
