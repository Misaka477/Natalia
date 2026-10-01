import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";

/**
 * Rebuilds the generated dev plugin store from `dist/ts/plugins` without running
 * npm. This keeps the store in sync with freshly built plugin UI bundles and
 * starts fast.
 */
const storeRoot = resolve("dist/ts/plugin-store");
const pluginsRoot = resolve("dist/ts/plugins");
// Rebuilding from scratch wants to `rm -rf` the store first, but a RUNNING
// runtime holds it: its ignore-free watcher keeps every directory under the
// workspace open (ReadDirectoryChangesW on Windows), and removing a directory
// with an open handle fails EACCES. So the rm is best-effort: when it does not
// go through, refresh IN PLACE instead. Overwriting the files the new build
// ships is enough — loaded modules are read, not held open — and `natalia.lock`
// (written below) is the authority for what actually loads. Stale directories
// of plugins no longer in dist/ts/plugins stay behind unlisted, which is inert.
try {
  await rm(storeRoot, { recursive: true, force: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
}
await mkdir(storeRoot, { recursive: true });
await mkdir(join(storeRoot, "node_modules", "@natalia"), { recursive: true });

const lockPlugins: Record<string, unknown> = {};
const storeDependencies: Record<string, string> = {};
let skipped = 0;
for (const packageDir of await readdirSorted(pluginsRoot)) {
  const abs = join(pluginsRoot, packageDir);
  const manifest = JSON.parse(
    await readFile(join(abs, "natalia.plugin.json"), "utf8"),
  ) as { id: string; version: string; scope: string };
  const packageJSON = JSON.parse(
    await readFile(join(abs, "package.json"), "utf8"),
  ) as { name: string };
  storeDependencies[packageJSON.name] = `file:../plugins/${packageDir}`;
  const target = join(
    storeRoot,
    "node_modules",
    ...packageJSON.name.split("/"),
  );
  await mkdir(join(target), { recursive: true });
  skipped += await copyTreeInPlace(abs, target);
  lockPlugins[manifest.id] = {
    packageName: packageJSON.name,
    manifest: join(target, "natalia.plugin.json"),
    metadata: {
      id: manifest.id,
      source: { type: "path", path: abs },
      resolvedVersion: manifest.version,
      scope: manifest.scope,
      dependencies: [],
    },
  };
}
await writeFile(
  join(storeRoot, "package.json"),
  `${JSON.stringify({ dependencies: storeDependencies }, null, 2)}\n`,
);
await writeFile(
  join(storeRoot, "natalia.lock"),
  `${JSON.stringify({ version: 1, plugins: lockPlugins }, null, 2)}\n`,
);
// Official plugin initialization skips the npm install path when this marker
// exists. The refresh script already produces the full plugin closure, so the
// marker must be recreated here; otherwise the next runtime start sees an
// uninitialized store and tries to npm-install every plugin again.
await writeFile(
  join(storeRoot, "official-plugins-initialized-v1"),
  "initialized\n",
);
console.log(`[refresh-plugin-store] rebuilt ${storeRoot}`);
if (skipped > 0)
  console.log(
    `[refresh-plugin-store] ${skipped} file(s) held open by a running process were left as-is (a running exe's image is locked on Windows); they stage with the next refresh after that process stops`,
  );

/**
 * A per-file, best-effort copy: on Windows a RUNNING process owns the file it
 * was loaded from — the mux server exe of a live terminal, for instance — and
 * refusing to overwrite it (EBUSY/EACCES/EPERM) must not fail a whole refresh.
 * The store serves the next runtime, so a kept-as-is file is a stale copy, not
 * a broken one, and the count is reported at the end.
 */
async function copyTreeInPlace(src: string, dest: string): Promise<number> {
  let skipped = 0;
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      skipped += await copyTreeInPlace(from, to);
      continue;
    }
    try {
      await copyFile(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return skipped;
}

async function readdirSorted(dir: string) {
  return (await import("node:fs/promises"))
    .readdir(dir)
    .then((items) => items.sort());
}
