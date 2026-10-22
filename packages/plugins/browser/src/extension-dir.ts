/**
 * Where the Chromium extension lives, resolved the same way everywhere.
 *
 * Two layouts are legitimate and which one applies depends on where this
 * code runs from:
 *
 *   - an install: the extension is staged beside the plugin
 *     (`<install>/plugins/natalia-browser/extension/chromium`) — the
 *     standalone build puts it there;
 *   - a checkout: the source tree
 *     (`packages/plugins/browser/src/extension/chromium`).
 *
 * The package root is found by walking up to the directory that holds
 * natalia.plugin.json — this module sits at `<package>/src/extension-dir.ts`
 * in a checkout and is inlined into `<package>/index.js` in a staged
 * release, so the depth differs and the manifest is the one anchor both
 * layouts share. Both the install helper and the runtime's error messages
 * read this one function, so the two can never name different directories.
 *
 * The walk matters: a fixed `../..` from this file is right in a checkout
 * and one level short in a release, and a path that does not exist sends
 * the user to load a folder that was never there.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin package root: the nearest ancestor holding the manifest. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, "natalia.plugin.json"))) return dir;
    dir = dirname(dir);
  }
  return dir;
}

const EXTENSION_CANDIDATES = [
  // An install: staged next to the plugin.
  join(packageRoot(), "extension", "chromium"),
  // A checkout: the source tree.
  join(packageRoot(), "src", "extension", "chromium"),
];

export function browserBridgeExtensionDir(): string {
  return (
    EXTENSION_CANDIDATES.find((dir) =>
      existsSync(join(dir, "manifest.json")),
    ) ?? EXTENSION_CANDIDATES[0]!
  );
}
