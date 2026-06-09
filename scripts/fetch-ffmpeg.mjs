#!/usr/bin/env node
// Vendors the single-thread ffmpeg.wasm core into vendor/ffmpeg/ — pinned + checksum-verified.
// Zero dependencies (Node built-ins only). Run once: `npm run fetch:ffmpeg`.
//
// This is the project's ONE external binary. We deliberately do NOT use npm for it: the version
// is pinned below and every byte is SHA-256 verified, so the download can never silently change.
// To bump: change VERSION and BOTH hashes together (get new hashes with `shasum -a 256 <file>`).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = "0.12.10";
const BASE = `https://unpkg.com/@ffmpeg/core@${VERSION}/dist/umd`;

const FILES = [
  {
    name: "ffmpeg-core.js",
    url: `${BASE}/ffmpeg-core.js`,
    sha256: "b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21",
  },
  {
    name: "ffmpeg-core.wasm",
    url: `${BASE}/ffmpeg-core.wasm`,
    sha256: "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
  },
];

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ffmpeg");

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Fetching @ffmpeg/core@${VERSION} (single-thread) …`);

  for (const f of FILES) {
    process.stdout.write(`  ${f.name} … `);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== f.sha256) {
      throw new Error(
        `checksum mismatch for ${f.name}\n  expected ${f.sha256}\n  got      ${got}\n` +
          `Refusing to write. The pinned version may have been republished, or the download is corrupt.`
      );
    }
    writeFileSync(join(OUT_DIR, f.name), bytes);
    console.log(`ok (${(bytes.length / 1e6).toFixed(1)} MB, sha-256 verified)`);
  }
  console.log("Done. MP4 transcoding fallback is now available.");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
