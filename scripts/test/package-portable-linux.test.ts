import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppImage } from "../appimage";

/**
 * The portable bundle, measured. A tarball preserves whatever mode the source
 * had, so an `AppRun` that lost its execute bit extracts into an application
 * that cannot start — and that failure would surface at the user's first
 * double-click instead of at the build. The packer repairs and reports it.
 */

// `fileURLToPath`, NOT `.pathname`: on Windows a URL's `pathname` is
// `/E:/Development/...` — a leading slash in front of the drive letter —
// which `bun` cannot resolve as a script ("Module not found
// /E:/Development/..."). The URL → path conversion is the platform's own,
// and it is the one that emits `E:\Development\...` there.
const packagerScript = fileURLToPath(
  new URL("../package-portable-linux.ts", import.meta.url),
);
const packager = (workspace: string) =>
  Bun.spawnSync(["bun", packagerScript], {
    env: { ...process.env, NATALIA_PACKAGE_ROOT: workspace },
    stdout: "pipe",
    stderr: "pipe",
  });

async function treeWithAppDir(): Promise<{ root: string; appRun: string }> {
  const root = await mkdtemp(join(tmpdir(), "portable-"));
  const release = join(root, "dist", "release", "9.9.9", "linux-x64");
  await mkdir(join(release, "resources"), { recursive: true });
  await writeFile(
    join(release, "natalia-cef-desktop"),
    "#!/bin/sh\necho HOST_LAUNCHED\n",
  );
  await writeFile(join(release, "natalia"), "rt\n");
  const built = await buildAppImage({
    releaseDir: release,
    outDir: join(root, "dist", "appimage", "9.9.9"),
    version: "9.9.9",
  });
  return { root, appRun: built.appRun };
}

// The two proofs below are POSIX-shaped on purpose: an AppImage's contract
// is a tarball whose AppRun carries the executable bit, and Windows has no
// such bit — `chmod` there moves the read-only flag only, so the "mode was
// lost" premise cannot even be constructed, and `tar -tzvf` reports
// `-rwxr-xr-x` only on a system that has it. They skip on Windows rather
// than assert a behavior that platform cannot show. Everything else in this
// file (the refusal, the staging layout) runs everywhere.
const posixTest = process.platform === "win32" ? test.skip : test;

posixTest(
  "a mode that was lost is repaired, and the loss is reported",
  async () => {
    const { root, appRun } = await treeWithAppDir();
    expect((await stat(appRun)).mode & 0o111).toBe(0o111);
    // The failure a user would hit.
    await chmod(appRun, 0o644);
    expect((await stat(appRun)).mode & 0o111).toBe(0);

    const run = packager(root);
    const out = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(out).toContain("is not executable");
    expect(out).toContain("mode(s) repaired");
    // And the packed archive carries the repaired mode.
    const tarball = join(root, "dist", "Natalia-9.9.9-linux-x64.tar.gz");
    expect(existsSync(tarball)).toBe(true);
    const listed = Bun.spawnSync(["tar", "-tzvf", tarball], {
      stdout: "pipe",
    }).stdout.toString();
    const appRunLine = listed
      .split("\n")
      .find((l) => l.includes("AppDir/AppRun"))!;
    expect(appRunLine).toContain("rwxr-xr-x");
  },
);

// The name says "starts the application", and it does not: the app under test is
// a stub this file writes (`#!/bin/sh\necho HOST_LAUNCHED`), so what is verified is
// the BUNDLE's contract — tarball layout, the AppDir/AppRun path, and that the
// entry point is executable after extraction with no install step. That is the
// packager's whole job and it is worth pinning, but it is not the application
// starting, and a reader who trusted the name would believe more than was checked.
//
// Closing that gap means a real release in the fixture — the shape the AppImage
// test uses (it renders from a real 91 MB release) — which is a different test,
// not a rename of this one. Until then the name is honest about its scope.
posixTest(
  "extracting the bundle and running its entry point executes it",
  async () => {
    // The user's path, executed: download, extract, run. No install, no command
    // line beyond the tar the message prints.
    const { root } = await treeWithAppDir();
    packager(root);
    const tarball = join(root, "dist", "Natalia-9.9.9-linux-x64.tar.gz");
    const dest = await mkdtemp(join(tmpdir(), "portable-extract-"));
    Bun.spawnSync(["tar", "-xzf", tarball, "-C", dest]);
    const run = Bun.spawnSync([join(dest, "AppDir", "AppRun")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`${run.stdout.toString()}`).toContain("HOST_LAUNCHED");
  },
);

test("a workspace without a release is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-empty-"));
  const run = packager(root);
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(out).toContain("no packable release");
});
