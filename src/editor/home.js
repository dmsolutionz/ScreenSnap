// The editor's home screen (shown when it opens without a clip, e.g. from the popup's "Video editor" row):
// open any video file (picker or drag-and-drop), reopen a recent recording from IndexedDB, or set up a
// new project — a blank canvas of a chosen format / length / background, optionally pre-filled with clips
// laid end to end. It only gathers choices; editor.js does the loading / generating.
import { pickFile, pickFiles, probeVideo } from "./source.js";
import { listClips } from "./idb.js";
import { FORMATS, LENGTHS, BACKGROUNDS } from "./blank-project.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDur = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
function fmtWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// onOpen(blob, fileName) opens a video; onOpenClip(id) a stored recording; onCreate({ format, lengthSec, bg,
// clips:[{blob, fileName, probe}] }) builds a new project. Each returns a promise; the home shows a busy
// line while it runs and comes back (with any message) if it fails.
export function initHome({ onOpen, onOpenClip, onCreate }) {
  const form = $("new-form"), actions = $("home-actions");
  let clips = []; // [{ blob, fileName, probe }]

  $("np-format").innerHTML = [...FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`), `<option value="match">Match the first clip</option>`].join("");
  $("np-length").innerHTML = LENGTHS.map(([v, l]) => `<option value="${v}" ${v === 30 ? "selected" : ""}>${l}</option>`).join("");
  $("np-bg").innerHTML = BACKGROUNDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

  const renderClips = () => {
    $("np-clip-list").innerHTML = clips.map((c, i) => `<li><span class="n">${esc(c.fileName)}</span><span class="d">${fmtDur(c.probe.durationSec)}</span><button type="button" data-rm="${i}" title="Remove">×</button></li>`).join("");
    const total = clips.reduce((a, c) => a + c.probe.durationSec, 0);
    $("np-length-row").classList.toggle("disabled", clips.length > 0);
    $("np-length").disabled = clips.length > 0;
    $("np-hint").textContent = clips.length
      ? `${clips.length} clip${clips.length > 1 ? "s" : ""} in sequence · ${fmtDur(total)} total. Drag them on the timeline afterwards to retime or overlap.`
      : "Optional. Clips play one after another and set the project's length; green-screen clips are keyed automatically.";
  };
  $("np-clip-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    clips.splice(Number(b.dataset.rm), 1);
    renderClips();
  });
  $("np-add-clips").addEventListener("click", async () => {
    const picked = await pickFiles({ multiple: true });
    const bad = [];
    for (const p of picked) {
      const probe = await probeVideo(p.blob);
      if (probe) clips.push({ ...p, probe });
      else bad.push(p.fileName);
    }
    renderClips();
    if (bad.length) $("np-hint").textContent = `Skipped (not a readable video): ${bad.join(", ")}`;
  });

  const showForm = (on) => { form.hidden = !on; actions.hidden = on; };
  $("new-btn").addEventListener("click", () => showForm(true));
  $("np-cancel").addEventListener("click", () => { clips = []; renderClips(); showForm(false); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const opts = { format: $("np-format").value, lengthSec: Number($("np-length").value) || 30, bg: $("np-bg").value, clips: clips.slice() };
    await busy("Creating project…", () => onCreate(opts));
  });

  $("open-btn").addEventListener("click", async () => {
    const picked = await pickFile();
    if (picked && picked.blob) await busy(`Opening ${picked.fileName}…`, () => onOpen(picked.blob, picked.fileName));
  });

  // Drag-and-drop anywhere on the home screen.
  const drop = $("drop-hint");
  let depth = 0;
  const isFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (homeVisible() && isFiles(e)) { depth++; drop.hidden = false; } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
  window.addEventListener("dragover", (e) => { if (homeVisible() && isFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    depth = 0;
    drop.hidden = true;
    if (!homeVisible()) return;
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await busy(`Opening ${f.name}…`, () => onOpen(f, f.name || "video"));
  });

  async function busy(label, fn) {
    const card = document.querySelector(".ss-empty-card");
    let line = card.querySelector(".ss-busy");
    if (!line) { line = document.createElement("div"); line.className = "ss-busy"; card.appendChild(line); }
    line.textContent = label;
    card.style.pointerEvents = "none";
    try { await fn(); } finally { card.style.pointerEvents = ""; line.remove(); }
  }

  refreshRecent(onOpenClip, busy);
}

function homeVisible() { const e = $("empty"); return !!e && e.style.display !== "none"; }

async function refreshRecent(onOpenClip, busy) {
  let list = [];
  try { list = await listClips(); } catch { return; }
  const box = $("recent");
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  $("recent-list").innerHTML = list.map((c) => `<button type="button" class="ss-recent-item" data-clip="${esc(c.id)}">
      <span class="n">${esc(c.fileName)}</span>
      <span class="m">${c.durationMs ? fmtDur(c.durationMs / 1000) + " · " : ""}${fmtSize(c.size)} · ${esc(fmtWhen(c.savedAt))}</span>
    </button>`).join("");
  $("recent-list").onclick = (e) => {
    const b = e.target.closest("[data-clip]");
    if (b) busy("Opening recording…", () => onOpenClip(b.dataset.clip));
  };
}

export function showHome(msg) {
  const empty = $("empty"), root = $("root");
  if (empty) empty.style.display = "flex";
  if (msg) $("empty-text").textContent = msg;
  if (root) root.style.display = "none";
}
