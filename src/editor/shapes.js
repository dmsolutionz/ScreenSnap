// Pure geometry/drawing functions for annotation shapes, operating in image/source coordinates.
//
// These are COPIED VERBATIM from src/content/editor-overlay.js (~lines 376-422). That file is an
// injected content script and cannot use ESM imports, so it owns the canonical copy and we duplicate
// here as named exports for the editor's ESM modules (compositor, annotate). Keep them in sync if the
// originals ever change. Do NOT modify editor-overlay.js to import this.

export const SANS = "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif";

// ── pure geometry/drawing (operate on image coords) ──
export function drawShape(ctx, s, unit, blurCanvas) {
  ctx.save();
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width || 6; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (s.type === "rect") ctx.strokeRect(s.x, s.y, s.w, s.h);
  else if (s.type === "arrow") drawArrow(ctx, s, unit);
  else if (s.type === "pencil") drawPath(ctx, s);
  else if (s.type === "highlight") { ctx.globalAlpha = 0.35; ctx.lineWidth = (s.width || 6) * 2.4; drawPath(ctx, s); }
  else if (s.type === "text") { ctx.font = `600 ${s.size}px ${SANS}`; ctx.textBaseline = "top"; ctx.fillText(s.text, s.x, s.y); }
  else if (s.type === "blur") ctx.drawImage(blurCanvas, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
  ctx.restore();
}
export function drawPath(ctx, s) { ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y); for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y); ctx.stroke(); }
export function drawArrow(ctx, s, unit) {
  const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), head = Math.max((s.width || 6) * 3, 14 * unit);
  ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath(); ctx.fill();
}
export function bbox(s, ctx) {
  if (s.type === "rect" || s.type === "blur") return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.type === "arrow") return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  if (s.type === "text") { let w = s.size * s.text.length * 0.6; try { ctx.save(); ctx.font = `600 ${s.size}px ${SANS}`; w = ctx.measureText(s.text).width; ctx.restore(); } catch {} return { x: s.x, y: s.y, w, h: s.size }; }
  const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
export function hit(s, p, tol) {
  if (s.type === "rect" || s.type === "blur") return p.x >= s.x - tol && p.x <= s.x + s.w + tol && p.y >= s.y - tol && p.y <= s.y + s.h + tol;
  if (s.type === "text") { const b = bbox(s); return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol; }
  if (s.type === "arrow") return distToSeg(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < (s.width || 6) + tol;
  if (s.points) return s.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < (s.width || 6) + tol);
  return false;
}
export function translate(s, dx, dy) {
  const c = JSON.parse(JSON.stringify(s));
  if (c.points) c.points = c.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (c.x != null) { c.x += dx; c.y += dy; }
  if (c.x1 != null) { c.x1 += dx; c.y1 += dy; c.x2 += dx; c.y2 += dy; }
  return c;
}
export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
