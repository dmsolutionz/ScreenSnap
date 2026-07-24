# screensnap — Privacy Policy

_Last updated: 2026-07-24_

**screensnap collects no data. None of your activity, captures, or recordings
leave your computer — unless you explicitly connect your own Google Drive for
backups, in which case only the recordings you upload go there, directly, and
nowhere else.**

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
  is fetched from the internet while you use it. The one exception is the optional
  Google Drive backup below, which is off until you connect it and only ever talks
  to Google's own API.

## Where your captures and recordings go

- **Screenshots and recordings** are saved to your browser's **Downloads** folder,
  exactly like any other file you download. They are never uploaded.
- A just-finished recording is held **temporarily in your browser's local storage
  (IndexedDB)** only so the editor can open it; it stays on your device.
- **Settings** (e.g. your audio/format preferences) are stored locally via Chrome's
  `storage` API on your device.

## Optional Google Drive backup (off by default)

If you choose to connect Google Drive in the popup, screensnap can upload
recordings to a private "screensnap" folder in **your own** Google Drive:

- It is **opt-in twice over**: nothing happens until you click Connect and approve
  Google's consent screen, and auto-upload is a separate toggle that starts off.
- Uploads go **directly from your browser to Google's Drive API**. There is no
  screensnap server, no proxy, no intermediary of any kind, and we never see your
  files or your account.
- screensnap uses the narrowest Drive permission Google offers (`drive.file`):
  it can only see the files it created itself, never the rest of your Drive.
- Uploaded files are **private to your Google account** by default; sharing them
  is entirely under your control in Google Drive.
- Disconnecting revokes screensnap's access at Google and deletes everything it
  stored about the connection. Your Google account is otherwise untouched.

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
- **`identity`** — Chrome's sign-in plumbing for the optional Google Drive backup.
  It sits unused (and causes no Google traffic at all) until you click Connect;
  Chrome shows no permission warning for it because by itself it grants access to
  nothing.
- **Access to `googleapis.com`** (optional) — requested only when you connect
  Google Drive, to upload recordings to your own Drive. Never requested otherwise.

## Children's privacy

screensnap does not collect any data from anyone, including children.

## Changes to this policy

If this policy ever changes, the updated version will be published at the same URL.

## Contact

Questions about privacy: **help@dmsolutions.io**
