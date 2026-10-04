import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadOrCreateConfigFile } from "@anthelia/config";

/**
 * Where the app's own configuration lives, and the one place that makes sure it
 * EXISTS.
 *
 * The rule this module exists to enforce: **the app is responsible for its own
 * config directory.** Not the installer — it cannot know the working directory
 * a launch will have, and a Start Menu launch's working directory is the install
 * directory. Not the user — nobody should have to create a `.natalia/` by hand
 * before the program they just installed will start.
 *
 * So every path through here does two things, on EVERY launch, not only the
 * first: resolve the path (env override, else `<cwd>/.natalia/config.json`), and
 * ensure the directory and a schema-valid config file exist before anyone reads
 * them. Before this, four call sites computed the same path and then handed it
 * to the STRICT reader, so a fresh install died with ENOENT on its first launch
 * while every dev checkout — whose repo root has carried a `.natalia/` for as
 * long as the path has existed — never saw it.
 */
export function nataliaConfigPath(cwd = process.cwd()): string {
  const fromEnv = process.env.NATALIA_CONFIG;
  return fromEnv
    ? isAbsolute(fromEnv)
      ? fromEnv
      : resolve(cwd, fromEnv)
    : resolve(cwd, ".natalia", "config.json");
}

/**
 * The config, loaded or created, with its directory made if it is missing.
 *
 * `loadOrCreateConfigFile` already writes a default when the file is absent;
 * what it cannot do is create the PARENT when the parent is absent too, because
 * `saveConfigFile`'s `mkdir(dirname(path))` runs before it — which it does. What
 * is left is the case where the read succeeds on a path whose directory was
 * removed underneath it, so the mkdir here is the belt to that braces.
 */
export async function ensureNataliaConfig(path: string = nataliaConfigPath()) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const loaded = await loadOrCreateConfigFile(path);
  return loaded;
}

/**
 * The path, with the directory and the file guaranteed to exist afterwards,
 * together with the config that was loaded or created on the way.
 *
 * One read, not two: a caller that reads again after this gets a plain "file
 * already there" summary and loses the "created default" line that says this
 * launch was the first one — which is what the first-run test pins.
 */
export async function ensureNataliaConfigPath(
  path: string = nataliaConfigPath(),
) {
  const loaded = await ensureNataliaConfig(path);
  return { path, ...loaded };
}
