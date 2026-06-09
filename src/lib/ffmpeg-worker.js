// Classic Web Worker that drives the vendored single-thread ffmpeg.wasm core.
// Runs OFF the offscreen document's main thread so transcoding never freezes messaging
// and progress updates can stream live.
//
// Loaded lazily: the offscreen doc only spawns this worker when a WebM->MP4 transcode is
// actually needed (i.e. the browser couldn't record MP4 natively).
//
// Protocol:
//   in : { type:'transcode', inputName, outputName, data:ArrayBuffer, args:string[] }
//   out: { type:'ready' } | { type:'progress', progress } | { type:'log', level, message }
//        | { type:'done', data:ArrayBuffer } | { type:'error', message }

const CORE_JS = new URL("../../vendor/ffmpeg/ffmpeg-core.js", self.location.href).href;
const CORE_WASM = new URL("../../vendor/ffmpeg/ffmpeg-core.wasm", self.location.href).href;

let corePromise = null;

function loadCore() {
  if (corePromise) return corePromise;
  // UMD core: declares global `createFFmpegCore` (a `var`) after importScripts.
  importScripts(CORE_JS);
  // eslint-disable-next-line no-undef
  corePromise = createFFmpegCore({
    locateFile: (path) => (path.endsWith(".wasm") ? CORE_WASM : path),
  });
  return corePromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== "transcode") return;

  try {
    const core = await loadCore();

    core.setLogger(({ type, message }) => {
      self.postMessage({ type: "log", level: type, message });
    });
    core.setProgress(({ progress }) => {
      if (typeof progress === "number" && isFinite(progress)) {
        self.postMessage({ type: "progress", progress: Math.max(0, Math.min(1, progress)) });
      }
    });

    core.FS.writeFile(msg.inputName, new Uint8Array(msg.data));
    core.reset();
    core.exec(...msg.args); // DEFAULT_ARGS (./ffmpeg -nostdin -y) are prepended by the core
    const code = core.ret;
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);

    const out = core.FS.readFile(msg.outputName); // Uint8Array
    try {
      core.FS.unlink(msg.inputName);
      core.FS.unlink(msg.outputName);
    } catch {
      /* best-effort cleanup */
    }

    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ type: "done", data: buf }, [buf]);
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

self.postMessage({ type: "ready" });
