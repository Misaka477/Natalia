import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableName } from "@anthelia/platform";
import {
  installedPluginDistributionRoot,
  installedPluginDistributionRoots,
  pluginStoreRootFrom,
} from "../src/official-plugins";

/**
 * The installed-layout branch for the standalone-executable bundle:
 * `process.execPath`/`import.meta.dir` live in the read-only `/$bunfs`
 * VFS there, so the real executable directory is recovered from argv0
 * (and PATH as a fallback) — the plugin STORE must land on a writable
 * sibling (versions/<v>/plugin-store), or every host command dies with
 * EROFS (doctor = the installer's advertised next step).
 */

const base = mkdtempSync(join(tmpdir(), "official-layout-"));

/**
 * The embedded filesystem a standalone bundle mounts its own program
 * from: `/$bunfs` on POSIX, `B:\~BUN\` on Windows (the same two roots
 * start-app and the native-terminal bridge discovery record). Every
 * fixture below is composed from the platform's own shape at runtime —
 * never baked — so each proof is the platform's real one.
 */
const vfsRoot =
  process.platform === "win32" ? "B:\\~BUN\\root" : "/$bunfs/root";
const vfsProgram = join(vfsRoot, executableName("natalia"));

test("argv0 resolution finds plugins beside the real executable", () => {
  const execDir = join(base, "versions", "1.0.0");
  mkdirSync(join(execDir, "plugins"), { recursive: true });
  const binary = executableName("natalia");
  writeFileSync(join(execDir, binary), "");
  // A linked bin (the installer's bin/natalia) resolves to the real dir.
  // POSIX links the executable itself; an unprivileged Windows process
  // cannot create a file symlink (EPERM), so the bin DIRECTORY is a
  // junction there — realpathSync resolves a junction exactly like a
  // symlink, which is the behavior under test.
  const binDir = join(base, "bin");
  if (process.platform === "win32") {
    symlinkSync(execDir, binDir, "junction");
  } else {
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(execDir, binary), join(binDir, binary));
  }
  const root = installedPluginDistributionRoot({
    argv0: join(binDir, binary),
    execPath: vfsProgram,
    pathEnv: "",
  });
  expect(root).toBe(join(execDir, "plugins"));
  // …and the store is the WRITABLE sibling.
  expect(pluginStoreRootFrom(root!)).toBe(join(execDir, "plugin-store"));
});

test("PATH scan is the fallback when argv0 is a bare name", () => {
  const execDir = join(base, "versions", "2.0.0");
  mkdirSync(join(execDir, "plugins"), { recursive: true });
  writeFileSync(join(execDir, executableName("natalia")), "");
  const roots = installedPluginDistributionRoots({
    argv0: "natalia",
    execPath: vfsProgram,
    pathEnv: execDir,
  });
  expect(roots).toContain(execDir);
  expect(
    installedPluginDistributionRoot({
      argv0: "natalia",
      execPath: vfsProgram,
      pathEnv: execDir,
    }),
  ).toBe(join(execDir, "plugins"));
});

test("no candidates with plugins/: the branch stays out", () => {
  expect(
    installedPluginDistributionRoot({
      argv0: join(base, "void", "natalia"),
      execPath: vfsProgram,
      pathEnv: join(base, "empty-path"),
    }),
  ).toBeUndefined();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("VFS candidates never win, and the store falls back to the home anchor", async () => {
  const { writableStoreRoot, installedPluginDistributionRoots } = await import(
    "../src/official-plugins"
  );
  // A VFS-shaped argv0 is rejected outright.
  // VFS-shaped argv0/execPath contribute nothing with plugins/ beside
  // them (kernel-exe candidates without a plugins/ dir never win).
  expect(
    installedPluginDistributionRoot({
      argv0: vfsProgram,
      execPath: vfsProgram,
      pathEnv: "",
    }),
  ).toBeUndefined();
  // A derived store under the VFS anchors to the user home instead. The
  // home fixture carries the platform's own shape: resolving a POSIX
  // absolute path on Windows would anchor it to the current drive, which
  // is not what an installed Windows host reports.
  const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  expect(
    writableStoreRoot(join(vfsRoot, "dist", "ts", "plugin-store"), {
      env: { NATALIA_HOME: join(home, ".natalia") },
      home,
    }),
  ).toBe(join(home, ".natalia", "plugin-store"));
  expect(writableStoreRoot("/elsewhere/plugin-store", { env: {} })).toBe(
    "/elsewhere/plugin-store",
  ); // non-VFS keeps the sibling rule
});

test("a throwing plugin bootstrap degrades with a warning, never a crash", async () => {
  const { initializeOfficialPluginsForHostCommand } = await import(
    "../src/official-plugins"
  );
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const result = await initializeOfficialPluginsForHostCommand(
      ["doctor"],
      (() => Promise.reject(new Error("npm tar broke"))) as never,
    );
    expect(result).toBe(true); // the command proceeds
  } finally {
    console.warn = original;
  }
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0]![1])).toContain("npm tar broke");
  // Non-host commands stay untouched by the wrapper.
  expect(
    await initializeOfficialPluginsForHostCommand(
      ["totally-not-a-command"],
      (() => Promise.reject(new Error("must not run"))) as never,
    ),
  ).toBe(false);
});

test("doctor survives a missing project config (first run, arbitrary cwd)", async () => {
  const { doctorReport } = await import("../src/index");
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevHome = process.env.HOME;
  const scratch = join(base, "xdg-empty");
  const homeEmpty = join(base, "home-empty");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(homeEmpty, { recursive: true });
  process.env.XDG_CONFIG_HOME = scratch;
  process.env.HOME = homeEmpty;
  try {
    const report = await doctorReport({
      configPath: join(base, "no-such-project", ".natalia", "config.json"),
      workspaceRoot: homeEmpty,
    });
    // Reports, never throws: defaults loaded, sources tell the truth.
    expect(report.migration.length).toBeGreaterThan(0);
    expect(
      report.layers.source === "node_modules" ||
        report.layers.source === "none",
    ).toBe(true);
    expect(report.sources.some((source) => source.applied === false)).toBe(
      true,
    );
  } finally {
    process.env.XDG_CONFIG_HOME = prevXdg;
    process.env.HOME = prevHome;
  }
});
