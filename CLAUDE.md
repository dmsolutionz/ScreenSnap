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
  **verify its integrity with a checksum**. See `scripts/fetch-ffmpeg.mjs` for the pattern (the ffmpeg.wasm core is
  vendored this way: pinned version + SHA-256 verification, downloaded once, never auto-updated).

## Product principles (do not regress)
- Completely free and unrestricted: no paywalls, no watermarks, no forced sign-ups, no upsell prompts.
- Privacy-first and fully local: all capture, processing, and storage stay on the user's machine. No external
  servers, no telemetry, no analytics, no runtime network calls.
- No "Awesome Screenshot" antipatterns: no forced new tab after recording, no mandatory cloud hosting.

## Architecture (1-paragraph map)
Service worker (`src/background/`) orchestrates everything: it coordinates screenshots (visible / full-page /
area) using `chrome.tabs.captureVisibleTab` + injected content scripts + `OffscreenCanvas`, and it owns the
recording lifecycle. Recording and MP4 transcoding happen in an **offscreen document** (`src/offscreen/`) because a
service worker has no DOM and a popup closes on blur. The offscreen doc runs `MediaRecorder` and — only when the
browser can't record MP4 natively — transcodes WebM→MP4 in a **Web Worker** (`src/lib/ffmpeg-worker.js`) driving the
vendored single-thread ffmpeg.wasm core. The popup (`src/popup/`) is just UI + message dispatch.
