// Opens the REAL video editor (this repo, loaded unpacked) in headless Chrome with a given MP4 as the
// "recording", exactly as the extension does after a capture: the clip is stashed in IndexedDB and the
// editor page is opened with ?clipId=. Used by the media scripts to film / screenshot the actual UI.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome } from "./chrome.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Serve one local file with CORS so an extension page can fetch() it (extension pages can't read file://).
function serveFile(file) {
  const size = statSync(file).size;
  const srv = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", size);
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/${basename(file)}` })));
}

export async function openEditor({ source, width = 1440, height = 900, dsf = 2, fileName = "pulse-walkthrough.mp4", args = [] }) {
  const chrome = await launchChrome({ args });
  const ext = await chrome.loadExtension(REPO);
  const file = await serveFile(source);
  const editorUrl = `chrome-extension://${ext.id}/src/editor/editor.html`;
  const page = await chrome.newPage(editorUrl, { width, height, dsf });
  await sleep(700);
  // Hand the clip over through IndexedDB (the same store the recorder uses), then reload with ?clipId=.
  await page.evaluate(`(async () => {
    const blob = await (await fetch(${JSON.stringify(file.url)})).blob();
    await new Promise((resolve, reject) => {
      const o = indexedDB.open('screensnap', 1);
      o.onupgradeneeded = () => { const db = o.result; if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' }); };
      o.onsuccess = () => { const db = o.result; const t = db.transaction('clips', 'readwrite'); t.objectStore('clips').put({ id: 'demo', blob, meta: { fileName: ${JSON.stringify(fileName)} }, savedAt: 0 }); t.oncomplete = () => { db.close(); resolve(); }; t.onerror = () => reject(t.error); };
      o.onerror = () => reject(o.error);
    });
  })()`, true);
  await page.navigate(`${editorUrl}?clipId=demo`);
  // Wait until the editor is fully alive: timeline built, filmstrip + waveform decoded.
  for (let i = 0; i < 200; i++) {
    const ready = await page.evaluate(`(() => {
      const f = document.querySelector('canvas.ss-tl-film'), w = document.querySelector('.ss-tl-await path');
      return !!f && Number(f.dataset.frames) > 0 && Number(f.dataset.frames) >= Math.min(12, ${"80"}) && !!w && (w.getAttribute('d') || '').length > 10;
    })()`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(500);
  return {
    chrome, page, ext,
    async close() { file.srv.close(); await chrome.close(); },
  };
}
