# Conventions for this repo (read before contributing / committing)

These are hard rules for anyone — human or AI — working in this project.

## Commits
- **Commit directly to `main`.** This project is trunk-based; no feature-branch ceremony required.
- **No attribution trailers, ever.** Do not add `Co-Authored-By`, `Generated with …`, "Assisted by", or any
  tool/agent attribution to commit messages or PR descriptions. Keep messages plain and about the change.

## Dependencies
- **Zero runtime npm dependencies. No bundler. No framework.** The extension is plain ES modules + self-contained
  content scripts and loads *unpacked directly from the repo root* — what you read is what ships.
- Avoid adding packages. If a dependency is genuinely unavoidable, **pin it to an exact version** (no `^`/`~`) and
  **verify its integrity with a checksum**. Vendored assets (committed so they ship with no runtime network request):
  the Geist `.woff2` fonts (`src/popup/fonts/`, SIL OFL) and **Mediabunny** (`src/vendor/mediabunny.mjs`, MPL-2.0) —
  the pure-JS, no-WASM media library that powers the video editor's pipeline. See `src/vendor/ATTRIBUTION.md` for the
  pinned version + SHA-256.
- **No ffmpeg / no WASM.** Recordings are saved as native MP4 via `MediaRecorder` (`video/mp4`) with no transcoding.
  The video editor re-encodes via the browser-native **WebCodecs** API (still no ffmpeg, no WASM); its video
  output is always MP4, plus a from-scratch pure-JS animated-GIF export (`src/editor/gif-*.js`). If a browser
  lacks native MP4 capture it saves `.webm` rather than lose the recording.

## Product principles (do not regress)
- Completely free and unrestricted: no paywalls, no watermarks, no forced sign-ups, no upsell prompts.
- Privacy-first and fully local: all capture, processing, and storage stay on the user's machine. No external
  servers, no telemetry, no analytics, no runtime network calls.
- No "Awesome Screenshot" antipatterns: no mandatory cloud hosting, no upsell. (Opening the local video editor in a
  tab after a recording is fine — it is on-device and the editor's **Download** button saves the clip as-is.)

## Branding
Product name is **screensnap.** (green-dot wordmark, dark theme, green `#22c55e` accent, Geist type). The repo
directory is still `clippy-but-good`; the shipped name everywhere is screensnap.

## Architecture (1-paragraph map)
Service worker (`src/background/`) orchestrates everything: it coordinates screenshots (visible / full-page) using
`chrome.tabs.captureVisibleTab` + injected page helpers + `OffscreenCanvas`, and owns the recording lifecycle,
badge, downloads, and `chrome.storage.session` state. Recording happens in an **offscreen document**
(`src/offscreen/`) because a service worker has no DOM and the popup closes on blur — it runs `MediaRecorder` and
saves **native MP4** (no transcoding). There are **three record sources**: "Current Tab" captures the current tab via
`chrome.tabCapture`, while "Screen / Window" and "Screen + Cam" capture a whole monitor or any app window via
**`getDisplayMedia()` called inside the offscreen document** (which has the `DISPLAY_MEDIA` reason for exactly this) —
the offscreen doc both opens Chrome's native picker and consumes the stream, because a `chrome.desktopCapture` stream
id obtained in the service worker *cannot* be redeemed by an offscreen page (it's scoped to a tab's secure origin). No
`desktopCapture` permission is needed. "Screen + Cam" additionally grabs the webcam (`getUserMedia`) and **composites
it as a corner bubble onto a canvas** in the offscreen doc — driven by a tiny Web Worker metronome
(`src/offscreen/draw-worker.js`), because `requestAnimationFrame`/`requestVideoFrameCallback` don't fire in a
never-painted offscreen document; `canvas.captureStream()` then feeds the same MediaRecorder/MP4/editor pipeline. The
bubble's shape/size/corner/mirror/hidden are read live per frame (the popup/bar send `set-bubble` →
`offscreen-set-bubble`, no rebuild). Screen capture has **no on-page countdown** (the native picker is the "get ready"
beat) and its controls are the toolbar badge / popup / shortcuts, since on-page overlays can't follow it off-tab. The
**popup** (`src/popup/`) is the screensnap UI; on-page controls are injected overlays (`src/content/`) —
`editor-overlay` (annotation editor), `recorder-control` (the recording control bar: countdown / timer / pause /
discard / stop) and `draw-overlay` (auto-fading pen). Because `chrome.tabCapture` records the *whole* tab and there is
no API to exclude an on-page element (any visible overlay appears in the video), the control bar copies Loom: it sits
bottom-left and is **collapsed / auto-hidden during recording** (revealed by moving the pointer to the bottom-left
corner), and global keyboard shortcuts (manifest `commands`: stop = Alt+Shift+S, pause = Alt+Shift+P, handled in the
service worker) + the toolbar REC badge operate it while hidden — so a normal recording stays clean. Overlays are
re-injected by a `tabs.onUpdated` listener when the tab navigates; surviving a jump to a *different site* needs the
**optional `<all_urls>` host permission**, which the popup requests with the user's click when a Current Tab recording
starts (declining → same-site-only; shortcuts/toolbar still stop everywhere). Mic & camera
permission is granted via a small dedicated window (`src/permission/`), since neither the popup nor the offscreen
document can prompt. When a recording finishes it is stashed in IndexedDB and the **video editor** (`src/editor/`) opens in a
tab — a WebCodecs-based **multi-track timeline** editor (constant-height frozen-pane track grid: pinned ruler + video
track, then a track per overlay layer, audio with mute regions, and an optional imported voiceover/music track mixed
in via `OfflineAudioContext` at export) with trim / cuts / crop / zoom blocks / speed / resolution, resizable +
time-scoped overlay layers, a left tool rail with draw-once tools, snapping, and MP4 / GIF export (or Download the
clip as-is). All surfaces reflect state live via `STATE_CHANGED` (the editor itself runs standalone off IndexedDB).
