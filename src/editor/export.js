// Export = transcode then save the MP4. The save mirrors src/offscreen/offscreen.js downloadBlob:
// try chrome.downloads.download with a blob: URL, fall back to an anchor-click download (rock-solid
// for blobs in a document), and always revoke the object URL.
import { transcode } from "./pipeline.js";
import { transcodeGif } from "./gif-export.js";

// input: Mediabunny Input. transforms: see transforms.js. store: layer store. fileName: suggested
// name. onProgress(0..1). signal: optional AbortSignal.
export async function runExport({ input, transforms, store, fileName, onProgress, signal, extraAudioInput }) {
  const blob = await transcode({ input, transforms, store, onProgress, signal, extraAudioInput });
  const name = toEditedName(fileName, "mp4");
  await downloadBlob(blob, `screensnap/${name}`);
  return { blob, fileName: name };
}

// Export the edited clip as an animated GIF instead of MP4. gifOpts: { fps, maxHeight }.
export async function runGifExport({ input, transforms, store, fileName, onProgress, signal, gifOpts }) {
  const blob = await transcodeGif({ input, transforms, store, onProgress, signal, ...(gifOpts || {}) });
  const name = toEditedName(fileName, "gif");
  await downloadBlob(blob, `screensnap/${name}`);
  return { blob, fileName: name };
}

function toEditedName(fileName, ext) {
  const base = (fileName || "edited").split("/").pop().replace(/\.[^.]+$/, "");
  const safe = base.replace(/[^\w.-]+/g, "-") || "edited";
  return `${safe}-edited.${ext}`;
}

// Save the MP4. chrome.downloads.download can reject a blob: URL on some Chrome builds, so on any
// failure fall back to an anchor-click download.
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await downloadViaApi(url, filename);
  } catch {
    anchorDownload(url, filename.split("/").pop());
    await new Promise((r) => setTimeout(r, 3500)); // let the browser read the blob before revoke
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadViaApi(url, filename) {
  return new Promise((resolve, reject) => {
    if (!(chrome && chrome.downloads && chrome.downloads.download)) return reject(new Error("no downloads api"));
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id == null) return reject(new Error(err ? err.message : "no download id"));
      const onChanged = (d) => {
        if (d.id === id && d.state && d.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
      setTimeout(resolve, 30000); // safety: never hang
    });
  });
}

function anchorDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
