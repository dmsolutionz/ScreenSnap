// Build the Chrome Web Store upload zip — exactly what the extension needs at runtime, nothing else.
// No dependencies: shells out to the system `zip`. Usage:  node scripts/package.mjs
import { execSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
process.chdir(root);

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;

// What ships: the manifest, icons, all runtime source (incl. vendored Mediabunny + fonts), and the
// GPL license text. Dev/repo files (README, CLAUDE.md, package.json, scripts/, .git, plans) are left out.
const include = ["manifest.json", "icons", "src", "LICENSE"];
const exclude = ["*.DS_Store", "*.map", "*/.git/*", "*/node_modules/*"];

for (const p of include) {
  if (!existsSync(p)) { console.error(`Missing required path: ${p}`); process.exit(1); }
}

mkdirSync("dist", { recursive: true });
const out = `dist/screensnap-${version}.zip`;
rmSync(out, { force: true });

const cmd = `zip -r -X "${out}" ${include.join(" ")} ${exclude.map((e) => `-x "${e}"`).join(" ")}`;
try {
  execSync(cmd, { stdio: "inherit" });
} catch {
  console.error("\nPackaging failed. Ensure the `zip` command is available on your PATH.");
  process.exit(1);
}

const size = (execSync(`du -h "${out}"`).toString().split("\t")[0] || "").trim();
console.log(`\n✓ Packaged ${out} (${size}) — upload this to the Chrome Web Store.`);
