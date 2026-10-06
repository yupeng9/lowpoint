// Stamps sw.js with a VERSION derived from the content of every file it precaches, so each deploy gets its
// own cache and the files are swapped in together.   node scripts/bump-sw.mjs   (run from anywhere)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function precacheFiles(swSource) {
  const list = /const FILES = \[([\s\S]*?)\];/.exec(swSource);
  if (!list) throw new Error("FILES array not found in sw.js");
  return [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

export function computeVersion(rootDir) {
  const files = precacheFiles(readFileSync(join(rootDir, "sw.js"), "utf8"));
  const hash = createHash("sha256");
  for (const f of files) {
    if (f === "./" || f === "sw.js") continue;
    hash.update(f + "\0");
    hash.update(readFileSync(join(rootDir, f)));
  }
  return hash.digest("hex").slice(0, 12);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const swPath = join(root, "sw.js");
  const version = computeVersion(root);
  const src = readFileSync(swPath, "utf8");
  const next = src.replace(/^const VERSION = ".*";$/m, `const VERSION = "${version}";`);
  if (next === src && !src.includes(`"${version}"`)) throw new Error("VERSION line not found in sw.js");
  writeFileSync(swPath, next);
  console.log(`sw.js VERSION = ${version}`);
}
