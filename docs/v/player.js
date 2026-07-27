"use strict";

/**
 * screensnap share player
 * -----------------------
 * Drives the branded viewer at screensnap.xyz/v/. The share link is
 *   screensnap.xyz/v/#id=DRIVE_FILE_ID   (optionally &title=... and &t=SECONDS)
 * or, to preview / natively play any file, #src=DIRECT_VIDEO_URL.
 *
 * Everything after the # is a URL fragment, which the browser never sends to a
 * server, so this static host logs nothing about which recording is watched; the
 * bytes stream from the sharer's own Google Drive. The page stores nothing and,
 * apart from the media itself, calls nothing.
 *
 * Playback modes:
 *  - Native: a real <video> with the full custom control bar. Needs the video
 *    bytes, via a direct #src, or via the Drive API when DRIVE_API_KEY is set.
 *  - Embed:  Google's Drive preview iframe. Used when only an id is available and
 *    no API key is configured. Branded, but Google owns the in-frame controls.
 */
(() => {
  // ---- Configuration -------------------------------------------------------

  /**
   * Optional Google API key (Drive API enabled, restricted to the screensnap.xyz
   * HTTP referrer). Setting it enables the native player and metadata row for #id
   * links. It only ever reads files already shared "anyone with link", so it is
   * safe to ship in the page.
   * @type {string}
   */
  const DRIVE_API_KEY = "";

  const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2];
  const IDLE_HIDE_MS = 2500; // hide overlay controls after this idle span while playing
  const FLASH_MS = 1600; // how long copy confirmations stay visible
  const TOAST_MS = 1800;
  const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

  /** Inline check icon for the copied state (a drawn icon, not a text glyph). */
  const CHECK_SVG =
    '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7.5l3.2 3.2L12 3.5"></path></svg>';

  // The recording id lives in the URL fragment, so navigating between share links (and back/forward)
  // only changes the hash, which never reloads the page. Force a reload so the new recording loads
  // instead of the page appearing to do nothing.
  window.addEventListener("hashchange", () => location.reload());

  // ---- Link parameters + shared state -------------------------------------

  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fileId = params.get("id") || "";
  const directSrc = params.get("src") || "";
  const linkTitle = params.get("title") || "";
  const startAt = Number.parseFloat(params.get("t") || "") || 0;

  const hasId = DRIVE_ID_PATTERN.test(fileId);
  const hasSrc = /^https?:\/\//i.test(directSrc);

  /** Metadata row values, filled in from the video element and (optionally) Drive. */
  const meta = { duration: "", resolution: "", size: "", date: "" };

  // ---- Entry ---------------------------------------------------------------

  if (!hasId && !hasSrc) {
    byId("empty").hidden = false;
    return;
  }
  byId("card").hidden = false;

  if (linkTitle) setTitle(linkTitle);
  setupHeaderLinks();
  wireCopyLink();

  // Prefer the native player when we have playable bytes; otherwise embed.
  const nativeSrc = hasSrc ? directSrc : DRIVE_API_KEY ? driveMediaUrl(fileId) : "";

  if (nativeSrc) {
    initNativePlayer(nativeSrc);
    if (hasId && DRIVE_API_KEY) loadDriveMetadata();
  } else {
    initEmbedPlayer();
  }

  // ---- Small helpers -------------------------------------------------------

  /** @param {string} id */
  function byId(id) {
    return document.getElementById(id);
  }

  /** @param {string} id @returns {string} Drive API media URL for a public file. */
  function driveMediaUrl(id) {
    return `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
  }

  /** @param {number} secs @returns {string} m:ss */
  function formatTime(secs) {
    const t = Math.max(0, secs || 0);
    const minutes = Math.floor(t / 60);
    const seconds = Math.floor(t % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  /** @param {string} text */
  function setTitle(text) {
    byId("vtitle").textContent = text;
    document.title = `${text} · screensnap`;
  }

  function setupHeaderLinks() {
    if (hasId) {
      byId("download").href = `https://drive.google.com/uc?export=download&id=${fileId}`;
      byId("openDrive").href = `https://drive.google.com/file/d/${fileId}/view`;
    } else {
      byId("download").href = directSrc;
      byId("openDrive").style.display = "none";
    }
  }

  // ---- Clipboard -----------------------------------------------------------

  /**
   * Copy text to the clipboard. Prefers the async Clipboard API on secure origins
   * and falls back to a hidden-textarea execCommand path so copy still works on
   * plain-http origins where navigator.clipboard is unavailable.
   * @param {string} text @returns {Promise<boolean>} resolves true on success
   */
  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => execCommandCopy(text));
    }
    return Promise.resolve(execCommandCopy(text));
  }

  /** Legacy clipboard path via a hidden textarea. @param {string} text @returns {boolean} */
  function execCommandCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  let toastEl = null;
  let toastTimer = 0;
  /** Show a brief confirmation toast, reusing a single element. @param {string} message */
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth; // restart the enter transition
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), TOAST_MS);
  }

  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  }

  function wireCopyLink() {
    const btn = byId("copy");
    // On touch devices with the Web Share API, open the native share sheet; elsewhere copy the link.
    const useShare = typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches;
    if (useShare) btn.textContent = "Share";
    const idle = btn.innerHTML;
    btn.addEventListener("click", () => {
      if (useShare) {
        navigator.share({ title: shareTitle(), url: location.href }).catch(() => {});
        return;
      }
      copyToClipboard(location.href).then((ok) => {
        if (!ok) {
          showToast(`Press ${isMac() ? "Cmd" : "Ctrl"}+C to copy the link`);
          return;
        }
        btn.classList.add("copied");
        btn.innerHTML = `${CHECK_SVG}Copied`;
        showToast("Link copied to clipboard");
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = idle;
        }, FLASH_MS);
      });
    });
  }

  function shareTitle() {
    return document.title.replace(/ · screensnap$/, "") || "Shared with screensnap";
  }

  // ---- Metadata row --------------------------------------------------------

  function renderMeta() {
    const parts = [meta.duration, meta.resolution, meta.size, meta.date].filter(Boolean);
    byId("vmeta").innerHTML = parts
      .map((part, i) => `${i ? "<span>·</span> " : ""}<span>${part}</span>`)
      .join(" ");
  }

  /** @param {number|string} bytes */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!n) return "";
    const mb = n / (1024 * 1024);
    return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
  }

  /** @param {string} iso */
  function formatDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  /** Fetch name / size / date from Drive (native mode with an API key only). */
  function loadDriveMetadata() {
    const url =
      `https://www.googleapis.com/drive/v3/files/${fileId}` +
      `?fields=name,size,createdTime,videoMediaMetadata&key=${encodeURIComponent(DRIVE_API_KEY)}`;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        if (!linkTitle && data.name) setTitle(data.name.replace(/\.[^.]+$/, ""));
        meta.size = formatBytes(data.size);
        meta.date = formatDate(data.createdTime);
        renderMeta();
      })
      .catch(() => {});
  }

  // ---- Native player -------------------------------------------------------

  /** @param {string} src */
  function initNativePlayer(src) {
    const stage = byId("stage");
    const video = document.createElement("video");
    video.className = "media";
    video.src = src;
    video.preload = "metadata";
    video.playsInline = true;
    stage.insertBefore(video, stage.firstChild);
    stage.classList.remove("empty-bg");

    const ui = {
      clickLayer: byId("clicklayer"),
      bigPlay: byId("bigplay"),
      controls: byId("controls"),
      iconPlay: byId("ic-play"),
      iconPause: byId("ic-pause"),
      current: byId("cur"),
      duration: byId("dur"),
      fill: byId("fill"),
      knob: byId("knob"),
      scrub: byId("scrub"),
      speed: byId("speed"),
      stamp: byId("stamp"),
      mute: byId("mute"),
      fullscreen: byId("fs"),
      playToggle: byId("playToggle"),
    };
    ui.clickLayer.hidden = false;
    ui.controls.hidden = false;
    ui.bigPlay.hidden = false;

    let speedIndex = 0;
    let stampCopied = false;
    let idleTimer = 0;

    const togglePlay = () => (video.paused ? video.play() : video.pause());

    const reflectPlayState = () => {
      const playing = !video.paused && !video.ended;
      // Toggle the two control-bar icons with inline display, not the hidden attribute: they start
      // hidden, and the global [hidden]{display:none!important} rule would otherwise pin them off.
      ui.iconPlay.style.display = playing ? "none" : "block";
      ui.iconPause.style.display = playing ? "block" : "none";
      ui.bigPlay.hidden = playing;
    };

    // Auto-hide the overlay controls during playback so they never cover the footage.
    const showControls = () => {
      stage.classList.remove("hide-ui");
      clearTimeout(idleTimer);
      if (!video.paused) {
        idleTimer = setTimeout(() => {
          if (!video.paused) stage.classList.add("hide-ui");
        }, IDLE_HIDE_MS);
      }
    };
    const hideControlsIfPlaying = () => {
      if (!video.paused) stage.classList.add("hide-ui");
    };

    stage.addEventListener("pointermove", showControls);
    stage.addEventListener("pointerleave", hideControlsIfPlaying);

    video.addEventListener("play", () => {
      reflectPlayState();
      showControls();
    });
    video.addEventListener("pause", () => {
      reflectPlayState();
      stage.classList.remove("hide-ui");
      clearTimeout(idleTimer);
    });
    video.addEventListener("ended", reflectPlayState);

    // If the native stream cannot play (e.g. the source will not serve byte ranges), fall back to
    // Google's embed for a Drive id, or surface a message for a direct src, rather than freezing.
    video.addEventListener("error", () => {
      if (hasId) {
        video.remove();
        initEmbedPlayer();
      } else {
        showToast("This video could not be played");
      }
    });

    video.addEventListener("loadedmetadata", () => {
      ui.duration.textContent = formatTime(video.duration);
      meta.duration = formatTime(video.duration);
      if (video.videoWidth) meta.resolution = `${video.videoWidth} × ${video.videoHeight}`;
      renderMeta();
      if (startAt > 0) {
        try {
          video.currentTime = startAt;
        } catch {
          /* seeking may fail before the media is ready; ignore */
        }
      }
    });

    video.addEventListener("timeupdate", () => {
      if (!video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      ui.fill.style.width = `${pct}%`;
      ui.knob.style.left = `${pct}%`;
      ui.current.textContent = formatTime(video.currentTime);
      if (!stampCopied) ui.stamp.textContent = `link @ ${formatTime(video.currentTime)}`;
    });

    ui.clickLayer.addEventListener("click", togglePlay);
    ui.bigPlay.addEventListener("click", togglePlay);
    ui.playToggle.addEventListener("click", togglePlay);

    // Scrubber: click and drag to seek.
    let dragging = false;
    const seekToClientX = (clientX) => {
      const rect = ui.scrub.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (video.duration) video.currentTime = p * video.duration;
      ui.fill.style.width = `${p * 100}%`;
      ui.knob.style.left = `${p * 100}%`;
    };
    ui.scrub.addEventListener("pointerdown", (e) => {
      dragging = true;
      try {
        ui.scrub.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer; capture is best-effort */
      }
      seekToClientX(e.clientX);
    });
    ui.scrub.addEventListener("pointermove", (e) => {
      if (dragging) seekToClientX(e.clientX);
    });
    ui.scrub.addEventListener("pointerup", () => {
      dragging = false;
    });

    ui.speed.addEventListener("click", () => {
      speedIndex = (speedIndex + 1) % PLAYBACK_SPEEDS.length;
      video.playbackRate = PLAYBACK_SPEEDS[speedIndex];
      ui.speed.textContent = `${PLAYBACK_SPEEDS[speedIndex]}×`;
    });

    ui.stamp.addEventListener("click", () => {
      const base = location.href.split("#")[0];
      const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
      frag.set("t", String(Math.floor(video.currentTime)));
      copyToClipboard(`${base}#${frag.toString()}`).then((ok) => {
        stampCopied = true;
        ui.stamp.classList.toggle("copied", ok);
        ui.stamp.textContent = ok ? "copied" : "copy failed";
        if (ok) showToast("Timestamped link copied");
        setTimeout(() => {
          stampCopied = false;
          ui.stamp.classList.remove("copied");
          ui.stamp.textContent = `link @ ${formatTime(video.currentTime)}`;
        }, FLASH_MS);
      });
    });

    ui.mute.addEventListener("click", () => {
      video.muted = !video.muted;
      ui.mute.style.opacity = video.muted ? "0.3" : "1";
    });

    ui.fullscreen.addEventListener("click", () => {
      const req = document.fullscreenElement
        ? document.exitFullscreen()
        : stage.requestFullscreen && stage.requestFullscreen();
      if (req && typeof req.catch === "function") req.catch(() => {});
    });

    // Keyboard shortcuts (native player only; the embed uses Google's own).
    document.addEventListener("keydown", (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          if (video.duration) video.currentTime = Math.min(video.duration, video.currentTime + 5);
          break;
        case "ArrowLeft":
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case "f":
          ui.fullscreen.click();
          break;
        case "m":
          ui.mute.click();
          break;
        default:
          break;
      }
    });

    reflectPlayState();
  }

  // ---- Embed fallback ------------------------------------------------------

  /**
   * Google's Drive preview iframe. Our overlay controls stay hidden because they
   * cannot drive a cross-origin frame, and the title overlay is hidden too so it
   * does not collide with Google's own in-frame chrome.
   */
  function initEmbedPlayer() {
    const stage = byId("stage");
    stage.classList.remove("empty-bg");

    const frame = document.createElement("iframe");
    frame.className = "media";
    frame.src = `https://drive.google.com/file/d/${fileId}/preview`;
    frame.setAttribute("allow", "autoplay; fullscreen");
    frame.setAttribute("allowfullscreen", "");
    stage.insertBefore(frame, stage.firstChild);

    byId("controls").hidden = true;
    byId("bigplay").hidden = true;
    byId("clicklayer").hidden = true;
    stage.querySelector(".ovl-top").hidden = true;
  }
})();
