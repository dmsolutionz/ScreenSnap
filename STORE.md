# Chrome Web Store submission guide

Everything needed to list screensnap. Build the upload with `node scripts/package.mjs`
→ `dist/screensnap-<version>.zip`.

## Single purpose

> Capture screenshots and screen/tab recordings and edit them locally — entirely
> on the user's machine, with no cloud, accounts, or data collection.

## Listing

- **Name:** screensnap
- **Category:** Productivity → Tools
- **Language:** English
- **Summary:** comes from the manifest `description` (≤132 chars, not editable in the
  dashboard): `Free, local, watermark-free screenshots and screen recording. Native MP4,
  all on your machine — no sign-up, no cloud, no upsell.`
- **Homepage URL:** `https://github.com/dmsolutionz/ScreenSnap`
- **Support URL / item support:** leave blank / off
- **Detailed description:**

  ```
  Screen recording shouldn't cost money, slap a watermark on your video, or make
  you create an account. screensnap records your screen and tabs for free — with
  no time limit, no watermark, no sign-up, and no cloud. Everything stays on your
  machine.

  FREE, UNLIMITED RECORDING
  • Record any tab to native MP4 (H.264/AAC) — no time limit, no watermark, ever
  • Screen + Cam: a draggable Loom-style webcam bubble recorded over the page
  • System/tab audio and/or microphone, with pause & resume
  • No account, no upgrade prompts, no "pro" tier — it's all just free

  BUILT-IN VIDEO EDITOR (also free)
  • Trim, change resolution, and change speed
  • Add logos/images and annotations (text, arrows, shapes, blur) as layers
  • Export to MP4, or download the original as-is

  SCREENSHOTS
  • Visible-tab and full-page screenshots (PNG), with an annotation editor

  PRIVATE BY DESIGN
  • 100% local: all capture, processing, and storage stay on your device
  • No servers, no telemetry, no analytics, no runtime network calls
  • Minimal permissions — no access to all your sites

  Free and open source (GPL-3.0). No catch.
  ```

- **Privacy policy URL:** `https://dmsolutionz.github.io/ScreenSnap/`
  (served from `docs/index.html`). Enable once: repo **Settings → Pages → Source:
  `main` branch, `/docs` folder**. **Required** because the extension uses `tabCapture`.

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

Run `node scripts/make-store-assets.mjs` → everything lands in `dist/store-assets/`
(the store rejects PNGs with an alpha channel; the script flattens them to 24-bit RGB).

- [x] Store icon (`dist/store-assets/store-icon-128.png` — 96px mark padded to 128 per guidelines)
- [x] Screenshots, 1280×800 no-alpha (`dist/store-assets/screenshots/` — upload at most 5)
- [x] Small promo tile 440×280 (`dist/store-assets/promo-small-440x280.png`)
- [x] Marquee promo tile 1400×560 (`dist/store-assets/promo-marquee-1400x560.png`)
- [x] Privacy policy hosted at `https://dmsolutionz.github.io/ScreenSnap/` (GitHub Pages, live)

## Pre-submission checklist

- [x] Version set to `1.0.0` for first public release
- [x] `web_accessible_resources` removed (no extension resources exposed to web pages)
- [x] Single-purpose, minimal permissions, no remote code, no WASM
- [x] Privacy policy drafted (`PRIVACY.md`) — needs hosting
- [ ] `node scripts/package.mjs` → upload `dist/screensnap-<version>.zip`
- [ ] $5 one-time developer registration (one account, one-off)
- [ ] Submit; expect one review round (most likely on permissions/privacy)
