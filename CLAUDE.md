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
  **verify its integrity with a checksum**. The only vendored assets are the Geist `.woff2` fonts (committed under
  `src/popup/fonts/`, SIL OFL) — committed so the UI renders with no runtime network request.
- **No ffmpeg / no WASM.** Recordings are saved as native MP4 via `MediaRecorder` (`video/mp4`); there is no
  transcoding step. If a browser lacks native MP4 it saves `.webm` rather than lose the recording.

## Product principles (do not regress)
- Completely free and unrestricted: no paywalls, no watermarks, no forced sign-ups, no upsell prompts.
- Privacy-first and fully local: all capture, processing, and storage stay on the user's machine. No external
  servers, no telemetry, no analytics, no runtime network calls.
- No "Awesome Screenshot" antipatterns: no forced new tab after recording, no mandatory cloud hosting.

## Branding
Product name is **screensnap.** (green-dot wordmark, dark theme, green `#22c55e` accent, Geist type). The repo
directory is still `clippy-but-good`; the shipped name everywhere is screensnap.

## Architecture (1-paragraph map)
Service worker (`src/background/`) orchestrates everything: it coordinates screenshots (visible / full-page / area)
using `chrome.tabs.captureVisibleTab` + injected page helpers + `OffscreenCanvas`, and owns the recording lifecycle,
badge, downloads, and `chrome.storage.session` state. Recording happens in an **offscreen document**
(`src/offscreen/`) because a service worker has no DOM and the popup closes on blur — it runs `MediaRecorder` and
saves **native MP4** (no transcoding). The **popup** (`src/popup/`) is the screensnap UI. Recording controls live on
the surface that fits: a **recorder window** (`src/recorder-window/`) for screen/window capture, and injected
overlays (`src/content/`) for everything else — `editor-overlay` (annotation editor), `area-select` (region picker),
`recorder-control` (tab-recording pill), and `webcam-bubble` (Video Circle). All surfaces reflect state live via
`STATE_CHANGED`.
