import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeTerminalPrebuiltDir,
  resolveNataliaWezTermForkExecutable,
} from "../src";
import { createTerminalController } from "../src";

test("terminal controller init without a host environment leaves the registry absent", async () => {
  if (resolveNataliaWezTermForkExecutable()) {
    // A managed WezTerm fork build exists in this environment, so the
    // "no host" precondition cannot be reproduced here. Mirrors the watcher
    // budget pattern: skip instead of failing on an environment fact.
    console.warn(
      "skipped: a managed WezTerm fork build is present in this environment",
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-controller-"));
  const controller = createTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "auto",
  });
  await controller.init();
  // No WezTerm host is available in tests; init must not throw and the
  // registry stays absent so members report "Native Terminal Host is
  // unavailable" instead of crashing.
  expect(await controller.list()).toEqual([]);
  await controller.close();
});

test("an externally provided registry is installed as-is and never rebuilt", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-terminal-controller-2-"));
  let disposals = 0;
  const external = {
    async reconcile() {
      return [];
    },
    dispose: async () => {
      disposals += 1;
    },
  } as never;
  const controller = createTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "auto",
    external,
  });
  await controller.init();
  expect(await controller.list()).toEqual([]);
  await controller.close();
  await controller.close();
  expect(disposals).toBe(0);
  await expect(controller.read("missing")).rejects.toThrow(
    "Native Terminal Host is unavailable",
  );
  await expect(controller.init()).rejects.toThrow(
    "terminal controller is closed",
  );
});

test("the prebuilt drop directory is the first candidate after an explicit one", async () => {
  // The ergonomics the distribution asked for: a fresh unpack drops the
  // three executables into prebuilt/<triple>/ and they are found WITHOUT
  // the fork's target/release existing (the paper cut this removes).
  const dir = await mkdtemp(join(tmpdir(), "natalia-prebuilt-"));
  try {
    const prebuilt = join(dir, "prebuilt");
    await mkdir(prebuilt, { recursive: true });
    // The drop: one directory, made by the unpack, holding wezterm.
    await writeFile(join(prebuilt, "wezterm"), "#!/bin/sh\n");
    // No explicit dir, no fork build reachable from a temp cwd: the
    // resolver's own prebuilt directory is the package's, so prove the
    // ORDER through an explicit dir that shadows it (an explicit dir is
    // the only candidate), then through the prebuilt dir itself.
    expect(
      resolveNataliaWezTermForkExecutable({ os: "linux", buildDir: prebuilt }),
    ).toBe(join(prebuilt, "wezterm"));
    // A spurious trailing entry in an explicit dir does not confuse it.
    expect(
      resolveNataliaWezTermForkExecutable({ os: "linux", buildDir: dir }),
    ).toBeUndefined();
    // And the package's own prebuilt path is the documented shape. The
    // separator is the platform's: join() builds with the native separator,
    // so the expected suffix must too.
    expect(
      nativeTerminalPrebuiltDir("win32").endsWith(join("prebuilt", "windows-x64")),
    ).toBe(true);
    expect(
      nativeTerminalPrebuiltDir("linux").endsWith(join("prebuilt", "linux-x64")),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the package's own prebuilt drop is in the search, ahead of the fork build", async () => {
  // The ergonomics itself: no explicit dir, the package's prebuilt
  // directory holding the executable — the resolver must answer with IT
  // (the fork build also exists in a dev environment, so the answer's
  // identity is what proves the order).
  const prebuilt = nativeTerminalPrebuiltDir("linux");
  const wanted = join(prebuilt, "wezterm");
  const alreadyThere = existsSync(wanted);
  if (!alreadyThere) await mkdir(prebuilt, { recursive: true });
  try {
    if (!alreadyThere) await writeFile(wanted, "#!/bin/sh\n");
    expect(resolveNataliaWezTermForkExecutable({ os: "linux" })).toBe(wanted);
  } finally {
    // Restore the environment exactly (the drop is a real directory a
    // developer may have populated for real).
    if (!alreadyThere) await rm(wanted, { force: true });
  }
});
