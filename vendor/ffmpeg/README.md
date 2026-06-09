# vendor/ffmpeg

This directory holds the **single-thread** [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) core, used
to transcode recorded WebM → MP4 *only* on browsers that can't record MP4 natively (most modern Chrome builds on
macOS/Windows can, so this is a fallback).

The two files below are **not committed** (the `.wasm` alone is ~32 MB). They are fetched and **checksum-verified**
on demand:

```
npm run fetch:ffmpeg
```

| File               | Source (pinned)                                                        |
| ------------------ | ---------------------------------------------------------------------- |
| `ffmpeg-core.js`   | `@ffmpeg/core@0.12.10` · `dist/umd/ffmpeg-core.js`                      |
| `ffmpeg-core.wasm` | `@ffmpeg/core@0.12.10` · `dist/umd/ffmpeg-core.wasm`                    |

Version and SHA-256 hashes are pinned in [`scripts/fetch-ffmpeg.mjs`](../../scripts/fetch-ffmpeg.mjs). The download
fails loudly if a hash doesn't match. To bump the version, change the pin **and** the expected hashes there.

If you skip this step, screenshots and recording still work; recording simply falls back to saving `.webm` when the
browser lacks native MP4 recording.
