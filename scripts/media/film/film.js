// The launch film, as a pure function of time. window.__render(t) sets every element's state for second t and
// resolves once the footage frames needed for t are decoded; render-film.mjs screenshots after that.
// Timing sits on a 120 BPM grid (1 beat = 0.5 s, 1 bar = 2 s) to match the synthesized music; the editor /
// popup / screenshot footage is mapped in through the capture manifests' marks so captions and key-caps hit
// the exact moment each thing happens on screen.

const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, u) => a + (b - a) * u;
const E = {
  lin: (u) => u,
  out3: (u) => 1 - Math.pow(1 - u, 3),
  out5: (u) => 1 - Math.pow(1 - u, 5),
  in3: (u) => u * u * u,
  io3: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  outBack: (u) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); },
  outExpo: (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u)),
};
const P = (t, a, b, e = E.out3) => e(clamp((t - a) / (b - a)));
const BEAT = 0.5;

// ── timeline (seconds) ──
// Every UI clip plays at real speed — each step slow enough to follow — so the film is long by design.
// (music-structure.json mirrors these section times for synth-audio.mjs)
export const T = { s1: [0, 4], s2: [4, 12], s3: [12, 34], s4: [34, 186], s5: [186, 212], s6: [212, 224], s7: [224, 238] };
export const DURATION = 238;
const FINAL = T.s7[0] + 10; // the last big hit
const FPS = 30;

// ── element helpers ──
function put(el, { x = 0, y = 0, s = 1, sx, sy, r = 0, o = 1, blur = 0, ry, rx } = {}) {
  const persp = ry != null || rx != null ? "perspective(2200px) " : "";
  el.style.transform = `${persp}translate(${x}px, ${y}px) ${rx != null ? `rotateX(${rx}deg) ` : ""}${ry != null ? `rotateY(${ry}deg) ` : ""}rotate(${r}deg) scale(${sx ?? s}, ${sy ?? s})`;
  el.style.opacity = String(clamp(o));
  el.style.filter = blur > 0.05 ? `blur(${blur}px)` : "none";
}
const vis = (el, on) => { el.style.display = on ? "block" : "none"; };
const inWin = (t, [a, b], pad = 0.05) => t >= a - pad && t < b + pad;

// scene in/out envelope: returns {i, o} progress for a scene window
function env(t, [a, b], inDur = 0.55, outDur = 0.4) { return { i: P(t, a, a + inDur, E.out5), o: P(t, b - outDur, b, E.in3) }; }
function sceneFx(el, t, win, { enter = true, exit = true, inDur, outDur } = {}) {
  const { i, o } = env(t, win, inDur, outDur);
  const ei = enter ? i : 1, eo = exit ? o : 0;
  put(el, { s: lerp(1.05, 1, ei) * lerp(1, 0.96, eo), o: ei * (1 - eo), blur: (1 - ei) * 22 + eo * 14 });
}

// ── assets & manifests ──
const base = { editor: "/work/editor/slow", popup: "/work/popup-slow", shots: "/work/shots-slow" };
const frameUrl = (set, i) => `${base[set]}/frames/${String(i).padStart(6, "0")}.png`;
async function manifest(set) { try { return await (await fetch(`${base[set]}/manifest.json`)).json(); } catch { return null; } }
const M = { editor: await manifest("editor"), popup: await manifest("popup"), shots: await manifest("shots") };
const mk = (set, name, fallback = 0) => (M[set] && M[set].marks && M[set].marks[name] != null ? M[set].marks[name] : fallback);

// footage → film time. Each clip plays from `t0` at `speed`x; the mapping is shared by captions and key-caps.
const FOOT = {
  editor: { t0: T.s4[0] + 0.6, speed: 1 },
  popup: { t0: T.s3[0] + 0.9, speed: 1 },
  shots: { t0: T.s5[0] + 0.5, speed: 1 },
};
const fT = (set, mark) => FOOT[set].t0 + mk(set, mark) / FOOT[set].speed;
const fFrame = (set, t) => {
  const m = M[set]; if (!m) return 0;
  return clamp(Math.round((t - FOOT[set].t0) * FOOT[set].speed * m.fps), 0, m.frames - 1);
};

// ── captions ──  (*word* = highlighted). srtOnly lines are spoken by the kinetic type on screen.
// `speak` overrides what the voiceover says and when ([[t, words], …]); by default it reads the caption at t0.
const C = (t0, t1, text, srtOnly = false, speak = null) => ({ t0, t1, text, srtOnly, speak });
// The editor's captions come from the capture itself (director.say), so each one starts on its step.
const KEY_LABEL = { S: "Split", "⌫": "Delete", "⌘Z": "Undo", "⇧⌘Z": "Redo", M: "Marker", Z: "Zoom", C: "Crop", "↵": "Apply", A: "Arrow", R: "Box" };
const editorSteps = ((M.editor && M.editor.captions) || []).map((c, i, all) => ({
  t0: FOOT.editor.t0 + c.t,
  t1: (i + 1 < all.length ? FOOT.editor.t0 + all[i + 1].t : T.s4[1] - 0.4) - 0.12,
  text: c.text, key: c.key || null,
}));
const S3 = T.s3[0], S5 = T.s5[0], S6 = T.s6[0], S7 = T.s7[0];
export const captions = [
  C(0.4, 3.9, "screensnap. Record. Edit. Keep it.", true, [[2.1, "screensnap."]]),
  C(4.0, 10.0, "Subscriptions? Watermarks? Sign-ups?", true, [[4.05, "Subscriptions?"], [6.05, "Watermarks?"], [8.05, "Sign-ups?"]]),
  C(10.1, 11.9, "screensnap is free. No paywall, no watermark, no account.", true, [[10.1, "screensnap is free."]]),
  C(S3 + 0.55, fT("popup", "audio") - 0.1, "Record a *tab*, a *window*, or your whole *screen*."),
  C(fT("popup", "audio"), fT("popup", "quality") - 0.1, "Record system audio and your mic."),
  C(fT("popup", "quality"), fT("popup", "cam-options") - 0.1, "Pick the quality and a countdown."),
  C(fT("popup", "cam-options"), fT("popup", "settings") - 0.1, "Screen + Cam adds a camera bubble."),
  C(fT("popup", "settings"), T.s3[1] - 0.3, "Recordings save as native *MP4*. No time limit."),
  ...editorSteps.map((c) => C(c.t0, c.t1, c.text)),
  C(S5 + 0.6, fT("shots", "steps") - 0.1, "Screenshots too. Draw an *arrow*."),
  C(fT("shots", "steps"), fT("shots", "spotlight") - 0.1, "Number your *steps*."),
  C(fT("shots", "spotlight"), fT("shots", "text") - 0.1, "Spotlight what *matters*."),
  C(fT("shots", "text"), fT("shots", "crop") - 0.1, "Add *text* wherever you need it."),
  C(fT("shots", "crop"), T.s5[1] - 0.4, "Crop, add a backdrop, re-edit any time."),
  C(S6 + 0.4, S6 + 2.9, "*Nothing* leaves your device."),
  C(S6 + 3.0, S6 + 7.9, "No servers. No telemetry. No accounts.", false, [[S6 + 3.0, "No servers, no telemetry, no accounts."]]),
  C(S6 + 8.0, T.s6[1] - 0.2, "Optional backup to *your* Drive, not ours."),
  C(S7 + 2.6, S7 + 7.4, "Free. Open source. *No catch.*"),
  C(FINAL + 0.4, T.s7[1] - 0.4, "Get it on the *Chrome Web Store*."),
];

// ── element refs ──
const el = Object.fromEntries(["s1","s2","s3","s4","s5","s6","s7","b1","b2","b3","hud","cap","cap-in","sweep","flash","fade","s1-word","s1-dot","s1-rec","s1-ring","s1-ring2","s1-tag","h1","h2","h3","s2-final","s2-pills","s3-title","s3-list","pop-dev","pop-img","ed-cam","ed-win","ed-img","ed-key","ed-kbd","ed-keylbl","sh-cam","sh-win","sh-img","s5-title","s5-keys","s6-head","z1","z2","z3","s6-drive","s7-word","s7-sub","s7-btn","s7-foot"].map((id) => [id, $(id)]));

// split the wordmark into letters for the staggered reveal; measure where the period lands
const wordEl = el["s1-word"];
const dotEl = el["s1-dot"];
const letters = [...("screensnap")].map((c) => { const s = document.createElement("span"); s.className = "ch"; s.textContent = c; return s; });
wordEl.textContent = ""; letters.forEach((l) => wordEl.appendChild(l)); wordEl.appendChild(dotEl);
await document.fonts.ready;
const dotBox = dotEl.getBoundingClientRect();
// the period is the glyph's small square at the baseline: its ink is ~ the lower-left of the glyph box
const DOT = { x: dotBox.left + dotBox.width * 0.5, y: dotBox.top + dotBox.height * 0.78, d: 236 * 0.135 };

// per-frame shake that decays after an impact
const shake = (t, t0, amp = 14, dur = 0.35) => { const u = (t - t0) / dur; if (u < 0 || u > 1) return [0, 0]; const k = (1 - u) * (1 - u) * amp; return [Math.sin(u * 60) * k, Math.cos(u * 47) * k * 0.7]; };

const ZEROS = [["z1", T.s6[0] + 0.9], ["z2", T.s6[0] + 1.7], ["z3", T.s6[0] + 2.5]];

// ── scenes ──
function bg(t) {
  put(el.b1, { x: Math.sin(t * 0.21) * 140, y: Math.cos(t * 0.17) * 100, s: 1 + 0.08 * Math.sin(t * 0.3) });
  put(el.b2, { x: Math.cos(t * 0.15) * 160, y: Math.sin(t * 0.2) * 120 });
  put(el.b3, { x: Math.sin(t * 0.13 + 2) * 120, y: Math.cos(t * 0.19) * 90, o: 0.9 });
}

function s1(t) {
  const on = inWin(t, [0, T.s1[1]], 0.3);
  vis(el.s1, on); if (!on) return;
  const sc = el.s1;
  const [sx, sy] = shake(t, 2.0, 16, 0.4);
  const out = P(t, 3.45, 3.95, E.in3);
  put(sc, { x: sx, y: sy, s: 1 + out * 0.1, o: 1 - out, blur: out * 18 });
  // the record light: pops in, pulses on each beat while the riser builds, then flies to the period
  const pop = P(t, 0.35, 0.6, E.outBack);
  const beat = (t % BEAT) / BEAT, pulse = t < 1.5 ? 1 + 0.22 * Math.pow(1 - beat, 3) : 1;
  const fly = P(t, 1.35, 2.0, E.io3);
  const cx = 960, cy = 540;
  const x = lerp(cx, DOT.x, fly), y = lerp(cy, DOT.y, fly) - Math.sin(Math.PI * fly) * 150;
  const d = lerp(48, DOT.d, fly) * pop * pulse;
  const r = el["s1-rec"];
  r.style.left = `${x - 24}px`; r.style.top = `${y - 24}px`;
  put(r, { s: d / 48, o: t < 2.0 ? 1 : 0 });
  // rings on the beats leading up to the hit, and a big shockwave at the impact
  const ring = (e, t0, dur, size, o0) => { const u = P(t, t0, t0 + dur, E.out3); const on2 = t >= t0 && t < t0 + dur; put(e, { s: lerp(0.3, size, u), o: on2 ? o0 * (1 - u) : 0 }); };
  ring(el["s1-ring"], 0.5, 0.9, 5, 0.7);
  ring(el["s1-ring2"], 2.0, 1.1, 22, 0.9);
  // wordmark letters
  letters.forEach((l, i) => { const u = P(t, 1.0 + i * 0.055, 1.0 + i * 0.055 + 0.5, E.outExpo); put(l, { y: (1 - u) * 90, o: u, blur: (1 - u) * 14 }); });
  const land = P(t, 2.0, 2.35, E.outBack);
  dotEl.style.opacity = t >= 2.0 ? "1" : "0";
  dotEl.style.transform = `scale(${t >= 2.0 ? lerp(2.4, 1, land) : 1})`;
  dotEl.style.transformOrigin = "30% 80%";
  // tagline
  [...el["s1-tag"].querySelectorAll("b, :scope")].length; // (layout only)
  put(el["s1-tag"], { y: (1 - P(t, 2.35, 2.85, E.out5)) * 40, o: P(t, 2.35, 2.8) });
}

function s2(t) {
  const on = inWin(t, T.s2, 0.3);
  vis(el.s2, on); if (!on) return;
  const out = P(t, 11.62, 12.0, E.in3);
  put(el.s2, { s: 1 + out * 0.05, o: 1 - out, blur: out * 12 });
  const hookExit = P(t, 9.95, 10.35, E.in3);
  const hooks = [["h1", 4.0, 5.0, 150], ["h2", 6.0, 7.0, 400], ["h3", 8.0, 9.0, 650]];
  for (const [id, t0, tStrike, top] of hooks) {
    const h = el[id], u = P(t, t0, t0 + 0.5, E.outExpo);
    h.style.top = `${top}px`;
    const struck = P(t, tStrike, tStrike + 0.2, E.out3);
    const dim = lerp(1, 0.4, P(t, tStrike, tStrike + 0.3));
    put(h, { y: (1 - u) * 140 - hookExit * 60, s: lerp(1.1, 1, u) * (1 - hookExit * 0.15), o: u * dim * (1 - hookExit), blur: (1 - u) * 20 + hookExit * 16 });
    h.querySelector("i").style.transform = `scaleX(${struck})`;
  }
  const f = P(t, 10.1, 10.65, E.outBack);
  put(el["s2-final"], { s: lerp(1.35, 1, f), o: P(t, 10.1, 10.35), blur: (1 - P(t, 10.1, 10.45)) * 20 });
  el["s2-pills"].querySelectorAll(".pill").forEach((p, i) => { const u = P(t, 10.75 + i * 0.4, 10.75 + i * 0.4 + 0.4, E.outBack); put(p, { y: (1 - u) * 60, s: lerp(0.6, 1, u), o: P(t, 10.75 + i * 0.4, 10.9 + i * 0.4) }); });
}

function s3(t) {
  const on = inWin(t, T.s3, 0.3);
  vis(el.s3, on); if (!on) return;
  sceneFx(el.s3, t, T.s3, { inDur: 0.5 });
  const tt = P(t, 12.25, 12.9, E.out5);
  put(el["s3-title"], { x: (1 - tt) * -120, o: tt, blur: (1 - tt) * 14 });
  // the feature list highlights in step with what the popup shows
  const marks = ["sources", "audio", "quality", "cam-options", "settings"].map((m) => fT("popup", m));
  let active = -1; marks.forEach((m, i) => { if (t >= m - 0.2) active = i; });
  el["s3-list"].querySelectorAll(".feat").forEach((f, i) => {
    const u = P(t, 12.6 + i * 0.12, 13.1 + i * 0.12, E.out5), a = i === active;
    f.style.background = a ? "rgba(34,197,94,.16)" : "rgba(255,255,255,.04)";
    f.style.borderColor = a ? "rgba(34,197,94,.7)" : "rgba(255,255,255,.07)";
    f.style.color = a ? "#fff" : "#8f9892";
    f.querySelector("b").style.color = a ? "#22c55e" : "#5f6862";
    put(f, { x: (1 - u) * -80 + (a ? 18 : 0), o: u });
  });
  const d = P(t, 12.3, 13.1, E.out5);
  put(el["pop-dev"], { y: (1 - d) * 160 + Math.sin(t * 1.3) * 7, ry: lerp(-24, -9, d) + Math.sin(t * 0.7) * 1.5, rx: 3, s: lerp(0.9, 1, d), o: d });
}

// camera for the editor window: [film time, focus x (0-1 of window), focus y, zoom]; eased between keys
function editorCam() {
  const k = (name, dt = 0) => fT("editor", name) + dt;
  return [
    [T.s4[0], 0.5, 0.5, 1.0],
    [k("open", 1.0), 0.5, 0.5, 1.04],
    [k("scrub", 0.2), 0.5, 0.62, 1.12],
    [k("trim", 0.0), 0.5, 0.62, 1.12],
    [k("cut", 0.0), 0.5, 0.6, 1.1],
    [k("undo", 0.0), 0.5, 0.6, 1.1],
    [k("zoom", 0.3), 0.5, 0.5, 1.08],
    [k("crop", -0.1), 0.5, 0.45, 1.08],
    [k("annotate", 0.1), 0.5, 0.5, 1.1],
    [k("audio", 0.0), 0.5, 0.62, 1.12],
    [k("backdrop", 0.0), 0.5, 0.5, 1.06],
    [k("export", 0.5), 0.5, 0.5, 1.03],
    [T.s4[1], 0.5, 0.5, 1.0],
  ];
}
function cam(t, keys, w, h, ox, oy) {
  let i = 0; while (i < keys.length - 2 && t >= keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1], u = E.io3(clamp((t - a[0]) / Math.max(0.001, b[0] - a[0])));
  const fx = lerp(a[1], b[1], u), fy = lerp(a[2], b[2], u), s = lerp(a[3], b[3], u);
  const px = ox + fx * w, py = oy + fy * h;
  return { tx: 960 - px * s, ty: 540 - py * s, s };
}
const EDCAM = editorCam();
const KEYCAPS = editorSteps.filter((c) => c.key).map((c) => ({ t: c.t0, k: c.key, lbl: KEY_LABEL[c.key] || "", end: Math.min(c.t1, c.t0 + 2.2) }));

function s4(t) {
  const on = inWin(t, T.s4, 0.3);
  vis(el.s4, on); if (!on) return;
  const { i, o } = env(t, T.s4, 0.7, 0.45);
  put(el.s4, { o: i * (1 - o), blur: (1 - i) * 10 + o * 12, s: lerp(1, 0.97, o) });
  const c = cam(t, EDCAM, 1360, 36 + 1360 * 0.625, 280, 40);
  const ein = P(t, T.s4[0], T.s4[0] + 0.75, E.out5);
  put(el["ed-cam"], { x: c.tx, y: c.ty + (1 - ein) * 150, s: c.s * lerp(0.93, 1, ein) });
  el["ed-cam"].style.transform = `translate(${c.tx}px, ${c.ty + (1 - ein) * 150}px) scale(${c.s * lerp(0.93, 1, ein)})`;
  // a key-cap announces the shortcut for the tool being used
  let cap = null;
  for (const kc of KEYCAPS) if (t >= kc.t - 0.05 && t < kc.end) cap = { k: kc.k, lbl: kc.lbl, u: P(t, kc.t, kc.t + 0.3, E.outBack), o: 1 - P(t, kc.end - 0.3, kc.end) };
  vis(el["ed-key"], !!cap);
  if (cap) {
    el["ed-kbd"].textContent = cap.k; el["ed-keylbl"].textContent = cap.lbl;
    const cw = el["cap-in"].offsetWidth || 0, kw = el["ed-key"].offsetWidth || 190;
    el["ed-key"].style.left = `${960 - cw / 2 - kw - 18}px`;
    put(el["ed-key"], { x: (1 - cap.u) * -50, s: lerp(0.8, 1, cap.u), o: cap.o * cap.u });
  }
}

function s5(t) {
  const on = inWin(t, T.s5, 0.3);
  vis(el.s5, on); if (!on) return;
  const { i, o } = env(t, T.s5, 0.6, 0.4);
  put(el.s5, { o: i * (1 - o), blur: (1 - i) * 10 + o * 12 });
  vis(el["s5-title"], false);
  const d = P(t, T.s5[0] + 0.05, T.s5[0] + 0.8, E.out5);
  el["sh-win"].style.left = "340px"; el["sh-win"].style.top = "70px"; el["sh-win"].style.width = "1300px";
  put(el["sh-cam"], { y: (1 - d) * 140, s: lerp(0.94, 1, d), o: d });
  // key-caps down the left edge, lit as each tool is used
  const keys = el["s5-keys"]; keys.style.cssText = "position:absolute;left:56px;top:230px;width:250px;display:flex;flex-direction:column;align-items:flex-start;gap:20px;";
  const order = ["arrow", "steps", "spotlight", "text", "crop"];
  keys.querySelectorAll(".key").forEach((k, idx) => {
    const a = fT("shots", order[idx]), lit = t >= a - 0.1 && (idx === 4 || t < fT("shots", order[idx + 1]) - 0.1);
    const u = P(t, T.s5[0] + 0.3 + idx * 0.1, T.s5[0] + 0.8 + idx * 0.1, E.out5);
    k.style.borderColor = lit ? "rgba(34,197,94,.8)" : "rgba(255,255,255,.08)";
    k.style.background = lit ? "rgba(34,197,94,.16)" : "rgba(255,255,255,.05)";
    k.style.color = lit ? "#fff" : "#9aa39d";
    put(k, { x: (1 - u) * -60 + (lit ? 14 : 0), o: u });
  });
}

function s6(t) {
  const on = inWin(t, T.s6, 0.3);
  vis(el.s6, on); if (!on) return;
  sceneFx(el.s6, t, T.s6, { inDur: 0.5 });
  const b = T.s6[0];
  const h = P(t, b + 0.2, b + 0.9, E.out5);
  put(el["s6-head"], { y: (1 - h) * 50, o: h, blur: (1 - h) * 14 });
  ZEROS.forEach(([id, t0]) => {
    const n = el[id], run = P(t, t0, t0 + 0.75, E.out3), v = Math.round(99 * (1 - run)), u = P(t, t0 - 0.1, t0 + 0.4, E.outBack);
    n.textContent = String(v);
    const landed = run >= 1;
    n.style.color = landed ? "#22c55e" : "#f4f6f5";
    n.style.textShadow = landed ? "0 0 90px rgba(34,197,94,.65)" : "none";
    put(n.parentElement, { y: (1 - u) * 80, s: lerp(0.8, 1, u) * (landed ? 1 + 0.06 * (1 - P(t, t0 + 0.75, t0 + 1.05)) : 1), o: P(t, t0 - 0.1, t0 + 0.25) });
  });
  const dv = P(t, b + 4.0, b + 4.7, E.out5);
  put(el["s6-drive"], { y: (1 - dv) * 80, o: dv });
}

function s7(t) {
  const on = inWin(t, T.s7, 0.3);
  vis(el.s7, on); if (!on) return;
  const b = T.s7[0];
  const fadeOut = P(t, T.s7[1] - 1.0, T.s7[1], E.io3);
  const [sx, sy] = shake(t, FINAL, 18, 0.4);
  put(el.s7, { x: sx, y: sy, s: lerp(1.05, 1, P(t, b, b + 0.55, E.out5)), o: P(t, b, b + 0.4) * (1 - fadeOut), blur: (1 - P(t, b, b + 0.55)) * 22 });
  const w = P(t, b + 0.25, b + 1.0, E.outExpo);
  put(el["s7-word"], { y: (1 - w) * 80, s: lerp(1.3, 1, w), o: w, blur: (1 - w) * 20 });
  const sub = P(t, b + 1.0, b + 1.7, E.out5);
  put(el["s7-sub"], { y: (1 - sub) * 40, o: sub });
  const bt = P(t, b + 3.2, b + 3.9, E.outBack);
  const hit = t >= FINAL ? 1 + 0.09 * (1 - P(t, FINAL, FINAL + 0.5, E.out3)) : 1;
  put(el["s7-btn"], { y: (1 - bt) * 70, s: lerp(0.8, 1, bt) * hit, o: P(t, b + 3.2, b + 3.5) });
  const f = P(t, b + 4.0, b + 4.6, E.out5);
  put(el["s7-foot"], { y: (1 - f) * 30, o: f });
}

// transitions: a green light-sweep across the frame between scenes, and a white flash on the big hits
const SWEEPS = [T.s3[0], T.s4[0], T.s5[0], T.s6[0], T.s7[0]].map((x) => x - 0.25);
const FLASHES = [[2.0, 0.34, 0.2], [4.0, 0.1, 0.15], [T.s4[0], 0.16, 0.2], [FINAL, 0.4, 0.3]];
function overlays(t) {
  let sw = 0, x = -700;
  for (const s0 of SWEEPS) if (t >= s0 && t < s0 + 0.6) { const u = (t - s0) / 0.6; sw = Math.sin(Math.PI * u); x = lerp(-700, 2100, E.io3(u)); }
  put(el.sweep, { x, o: sw * 0.9 });
  let fl = 0; for (const [t0, a, d] of FLASHES) if (t >= t0 && t < t0 + d) fl = Math.max(fl, a * Math.pow(1 - (t - t0) / d, 2));
  el.flash.style.opacity = String(fl);
  el.fade.style.opacity = String(Math.max(P(t, 0, 0.25, E.lin) < 1 ? 1 - P(t, 0, 0.25, E.lin) : 0, t > DURATION - 0.6 ? P(t, DURATION - 0.6, DURATION, E.lin) : 0));
  // wordmark in the corner for the product scenes
  put(el.hud, { o: Math.max(P(t, T.s3[0] + 0.4, T.s3[0] + 0.9) * (1 - P(t, T.s3[1] - 0.6, T.s3[1] - 0.2)), P(t, T.s6[0] + 0.4, T.s6[0] + 0.9) * (1 - P(t, T.s6[1] - 0.5, T.s6[1] - 0.1))) * 0.92 });
}

// captions: words rise in one by one, the whole line fades at the end
let capKey = null;
function caption(t) {
  const c = captions.find((x) => !x.srtOnly && t >= x.t0 && t < x.t1);
  const root = el.cap;
  if (!c) { root.style.display = "none"; capKey = null; return; }
  root.style.display = "flex";
  const inner = el["cap-in"];
  if (capKey !== c.text) {
    capKey = c.text;
    inner.textContent = "";
    const words = [];
    c.text.split(/(\*[^*]+\*)/).filter(Boolean).forEach((part) => {
      const hl = part.startsWith("*");
      let txt = hl ? part.slice(1, -1) : part;
      const lead = !hl && words.length && txt.match(/^[,.;:!?]+/); // punctuation hugs the word before it
      if (lead) { words[words.length - 1].w += lead[0]; txt = txt.slice(lead[0].length); }
      txt.trim().split(/\s+/).filter(Boolean).forEach((w) => words.push({ w, hl }));
    });
    words.forEach(({ w, hl }, i) => {
      const sp = document.createElement("span");
      sp.className = "w" + (hl ? " hl" : ""); sp.textContent = w;
      if (i < words.length - 1) sp.style.marginRight = "0.26em";
      inner.appendChild(sp);
    });
  }
  const ws = inner.querySelectorAll(".w");
  ws.forEach((w, i) => { const u = P(t, c.t0 + i * 0.06, c.t0 + i * 0.06 + 0.3, E.out5); put(w, { y: (1 - u) * 22, o: u }); });
  const out = P(t, c.t1 - 0.25, c.t1, E.lin), appear = P(t, c.t0, c.t0 + 0.14, E.out3); // the pill arrives with its first word
  put(root, { o: appear * (1 - out), y: out * 10 + (1 - appear) * 8 });
}

// footage frames for t (and wait for them to decode so the screenshot is never one frame behind)
async function media(t) {
  const jobs = [];
  const load = (img, url) => { if (img.__u !== url) { img.__u = url; img.src = url; } return img.decode().catch(() => {}); };
  if (el.s4.style.display === "block") jobs.push(load(el["ed-img"], frameUrl("editor", fFrame("editor", t))));
  if (el.s3.style.display === "block" && M.popup) jobs.push(load(el["pop-img"], frameUrl("popup", fFrame("popup", t))));
  if (el.s5.style.display === "block" && M.shots) jobs.push(load(el["sh-img"], frameUrl("shots", fFrame("shots", t))));
  await Promise.all(jobs);
}

// ── sound-effect cue sheet: [film time, file in audio/sfx, gain dB]. Built from the same timeline and the
// capture manifests, so a click sound always lands on the frame where that click happens on screen.
export const sfx = (() => {
  const q = [];
  const add = (t, name, db = -10) => q.push({ t: Math.round(t * 1000) / 1000, name, db });
  add(0.35, "pop", -16); [0.5, 1.0, 1.5].forEach((b) => add(b, "tick", -18));
  add(1.2, "whoosh_slow", -14); add(2.0, "impact_low", -4); add(2.02, "sparkle", -14); add(2.35, "pop", -12); add(3.5, "whoosh_fast", -12);
  [4, 6, 8].forEach((b) => add(b, "thud_soft", -8)); [5, 7, 9].forEach((b) => add(b, "strike", -9));
  add(9.95, "whoosh_slow", -11); add(10.1, "swoosh_in", -9); [10.75, 11.15, 11.55].forEach((b) => add(b, "pop_up", -11));
  SWEEPS.forEach((s0) => add(s0 - 0.05, "whoosh_fast", -10));
  add(T.s3[0] + 0.25, "swoosh_in", -10); add(T.s4[0], "swoosh_in", -9);
  const clicks = (set, db) => ((M[set] && M[set].clicks) || []).forEach((c) => add(FOOT[set].t0 + c.t / FOOT[set].speed, "click", db));
  clicks("popup", -12); clicks("editor", -12); clicks("shots", -12);
  KEYCAPS.forEach((kc) => add(kc.t + 0.02, "pop_up", -14));
  add(fT("editor", "backdrop") + 2.0, "toggle_on", -12);
  add(fT("editor", "export") + 0.6, "riser_2s", -22);
  add(fT("editor", "saved") + 0.05, "chime_success", -9);
  add(FOOT.shots.t0 + 0.0, "shutter", -9);
  add(T.s6[0] + 0.2, "swoosh_in", -10);
  ZEROS.forEach(([, t0]) => { for (let k = 0; k < 7; k++) add(t0 + k * 0.1, "tick", -19); add(t0 + 0.75, "thud_soft", -9); add(t0 + 0.77, "pop_up", -12); });
  add(T.s6[0] + 4.0, "swoosh_in", -11);
  add(T.s7[0] + 0.25, "impact_low", -9); add(T.s7[0] + 3.2, "pop_up", -11);
  add(FINAL, "impact_low", -3); add(FINAL + 0.02, "sparkle", -10);
  return q.sort((a, b) => a.t - b.t);
})();
window.__sfx = () => sfx;

window.__render = async (t) => {
  bg(t); s1(t); s2(t); s3(t); caption(t); s4(t); s5(t); s6(t); s7(t); overlays(t);
  await media(t);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
};
window.__captions = () => captions;
// The voiceover script: one line per caption (or its `speak` parts), each with the time it may run until —
// the start of the next line — so narrate.mjs can make sure no line talks over the next.
window.__voice = () => {
  const lines = captions.flatMap((c) => (c.speak || [[c.t0, c.text]]).map(([t, words]) => ({ t, text: words.replace(/\*/g, "") })));
  return lines.map((l, i) => ({ ...l, until: i + 1 < lines.length ? lines[i + 1].t : DURATION - 0.5 }));
};
window.__duration = DURATION;
window.__ready = true;
