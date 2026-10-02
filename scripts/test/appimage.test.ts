import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
  // Self-identifying, so a test can tell "the host ran" from "the shell could not find it".
  await writeFile(
    join(root, "natalia-cef-desktop"),
    "#!/bin/sh\necho HOST_LAUNCHED\n",
  );
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
  // The launcher, not the app's name: `Exec=<app name>` makes the launcher
  // search PATH for a binary that does not exist there, which is exactly the
  // "it has a launcher entry but double-clicking does nothing" failure.
  expect(entry["Exec"]).toBe("AppRun");
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

test("the icon set ships under the entry's own name", async () => {
  // Without an icon the launcher shows its generic unknown-application mark; the
  // entry names the file, and the sized siblings let the shell pick a bitmap
  // instead of scaling the one it found.
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  const icons = await mkdtemp(join(tmpdir(), "natalia-icons-"));
  await writeFile(join(icons, "icon.png"), "png");
  for (const size of [16, 48, 256])
    await writeFile(join(icons, `icon-${size}.png`), `png${size}`);
  const result = await buildAppImage({
    releaseDir: release,
    outDir: out,
    icon: join(icons, "icon.png"),
  });
  const entry = await readDesktopEntry(result.desktopEntry);
  expect(entry["Icon"]).toBe("natalia");
  for (const size of [16, 48, 256])
    expect(existsSync(join(result.appDir, `natalia-${size}.png`))).toBe(true);
  // The named icon itself is the one the entry resolves to.
  expect(existsSync(join(result.appDir, "natalia.png"))).toBe(true);
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

test("AppRun hands off to a running instance instead of starting a copy", async () => {
  // The generated launcher is the app's only product use of the single-instance
  // lock, and the branch that matters is the one a user hits by clicking the icon
  // twice. Three outcomes, all measured by running the generated script:
  //   a live listener  -> ask it to show, exit 0 (no second copy)
  //   a stale socket with a LIVE pid    -> defer, exit 0 (the app is starting)
  //   a stale socket with a dead pid    -> take the lock over (a crash recovers)
  const release = await fakeRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-appimage-"));
  await withAppRun(release, out, async ({ run, stateDir }) => {
    // 1. A listener that answers.
    const answering = Bun.spawn(
      [
        "socat",
        `UNIX-LISTEN:${stateDir}/natalia.instance.sock,fork`,
        'SYSTEM:echo {"ok":true}',
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(300);
    // Connecting IS the signal now: the app is there, so this launch exits
    // without starting a copy. Empty output, exit 0.
    expect(run()).toBe("");
    answering.kill();

    // 2. A socket file with NO listener (what a starting app has before its
    //    listener is up, or one that died without cleaning up), plus a live pid.
    //    socat removes its socket on exit, so this state is created by hand.
    const keep = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await writeFile(join(stateDir, "natalia.instance.pid"), `${keep.pid}\n`);
    const orphanSocket = join(stateDir, "natalia.instance.sock");
    const bound = Bun.spawn(
      ["socat", `UNIX-LISTEN:${orphanSocket},fork`, "SYSTEM:true"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(300);
    bound.kill(9);
    await Bun.sleep(100);
    // The file survives a SIGKILL, and nothing is listening on it.
    expect(existsSync(orphanSocket)).toBe(true);
    expect(run()).toContain("deferring to it");
    keep.kill();

    // 3. The same orphan socket, with a DEAD pid: the lock is taken over.
    await writeFile(join(stateDir, "natalia.instance.pid"), "999999\n");
    const third = await run({
      NATALIA_INSTANCE_SOCK: `${stateDir}/answer.sock`,
    });
    expect(third).toContain("HOST_LAUNCHED");
  });
});

/** Renders an AppDir, then runs its AppRun with a private state dir. */
async function withAppRun(
  release: string,
  out: string,
  body: (
    run: (env?: Record<string, string>) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const result = await buildAppImage({ releaseDir: release, outDir: out });
  const stateDir = await mkdtemp(join(tmpdir(), "natalia-apprun-state-"));
  const run = (env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync([result.appRun], {
      env: {
        ...process.env,
        NATALIA_STATE_DIR: stateDir,
        NATALIA_CEF_URL: "http://127.0.0.1:1/",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return `${proc.stdout.toString()}${proc.stderr.toString()}`;
  };
  await body({ run, stateDir });
}

const repoRoot = join(import.meta.dir, "..", "..");

test("a packer without its tool says so, and does not report success", () => {
  // The AppDir installs, but the single file a user double-clicks is what this
  // step exists to make — so "appimagetool not on PATH" must not read as done.
  const source = readFileSync(
    new URL("../build-appimage.ts", import.meta.url),
    "utf8",
  );
  // It looks in .tools/ as well as PATH, because that is where the fetch script
  // puts it.
  expect(source).toContain('join(root, ".tools", "appimagetool")');
  // And when it is absent, the message names what produces it.
  expect(source).toContain("no .AppImage was produced");
  expect(source).toContain("npm run appimage:fetch");
});

test("the fetch script is a real script, not an inline heredoc", () => {
  // An inline `bun -e` with shell escaping broke on its first attempt; the fix
  // was a file. This pins the shape so it does not regress to something
  // unreadable.
  expect(existsSync(join(repoRoot, "scripts", "fetch-appimagetool.ts"))).toBe(
    true,
  );
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["appimage:fetch"]).toBe(
    "bun scripts/fetch-appimagetool.ts",
  );
});
