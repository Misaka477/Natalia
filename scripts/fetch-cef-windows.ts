/**
 * Fetches the Windows CEF binary distribution into `.cef-windows/`.
 *
 * Why a fetch and not a vendor: libcef is a per-platform build of Chromium —
 * roughly a gigabyte of binaries nobody commits, and nobody can rebuild on a
 * coding-agent's timeline. The repository already carries the Linux
 * distribution in `.cef-test/` (git-ignored, dropped by hand); this script is
 * the same act for Windows, with the one thing a hand-drop cannot promise: the
 * VERSION MATCHES.
 *
 * The version is read from the Linux distribution's own `include/cef_version.h`
 * and the Windows archive's name is derived from it, so a mismatch is a
 * compile-time-shaped failure ("the SDK is 152.0.6+g708dc14") rather than a
 * link error about missing CEF symbols.
 *
 *   bun scripts/fetch-cef-windows.ts [--force]
 *
 * The archive comes from Spotify's CEF builds CDN, the same mirror the CEF
 * project points at for binary distributions.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const linuxSdk = join(root, ".cef-test");
const target = join(root, ".cef-windows");
const force = process.argv.includes("--force");

/** The vendored Linux distribution's CEF version, from its own header. */
function linuxCefVersion(): string {
  const header = join(linuxSdk, "include", "cef_version.h");
  if (!existsSync(header))
    throw new Error(
      `no CEF version to match: ${header} is absent — the Linux distribution (.cef-test) must be present first`,
    );
  const source = require("node:fs").readFileSync(header, "utf8") as string;
  const match = /#define CEF_VERSION "([^"]+)"/u.exec(source);
  if (!match) throw new Error(`${header} does not define CEF_VERSION`);
  return match[1]!;
}

/**
 * `152.0.6+g708dc14+chromium-152.0.7977.83` → the archive's coordinates:
 * the version (`152.0.6`) and the commit hash (`g708dc14`).
 */
function archiveCoordinates(cefVersion: string) {
  const match = /^(\d+\.\d+\.\d+)\+g([0-9a-f]+)\+chromium-/u.exec(cefVersion);
  if (!match)
    throw new Error(
      `cannot derive the archive name from CEF_VERSION ${cefVersion}`,
    );
  return { version: match[1]!, hash: `g${match[2]!}` };
}

/** The shape check the coordinates above enforce, kept as a guard on the input. */
const cefVersion = linuxCefVersion();
archiveCoordinates(cefVersion);
const platform = "windows64";
// The CDN's archive name carries the FULL CEF_VERSION with its `+`
// separators URL-encoded, e.g.
// cef_binary_152.0.6%2Bg708dc14%2Bchromium-152.0.7977.83_windows64_minimal.tar.bz2
// — the version and the git hash alone (joined with `_`) 404s.
const archiveName = `cef_binary_${cefVersion.replace(/\+/gu, "%2B")}_${platform}_minimal.tar.bz2`;
const downloadURL = `https://cef-builds.spotifycdn.com/${archiveName}`;
const sha256URL = `${downloadURL}.sha256`;

if (existsSync(join(target, "include", "cef_version.h"))) {
  if (!force) {
    const present = readFileSyncSafe(join(target, "include", "cef_version.h"));
    const match = /#define CEF_VERSION "([^"]+)"/u.exec(present);
    if (match && match[1] === cefVersion) {
      console.log(
        `[fetch-cef] ${platform} already at ${cefVersion} (--force to replace)`,
      );
      process.exit(0);
    }
    console.log(
      `[fetch-cef] ${platform} is at ${match?.[1] ?? "unknown"}; replacing with ${cefVersion}`,
    );
  }
  await rm(target, { recursive: true, force: true });
}

function readFileSyncSafe(path: string): string {
  return require("node:fs").readFileSync(path, "utf8") as string;
}

await mkdir(target, { recursive: true });
console.log(
  `[fetch-cef] matching ${platform} to the vendored Linux SDK: ${cefVersion}`,
);
console.log(`[fetch-cef] ${downloadURL}`);

// Download to a temp path, verify against the published sha256, then extract.
// An unverified Chromium tarball is a supply-chain decision, not a build step.
const archivePath = join(root, ".cef-windows-download.tar.bz2");
await download(downloadURL, archivePath);

const expectedHash = (
  await fetch(sha256URL).then((r) => {
    if (!r.ok)
      throw new Error(
        `no checksum published at ${sha256URL} (HTTP ${r.status})`,
      );
    return r.text();
  })
)
  .trim()
  .split(/\s+/u)[0]!
  .toLowerCase();
const actualHash = await sha256File(archivePath);
if (actualHash !== expectedHash)
  throw new Error(
    `checksum mismatch for ${archiveName}\n  expected ${expectedHash}\n  actual   ${actualHash}`,
  );
console.log(`[fetch-cef] sha256 verified (${actualHash.slice(0, 16)}…)`);

await extract(archivePath, target);

// The version must now be the one the Linux SDK carries. A silent divergence
// here is the whole failure this script exists to prevent.
const installed = readFileSyncSafe(join(target, "include", "cef_version.h"));
const installedMatch = /#define CEF_VERSION "([^"]+)"/u.exec(installed);
if (!installedMatch || installedMatch[1] !== cefVersion)
  throw new Error(
    `the fetched distribution is ${installedMatch?.[1] ?? "unversioned"}, not ${cefVersion}`,
  );
console.log(`[fetch-cef] ${platform} ready at ${cefVersion} in ${target}`);
await rm(archivePath, { force: true });

async function download(url: string, destination: string) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`download failed: ${url} (HTTP ${response.status})`);
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastReported = -1;
  // bun's node:fs write streams carry no WHATWG writer (getWriter is
  // undefined there), so the body streams through Bun's file writer.
  const writer = Bun.file(destination).writer();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    received += value.length;
    if (total > 0) {
      const percent = Math.floor((received / total) * 100);
      if (percent >= lastReported + 20) {
        lastReported = percent;
        console.log(
          `[fetch-cef] ${percent}% (${(received / 1e6).toFixed(0)} MiB)`,
        );
      }
    }
  }
  await writer.end();
  const size = (await stat(destination)).size;
  if (size === 0) throw new Error(`downloaded nothing: ${url}`);
  console.log(`[fetch-cef] downloaded ${(size / 1e6).toFixed(0)} MiB`);
}

async function sha256File(path: string) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function extract(archive: string, destination: string) {
  // The archive wraps everything in one top-level directory; tar's strip
  // removes it so the SDK lands where CMake expects.
  await Bun.$`tar -xjf ${archive} -C ${destination} --strip-components=1`.quiet();
}
