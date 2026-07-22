// Offscreen document: owns MediaRecorder. Records native MP4 where the browser supports it
// (modern Chrome does); otherwise saves WebM directly. No transcoding — there is no ffmpeg.
// Created on demand and torn down by the service worker after each recording.
import { MSG, TARGET, PHASE, stamp, bubbleRadius } from "../lib/messages.js";
import { putBlob } from "../editor/idb.js";

let current = {}; // { recorder, stream, rawStreams, audioContext, chunks, opts, mime, discard }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only this extension's own service worker
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;
  (async () => {
    if (msg.type === MSG.OFFSCREEN_START) await startRecording(msg);
    else if (msg.type === MSG.OFFSCREEN_STOP) stopRecording(msg.discard);
    else if (msg.type === MSG.OFFSCREEN_PAUSE) pauseRec();
    else if (msg.type === MSG.OFFSCREEN_RESUME) resumeRec();
    else if (msg.type === MSG.OFFSCREEN_SET_MIC) setMicMuted(msg.muted);
    else if (msg.type === MSG.OFFSCREEN_SET_BUBBLE) setBubbleLive(msg);
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      fail(err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true;
});

let acquiring = false; // a screen picker (getDisplayMedia) is open — guards against opening a second
async function startRecording(opts) {
  // Idempotent: ignore a duplicate OFFSCREEN_START while a recorder is already live, or while the screen
  // picker is still open (no recorder yet) — otherwise we'd build a second stream or pop a second picker.
  if ((current.recorder && current.recorder.state !== "inactive") || acquiring) return;
  acquiring = true;
  let stream;
  try {
    stream = await buildStream(opts);
  } catch (e) {
    acquiring = false;
    // User dismissed the screen picker (or denied the OS screen-recording permission) — that's a cancel,
    // not a failure, so report a cancelled REC_DONE (no error toast). Anything else → fail() / REC_ERROR.
    if (e && (e.name === "NotAllowedError" || e.name === "NotFoundError" || e.name === "AbortError")) {
      cleanupTracks();
      send({ type: MSG.REC_DONE, filename: null, cancelled: true });
      resetCurrent();
      return;
    }
    throw e;
  }
  acquiring = false;
  const mime = pickMime(opts.videoFormat !== "webm");
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => finalize().catch(fail);
  recorder.onerror = (e) => {
    const err = (e && e.error) || new Error("MediaRecorder error");
    // Salvage: if part of the take was already captured, save that instead of dropping everything — a
    // recording must never be lost. The recorder fires "stop" after a fatal error, so finalize() runs
    // with the chunks recorded so far; the note tells the user why it ended early. The timed backstop
    // covers a build that skips the stop event (the finalize latch + identity check prevent doubles).
    const cur = current;
    if (cur.recorder === recorder && cur.chunks && cur.chunks.length) {
      cur.errNote = `Recording ended early (${String((err && err.message) || err)}) — saved what was captured.`;
      try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
      setTimeout(() => { if (current === cur && !cur.finalized) finalize().catch(fail); }, 1500);
      return;
    }
    fail(err);
  };

  current = { ...current, recorder, stream, chunks, opts, mime, discard: false, startedAt: Date.now() };

  // Stop when the SOURCE video ends — e.g. the user clicks Chrome's native "Stop sharing" bar, or the
  // screen/camera device goes away. For Screen + Cam this must watch the raw screen track (sourceVideoTrack),
  // NOT the composite canvas track, which never fires "ended" when its inputs die (it just goes black).
  (current.sourceVideoTrack || stream.getVideoTracks()[0])?.addEventListener("ended", () => {
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
// Mute/unmute the mic mid-recording by toggling the mic track's `enabled`. A disabled track emits
// silence, which propagates through the mixer (when mixed with system audio) or the mic-only path — so
// the recording goes silent for the mic without tearing anything down. The speaker monitor (system
// audio playback) is a separate element and is unaffected.
function setMicMuted(muted) {
  current.micStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
}

async function buildStream(opts) {
  const { streamId, sourceKind, withMic, withSystemAudio, maxHeight, fps, withCam, pipActive } = opts;

  // Acquire the screen/window or tab video (+ its system audio). Screen capture opens Chrome's native
  // picker HERE, in the offscreen doc, via getDisplayMedia — a chrome.desktopCapture stream id can't be
  // redeemed in an offscreen page (it's origin-scoped to a tab), so the offscreen doc both picks and
  // consumes. Tab capture redeems the tabCapture stream id the service worker passed in.
  let av;
  if (sourceKind === "screen") {
    // getDisplayMedia uses STANDARD constraints (not the getUserMedia mandatory{} shape). systemAudio:
    // "include" surfaces the picker's "Share audio" checkbox — the user decides, we can't force it. On
    // macOS there's no system-audio loopback for a full-screen share, so "Entire Screen" is usually
    // video-only; window/tab shares can still carry audio. A dismissed picker throws (handled upstream).
    av = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps || 30 }, height: { ideal: maxHeight || 2160 } },
      audio: !!withSystemAudio,
      ...(withSystemAudio ? { systemAudio: "include" } : {}),
    });
  } else {
    // min == max pins the capture to a FIXED frame size (Chromium's fixed-resolution policy): when the
    // tab resizes mid-recording — fullscreen video, a window resize — the frames are scaled/letterboxed
    // into the same dimensions instead of changing the stream's frame size, which would kill the MP4
    // recorder mid-take (its muxer can't represent a resolution change). The service worker measures
    // the tab and passes fixedWidth/Height; without them (measurement failed) fall back to max-only.
    const fw = opts.fixedWidth > 0 ? Math.round(opts.fixedWidth) : 0;
    const fh = opts.fixedHeight > 0 ? Math.round(opts.fixedHeight) : 0;
    const size = fw && fh
      ? { minWidth: fw, minHeight: fh, maxWidth: fw, maxHeight: fh }
      : { maxWidth: 3840, maxHeight: maxHeight || 2160 };
    const video = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, ...size, maxFrameRate: fps || 30 } };
    const audio = withSystemAudio ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } : false;
    try {
      av = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (e) {
      if (audio) av = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      else throw e;
    }
  }

  const videoTrack = av.getVideoTracks()[0];
  current.sourceVideoTrack = videoTrack; // the real screen/tab track (the "ended" watcher + Screen+Cam compositor read it)
  // Which surface did the picker capture? "monitor" (entire screen) | "window" | "browser" (a tab).
  // camIsPip = the floating PiP window is itself the recorded camera (only on an entire-screen share with an
  // active PiP). The SW uses this to close the now-redundant PiP for window/tab shares and to label the popup.
  const displaySurface = (videoTrack.getSettings && videoTrack.getSettings().displaySurface) || null;
  const pipIsTheCamera = !!withCam && !!pipActive && displaySurface === "monitor";
  send({ type: MSG.REC_SURFACE, displaySurface, camIsPip: pipIsTheCamera });
  const sysAudioTracks = av.getAudioTracks();

  // Capturing tab audio via getUserMedia mutes it from the speakers. Play it back through an <audio>
  // element so the user still hears the tab. We deliberately do NOT use an AudioContext for this:
  // an AudioContext in an offscreen document starts suspended (no user gesture) and can emit a
  // silent track, which previously killed audio even when only system audio was selected.
  if (sysAudioTracks.length && sourceKind === "tab") {
    const el = new Audio();
    el.srcObject = new MediaStream(sysAudioTracks);
    el.play().catch(() => {});
    current.monitorEl = el;
  }

  let micStream = null;
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      micStream = null;
    }
  }
  const micTracks = micStream ? micStream.getAudioTracks() : [];

  // MediaRecorder records a single audio track. One source → use it directly (no mixer, so a
  // suspended context can never silence it). Two sources → mix mic + system into one track.
  let audioTracks = [];
  if (sysAudioTracks.length && micTracks.length) {
    const ac = new AudioContext();
    await ac.resume().catch(() => {});
    const dest = ac.createMediaStreamDestination();
    ac.createMediaStreamSource(new MediaStream(sysAudioTracks)).connect(dest);
    ac.createMediaStreamSource(new MediaStream(micTracks)).connect(dest);
    audioTracks = dest.stream.getAudioTracks();
    current.audioContext = ac;
  } else if (sysAudioTracks.length) {
    audioTracks = sysAudioTracks;
  } else if (micTracks.length) {
    audioTracks = micTracks;
  }

  // Screen + Cam: composite the webcam as a corner bubble onto a canvas and record THAT instead of the raw
  // screen track. Camera failure degrades to screen-only — never lose the recording. (camStream is added to
  // rawStreams for cleanup; the camera light goes off when those tracks stop.)
  // EXCEPTION: when an entire-screen ("monitor") share is paired with an active floating PiP preview, that PiP
  // window is itself in the captured pixels — so compositing too would show the camera twice. There we record the
  // raw screen track and let the captured PiP be the one camera. (Window/tab shares don't capture the PiP, and a
  // monitor share with no PiP still composites — so the camera is always present exactly once.)
  let outVideoTrack = videoTrack;
  if (withCam && !pipIsTheCamera) outVideoTrack = (await startCameraComposite(videoTrack, opts)) || videoTrack;

  current.rawStreams = [av, current.camStream, micStream].filter(Boolean);
  current.micStream = micStream; // kept so the mic can be muted/unmuted live (setMicMuted)
  return new MediaStream([outVideoTrack, ...audioTracks]);
}

// Build the Screen + Cam compositor: draw the screen full-frame + a clipped, optionally-mirrored camera
// bubble in a corner, every Worker tick (rAF/rVFC don't fire in an unpainted offscreen doc), and expose the
// result as a captureStream video track. The bubble's shape/size/corner/mirror/hidden are read live from
// current.bubbleState each frame (OFFSCREEN_SET_BUBBLE mutates it — no rebuild). Returns the composite track,
// or null if the camera can't be acquired (caller falls back to screen-only).
async function startCameraComposite(screenTrack, opts) {
  let camStream;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    return null; // permission denied / camera busy → screen-only
  }
  current.camStream = camStream;

  const screenVideo = Object.assign(document.createElement("video"), { srcObject: new MediaStream([screenTrack]), muted: true, playsInline: true });
  const camVideo = Object.assign(document.createElement("video"), { srcObject: camStream, muted: true, playsInline: true });
  // Attach to the (never-shown) offscreen DOM: across Chrome builds a detached <video> can stall before
  // HAVE_CURRENT_DATA, which would leave the camera bubble permanently skipped (readyState < 2 guard below).
  screenVideo.style.cssText = camVideo.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0";
  document.body.append(screenVideo, camVideo);
  // play() is load-bearing: an unplayed video never advances frames, so drawImage would paint one frozen still.
  await Promise.all([screenVideo.play().catch(() => {}), camVideo.play().catch(() => {})]);
  current.screenVideo = screenVideo;
  current.camVideo = camVideo;

  const maxH = opts.maxHeight || 2160;
  const fps = opts.fps || 30; // NOTE: fps is only destructured in buildStream — must read it from opts here
  const fit = () => { const s = screenTrack.getSettings(); let w = s.width || 1920, h = s.height || 1080; if (h > maxH) { w = Math.round((w * maxH) / h); h = maxH; } return { w, h }; };

  const canvas = document.createElement("canvas");
  let { w, h } = fit();
  canvas.width = w; canvas.height = h;
  let ctx = canvas.getContext("2d", { alpha: false }); // opaque: skips per-pixel alpha, faster full-frame draws

  // Bubble diameter as a FRACTION of canvas height — fixed px would be a tiny dot on a 4K/Retina capture.
  // md ≈ 1/5 of the height, like Loom. (size is a preset string; the px is recomputed per frame.)
  const SIZE_FRAC = { sm: 0.16, md: 0.20, lg: 0.26 };
  current.bubbleState = {
    shape: opts.bubbleShape === "square" ? "square" : "circle",
    size: SIZE_FRAC[opts.bubbleSize] ? opts.bubbleSize : "md",
    corner: opts.bubbleCorner || "br",
    mirror: opts.camMirror !== false,
    hidden: false,
  };

  const draw = () => {
    const f = fit(); // honor live resolution changes (resizing a canvas resets its 2D state, so re-fetch ctx)
    if (f.w !== canvas.width || f.h !== canvas.height) { canvas.width = f.w; canvas.height = f.h; ctx = canvas.getContext("2d", { alpha: false }); }
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(screenVideo, 0, 0, W, H);
    const b = current.bubbleState;
    if (!b || b.hidden || camVideo.readyState < 2) return; // HAVE_CURRENT_DATA
    const d = Math.round(H * (SIZE_FRAC[b.size] || SIZE_FRAC.md)), m = Math.round(H * 0.025);
    const x = b.corner === "tr" || b.corner === "br" ? W - d - m : m;
    const y = b.corner === "bl" || b.corner === "br" ? H - d - m : m;
    const vw = camVideo.videoWidth, vh = camVideo.videoHeight, side = Math.min(vw, vh), sx = (vw - side) / 2, sy = (vh - side) / 2;
    const path = () => { ctx.beginPath(); if (b.shape === "square") ctx.roundRect(x, y, d, d, bubbleRadius("square", d)); else ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); };
    ctx.save();
    path(); ctx.clip();
    if (b.mirror) { ctx.translate(x + d, y); ctx.scale(-1, 1); ctx.drawImage(camVideo, sx, sy, side, side, 0, 0, d, d); }
    else ctx.drawImage(camVideo, sx, sy, side, side, x, y, d, d);
    ctx.restore();
    ctx.save(); path(); ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.92)"; ctx.stroke(); ctx.restore(); // white ring
  };

  const worker = new Worker(chrome.runtime.getURL("src/offscreen/draw-worker.js"));
  worker.onmessage = draw;
  worker.postMessage({ cmd: "start", fps });
  current.worker = worker;

  const captured = canvas.captureStream(fps);
  current.compositeStream = captured;
  current.compositeTrack = captured.getVideoTracks()[0];
  return current.compositeTrack;
}

// Live-tweak the composited camera bubble mid-recording (no stream/recorder rebuild — draw() reads this
// every tick). Mirrors the popup/bar SET_BUBBLE message.
function setBubbleLive(msg) {
  const b = current.bubbleState;
  if (!b) return;
  if (msg.shape != null) b.shape = msg.shape === "square" ? "square" : "circle";
  if (msg.size != null) b.size = msg.size; // preset string (sm|md|lg); px computed per frame from canvas height
  if (msg.mirror != null) b.mirror = !!msg.mirror;
  if (msg.hidden != null) b.hidden = !!msg.hidden;
  if (msg.corner != null) b.corner = msg.corner;
}

function pickMime(preferMp4) {
  const mp4 = ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
  const webm = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const t of preferMp4 ? [...mp4, ...webm] : webm) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

async function finalize() {
  if (current.finalized) return; // stop event + error backstop can both land here — run once
  current.finalized = true;
  const { chunks, mime, opts, discard, errNote } = current;

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
  const note = errNote || (!isMp4 && opts.videoFormat !== "webm" ? "Saved as WebM — this browser can't record MP4 natively." : null);

  send({ type: MSG.REC_PHASE, phase: PHASE.SAVING });
  const filename = `screensnap/recording-${stamp()}.${ext}`;

  // Stash the recording in IndexedDB and hand off to the video editor, which opens automatically and
  // offers "Download" (save as-is) or editing — so we do NOT auto-download here. We stash BEFORE
  // stopping the tracks: a USER_MEDIA offscreen document can be auto-closed by Chrome once its media
  // ends, which would kill in-flight IO.
  let clipId = null;
  try {
    clipId = crypto.randomUUID();
    const durationMs = current.startedAt ? Date.now() - current.startedAt : null;
    await putBlob(clipId, blob, { fileName: filename.split("/").pop(), isMp4, durationMs });
  } catch {
    clipId = null;
  }

  // Safety net: if stashing failed the editor would have nothing to open, so save directly instead —
  // a recording must never be lost.
  if (!clipId) await downloadBlob(blob, filename);

  cleanupTracks();
  send({ type: MSG.REC_DONE, filename, note, clipId });
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

function cleanupTracks() {
  // Stop the Screen + Cam compositor first: kill the Worker metronome, the captureStream track, and detach
  // the source <video>s. (camStream is stopped via rawStreams below — that's what turns the camera light off.)
  try { current.worker?.postMessage({ cmd: "stop" }); current.worker?.terminate(); } catch {}
  current.worker = null;
  try { current.compositeTrack?.stop(); } catch {}
  // Stop the camera + source tracks DIRECTLY (not only via rawStreams): if buildStream threw partway —
  // e.g. after acquiring the camera but before rawStreams was assigned — these are the only refs, and the
  // camera light must still go off. Stopping an already-stopped track is a no-op.
  try { current.camStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { current.sourceVideoTrack?.stop(); } catch {}
  try { if (current.screenVideo) current.screenVideo.srcObject = null; } catch {}
  try { if (current.camVideo) current.camVideo.srcObject = null; } catch {}
  current.compositeTrack = null; current.compositeStream = null; current.camStream = null; current.sourceVideoTrack = null; current.screenVideo = null; current.camVideo = null; current.bubbleState = null;
  try {
    current.stream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    current.rawStreams?.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  } catch {}
  try {
    if (current.monitorEl) { current.monitorEl.pause(); current.monitorEl.srcObject = null; }
  } catch {}
  current.monitorEl = null;
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
