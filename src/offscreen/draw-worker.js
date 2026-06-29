// Draw-loop metronome for the Screen + Cam compositor (src/offscreen/offscreen.js).
//
// Why a Worker: the offscreen document is never painted, so requestAnimationFrame (and
// HTMLVideoElement.requestVideoFrameCallback) are gated on a rendering pipeline that never runs — they
// stall, freezing the composited video. Main-thread setInterval is also throttled (~1Hz) in a backgrounded
// document. A *Worker* timer is immune to that throttling, so this Worker is a plain metronome: it posts a
// tick at the target fps and the offscreen main thread does the actual drawImage (where the <video> elements
// and 2D canvas context live). This Worker holds no media and does no drawing.
let id = null;
self.onmessage = (e) => {
  const d = e.data || {};
  if (d.cmd === "start") {
    if (id) clearInterval(id);
    const ms = 1000 / (d.fps || 30);
    id = setInterval(() => self.postMessage(0), ms);
  } else if (d.cmd === "stop") {
    if (id) clearInterval(id);
    id = null;
  }
};
