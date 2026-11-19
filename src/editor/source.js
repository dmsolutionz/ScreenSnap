// Source loading: a clip either comes from IndexedDB (the just-recorded handoff via ?clipId=) or
// from a file the user picks. toInput() wraps a Blob in a Mediabunny Input for the decode pipeline.
import { Input, ALL_FORMATS, BlobSource } from "../vendor/mediabunny.mjs";
import { getBlob } from "./idb.js";

export async function loadClip(clipId) {
  if (!clipId) return null;
  try {
    return await getBlob(clipId);
  } catch {
    return null;
  }
}

// Any video the browser can decode: MP4 / WebM / MOV (QuickTime H.264) / MKV. `accept` is only a hint —
// start() and addVideoLayer() probe the file with Mediabunny and refuse what it can't read.
const VIDEO_ACCEPT = "video/*,.mp4,.m4v,.mov,.webm,.mkv";

export async function pickFile() {
  const files = await pickFiles({ multiple: false });
  return files[0] || null;
}

// -> [{ blob, fileName }] (empty when the dialog is cancelled).
export function pickFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = VIDEO_ACCEPT;
    input.multiple = !!multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(val);
    };
    input.addEventListener("change", () => {
      const list = [...(input.files || [])];
      finish(list.map((file) => ({ blob: file, fileName: file.name || "clip" })));
    });
    // If the dialog is dismissed without a selection, 'change' never fires. Resolve empty on the
    // next focus so callers aren't left hanging on cancel.
    window.addEventListener(
      "focus",
      () => setTimeout(() => finish([]), 400),
      { once: true }
    );
    input.click();
  });
}

// Probe a video file: -> { width, height, durationSec, hasAudio } or null when it isn't a readable video.
export async function probeVideo(blob) {
  try {
    const input = toInput(blob);
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) return null;
    const width = await vTrack.getDisplayWidth();
    const height = await vTrack.getDisplayHeight();
    const durationSec = await vTrack.computeDuration();
    const hasAudio = !!(await input.getPrimaryAudioTrack().catch(() => null));
    if (!(width > 0 && height > 0 && durationSec > 0)) return null;
    return { width, height, durationSec, hasAudio };
  } catch {
    return null;
  }
}

export function toInput(blob) {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
}
