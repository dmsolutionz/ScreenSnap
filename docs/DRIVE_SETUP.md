# Google Drive backup: one-time OAuth setup

The Drive backup feature ships disabled-by-default and needs a Google OAuth client id in
`manifest.json` before the Connect button works. This is a one-time, free setup by the extension
maintainer; users never touch any of this, they just click "Connect Google Drive" in the popup.

Until the placeholder client id is replaced, the popup shows the Drive section as
"not configured in this build" and nothing network-related can run.

## Steps

1. Go to https://console.cloud.google.com/ and create a project (e.g. "screensnap").
2. Enable the **Google Drive API** for the project (APIs & Services, Library, search "Google
   Drive API", Enable).
3. Configure the **OAuth consent screen** (APIs & Services, OAuth consent screen):
   - User type: External.
   - App name "screensnap", support email, developer email.
   - Scopes: add `https://www.googleapis.com/auth/drive.file` only. This is a non-sensitive
     scope (per-file access to files the app created), so no Google security review is needed.
   - Publish the app (leaving it in "Testing" limits sign-ins to allowlisted test users and
     expires refresh grants after 7 days).
4. Create credentials (APIs & Services, Credentials, Create credentials, **OAuth client ID**):
   - Application type: **Chrome Extension**.
   - Item ID: the extension's id. For the published extension that is the Chrome Web Store item
     id. For local development with an unpacked load, pin the id first by adding the `key` field
     to `manifest.json` (copy the "public key" Chrome shows on chrome://extensions after packing,
     or reuse the store key) so the unpacked id matches.
5. Copy the generated client id (ends in `.apps.googleusercontent.com`) into the `oauth2.client_id`
   field of `manifest.json`, replacing the `REPLACE_WITH_OAUTH_CLIENT_ID` placeholder.

## What the extension does with it

- Scope is `drive.file` only: screensnap can create files and see the files it created, and
  nothing else in the user's Drive.
- Uploads go to a "screensnap" folder in My Drive, private to the user's account.
- Auth and uploads talk directly to `googleapis.com` from the user's browser. There is no
  intermediary server and nothing is proxied.
- The `identity` permission ships in the manifest (Chrome shows no warning for it, and it grants
  nothing by itself; it cannot be an optional permission because Chrome doesn't reliably expose a
  runtime-granted API namespace to a running service worker). The `https://*.googleapis.com/*`
  host permission is optional and only requested when the user clicks Connect. Disconnecting
  revokes the grant at Google and clears everything local.
