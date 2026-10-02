/**
 * Fetch the AppImage packing tool.
 *
 * `appimagetool` is published as an AppImage, so this workstation needs one of
 * two things to run it: `/dev/fuse` (to mount it) or `libgpgme.so.11` (to run
 * the binary after `--appimage-extract`). Neither is guaranteed — the Linux
 * workspace this was written on has neither, and it measured the failure so the
 * message names the requirement rather than blaming the AppDir.
 *
 * The tool is optional: the AppDir `npm run appimage` produces is the complete,
 * installable artifact, and this is only what turns it into the single file a
 * user double-clicks.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const SOFTWARE_URL =
  "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage";

const root = resolve(import.meta.dir, "..");
const target = join(root, ".tools", "appimagetool");

await mkdir(join(root, ".tools"), { recursive: true });
const response = await fetch(SOFTWARE_URL);
if (!response.ok)
  throw new Error(`fetch failed: HTTP ${response.status} for ${SOFTWARE_URL}`);
await Bun.write(target, await response.blob());
await chmod(target, 0o755);
console.log(`[appimage:fetch] ${target}`);
console.log(
  `[appimage:fetch] now run \`npm run appimage\`; if it reports a missing ` +
    `library, this host needs /dev/fuse or libgpgme.so.11 (see the script's note)`,
);
