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
  cleanupTracks();
  const { chunks, mime, opts, discard } = current;

  if (discard || !chunks || !chunks.length) {
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
  await downloadBlob(blob, filename);
  send({ type: MSG.REC_DONE, filename, note });
  resetCurrent();
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
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
      resolve(downloadId);
    });
  });
}

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
