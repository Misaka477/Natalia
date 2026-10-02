import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";

/**
 * Rebuilds the generated dev plugin store from `dist/ts/plugins` without running
 * npm. This keeps the store in sync with freshly built plugin UI bundles and
 * starts fast.
 */
const storeRoot = resolve("dist/ts/plugin-store");
const pluginsRoot = resolve("dist/ts/plugins");
await rm(storeRoot, { recursive: true, force: true });
await mkdir(storeRoot, { recursive: true });
await mkdir(join(storeRoot, "node_modules", "@natalia"), { recursive: true });

const lockPlugins: Record<string, unknown> = {};
const storeDependencies: Record<string, string> = {};
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
  await cp(abs, target, { recursive: true });
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

async function readdirSorted(dir: string) {
  return (await import("node:fs/promises"))
    .readdir(dir)
    .then((items) => items.sort());
}
