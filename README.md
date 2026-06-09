# Clippy — screenshots & screen recording

A free, local, watermark-free Chrome extension (Manifest V3) for screenshots and screen recording.
Built because being nagged to log in just to save a screenshot is miserable.

- **Free & unrestricted** — no paywalls, no watermarks, no sign-ups, no upsell prompts.
- **Private & local** — every byte of capture, processing, and storage stays on your machine. No
  servers, no telemetry, no cloud, no runtime network calls.
- **No dark patterns** — no forced new tab after recording, no mandatory cloud hosting. Capture →
  it lands in your Downloads. Done.

## Features

**Screenshots** (saved as PNG in one click)
- Visible area of the tab
- Full scrolling page (auto-scroll + stitch, with fixed/sticky headers de-duplicated)
- A drag-selected region

**Screen recording** → exports **`.mp4`**
- Record the current **tab**, or a **screen / window / tab** via Chrome's native picker
- Capture **system / tab audio** and/or the **microphone** (mixed together)
- A red **`REC`** toolbar badge while recording is live
- On stop it converts to MP4 and triggers a normal browser download — no detour, no new tab

## Install (load unpacked)

```bash
git clone <this repo> && cd clippy-but-good
npm run setup            # generates icons + fetches the ffmpeg core (pinned + checksum-verified)
```

Then in Chrome: **`chrome://extensions`** → enable **Developer mode** → **Load unpacked** → select
this folder. Pin the toolbar icon and click it.

> `npm run setup` runs two zero-dependency Node scripts. `make:icons` draws the placeholder icons;
> `fetch:ffmpeg` downloads the single-thread ffmpeg.wasm core into `vendor/ffmpeg/`. **The ffmpeg
> step is optional** — most modern Chrome builds record MP4 natively (see below). Skip it and the
> extension still works; it just falls back to saving `.webm` on the rare browser that can't.

There is **no build step and no bundler** — the extension runs the source in `src/` directly.

## How MP4 export works

MediaRecorder usually produces WebM. Clippy gets you MP4 two ways, preferring the fast path:

1. **Native MP4** — if `MediaRecorder` supports `video/mp4` (true on most current Chrome, especially
   macOS/Windows with hardware H.264), it records MP4 directly. No conversion, instant save.
2. **ffmpeg.wasm fallback** — otherwise it records WebM and transcodes to H.264/AAC MP4 locally with
   the vendored ffmpeg core, off the main thread, with a live progress bar. If the core isn't
   present, it saves the `.webm` rather than lose your recording.

## Architecture

No framework, no bundler, zero runtime npm dependencies — plain ES modules + self-contained
injected functions. The pieces and why they exist:

| Piece | File | Role |
| --- | --- | --- |
| **Service worker** | `src/background/service-worker.js` | Orchestrates everything. Coordinates screenshots (`captureVisibleTab` + injected scroll/crop helpers, stitched/cropped with `OffscreenCanvas`), owns the recording lifecycle, badge, downloads, and persisted state. |
| **Offscreen document** | `src/offscreen/` | Hosts `MediaRecorder` and the transcode worker. Needed because a service worker has no DOM and the popup closes on blur — neither can hold a recording. |
| **ffmpeg worker** | `src/lib/ffmpeg-worker.js` | Classic Web Worker driving the single-thread ffmpeg core, so transcoding never freezes the offscreen page. Loaded lazily, only when a fallback transcode is actually needed. |
| **Popup** | `src/popup/` | UI + message dispatch only. Reflects live state via `GET_STATE` / `STATE_CHANGED`. |
| **Page helpers** | `src/content/` | Pure functions injected via `chrome.scripting.executeScript({func})` for full-page scrolling and the area-select overlay. |

Capture/record start in the popup → message the service worker → it gets a media stream id
(`tabCapture` for the tab, `desktopCapture` for screen/window) → hands it to the offscreen doc →
`MediaRecorder` runs → on stop it (optionally) transcodes, then downloads. State lives in
`chrome.storage.session` so it survives the service worker being torn down mid-recording.

## Permissions (deliberately minimal)

`activeTab` + `scripting` (capture/inject only the tab you invoked it on — **no `<all_urls>`,
no broad history access**), `tabCapture`, `desktopCapture`, `offscreen`, `downloads`, `storage`.

## Known limitations (v1)

- **Full-page capture** uses `captureVisibleTab`, which is rate-limited to ~2/sec, so very long
  pages take a few seconds. Lazy-loaded content and complex sticky layouts can still leave seams.
- Capturing a **browser/internal page** (`chrome://`, the Web Store, etc.) isn't possible — Chrome
  blocks it. Use a normal website tab.
- The ffmpeg fallback core is ~32 MB and the single-thread transcode is slower than real time on
  long clips. The native-MP4 path avoids this entirely where available.

## Project conventions

See [CLAUDE.md](CLAUDE.md) — trunk-based commits to `main` with no attribution trailers, zero
runtime dependencies (anything unavoidable is pinned + checksum-verified), and the privacy/free
principles above are non-negotiable.

> **Note:** the popup's visual design is an intentional neutral placeholder, themed entirely via CSS
> variables in `src/popup/popup.css` so it can be re-skinned wholesale once a design reference lands.

## License

MIT — see [LICENSE](LICENSE).
