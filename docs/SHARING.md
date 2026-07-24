# Sharing recordings without a third-party service: design notes

Where sharing could go after the v1 Google Drive backup. The bar every option must clear (from
CLAUDE.md): free and unrestricted, privacy-first, no screensnap servers, no telemetry, zero runtime
npm dependencies, and no network activity for users who never opt in. "Without another third-party
service" here means: no Loom-style hosted middleman that sees the videos, holds the accounts, or
can paywall the feature later. Storage the user already owns (their Drive, their own server) is
fair game when they explicitly connect it.

## Where v1 leaves us

The Drive backup uploads recordings to a private "screensnap" folder in the user's own Drive
(scope `drive.file`, direct browser-to-Google, opt-in). Sharing today is manual: open the file in
Drive and use Google's own sharing UI. That already works, but it is outside the product.

## Option A: Drive-native sharing (near term, cheap)

Build sharing on the plumbing v1 already has. The `drive.file` scope allows managing permissions
on files the extension created, so after an upload the extension can:

- **Copy share link**: one click flips the uploaded file to "anyone with the link can view" via
  the Drive permissions API and puts the `webViewLink` on the clipboard. Drive's built-in player
  streams the MP4, so recipients need nothing installed.
- **Share to specific people**: enter teammate emails once; each upload adds reader permissions
  for them. Google enforces access (viewers sign in with their Google account), and revoking is
  deleting the permission or the file.
- **Team folder**: point uploads at a folder inside a Google Shared Drive (or a folder the user
  shared with the team once). Every teammate's uploads land in one place the whole team can see,
  which is most of what a company wants from Loom.

Trade-offs: Google can read the content (it is the user's chosen storage, but not end-to-end
private), and restricted sharing requires recipients to have Google accounts. Effort is small:
a handful of extra Drive API calls and a "Sharing" row in the popup.

## Option B: End-to-end encrypted share links (recommended direction)

Make the storage blind. The extension encrypts locally, uploads only ciphertext, and the key
never touches any server:

- **Encrypt**: WebCrypto AES-GCM 256 with a random per-clip key, encrypting in chunks (a few MB
  each, sequence-numbered IVs so chunks cannot be reordered; GCM's auth tag gives integrity for
  free). Pure browser crypto, zero dependencies, no WASM.
- **Store**: the ciphertext is just a file, so any dumb storage works. Reuse the v1 Drive
  plumbing: upload the encrypted blob, flip it to "anyone with the link". Google now hosts bytes
  it cannot read.
- **Link**: the share link carries the decryption key in the URL fragment
  (`...#k=<base64url-key>`). Fragments are never sent in HTTP requests, so neither Google nor
  anything in between ever sees the key. Possession of the full link is the capability.
- **View**: a viewer page in the extension fetches the ciphertext, decrypts, and plays. For
  recipients without screensnap, offer "export encrypted bundle": the ciphertext plus a small
  self-contained local HTML decryptor (same from-scratch spirit as the GIF encoder). Installing
  screensnap (free, no sign-up) stays the smooth path, which is fine: it is the product.
- **Revoke**: delete the ciphertext file. **Rotate**: re-encrypt and share a new link.

Honest limits: whoever obtains the link can watch (send it over a channel you trust), and there
is no per-viewer audit trail. But this is exactly the Firefox Send / Wormhole model: simple,
provably private, no accounts, no middleman that can read anything.

## Option C: Direct peer-to-peer handoff (no storage at all)

For "send this take to one colleague right now": a WebRTC data channel is end-to-end encrypted
(DTLS) and needs no storage, but it does need signaling. Truly serverless signaling means both
people are online and paste short offer/answer codes (or scan a QR) to connect, after which the
file streams browser-to-browser, even across networks (STUN only, public stateless servers).
Verdict: genuinely zero-infrastructure and a great fit for the brand, but the copy-paste dance is
clunky and it does not cover async sharing, which is the main Loom use case. Worth building only
as a complement after B, not instead of it.

## Option D: Self-hosted team vault (for Google-free teams)

Some companies will not touch Google. Give them a "custom endpoint" option: a deliberately tiny,
separate, open-source server (single binary or a Cloudflare Worker on the team's own account)
that stores encrypted blobs and knows nothing else. Combine with B so the vault is untrusted
storage too, and add a team roster of public keys (WebCrypto ECDH): the uploader wraps the clip
key for each teammate, so only the roster can decrypt and the server never can. The extension
side is just a base URL setting on top of B's crypto; the server lives in its own repo so this
repo keeps its zero-dependency rule. Most effort, smallest audience, so last.

## Recommended phasing

1. **v1 (this branch)**: Drive backup, auto-upload, private files.
2. **v1.5**: Option A. Copy-share-link and a team folder setting are days of work on existing
   plumbing and deliver most of the "share with my team" value immediately.
3. **v2**: Option B. Encrypted share links plus the in-extension viewer make screensnap the
   private alternative to Loom: shareable links where even the storage provider cannot watch.
4. **Later, if pulled**: Option D for self-hosted teams, Option C as an instant-handoff extra.

Every phase keeps the core promise: off by default, the user's own storage, no screensnap
servers, nothing to pay for, and nothing new to trust.
