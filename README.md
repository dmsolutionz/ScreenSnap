# screensnap.

A free, local, watermark-free Chrome extension (Manifest V3) for screenshots and screen recording.
Built because being nagged to log in just to save a screenshot is miserable.

- **Free & unrestricted** — no paywalls, no watermarks, no sign-ups, no upsell.
- **Private & local** — every byte of capture, processing, and storage stays on your machine. No
  servers, no telemetry, no cloud, **no runtime network requests** (fonts are vendored, not fetched).
- **No dark patterns** — no forced new tab after recording, no mandatory cloud hosting. Capture →
  it lands in your Downloads. Done.

## Features

**Screenshots** (PNG)
- **Visible Tab** · **Full Page** (auto-scroll + stitch, de-dupes sticky headers) · **Select Area**
  (on-page green marquee with live dimensions, Enter to capture)
- After capture you get a **captured card**: **Annotate & save**, **Save PNG directly**, **Copy**, or Discard
- **Annotation editor** — Draw, Arrow, Rectangle, Text, Highlight, Blur/Redact, Eraser, colours,
  stroke weights, undo/redo, copy-to-clipboard

**Screen recording** → **native `.mp4`**
- **Current Tab** — instant, no picker; a draggable control pill sits on the page
- **Screen / Window** — Chrome's native picker, driven from a separate **recorder window** so the
  control isn't baked into the capture
- **Video Circle** — a Loom-style draggable **webcam bubble** on the page, recorded with the tab
- **System / tab audio** and/or **microphone** (mixed), **pause / resume**, and a red **REC** badge

## MP4, natively — no transcoding

`MediaRecorder` records **H.264 MP4 directly** on modern Chrome, so there's **no ffmpeg, no WASM, no
conversion step** — the recording is saved the instant you stop. (On the rare build without native
MP4 support it saves `.webm` rather than lose your recording.)

## Install (load unpacked)

```
chrome://extensions  →  enable Developer mode  →  Load unpacked  →  select this folder
```

That's it — **no build step, no `npm install`, zero dependencies.** Icons and fonts are committed, so
it runs straight from source. (`npm run make:icons` only re-generates the placeholder icons.)

## Architecture

No framework, no bundler, zero runtime dependencies — plain ES modules + self-contained injected
overlays.

| Piece | File(s) | Role |
| --- | --- | --- |
| **Service worker** | `src/background/service-worker.js` | Orchestrates everything: screenshots (`captureVisibleTab` + injected scroll/crop helpers stitched with `OffscreenCanvas`), the recording lifecycle, downloads, badge, and persisted state. |
| **Popup** | `src/popup/` | The screensnap UI — capture/record tabs, captured card, recording / saving / done. UI + dispatch only. |
| **Offscreen document** | `src/offscreen/` | Hosts `MediaRecorder` (a service worker has no DOM; the popup closes on blur). Saves native MP4. |
| **Recorder window** | `src/recorder-window/` | Separate floating window for screen/window recording (picker → live timer + stop). |
| **On-page overlays** | `src/content/` | Injected via `executeScript`: `editor-overlay` (annotation editor), `area-select` (region picker), `recorder-control` (tab-recording pill), `webcam-bubble` (Video Circle). |

State lives in `chrome.storage.session` so it survives the service worker being torn down
mid-recording. The popup, recorder window, and overlays all reflect it live via `STATE_CHANGED`.

## Permissions (deliberately minimal)

`activeTab` + `scripting` (only the tab you invoked it on — **no `<all_urls>`, no history scope**),
`tabCapture`, `desktopCapture`, `offscreen`, `downloads`, `storage`. Video Circle requests camera
access per-site via the standard browser prompt.

## Known limitations

- **Full-page capture** uses `captureVisibleTab` (rate-limited ~2/sec), so long pages take a few
  seconds; lazy-loaded content and complex sticky layouts can still leave seams.
- **Video Circle** records the current tab (the bubble lives in the page); it's not a full-desktop
  composite. Camera permission is per-site.
- Internal pages (`chrome://`, the Web Store, etc.) can't be captured — Chrome blocks it.

## Fonts

UI type is [Geist / Geist Mono](https://github.com/vercel/geist-font) (SIL OFL 1.1), vendored as
`.woff2` under `src/popup/fonts/` so nothing is fetched at runtime.

## Project conventions

See [CLAUDE.md](CLAUDE.md) — trunk-based commits to `main` with no attribution trailers, zero runtime
dependencies, and the privacy/free principles above are non-negotiable.

## License

MIT — see [LICENSE](LICENSE).
