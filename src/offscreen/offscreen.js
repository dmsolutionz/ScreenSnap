// Offscreen document: owns MediaRecorder. Records native MP4 where the browser supports it
// (modern Chrome does); otherwise saves WebM directly. No transcoding — there is no ffmpeg.
// Created on demand and torn down by the service worker after each recording.
import { MSG, TARGET, PHASE, stamp } from "../lib/messages.js";

let current = {}; // { recorder, stream, rawStreams, audioContext, chunks, opts, mime, discard }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;
  (async () => {
    if (msg.type === MSG.OFFSCREEN_START) await startRecording(msg);
    else if (msg.type === MSG.OFFSCREEN_STOP) stopRecording(msg.discard);
    else if (msg.type === MSG.OFFSCREEN_PAUSE) pauseRec();
    else if (msg.type === MSG.OFFSCREEN_RESUME) resumeRec();
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      fail(err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true;
});

async function startRecording(opts) {
  const stream = await buildStream(opts);
  const mime = pickMime(opts.videoFormat !== "webm");
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => finalize().catch(fail);
  recorder.onerror = (e) => fail((e && e.error) || new Error("MediaRecorder error"));

  current = { ...current, recorder, stream, chunks, opts, mime, discard: false };

  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") recorder.stop();
  });

  recorder.start(1000);
  send({ type: MSG.REC_STARTED, mime: mime || "video/webm" });

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
    current.stopRequested = { discard: !!discard };
  }
}
function pauseRec() {
  if (current.recorder && current.recorder.state === "recording") current.recorder.pause();
}
function resumeRec() {
  if (current.recorder && current.recorder.state === "paused") current.recorder.resume();
}

async function buildStream(opts) {
  const { streamId, sourceKind, withMic, withSystemAudio, maxHeight, fps } = opts;
  const chromeMediaSource = sourceKind === "tab" ? "tab" : "desktop";

  const video = {
    mandatory: { chromeMediaSource, chromeMediaSourceId: streamId, maxWidth: 3840, maxHeight: maxHeight || 2160, maxFrameRate: fps || 30 },
  };
  const audio = withSystemAudio ? { mandatory: { chromeMediaSource, chromeMediaSourceId: streamId } } : false;

  let av;
  try {
    av = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (e) {
    if (audio) av = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    else throw e;
  }

  const videoTrack = av.getVideoTracks()[0];
  const streamAudioTracks = av.getAudioTracks();

  let micStream = null;
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      micStream = null;
    }
  }

  const audioTracks = [];
  if (streamAudioTracks.length || micStream) {
    const ac = new AudioContext();
    await ac.resume().catch(() => {});
    const dest = ac.createMediaStreamDestination();
    if (streamAudioTracks.length) {
      const srcNode = ac.createMediaStreamSource(new MediaStream(streamAudioTracks));
      srcNode.connect(dest);
      if (sourceKind === "tab") srcNode.connect(ac.destination); // keep the tab audible while capturing it
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
  for (const t of preferMp4 ? [...mp4, ...webm] : webm) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

async function finalize() {
  const { chunks, mime, opts, discard } = current;

  if (discard || !chunks || !chunks.length) {
    cleanupTracks();
    send({ type: MSG.REC_DONE, filename: null, cancelled: true });
    resetCurrent();
    return;
  }

  const baseType = (mime || "video/webm").split(";")[0];
  const blob = new Blob(chunks, { type: baseType });
  const isMp4 = baseType.includes("mp4");
  const ext = isMp4 ? "mp4" : "webm";
  const note = !isMp4 && opts.videoFormat !== "webm" ? "Saved as WebM — this browser can't record MP4 natively." : null;

  send({ type: MSG.REC_PHASE, phase: PHASE.SAVING });
  const filename = `screensnap/recording-${stamp()}.${ext}`;
  // Download BEFORE stopping the tracks: a USER_MEDIA offscreen document can be auto-closed by
  // Chrome once its media ends, which would kill the in-flight download.
  await downloadBlob(blob, filename);
  cleanupTracks();
  send({ type: MSG.REC_DONE, filename, note });
  resetCurrent();
}

// Save the recording. chrome.downloads.download can reject a blob: URL created in an offscreen
// document on some Chrome builds — so on any failure we fall back to an anchor-click download
// (rock-solid for blobs in a document). We wait for the download to finish before resolving,
// because finalize() tears this document down right after.
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
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
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

function cleanupTracks() {
  try {
    current.stream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    current.rawStreams?.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  } catch {}
  // AudioContext.close() returns a promise; closing an already-closed one rejects (and a bare
  // try/catch won't catch that async rejection). Guard on state, catch, and null it out.
  try {
    if (current.audioContext && current.audioContext.state !== "closed") current.audioContext.close().catch(() => {});
  } catch {}
  current.audioContext = null;
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
