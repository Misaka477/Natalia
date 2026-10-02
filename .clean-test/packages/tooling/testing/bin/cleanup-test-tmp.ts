/**
 * Cleans up test leftovers under /tmp.
 *
 * Tests create `natalia-*` directories and never remove them; /tmp has been
 * observed holding 20k+ of them. Only directories older than two hours are
 * removed, so a test that is *currently running* (or a runtime someone is
 * actively using) is never touched — a leftover from a finished run is by
 * definition hours old. Nothing outside the `natalia-` prefix is touched.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = tmpdir();
const cutoffMs = 2 * 60 * 60 * 1000;
const now = Date.now();

const entries = await readdir(root).catch(() => []);
let removed = 0;
let retained = 0;
for (const entry of entries) {
  if (!entry.startsWith("natalia-")) continue;
  const path = join(root, entry);
  try {
    const info = await stat(path);
    if (info.isDirectory() && now - info.mtimeMs > cutoffMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } else {
      retained += 1;
    }
  } catch {
    retained += 1;
  }
}
console.log(
  JSON.stringify({
    root,
    removed,
    retained,
    cutoffMinutes: cutoffMs / 60_000,
  }),
);
