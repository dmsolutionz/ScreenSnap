// Local preview server for docs/ WITH HTTP Range (206) support.
//
// `python3 -m http.server` does not honor Range requests, and Chrome's <video> needs them to play
// and seek MP4 (without Range, seeking is dead and headful Chrome often refuses to start playback at
// all, leaving the play button frozen). Production is fine because GitHub Pages and Google Drive both
// serve Range; this is only for previewing docs/ locally. Zero deps. Run: `npm run preview`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
  ".gif": "image/gif",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = join(DOCS, path);
    if (!file.startsWith(DOCS)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    const type = MIME[extname(path)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": body.length });
      res.end(body);
    }
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`screensnap docs preview (Range-capable) -> ${url}`);
  console.log(`  native player (demo): ${url}/v/#src=${url}/media/screensnap-demo.mp4&title=Demo`);
  console.log(`  empty state:          ${url}/v/`);
  console.log(`  embed (public id):    ${url}/v/#id=DRIVE_FILE_ID`);
  console.log("Ctrl+C to stop.");
});
