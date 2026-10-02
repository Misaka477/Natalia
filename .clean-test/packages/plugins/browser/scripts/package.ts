/**
 * Package the Natalia Browser Bridge extensions for store upload.
 *
 * Outputs:
 *   packages/plugins/browser/dist/natalia-browser-bridge-chromium.zip
 *   packages/plugins/browser/dist/natalia-browser-bridge-firefox.zip
 */
import {
  mkdir,
  readdir,
  rm,
  writeFile,
  copyFile,
  readFile,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "dist");
const TMP = join(OUT_DIR, ".tmp");

async function copyDir(src: string, dest: string) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await copyFile(from, to);
  }
}

async function zip(src: string, out: string) {
  const result = spawnSync("zip", ["-qr", out, "."], {
    cwd: src,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`zip failed: ${result.status}`);
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const chromiumSrc = join(ROOT, "src/extension/chromium");
  const firefoxSrc = join(ROOT, "src/extension/firefox");

  const chromiumTmp = join(TMP, "chromium");
  const firefoxTmp = join(TMP, "firefox");
  await copyDir(chromiumSrc, chromiumTmp);
  await copyDir(firefoxSrc, firefoxTmp);

  const chromiumOut = join(OUT_DIR, "natalia-browser-bridge-chromium.zip");
  const firefoxOut = join(OUT_DIR, "natalia-browser-bridge-firefox.zip");

  await zip(chromiumTmp, chromiumOut);
  await zip(firefoxTmp, firefoxOut);
  await rm(TMP, { recursive: true, force: true });
  console.log(`Created ${chromiumOut}`);
  console.log(`Created ${firefoxOut}`);
}

await main();
