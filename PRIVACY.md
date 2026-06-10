# screensnap — Privacy Policy

_Last updated: 2026-06-10_

**screensnap collects no data. None of your activity, captures, or recordings
ever leave your computer.**

## What screensnap does

screensnap captures screenshots and screen/tab recordings and lets you annotate
and edit them. Every part of this — capture, the webcam bubble, annotation, video
trimming/encoding, and saving — happens **entirely on your own machine, inside
your browser**.

## Data we collect

**Nothing.** screensnap has:

- **No servers.** There is no backend; the extension never sends your data
  anywhere.
- **No telemetry or analytics.** We do not track usage, clicks, or any behavior.
- **No accounts or sign-in.** There is nothing to log in to.
- **No network requests at runtime.** The extension and its one bundled library
  (Mediabunny, for local video encoding) are shipped inside the extension; nothing
  is fetched from the internet while you use it.

## Where your captures and recordings go

- **Screenshots and recordings** are saved to your browser's **Downloads** folder,
  exactly like any other file you download. They are never uploaded.
- A just-finished recording is held **temporarily in your browser's local storage
  (IndexedDB)** only so the editor can open it; it stays on your device.
- **Settings** (e.g. your audio/format preferences) are stored locally via Chrome's
  `storage` API on your device.

## Permissions and why they are needed

- **`tabCapture`** — to record the current browser tab's video and audio. Local only.
- **`activeTab` + `scripting`** — to show the capture/recording overlays (countdown,
  webcam bubble, annotation editor) on the page you invoked screensnap on.
- **`offscreen`** — to run the recorder (which needs a hidden document with media
  access) in the background.
- **`downloads`** — to save your screenshots and recordings to your Downloads folder.
- **`storage`** — to remember your preferences locally.
- **Camera / microphone** (requested only when you choose them) — to include your
  webcam and voice in a recording. These streams are processed locally and never
  transmitted.

## Children's privacy

screensnap does not collect any data from anyone, including children.

## Changes to this policy

If this policy ever changes, the updated version will be published at the same URL.

## Contact

Questions about privacy: **help@dmsolutions.io**
