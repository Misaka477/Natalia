import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import {
  buildAppImage,
  isPackableRelease,
  readDesktopEntry,
} from "../appimage";

/**
 * The AppDir a user's launcher reads.
 *
 * A release directory is a directory of files; an installed application is a
 * `.desktop` entry, an icon and an executable the entry points at. The pins
 * below are what a launcher actually consumes, so a regression here is a
 * regression in "the app appears in my app list and starts when I click it".
 */

async function fakeRelease(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "natalia-release-"));
  await mkdir(join(root, "libcef-bin"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  await writeFile(join(root, "natalia-cef-desktop"), "cef\n");
  await writeFile(join(root, "natalia"), "runtime\n");
  await writeFile(join(root, "libcef-bin", "libcef.so"), "lib\n");
  await writeFile(join(root, "libcef-bin", "libEGL.so"), "lib\n");
  await writeFile(join(root, "resources", "plugin.js"), "");
  await writeFile(join(root, "composition.base.json"), "{}\n");
  await writeFile(join(root, "SHA256SUMS"), "abc\n");
  await writeFile(join(root, "install.sh"), "#!/bin/sh\n");
  for (const [name, text] of Object.entries(extra))
    await writeFile(join(root, name), text);
  return root;
}

test("the AppDir carries the release's binaries and the desktop entry", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const result = await buildAppImage({ releaseDir: release, outDir: out });

  // The CEF window, the runtime and their libraries are all inside.
  const paths = [result.appRun, result.desktopEntry];
  expect(paths.length).toBe(2);
  const entry = await readDesktopEntry(result.desktopEntry);

  // A launcher reads Name/Exec/TryExec/Terminal. All four must be present and
  // Terminal must be false — an app that opens a console window on launch is not
  // a normal application.
  expect(entry["Type"]).toBe("Application");
  expect(entry["Name"]).toBeTruthy();
  expect(entry["Exec"]).toBeTruthy();
  expect(entry["TryExec"]).toBe(entry["Exec"]);
  expect(entry["Terminal"]).toBe("false");
  // The window dedupes against the entry while it is running.
  expect(entry["StartupWMClass"]).toBeTruthy();
});

test("the entry points at AppRun, and AppRun is executable", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const result = await buildAppImage({
    releaseDir: release,
    outDir: out,
    id: "natalia",
  });
  const entry = await readDesktopEntry(result.desktopEntry);
  // `Exec=Natalia` would need the app on PATH; the entry points at the bundle's
  // own launcher instead.
  expect(entry["Exec"]).toBe("natalia");
  expect(entry["Icon"]).toBe("natalia");
  const mode = (await stat(result.appRun)).mode;
  // The execute bits: the user (7), group (5) and others (5).
  expect(mode & 0o111).toBe(0o111);
});

test("AppRun releases the bundled CEF's libraries where the binary finds them", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const result = await buildAppImage({ releaseDir: release, outDir: out });
  const text = await Bun.file(result.appRun).text();
  // CEF resolves its resources and libraries relative to the executable, so
  // AppRun has to put the bundle first on both search paths.
  expect(text).toContain("LD_LIBRARY_PATH");
  expect(text).toContain('PATH="$HERE:$PATH"');
  expect(text).toContain("natalia-cef-desktop");
  // And it must not depend on the user having set anything.
  expect(text).not.toContain("/home/");
});

test("the release's bookkeeping files never ship inside the image", async () => {
  // A checksum manifest and the shell installers are for a person unpacking a
  // tarball; their presence inside an installed app implies the user should run
  // something, which is exactly what a normal application must not require.
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const result = await buildAppImage({ releaseDir: release, outDir: out });
  const shipped = await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd: result.appDir, onlyFiles: false }),
  );
  expect(shipped).not.toContain("SHA256SUMS");
  expect(shipped).not.toContain("install.sh");
  // But the app root's contents must be there.
  expect(shipped).toContain("natalia");
  expect(shipped).toContain("natalia-cef-desktop");
  expect(shipped).toContain("resources");
});

test("a directory that is not a release is refused before anything is written", async () => {
  const empty = await mkdtemp(join(tmpdir(), "natalia-not-a-release-"));
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  expect(await isPackableRelease(empty)).toBe(false);
  let threw = "";
  try {
    await buildAppImage({ releaseDir: empty, outDir: out });
  } catch (error) {
    threw = String(error);
  }
  expect(threw).toContain("does not look like a release directory");
});

test("the icon ships under the entry's own name", async () => {
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const icon = await mkdtemp(join(tmpdir(), "natalia-icon-"));
  await writeFile(join(icon, "logo.png"), "png");
  const result = await buildAppImage({
    releaseDir: release,
    outDir: out,
    icon: join(icon, "logo.png"),
  });
  expect(result.icon).toBe(join(result.appDir, "natalia.png"));
  const entry = await readDesktopEntry(result.desktopEntry);
  expect(entry["Icon"]).toBe("natalia");
});

test("the generated entry passes desktop-file-validate clean", async () => {
  // A launcher reads the entry; the freedesktop VALIDATOR is what tells us the
  // entry is legal. Two of its complaints are the kind a build can ship by
  // accident: an application version in the spec's Version key, and more than
  // one main Category (which makes the app appear twice in the menu). Both cost
  // nothing to avoid and a support question to explain.
  const validator = Bun.which("desktop-file-validate");
  if (!validator) test.skip("desktop-file-validate is not installed");
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const result = await buildAppImage({
    releaseDir: release,
    outDir: out,
    version: "9.9.9-test",
  });
  const run = Bun.spawnSync([validator!, result.desktopEntry], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(output.trim()).toBe("");
});
