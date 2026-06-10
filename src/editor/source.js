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

export async function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/webm";
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
      const file = input.files && input.files[0];
      if (!file) return finish(null);
      finish({ blob: file, fileName: file.name || "clip" });
    });
    // If the dialog is dismissed without a selection, 'change' never fires. Resolve null on the
    // next focus so callers aren't left hanging on cancel.
    window.addEventListener(
      "focus",
      () => setTimeout(() => finish(null), 400),
      { once: true }
    );
    input.click();
  });
}

export function toInput(blob) {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
}
