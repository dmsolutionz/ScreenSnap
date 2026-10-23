# screensnap.

### ▸ [Add to Chrome — free on the Chrome Web Store](https://chromewebstore.google.com/detail/screensnap/hadhpopgpoejimciiihfffdmiihffkcl)

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hadhpopgpoejimciiihfffdmiihffkcl?label=Chrome%20Web%20Store&color=16a34a&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/screensnap/hadhpopgpoejimciiihfffdmiihffkcl)
[![Users](https://img.shields.io/chrome-web-store/users/hadhpopgpoejimciiihfffdmiihffkcl?color=16a34a)](https://chromewebstore.google.com/detail/screensnap/hadhpopgpoejimciiihfffdmiihffkcl)
[![Rating](https://img.shields.io/chrome-web-store/rating/hadhpopgpoejimciiihfffdmiihffkcl?color=16a34a)](https://chromewebstore.google.com/detail/screensnap/hadhpopgpoejimciiihfffdmiihffkcl)
[![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

A free, local, watermark-free Chrome extension (Manifest V3) for screenshots and screen recording.
Built because being nagged to log in just to save a screenshot is miserable.

- **Free & unrestricted** — no paywalls, no watermarks, no sign-ups, no upsell.
- **Private & local** — every byte of capture, processing, and storage stays on your machine. No
  servers, no telemetry, no cloud, **no runtime network requests** (fonts are vendored, not fetched).
- **No dark patterns** — no forced new tab after recording, no mandatory cloud hosting. Capture →
  it lands in your Downloads. Done.

![A walk through the video editor: trim, annotate, zoom, audio editing, backdrop, and export](docs/media/screensnap-demo.gif)

## Features

**Screenshots** (PNG)
- **Visible Tab** · **Full Page** (auto-scroll + stitch, de-dupes sticky headers; also handles web apps whose
  content scrolls inside a panel rather than the page, e.g. Gmail) · **Select Area**
  (on-page green marquee with live dimensions, Enter to capture)
- After capture you get a **captured card**: **Annotate & save**, **Save PNG directly**, **Copy**, or Discard
- **Annotation editor** — Pen, Arrow, Rectangle, **Text** (a visible frame you can move, re-wrap and
  scale while typing), numbered **Step** badges, Highlight, **Spotlight** (dim everything else),
  Blur/Redact, **Crop** (a movable, resizable box with exact W × H and an orientation swap; free-form or
  16:9 / 1:1 / 9:16 / 4:3) and an **Eyedropper**. Every item stays selected with **move / resize handles** (plus
  rotate on images, boxes, text and steps) right after you place it, with smart-guide snapping and arrow-key nudges; a contextual
  **options bar** shows only the active tool's settings (colour, stroke, size, opacity); **zoom & pan**
  (⌘-scroll, ⌘0 fit, space-drag); a **Layers panel** with the screenshot as a locked Background layer,
  drag-to-reorder, duplicate (⌘D), show/hide, delete and **image/logo layers**; a **Beautify backdrop**
  (gradient/solid + rounded corners + shadow), undo/redo, copy-to-clipboard

**Screen recording** → **native `.mp4`**
- **Current Tab** — instant, no picker; a Loom-style control bar sits on the page (auto-hidden during capture)
- **Screen / Window** — Chrome's **native picker** (`getDisplayMedia`, run inside the offscreen document):
  record a whole monitor or any app window, even outside Chrome
- **Screen + Cam** — the picker plus your **webcam composited as a corner bubble** (circle/square, size,
  corner, mirror — all adjustable live), drawn onto a canvas in the offscreen document and recorded as one MP4
- Screen / Screen+Cam are controlled from the toolbar **REC** badge, the popup, and keyboard shortcuts
  (no on-page bar off-tab, and no countdown — the picker is the "get ready" beat)
- **System / tab audio** and/or **microphone** (mixed), **pause / resume**, and a red **REC** badge
- **Quality** — Small (720p), **Standard** (1080p, the default) or High (full resolution), each with an
  explicit bitrate, so a Standard take is roughly 15 MB a minute (a 7-minute walkthrough ≈ 100 MB)

**Video editor** (opens after a recording; WebCodecs, no ffmpeg/WASM)
- A **multi-track timeline** — a big timecode readout over a real ruler, the video as a **filmstrip clip**
  (frames across it, out-of-trim parts dimmed), then a colour-badged track per zoom / overlay / audio —
  with drag-to-move / drag-edge-to-resize clips, a draggable flag **playhead**, **snapping** (a magnet
  toggle; hold ⌥ to bypass), a **zoom & pan navigator** (drag the bar to pan, its round ends to zoom),
  per-track mute / volume / show-hide, and a constant-height panel (adding tracks never reflows the stage)
- **Trim** the ends (drag the handles, or Q / W to the playhead) and **cut** mistakes out of the middle: split at
  the playhead (S), click a piece and press Delete, and the rest closes up. Every timeline, crop and overlay
  edit is one **undo** step (⌘Z / ⇧⌘Z). **Markers** (M), J / K / L playback, ↑ / ↓ to jump between edits,
  Esc to abandon a drag, and the preview follows a trim handle so you see the frame you're cutting on.
  **Resolution** and **speed**
- **Crop** with a persistent box over the whole frame: drag it to move, pull any of 8 handles to resize
  (⇧ keeps the shape, ⌥ resizes from the centre), pick a ratio (16:9 / 9:16 / 1:1 / 4:3 / 4:5), type an
  exact W × H, swap orientation, nudge with the arrow keys, and re-open it later to adjust; **Zoom** with draggable, resizable focus
  blocks that ease in/out; **Beautify backdrop** (gradient/solid + rounded corners + shadow)
- **Layers** — annotations (text, arrows, shapes, blur), **image/logo** overlays, and **animated GIF**
  overlays — all **resizable** on the stage (8-handle selection box) and **time-scoped** on the
  timeline (e.g. an arrow that appears for 3 seconds), composited live (WYSIWYG preview = export)
- **Audio editing** — waveform view, drag to **mute regions** (without cutting the video), volume /
  mute, and **import a voiceover or music track** (movable, trimmable, mixed into the export)
- A left **tool rail** with keyboard shortcuts (V R A T B I; C crop, X cut, Z zoom), draw-once tools that return to Select,
  ⌘D duplicate, frame-step keys, and prev/next-edit transport buttons
- **Export** a native **MP4** (bitrate scales with resolution, so 720p/1080p genuinely shrink files)
  or an animated **GIF** — or download the original clip untouched

**Google Drive backup** (optional, off by default)
- Connect **your own Google Drive** in the popup and screensnap can **auto-upload finished
  recordings** to a private "screensnap" folder — or upload one-off from the done card / the
  editor's export menu
- **Share a recording with a link.** From the done card or the editor, screensnap marks that clip
  "anyone with the link" and hands you a branded share page at **screensnap.xyz/v/** that plays it back.
  Sharing is per-recording and opt-in, so your other recordings stay private.
- Direct browser-to-Google only (narrow `drive.file` scope: screensnap can only see files it
  created). **No screensnap servers, no proxy, no account with us** — disconnect revokes access.
  Until you connect it, the extension makes no network requests at all.

## MP4, natively — no transcoding

`MediaRecorder` records **H.264 MP4 directly** on modern Chrome, so there's **no ffmpeg, no WASM, no
conversion step** — the recording is saved the instant you stop. (On the rare build without native
MP4 support it saves `.webm` rather than lose your recording.)

## Install

**Most people:** [add it from the Chrome Web Store](https://chromewebstore.google.com/detail/screensnap/hadhpopgpoejimciiihfffdmiihffkcl) — one click, no sign-up.

**From source (for development):**

```
chrome://extensions  →  enable Developer mode  →  Load unpacked  →  select this folder
```

That's it — **no build step, no `npm install`, zero dependencies.** Icons and fonts are committed, so
it runs straight from source. (`npm run make:icons` only re-generates the placeholder icons.)

**Releasing:** bump `version` in `manifest.json` and `package.json`, then push to `main`. The
[Package workflow](.github/workflows/package.yml) runs the tests + lint, builds `screensnap-<version>.zip`
(`npm run package` locally), and publishes a `v<version>` GitHub release with the zip and its SHA-256,
ready to upload to the Chrome Web Store. Pushes that don't change the version just build the zip as a
workflow artifact.

## Architecture

No framework, no bundler, zero runtime dependencies — plain ES modules + self-contained injected
overlays.

| Piece | File(s) | Role |
| --- | --- | --- |
| **Service worker** | `src/background/service-worker.js` | Orchestrates everything: screenshots (`captureVisibleTab` + injected scroll/crop helpers stitched with `OffscreenCanvas`), the recording lifecycle, downloads, badge, and persisted state. |
| **Popup** | `src/popup/` | The screensnap UI — capture/record tabs, captured card, recording / saving / done. UI + dispatch only. |
| **Offscreen document** | `src/offscreen/` | Hosts `MediaRecorder` (a service worker has no DOM; the popup closes on blur). Opens the screen picker (`getDisplayMedia`), and for Screen + Cam composites the screen + webcam bubble onto a canvas (driven by `draw-worker.js`). Saves native MP4. |
| **On-page overlays** | `src/content/` | Injected via `executeScript`: `editor-overlay` (annotation editor — split into ordered plain scripts under `src/content/editor/`), `recorder-control` (the recording control bar: countdown → timer + pause + discard + stop) and `draw-overlay` (auto-fading pen). Re-injected on navigation so controls survive reloads / navigation. The Screen + Cam webcam is **not** an overlay — it's composited into the video in the offscreen document (`draw-worker.js` metronome + canvas), so it works over any screen/window. |

`chrome.tabCapture` records the **entire tab**, and there is no API to exclude an on-page element — so a *visible*
control would appear in the video. Like Loom, the control bar copies that constraint instead of fighting it: it's
bottom-left and **collapsed / auto-hidden during recording** (move the pointer to the bottom-left corner to reveal
it), and global shortcuts (`commands`: stop `Alt+Shift+S`, pause `Alt+Shift+P`) + the toolbar REC badge stop/pause it
while hidden — so the recording stays clean. (Screen / Screen+Cam capture at the OS level via `getDisplayMedia`, so
their controls are the badge / popup / shortcuts; the on-page bar there is a best-effort extra on the active tab.)
Surviving a jump to a **different site** mid-recording needs the optional `<all_urls>` host permission, which the
popup requests with the user's click when a Current Tab recording starts. The captured media stream keeps running
across navigations regardless.

State lives in `chrome.storage.session` so it survives the service worker being torn down
mid-recording. The popup, recorder window, and overlays all reflect it live via `STATE_CHANGED`.

## Permissions (deliberately minimal)

`activeTab` + `scripting` (only the tab you invoked it on — **no `<all_urls>`, no history scope**),
`tabCapture` (record the current tab), `offscreen`, `downloads`, `storage`. Whole-screen / window capture
uses the standard **`getDisplayMedia()`** Web API from the offscreen document — it needs **no extra
permission** and shows nothing until you start a Screen / Window recording and pick a source (no background
screen access). Screen + Cam additionally uses your webcam via standard `getUserMedia` (one-time browser
prompt) — also no manifest permission. For the optional Google Drive backup, `identity` ships in the
manifest (it is warning-free and inert until you connect — Chrome can't reliably expose a
runtime-granted API to a running service worker, so it can't be optional), while `googleapis.com`
host access **is** optional and requested only when you click Connect.

## Known limitations

- **Full-page capture** uses `captureVisibleTab` (rate-limited ~2/sec), so long pages take a few
  seconds; lazy-loaded content and complex sticky layouts can still leave seams. For apps that scroll
  inside a panel it expands the largest scrolling panel only, and content inside iframes isn't scrolled.
- **Screen + Cam** composites the webcam as a fixed corner bubble (pick corner/size/shape/mirror in the
  popup, adjustable mid-recording) — it isn't a freely-draggable live overlay, because off-tab screen
  capture has no web page to overlay.
- **Screen / Window** capture has no on-page overlays when you're off the active browser tab (the camera
  bubble and pen live in a web page), and on **macOS** system audio isn't captured (no OS loopback) —
  the mic still records. The native picker / OS prompt governs screen access.
- Internal pages (`chrome://`, the Web Store, etc.) can't be captured **as a tab** — Chrome blocks it.
  (You can still capture them via **Screen / Window**, which records at the OS level.)

## Fonts

UI type is [Geist / Geist Mono](https://github.com/vercel/geist-font) (SIL OFL 1.1), vendored as
`.woff2` under `src/popup/fonts/` so nothing is fetched at runtime.

## Project conventions

See [CLAUDE.md](CLAUDE.md) — trunk-based commits to `main`, zero runtime dependencies, and the
privacy/free principles above are non-negotiable.

## License

GNU GPL v3.0 (or later) — see [LICENSE](LICENSE).
