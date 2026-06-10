# Vendored third-party code

Committed directly to the repo (no runtime npm install, no bundler) so the
extension loads unpacked with no network fetch — same policy as the Geist fonts
under `src/popup/fonts/`.

## mediabunny.mjs

- **Library:** Mediabunny — pure-TypeScript, zero-dependency, **no-WASM** media
  toolkit (demux / decode / re-encode / mux via the native WebCodecs API).
- **Used for:** the video editor pipeline (`src/editor/pipeline.js`) — reading a
  recorded MP4/WebM, compositing overlay layers onto decoded frames, and
  re-encoding to **MP4 only**.
- **Version (pinned, exact):** `1.46.0`
- **Source:** https://mediabunny.dev — https://github.com/Vanilagy/mediabunny
- **Build file:** `dist/bundles/mediabunny.mjs` (un-minified, self-contained ESM)
  from https://cdn.jsdelivr.net/npm/mediabunny@1.46.0/dist/bundles/mediabunny.mjs
- **License:** MPL-2.0 (Mozilla Public License 2.0). File-level weak copyleft —
  the file is committed unmodified and is not combined into other source files,
  so it does not affect the licensing of the rest of this project.
- **SHA-256:** `9076936d2f02d245630aa4ba2b556fab7c74776a37b66c91003fabd0de9f8d41`

Verify integrity:

```sh
shasum -a 256 src/vendor/mediabunny.mjs
# => 9076936d2f02d245630aa4ba2b556fab7c74776a37b66c91003fabd0de9f8d41

# To re-vendor an updated version, re-download the pinned build and update the
# version + hash above:
curl -s https://cdn.jsdelivr.net/npm/mediabunny@1.46.0/dist/bundles/mediabunny.mjs \
  -o src/vendor/mediabunny.mjs
```

Audited on vendoring: self-contained (no bare/external imports), contains **no**
`eval` / `new Function` / `WebAssembly` (CSP-safe under the default MV3 policy),
and is never given a remote `UrlSource`/`UrlTarget`, so it makes no network calls.
