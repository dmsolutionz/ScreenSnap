// Offscreen document: owns MediaRecorder and drives WebM->MP4 transcoding (in a worker).
// Receives OFFSCREEN_START / OFFSCREEN_STOP from the service worker; reports progress back via
// REC_* messages. Created on demand and torn down by the service worker after each recording.
import { MSG, TARGET, PHASE, stamp } from "../lib/messages.js";

let current = {}; // { recorder, stream, rawStreams, audioContext, chunks, opts, mime, discard }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;
  (async () => {
    if (msg.type === MSG.OFFSCREEN_START) await startRecording(msg);
    else if (msg.type === MSG.OFFSCREEN_STOP) stopRecording(msg.discard);
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      fail(err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true;
});

// ---------------------------------------------------------------------------
async function startRecording(opts) {
  const stream = await buildStream(opts);
  const mime = pickMime(opts.videoFormat === "mp4");
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => finalize().catch(fail);
  recorder.onerror = (e) => fail((e && e.error) || new Error("MediaRecorder error"));

  current = { ...current, recorder, stream, chunks, opts, mime, discard: false };

  // If the user clicks Chrome's native "Stop sharing" bar, the video track ends — finish cleanly.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") recorder.stop();
  });

  recorder.start(1000); // 1s timeslices

  const willTranscode = opts.videoFormat === "mp4" && !(mime || "").startsWith("video/mp4");
  send({
    type: MSG.REC_STARTED,
    source: opts.sourceKind === "tab" ? "tab" : "screen",
    mime: mime || "(browser default)",
    willTranscode,
  });

  // If Stop arrived during the (async) stream setup above, honour it now.
  if (current.stopRequested) {
    const { discard } = current.stopRequested;
    current.stopRequested = null;
    stopRecording(discard);
  }
}

function stopRecording(discard) {
  if (current.recorder && current.recorder.state !== "inactive") {
    current.discard = !!discard;
    current.recorder.stop();
  } else {
    // Recorder not built yet (still preparing) — defer until it starts.
    current.stopRequested = { discard: !!discard };
  }
}

// ---------------------------------------------------------------------------
async function buildStream(opts) {
  const { streamId, sourceKind, withMic, withSystemAudio, maxHeight, fps } = opts;
  const chromeMediaSource = sourceKind === "tab" ? "tab" : "desktop";

  const video = {
    mandatory: {
      chromeMediaSource,
      chromeMediaSourceId: streamId,
      maxWidth: 3840,
      maxHeight: maxHeight || 2160,
      maxFrameRate: fps || 30,
    },
  };
  const audio = withSystemAudio ? { mandatory: { chromeMediaSource, chromeMediaSourceId: streamId } } : false;

  let av;
  try {
    av = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (e) {
    // A window/source may not offer audio — fall back to video-only.
    if (audio) av = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    else throw e;
  }

  const videoTrack = av.getVideoTracks()[0];
  const streamAudioTracks = av.getAudioTracks();

  let micStream = null;
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      micStream = null; // mic denied/unavailable — record without it
    }
  }

  const audioTracks = [];
  if (streamAudioTracks.length || micStream) {
    const ac = new AudioContext();
    await ac.resume().catch(() => {});
    const dest = ac.createMediaStreamDestination();
    if (streamAudioTracks.length) {
      const src = ac.createMediaStreamSource(new MediaStream(streamAudioTracks));
      src.connect(dest);
      // Capturing a TAB mutes it for the user unless we echo it back to the speakers.
      if (sourceKind === "tab") src.connect(ac.destination);
    }
    if (micStream) ac.createMediaStreamSource(micStream).connect(dest);
    audioTracks.push(...dest.stream.getAudioTracks());
    current.audioContext = ac;
  }

  current.rawStreams = [av, micStream].filter(Boolean);
  return new MediaStream([videoTrack, ...audioTracks]);
}

function pickMime(preferMp4) {
  const mp4 = ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
  const webm = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const t of preferMp4 ? [...mp4, ...webm] : webm) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// ---------------------------------------------------------------------------
async function finalize() {
  cleanupTracks();
  const { chunks, mime, opts, discard } = current;

  if (discard || !chunks || !chunks.length) {
    send({ type: MSG.REC_DONE, filename: null, cancelled: true });
    resetCurrent();
    return;
  }

  const recorded = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
  let outBlob = recorded;
  let ext = recorded.type.includes("mp4") ? "mp4" : "webm";
  let note = null;

  if (opts.videoFormat === "mp4" && ext !== "mp4") {
    try {
      send({ type: MSG.REC_PHASE, phase: PHASE.TRANSCODING });
      outBlob = await transcodeToMp4(recorded);
      ext = "mp4";
    } catch {
      // Graceful fallback: keep the recording rather than lose it.
      outBlob = recorded;
      ext = "webm";
      note = "Saved as WebM — MP4 conversion unavailable (run `npm run fetch:ffmpeg`).";
    }
  }

  send({ type: MSG.REC_PHASE, phase: PHASE.SAVING });
  const filename = `Clippy/recording-${stamp()}.${ext}`;
  await downloadBlob(outBlob, filename);
  send({ type: MSG.REC_DONE, filename, note });
  resetCurrent();
}

async function transcodeToMp4(webmBlob) {
  const buf = await webmBlob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL("src/lib/ffmpeg-worker.js"));
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Transcode timed out."));
    }, 10 * 60 * 1000);

    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "ready") {
        worker.postMessage(
          {
            type: "transcode",
            inputName: "in.webm",
            outputName: "out.mp4",
            data: buf,
            args: [
              "-i", "in.webm",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
              "-c:a", "aac", "-b:a", "128k",
              "-pix_fmt", "yuv420p", "-movflags", "+faststart",
              "out.mp4",
            ],
          },
          [buf]
        );
      } else if (m.type === "progress") {
        send({ type: MSG.REC_PROGRESS, progress: m.progress });
      } else if (m.type === "done") {
        clearTimeout(timeout);
        worker.terminate();
        resolve(new Blob([m.data], { type: "video/mp4" }));
      } else if (m.type === "error") {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(e.message || "ffmpeg worker failed to load"));
    };
  });
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        URL.revokeObjectURL(url);
        return reject(new Error(err.message));
      }
      const onChanged = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(onChanged);
          URL.revokeObjectURL(url);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000); // safety net
      resolve(downloadId);
    });
  });
}

// ---------------------------------------------------------------------------
function cleanupTracks() {
  try {
    current.stream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    current.rawStreams?.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  } catch {}
  try {
    current.audioContext?.close();
  } catch {}
}

function resetCurrent() {
  current = {};
}

function fail(err) {
  cleanupTracks();
  send({ type: MSG.REC_ERROR, message: String((err && err.message) || err) });
  resetCurrent();
}

function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
