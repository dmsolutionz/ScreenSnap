# Chrome Web Store submission guide

Everything needed to list screensnap. Build the upload with `node scripts/package.mjs`
→ `dist/screensnap-<version>.zip`.

## Single purpose

> Capture screenshots and screen/tab recordings and edit them locally — entirely
> on the user's machine, with no cloud, accounts, or data collection.

## Listing

- **Name:** screensnap
- **Category:** Productivity
- **Language:** English
- **Summary (≤132 chars):**
  `Free, on-device screenshots & screen recording — native MP4, webcam bubble, and a built-in video editor. No cloud, no watermark.`
- **Detailed description:**

  ```
  screensnap is a completely free, privacy-first screenshot and screen recorder
  that runs entirely on your machine. No sign-up, no watermark, no cloud, no
  upsell — and nothing you capture ever leaves your computer.

  CAPTURE
  • Visible-tab and full-page screenshots (PNG)
  • Record the current tab to native MP4 (H.264/AAC) — no transcoding, no ffmpeg
  • Screen + Cam: a draggable Loom-style webcam bubble recorded over the page
  • System/tab audio and/or microphone, with pause & resume

  EDIT
  • Trim, change resolution, and change speed
  • Add logos/images and annotations (text, arrows, shapes, blur) as layers
  • Export to MP4, or download the original as-is

  PRIVATE BY DESIGN
  • 100% local: all capture, processing, and storage stay on your device
  • No servers, no telemetry, no analytics, no runtime network calls
  • Minimal permissions — no access to all your sites

  Open source (GPL-3.0).
  ```

- **Privacy policy URL:** _host `PRIVACY.md` and paste the URL here_
  (e.g. GitHub Pages / a gist / the repo's raw file). **Required** because the
  extension uses `tabCapture`.

## Permission justifications (paste into the dashboard)

- **activeTab** — Acts only on the tab you invoke screensnap from: to capture that
  tab and show the on-page recording/annotation overlays. Avoids broad host access.
- **scripting** — Injects the on-page UI (recording countdown + controls, webcam
  bubble, screenshot annotation editor) into that active tab when you start a capture.
- **tabCapture** — Records the current tab's video and audio into a local MP4.
- **offscreen** — Runs MediaRecorder in a hidden offscreen document (a service
  worker has no DOM and the popup closes on blur).
- **downloads** — Saves screenshots and recordings to the user's Downloads folder.
- **storage** — Stores preferences (audio/format options) locally on the device.
- **Host permissions:** none. No `host_permissions`, no `<all_urls>`,
  no `web_accessible_resources`.
- **Remote code:** none. All code (including the bundled Mediabunny library) ships
  inside the package; no `eval`, no remotely-hosted scripts, no WASM.

## Data practices form

- Personally identifiable info: **No**
- Health, financial, authentication, personal communications, location, web
  history, user activity: **No** to all
- Does the extension collect or use user data? **No**
- Certifications (all true):
  - Does **not** sell or transfer user data to third parties (outside approved uses)
  - Does **not** use or transfer data for purposes unrelated to the item's single purpose
  - Does **not** use or transfer data to determine creditworthiness or for lending

## Assets checklist

- [x] Icon 128×128 (`icons/icon-128.png`)
- [ ] 1–5 screenshots, 1280×800 or 640×400 (popup + editor + a recording in progress)
- [ ] Optional: small promo tile 440×280
- [ ] Privacy policy hosted, URL pasted into the listing

## Pre-submission checklist

- [ ] Decide version (currently `0.1.0` — bump to `1.0.0` for first public release)
- [x] `web_accessible_resources` removed (no extension resources exposed to web pages)
- [x] Single-purpose, minimal permissions, no remote code, no WASM
- [x] Privacy policy drafted (`PRIVACY.md`) — needs hosting
- [ ] `node scripts/package.mjs` → upload `dist/screensnap-<version>.zip`
- [ ] $5 one-time developer registration (one account, one-off)
- [ ] Submit; expect one review round (most likely on permissions/privacy)
