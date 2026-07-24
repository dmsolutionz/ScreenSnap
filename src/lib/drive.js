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

// True when the manifest carries a real OAuth client id (see docs/DRIVE_SETUP.md).
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

// Drop cached tokens, revoke the grant at Google, and forget everything local. After this the
// extension is back to zero network capability until the user connects again.
export async function driveDisconnect() {
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
  await chrome.storage.local.remove(["driveAccount", "driveFolderId"]);
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

// Find-or-create the "screensnap" folder in My Drive. The id is cached and re-validated so a
// user deleting the folder in Drive just gets a fresh one on the next upload.
async function ensureFolder(token) {
  const { driveFolderId } = await chrome.storage.local.get("driveFolderId");
  if (driveFolderId) {
    const res = await fetch(`${API}/files/${driveFolderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const meta = await res.json();
      if (!meta.trashed) return driveFolderId;
    }
  }
  const q = encodeURIComponent(
    `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' ` +
      `and trashed = false and 'root' in parents`
  );
  const found = await driveFetch(token, `${API}/files?q=${q}&fields=files(id)`).then((r) =>
    r.json()
  );
  let id = found?.files?.[0]?.id;
  if (!id) {
    const created = await driveFetch(token, `${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    }).then((r) => r.json());
    id = created.id;
  }
  await chrome.storage.local.set({ driveFolderId: id });
  return id;
}

// Upload a Blob into the screensnap folder via the resumable protocol, in CHUNK-sized PUTs so
// (a) onProgress gets real ticks — fetch has no upload-progress events and MV3 workers have no
// XHR — and (b) each chunk's in-flight fetch keeps the service worker alive for the duration.
// Resolves to { id, name, webViewLink }.
export async function uploadToDrive(blob, name, { onProgress } = {}) {
  const token = await getToken(false);
  const folderId = await ensureFolder(token);
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
    }
  );
  const session = start.headers.get("Location");
  if (!session) throw new Error("Google Drive did not open an upload session.");

  let offset = 0;
  let attempts = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size);
    let res;
    try {
      res = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${blob.size}` },
        body: blob.slice(offset, end),
      });
    } catch (err) {
      // Network blip: ask the session where it actually got to, then continue from there.
      if (++attempts > 5) throw new Error("Upload failed: network connection lost.");
      await new Promise((r) => setTimeout(r, 1000 * attempts));
      offset = await queryResumeOffset(session, blob.size);
      continue;
    }
    if (res.status === 308) {
      const range = res.headers.get("Range"); // "bytes=0-N" for the bytes Drive has so far
      offset = range ? Number(range.split("-")[1]) + 1 : end;
      attempts = 0;
      onProgress?.(offset, blob.size);
    } else if (res.ok) {
      onProgress?.(blob.size, blob.size);
      return res.json();
    } else if (res.status >= 500 && ++attempts <= 5) {
      await new Promise((r) => setTimeout(r, 1000 * attempts));
      offset = await queryResumeOffset(session, blob.size);
    } else {
      throw new Error(`Upload failed (HTTP ${res.status}).`);
    }
  }
  throw new Error("Upload ended without a confirmation from Google Drive.");
}

// Content-Range "bytes */total" probe: returns the next byte offset the session expects.
async function queryResumeOffset(session, total) {
  const res = await fetch(session, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${total}` },
  }).catch(() => null);
  if (!res) return 0;
  if (res.status === 308) {
    const range = res.headers.get("Range");
    return range ? Number(range.split("-")[1]) + 1 : 0;
  }
  return 0;
}
