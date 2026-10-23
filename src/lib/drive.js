// Google Drive client for the opt-in cloud backup feature.
// Plain fetch against the Drive v3 REST API — no SDK, no external scripts (zero-dependency rule).
// Auth is chrome.identity.getAuthToken with the "drive.file" scope, the narrowest Drive scope there
// is: the extension can only see and touch files it created itself, never the rest of the user's
// Drive. Everything in this module is inert until the user connects Drive in the popup; the
// "identity" permission and the googleapis host permission are optional and requested with that
// click, so a user who never opts in gets an extension that cannot make a network request at all.
// Imported by the service worker (auto-upload after a recording) and the editor page (Save to
// Drive for exports); both are extension contexts where chrome.identity is available.

export const DRIVE_FOLDER_NAME = "screensnap";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// Requested via chrome.permissions.request when the user connects; covers www.googleapis.com
// (Drive API) and oauth2.googleapis.com (token revoke on disconnect).
export const DRIVE_ORIGINS = ["https://*.googleapis.com/*"];

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
// Resumable-upload chunk size. Must be a multiple of 256 KiB per the protocol; 8 MiB keeps the
// number of requests low while still giving usable progress ticks on multi-hundred-MB recordings.
const CHUNK = 8 * 1024 * 1024;

// True when this build can do the OAuth dance at all. Keyed off the manifest, NOT chrome.identity:
// identity is an optional permission, so the namespace doesn't exist until the user grants it —
// checking it here would hide the Connect button forever. A build without the oauth2 manifest
// block (drop it for Firefox, which has no getAuthToken) hides the whole feature.
export function driveSupported() {
  return !!chrome.runtime.getManifest().oauth2;
}

// True when the manifest carries a real OAuth client id.
export function driveConfigured() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || "";
  return !!id && !id.includes("REPLACE");
}

// Connection + preference snapshot for the popup / editor UI.
export async function driveStatus() {
  const { driveAccount } = await chrome.storage.local.get("driveAccount");
  return {
    supported: driveSupported(),
    configured: driveConfigured(),
    connected: !!driveAccount,
    account: driveAccount || null,
  };
}

function tokenFromResult(r) {
  return typeof r === "string" ? r : r?.token || null;
}

async function getToken(interactive) {
  // identity is a required (warning-free) manifest permission, so this only trips on a build for a
  // browser without getAuthToken (Firefox). It was optional once: Chrome doesn't reliably expose a
  // runtime-granted API namespace to an already-running service worker, which broke Connect.
  if (!chrome.identity?.getAuthToken) throw new Error("Google sign-in isn't available in this browser.");
  const result = await chrome.identity.getAuthToken({ interactive: !!interactive });
  const token = tokenFromResult(result);
  if (!token) throw new Error("Google sign-in was not completed.");
  return token;
}

// Interactive connect: runs the Google consent flow, then remembers which account we are backed
// by so the UI can show it. Must run in the service worker — the popup closes when the consent
// window takes focus, which would kill an in-popup flow mid-dance.
export async function driveConnect() {
  const token = await getToken(true);
  const about = await driveFetch(
    token,
    `${API}/about?fields=user(displayName,emailAddress)`
  ).then((r) => r.json());
  const account = about?.user?.emailAddress || about?.user?.displayName || "Google account";
  await chrome.storage.local.set({ driveAccount: account });
  return account;
}

// Disconnect must stop an upload that is already streaming: the resumable session URI needs no bearer
// token, so revoking the grant alone wouldn't. Each upload captures the controller current at its
// start and threads its signal through every fetch; driveDisconnect aborts it (in-flight chunk
// included) and swaps in a fresh one. Uploads running in ANOTHER context (the editor page has its own
// copy of this module) are stopped by the per-chunk driveAccount check in assertLive() instead.
const disconnectedError = () => new DOMException("Drive disconnected", "AbortError");
let uploadAbort = new AbortController();

// Throws the AbortError when this context disconnected or the account is gone (disconnected elsewhere).
async function assertLive(signal) {
  if (signal.aborted) throw signal.reason;
  const { driveAccount } = await chrome.storage.local.get("driveAccount");
  if (!driveAccount) throw disconnectedError();
}

// Drop cached tokens, revoke the grant at Google, and forget everything local. After this the
// extension is back to zero network capability until the user connects again.
export async function driveDisconnect() {
  uploadAbort.abort(disconnectedError());
  uploadAbort = new AbortController();
  try {
    const token = tokenFromResult(await chrome.identity.getAuthToken({ interactive: false }));
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }).catch(() => {});
    }
    await chrome.identity.clearAllCachedAuthTokens?.().catch(() => {});
  } catch {
    // Revoke is best-effort: local state is cleared regardless.
  }
  await chrome.storage.local.remove(["driveAccount", "driveFolderId", "driveFolderName"]);
}

// Base URL of the screensnap share player (docs/v/). The file id (and optional title) ride in the
// URL fragment, so they are never sent to the static host that serves the page.
export const SHARE_BASE = "https://screensnap.xyz/v/";

// Build the share-player URL for a Drive file id, carrying the file name as a title.
export function shareUrl(fileId, name) {
  const title = name ? "&title=" + encodeURIComponent(String(name).replace(/\.[^.]+$/, "")) : "";
  return `${SHARE_BASE}#id=${fileId}${title}`;
}

// Make an app-created file link-shareable: "anyone with the link" can view it, unlisted (not
// searchable). Within the drive.file scope because the extension created the file itself. Idempotent
// enough — re-granting the same public permission is a harmless no-op on Drive's side.
export async function makeShareable(fileId) {
  const token = await getToken(false);
  await driveFetch(token, `${API}/files/${fileId}/permissions?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ role: "reader", type: "anyone", allowFileDiscovery: false }),
  });
}

// fetch wrapper that retries exactly once on 401 with a freshly minted token (cached tokens
// expire after an hour; removeCachedAuthToken + silent getAuthToken transparently renews).
async function driveFetch(token, url, init = {}, isRetry = false) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && !isRetry) {
    await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
    const fresh = await getToken(false);
    return driveFetch(fresh, url, init, true);
  }
  if (!res.ok && res.status !== 308) {
    throw new Error(`Google Drive request failed (HTTP ${res.status}).`);
  }
  return res;
}

// The destination folder name: the user's configured driveFolderName, defaulting to "screensnap".
async function destinationFolderName() {
  const { settings } = await chrome.storage.local.get("settings");
  const name = ((settings && settings.driveFolderName) || DRIVE_FOLDER_NAME).trim();
  return name || DRIVE_FOLDER_NAME;
}

// Find-or-create the destination folder in My Drive, by its configured name. Under drive.file the
// query only ever sees folders screensnap created itself, so renaming to a folder made elsewhere
// makes a fresh one rather than merging into it. The id is cached per name and re-validated, so
// deleting the folder or changing the name just re-resolves on the next upload. Returns { id, name }.
//
// Single-flight: two uploads starting together (auto-backup + an editor export) would otherwise both
// miss the cache, both find nothing, and create two "screensnap" folders. Callers in this context share
// one in-flight resolution; a Web Lock serializes it across contexts (service worker vs editor page),
// so the second one in finds the first one's cached id.
let folderInFlight = null; // { signal, promise }
function ensureFolder(token, signal) {
  if (folderInFlight && folderInFlight.signal === signal) return folderInFlight.promise;
  const run = () => resolveFolder(token, signal);
  const promise = (navigator.locks ? navigator.locks.request("screensnap-drive-folder", { signal }, run) : run())
    .finally(() => { if (folderInFlight && folderInFlight.promise === promise) folderInFlight = null; });
  folderInFlight = { signal, promise };
  return promise;
}

async function resolveFolder(token, signal) {
  const name = await destinationFolderName();
  const cache = await chrome.storage.local.get(["driveFolderId", "driveFolderName"]);
  if (cache.driveFolderId && cache.driveFolderName === name) {
    const res = await fetch(`${API}/files/${cache.driveFolderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (res.ok) {
      const meta = await res.json();
      if (!meta.trashed) return { id: cache.driveFolderId, name };
    }
  }
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' ` +
      `and trashed = false and 'root' in parents`
  );
  const found = await driveFetch(token, `${API}/files?q=${q}&fields=files(id)`, { signal }).then((r) => r.json());
  let id = found?.files?.[0]?.id;
  if (!id) {
    const created = await driveFetch(token, `${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
      signal,
    }).then((r) => r.json());
    id = created.id;
  }
  if (signal.aborted) throw signal.reason; // don't re-cache a folder id after Disconnect cleared it
  await chrome.storage.local.set({ driveFolderId: id, driveFolderName: name });
  return { id, name };
}

// Upload a Blob into the screensnap folder via the resumable protocol, in CHUNK-sized PUTs so
// (a) onProgress gets real ticks — fetch has no upload-progress events and MV3 workers have no
// XHR — and (b) each chunk's in-flight fetch keeps the service worker alive for the duration.
// Resolves to { id, name, webViewLink }.
// Throws a DOMException "AbortError" ("Drive disconnected") if the user disconnects mid-upload.
export async function uploadToDrive(blob, name, { onProgress } = {}) {
  const { signal } = uploadAbort;
  await assertLive(signal);
  const token = await getToken(false);
  const folder = await ensureFolder(token, signal);
  const folderId = folder.id;
  const mime = blob.type || "video/mp4";

  const start = await driveFetch(
    token,
    `${UPLOAD_API}/files?uploadType=resumable&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(blob.size),
        "X-Upload-Content-Type": mime,
      },
      body: JSON.stringify({ name, parents: [folderId], mimeType: mime }),
      signal,
    }
  );
  const session = start.headers.get("Location");
  if (!session) throw new Error("Google Drive did not open an upload session.");

  let offset = 0;
  let attempts = 0;
  const backoff = async () => { await new Promise((r) => setTimeout(r, 1000 * attempts)); if (signal.aborted) throw signal.reason; };
  while (offset < blob.size) {
    await assertLive(signal);
    const end = Math.min(offset + CHUNK, blob.size);
    let res;
    try {
      res = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}` },
        body: blob.slice(offset, end),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      // Network blip: ask the session where it actually got to, then continue from there.
      if (++attempts > 5) throw new Error("Upload failed: network connection lost.");
      await backoff();
      offset = await queryResumeOffset(session, blob.size, signal);
      continue;
    }
    if (res.status === 308) {
      // Progress resets the retry budget; a 308 that didn't move us forward (no Range header = Drive
      // has nothing, so we resend from 0) spends it, so a session that never accepts data can't spin.
      const next = persistedOffset(res);
      if (next > offset) attempts = 0;
      else if (++attempts > 5) throw new Error("Upload failed: Google Drive isn't accepting the data.");
      offset = next;
      onProgress?.(offset, blob.size);
    } else if (res.ok) {
      onProgress?.(blob.size, blob.size);
      const meta = await res.json();
      return { ...meta, folderId, folderName: folder.name };
    } else if (res.status >= 500 && ++attempts <= 5) {
      await backoff();
      offset = await queryResumeOffset(session, blob.size, signal);
    } else {
      throw new Error(`Upload failed (HTTP ${res.status}).`);
    }
  }
  throw new Error("Upload ended without a confirmation from Google Drive.");
}

// Next byte offset from a 308's Range header ("bytes=0-N" for the bytes Drive has persisted). Per the
// resumable protocol a 308 WITHOUT a Range header means no bytes were received at all → 0.
function persistedOffset(res) {
  const range = res.headers.get("Range");
  return range ? Number(range.split("-")[1]) + 1 : 0;
}

// Content-Range "bytes */total" probe: returns the next byte offset the session expects.
async function queryResumeOffset(session, total, signal) {
  const res = await fetch(session, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${total}` },
    signal,
  }).catch(() => null);
  if (signal.aborted) throw signal.reason;
  return res && res.status === 308 ? persistedOffset(res) : 0;
}
