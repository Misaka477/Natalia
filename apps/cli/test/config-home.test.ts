/**
 * The config's LOCATION, which was the defect.
 *
 * It used to be `<cwd>/.natalia/config.json`, and the Start Menu shortcut sets
 * the working directory to the install folder — so a normal launch wrote the
 * user's model configuration into `<install>\.natalia\`, a directory the
 * uninstaller deletes. Uninstalling removed the model configuration, and which
 * file held it depended on how the process happened to be started: three
 * different files were called "the global config" (`defaultGlobalConfigPath`,
 * `<cwd>/.natalia/config.json`, and `<cwd>/.natalia/global-config.json`).
 *
 * There is one now, in the one home, and the working directory is not
 * consulted. `NATALIA_CONFIG` remains the explicit override, which is the
 * documented seam a test or a CLI `-c` uses.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveNataliaHome } from "@anthelia/platform";
import { nataliaConfigPath } from "../src/config-home";

test("the config path does not depend on the working directory", () => {
  const saved = process.env.NATALIA_CONFIG;
  delete process.env.NATALIA_CONFIG;
  try {
    // Two working directories that used to produce two different files — one
    // of them inside the install tree.
    const fromOneCwd = nataliaConfigPath(resolve("/some/where/else"));
    const fromInstallCwd = nataliaConfigPath(resolve("/opt/natalia"));
    expect(fromOneCwd).toBe(fromInstallCwd);
    expect(fromOneCwd).toBe(join(resolveNataliaHome(), "config.json"));
  } finally {
    if (saved === undefined) delete process.env.NATALIA_CONFIG;
    else process.env.NATALIA_CONFIG = saved;
  }
});

test("NATALIA_CONFIG still overrides: relative against the cwd, absolute as given", async () => {
  const saved = process.env.NATALIA_CONFIG;
  const base = await mkdtemp(join(tmpdir(), "natalia-config-home-"));
  try {
    process.env.NATALIA_CONFIG = "nested/config.json";
    expect(nataliaConfigPath(base)).toBe(
      resolve(base, "nested", "config.json"),
    );
    const absolute = resolve(base, "elsewhere", "config.json");
    process.env.NATALIA_CONFIG = absolute;
    // An absolute override is not relocated by the working directory.
    expect(nataliaConfigPath(resolve(base, "other"))).toBe(absolute);
  } finally {
    if (saved === undefined) delete process.env.NATALIA_CONFIG;
    else process.env.NATALIA_CONFIG = saved;
    await rm(base, { recursive: true, force: true });
  }
});
