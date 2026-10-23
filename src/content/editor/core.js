// Shared namespace + constants for the annotation editor: tool table + shortcut keys, handle / snap
// geometry, palettes, ratio + backdrop presets, icons and tiny string helpers.
// Plain content script (executeScript can't load modules): registers into the shared namespace.
(() => {
  const NS = (globalThis.__screensnapEditorNS ||= {});const HOST_ID = "__screensnap_editor";

  const PATH = {
    move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    rect: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    blur: '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="14" y1="3" x2="14" y2="21"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.3 4.1"/><path d="M6.6 6.6A17.6 17.6 0 0 0 2 11s3.5 7 10 7a10.9 10.9 0 0 0 4.1-.8"/><path d="m10 10a3 3 0 0 0 4 4"/><line x1="2" y1="2" x2="22" y2="22"/>',
    chevup: '<polyline points="18 15 12 9 6 15"/>',
    chevdown: '<polyline points="6 9 12 15 18 9"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    step: '<circle cx="12" cy="12" r="9"/><path d="M10.5 9.5 12.5 8v8"/>',
    spot: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2.5 2.6"/><rect x="8" y="8" width="8" height="8" rx="1.5"/>',
    pick: '<path d="m14.5 4.5 5 5"/><path d="M16.5 2.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3l-2.5 2.5-5-5z"/><path d="M14 7 5 16l-1 4 4-1 9-9"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    swap: '<path d="M7 4v16"/><path d="m4 7 3-3 3 3"/><path d="M17 20V4"/><path d="m14 17 3 3 3-3"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
  };
  const ico = (n, c = "#71717a", sz = 17, sw = 1.7) =>
    `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${PATH[n]}</svg>`;

  // Layer-row glyph per shape type (a PATH key). Falls back to "rect" for anything unmapped.
  const LAYER_ICON = { text: "type", arrow: "arrow", rect: "rect", highlight: "highlight", blur: "blur", pencil: "pencil", image: "image", step: "step", spot: "spot" };
  // Stable id for image assets. Prefer crypto.randomUUID; fall back to a monotonic counter.
  let assetCounter = 0;
  const newAssetId = () =>
    (crypto && crypto.randomUUID) ? crypto.randomUUID() : `asset-${Date.now()}-${assetCounter++}`;

  // [id, icon, label, shortcut key] — single-letter tool keys, Photoshop's letters where they map.
  const TOOLS = [
    ["select", "move", "Move", "v"],
    ["pencil", "pencil", "Draw", "p"],
    ["arrow", "arrow", "Arrow", "a"],
    ["rect", "rect", "Rectangle", "r"],
    ["text", "type", "Text", "t"],
    ["step", "step", "Step number", "n"],
    ["highlight", "highlight", "Highlight", "h"],
    ["spot", "spot", "Spotlight", "s"],
    ["blur", "blur", "Blur / Redact", "b"],
    ["crop", "crop", "Crop", "c"],
    ["pick", "pick", "Eyedropper", "i"],
  ];
  const TOOL_KEYS = Object.fromEntries(TOOLS.map(([id, , , k]) => [k, id]));
  // The tool rail, grouped (a thin rule between groups). Colours and strokes live in the options bar.
  const RAIL = [["select"], ["pencil", "arrow", "rect", "text", "step"], ["highlight", "spot", "blur"], ["crop", "pick"]];
  // Transform / crop handle geometry, in SCREEN px (converted at the current scale).
  const HANDLE_PX = 8;   // handle square size
  const GRAB_PX = 8;     // reach of a handle / frame edge
  const SNAP_PX = 8;     // smart-guide snap distance
  const NUDGE_RUN_MS = 1000; // arrow nudges closer together than this are one undo step
  const GUIDE = "#d946ef"; // smart guides: magenta, as in Photoshop / photocraft, distinct from the green selection
  // Handle positions as (hx, hy): -1 left/top, 0 middle, 1 right/bottom.
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const resizeCursor = (hx, hy) => (hx && hy ? (hx === hy ? "nwse-resize" : "nesw-resize") : hx ? "ew-resize" : "ns-resize");
  // The resize cursor for handle (hx, hy) of an item turned by `rot` radians: the handle's outward
  // direction, turned, picks the nearest of the four double-arrow cursors.
  const resizeCursorAt = (hx, hy, rot = 0) => {
    if (!rot) return resizeCursor(hx, hy);
    const deg = ((((Math.atan2(hy, hx) + rot) * 180) / Math.PI) % 180 + 180) % 180; // direction, mod 180°
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(deg / 45) % 4];
  };
  const ROT_OFF = 24;    // rotate handle: screen px above the top edge
  // A small curved-arrow cursor for the rotate handle (an SVG data URL, hotspot centred).
  const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9" stroke="#fff" stroke-width="4.5"/><path d="M20 4v5h-5" stroke="#fff" stroke-width="4.5"/><path d="M20 12a8 8 0 1 1-2.6-5.9" stroke="#18181b" stroke-width="2"/><path d="M20 4v5h-5" stroke="#18181b" stroke-width="2"/></svg>')}") 11 11, grab`;
  const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111111"];
  const WEIGHTS = [["sm", 2], ["md", 3.5], ["lg", 6]];   // [id, preview line thickness]
  // Crop aspect-ratio presets — [label, ratio]; ratio = width/height in image px, null = free.
  const RATIOS = [["Free", null], ["16:9", 16 / 9], ["1:1", 1], ["9:16", 9 / 16], ["4:3", 4 / 3]];
  // Backdrop background presets — gradients (top→bottom stops) and solids. Keyed by id.
  const BACKDROPS = [
    ["violet", "Violet", ["#8b5cf6", "#ec4899"]],
    ["sky", "Sky", ["#38bdf8", "#2563eb"]],
    ["amber", "Amber", ["#f59e0b", "#ef4444"]],
    ["mint", "Mint", ["#34d399", "#16a34a"]],
    ["slate", "Slate", ["#64748b", "#1e293b"]],
    ["dark", "Dark", "#18181b"],
    ["light", "Light", "#f3f4f6"],
    ["white", "White", "#ffffff"],
  ];
  const DEFAULT_BACKDROP = { pad: 0.07, radius: 0.03, shadow: true, bg: "violet" };
  // CSS background for a backdrop swatch chip: a CSS gradient for [a,b] stops, or the solid color.
  const bdSwatchCss = (val) => Array.isArray(val) ? `linear-gradient(135deg, ${val[0]}, ${val[1]})` : val;
  const SANS = "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif";
  const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace";
  const GREEN = "#16a34a";
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  Object.assign(NS, { HOST_ID, PATH, ico, LAYER_ICON, newAssetId, TOOLS, TOOL_KEYS, RAIL, HANDLE_PX, GRAB_PX, SNAP_PX, NUDGE_RUN_MS, GUIDE, HANDLES, resizeCursor, resizeCursorAt, ROT_OFF, ROTATE_CURSOR, COLORS, WEIGHTS, RATIOS, BACKDROPS, DEFAULT_BACKDROP, bdSwatchCss, SANS, MONO, GREEN, escapeHtml });
})();
