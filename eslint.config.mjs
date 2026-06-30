// Lint config. The ONE job we care about here is catching undefined-identifier references
// (`no-undef`) — e.g. a render helper used in a template literal but never declared — so a
// `ReferenceError: x is not defined` can never reach the shipped extension. This is a DEV-ONLY tool
// (in devDependencies); it is not part of the unpacked extension and changes nothing about what ships.
//
// Globals are merged across every environment the codebase runs in (page DOM, service worker, web
// worker / offscreen, the chrome.* extension APIs, and Node for the build scripts) plus a few recent
// browser APIs the `globals` package doesn't track yet, so genuine platform globals don't false-flag.
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "src/vendor/**", "icons/**"] },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.worker,
        ...globals.webextensions,
        ...globals.node,
        // Recent media/codec APIs used by the recorder + editor that `globals` may not list yet.
        ImageDecoder: "readonly",
        VideoFrame: "readonly",
        AudioData: "readonly",
        EncodedVideoChunk: "readonly",
        EncodedAudioChunk: "readonly",
        MediaStreamTrackProcessor: "readonly",
        OffscreenCanvas: "readonly",
        ClipboardItem: "readonly",
      },
    },
    rules: {
      // The guardrail this config exists for. Everything else is intentionally left off so the check
      // stays focused and noise-free.
      "no-undef": "error",
    },
  },
];
