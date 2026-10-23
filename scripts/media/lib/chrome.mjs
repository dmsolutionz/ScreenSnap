// Minimal Chrome DevTools Protocol driver for the media scripts (zero dependencies: Node's global
// WebSocket + fetch). Launches Google Chrome with a throwaway profile, optionally loads this unpacked
// extension, and hands back "pages" with evaluate / screenshot / mouse / key helpers.
//
// The GPU flags matter: plain headless Chrome has no hardware H.264, so WebCodecs can neither decode nor
// encode MP4 and the editor's real export would fail. With ANGLE/Metal it works exactly as in a normal window.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const CHROME = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => existsSync(p));

export async function launchChrome({ headless = true, args = [] } = {}) {
  if (!CHROME) throw new Error("No Chrome found — set CHROME_PATH.");
  const profile = mkdtempSync(join(tmpdir(), "screensnap-media-"));
  const proc = spawn(CHROME, [
    ...(headless ? ["--headless=new"] : []),
    "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-features=Translate",
    "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars", "--force-color-profile=srgb",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1600,1000",
    // never let Chrome treat a tab as hidden / occluded: requestAnimationFrame would stop and captures hang
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    ...args, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  const portFile = join(profile, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 100 && !port; i++) { if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0].trim(); else await sleep(150); }
  if (!port) { proc.kill("SIGKILL"); throw new Error("Chrome didn't expose a debugging port\n" + log.slice(0, 500)); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  let nextId = 1;
  const pending = new Map(), listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result); }
    else if (m.method) for (const l of listeners) if (l.method === m.method && (!l.sessionId || l.sessionId === m.sessionId)) l.fn(m.params);
  };
  // A command that never answers (e.g. the page is blocked on an alert/confirm) is an error, not a hang.
  const cmd = (method, params = {}, sessionId, timeoutMs = 45000) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method}: no answer in ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }, method });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  const on = (method, sessionId, fn) => listeners.push({ method, sessionId, fn });
  await cmd("Target.setDiscoverTargets", { discover: true });

  // A "page" is one attached target with the helpers the capture scripts need.
  async function attach(targetId, { width = 1440, height = 900, dsf = 1 } = {}) {
    const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
    const errors = [];
    on("Runtime.consoleAPICalled", sessionId, (p) => { if (p.type === "error") errors.push((p.args || []).map((a) => a.value ?? a.description ?? "").join(" ")); });
    on("Runtime.exceptionThrown", sessionId, (p) => errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0]));
    await cmd("Runtime.enable", {}, sessionId);
    await cmd("Page.enable", {}, sessionId);
    on("Page.javascriptDialogOpening", sessionId, (p) => { errors.push(`dialog: ${p.type} "${p.message}"`); cmd("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {}); });
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false }, sessionId);
    await cmd("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
    await cmd("Page.bringToFront", {}, sessionId).catch(() => {});
    const c = (method, params) => cmd(method, params, sessionId);
    return {
      sessionId, errors, cmd: c,
      async evaluate(expression, awaitPromise = false) {
        const r = await c("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
        if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result?.value;
      },
      async screenshot(opts = {}) {
        const r = await c("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, ...opts });
        return Buffer.from(r.data, "base64");
      },
      mouse: (type, x, y, o = {}) => c("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !o.buttons ? "none" : "left", buttons: 0, clickCount: type === "mouseMoved" ? 0 : 1, ...o }),
      async key(key, { shift = false, alt = false, meta = false, ctrl = false } = {}) {
        const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
        const named = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8 }[key];
        const code = named ?? key.toUpperCase().charCodeAt(0);
        const base = { key, code: named ? key : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
        await c("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(key.length === 1 && !meta && !ctrl ? { text: key } : {}) });
        await c("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      },
      insertText: (text) => c("Input.insertText", { text }),
      navigate: async (url) => { await c("Page.navigate", { url }); await sleep(300); },
    };
  }

  async function newPage(url, size) {
    const { targetId } = await cmd("Target.createTarget", { url });
    return attach(targetId, size);
  }

  async function loadExtension(path) {
    const { id } = await cmd("Extensions.loadUnpacked", { path });
    // wait for its service worker so chrome.tabs / runtime are alive before pages are opened
    for (let i = 0; i < 60; i++) {
      const t = (await cmd("Target.getTargets")).targetInfos.find((x) => x.url.startsWith(`chrome-extension://${id}`) && (x.type === "service_worker" || x.type === "background_page"));
      if (t) return { id, swTargetId: t.targetId };
      await sleep(200);
    }
    throw new Error("extension service worker never appeared");
  }

  return {
    cmd, on, attach, newPage, loadExtension,
    async close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); await sleep(200); try { rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
}
