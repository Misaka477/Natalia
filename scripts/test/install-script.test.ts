import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * The install script, run for real.
 *
 * `scripts/install.sh` is the one-command path onto a machine, and it makes
 * three promises its header states: every file is verified against SHA256SUMS
 * BEFORE anything touches the destination; the installed binary answers
 * --version or the install fails; and uninstall/purge own the data, not the
 * install. None of that was executed anywhere — the installer package's tests
 * cover the TS library, not this shell script. So these tests build a small
 * release (the script needs only VERSION, SHA256SUMS and the listed files) and
 * run it.
 */

const repoRoot = join(import.meta.dir, "..", "..");
const INSTALL = join(repoRoot, "scripts", "install.sh");

/** A release the script accepts: the metadata, a self-reporting binary, a file. */
async function fakeRelease(
  options: { version?: string; binaryReports?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "natalia-inst-release-"));
  const version = options.version ?? "9.9.9-test";
  await mkdir(join(root, "plugins"), { recursive: true });
  const binary = options.binaryReports ?? version;
  await writeFile(join(root, "natalia"), `#!/bin/sh\necho ${binary}\n`, "utf8");
  await chmod(join(root, "natalia"), 0o755);
  await writeFile(join(root, "plugins", "one.js"), "plugin-one\n");
  await writeFile(join(root, "VERSION"), `${version}\n`);
  // The real release writes this; the script reads it and carries it over.
  await writeFile(join(root, "manifest.json"), '{"name":"natalia"}\n');
  // SHA256SUMS over the two files (VERSION is the verification's own input,
  // exactly as the real build excludes it — see build-standalone.ts).
  const lines: string[] = [];
  for (const file of ["natalia", "plugins/one.js"]) {
    const bytes = await Bun.file(join(root, file)).arrayBuffer();
    lines.push(
      `${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}  ${file}`,
    );
  }
  await writeFile(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return root;
}

async function install(
  from: string,
  home: string,
): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bash", INSTALL, "--from", from, "--home", home], {
    stdout: "pipe",
    stderr: "pipe",
    // A machine behind an HTTP proxy would send 127.0.0.1 through it and get
    // a 502 for the local test server; the bypass is the test's own
    // environment, not a property of the script under test.
    env: {
      ...process.env,
      no_proxy: "127.0.0.1,localhost",
      NO_PROXY: "127.0.0.1,localhost",
    },
  });
  // Async, not spawnSync: the URL-path test serves the release from this same
  // process, and a synchronous child would block the loop the server needs.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

// The script is POSIX shell and the layout is POSIX paths; Windows runs the
// installer's own path instead.
const POSIX = process.platform !== "win32";
const maybe = POSIX ? test : test.skip;

maybe("a good release installs, and the binary answers --version", async () => {
  const release = await fakeRelease();
  const home = await mkdtemp(join(tmpdir(), "natalia-inst-home-"));
  const result = await install(release, home);
  expect(result.code).toBe(0);
  // The layout the docs promise: versions/<v>/ plus a relative bin symlink.
  expect(existsSync(join(home, "versions", "9.9.9-test", "natalia"))).toBe(
    true,
  );
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/9.9.9-test/natalia",
  );
  // And it runs.
  const version = Bun.spawnSync([join(home, "bin", "natalia"), "--version"], {
    stdout: "pipe",
  });
  expect(version.stdout.toString().trim()).toBe("9.9.9-test");
});

maybe("a tampered byte aborts before anything is installed", async () => {
  // The supply-chain promise, verbatim: verification happens against the
  // staging tree, before the destination is touched. Measured by checking the
  // home was never created at all.
  const release = await fakeRelease();
  await Bun.write(join(release, "plugins", "one.js"), "tampered\n");
  const home = join(
    await mkdtemp(join(tmpdir(), "natalia-inst-tamper-")),
    "home",
  );
  const result = await install(release, home);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("checksum verification FAILED");
  expect(existsSync(home)).toBe(false);
});

maybe("a failed install leaves an existing install runnable", async () => {
  // The regression this pins: the landing re-points bin/natalia, so a rollback
  // that merely DELETES it takes the previous install down with it — measured
  // by installing a good release, then a failed one into the same home and
  // finding bin/natalia gone. The rollback now restores the previous pointer.
  const good = await fakeRelease({ version: "1.0.0-good" });
  const home = await mkdtemp(join(tmpdir(), "natalia-inst-coexist-"));
  expect((await install(good, home)).code).toBe(0);

  // A release whose identity check fails: its binary reports one version and
  // its VERSION file names another.
  const bad = await fakeRelease({
    version: "2.0.0-bad",
    binaryReports: "something-else",
  });
  const result = await install(bad, home);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("rolling back");

  // The good install is untouched and still the one that runs.
  const version = Bun.spawnSync([join(home, "bin", "natalia"), "--version"], {
    stdout: "pipe",
  });
  expect(version.stdout.toString().trim()).toBe("1.0.0-good");
  expect(existsSync(join(home, "versions", "1.0.0-good"))).toBe(true);
});

maybe("a failed install into a fresh home leaves no husks", async () => {
  const bad = await fakeRelease({
    version: "2.0.0-bad",
    binaryReports: "something-else",
  });
  const home = await mkdtemp(join(tmpdir(), "natalia-inst-fresh-"));
  const result = await install(bad, home);
  expect(result.code).not.toBe(0);
  // No version tree, no symlink, and not even the two empty directories the
  // landing created: "nothing was installed" is the literal claim.
  expect(existsSync(join(home, "bin"))).toBe(false);
  expect(existsSync(join(home, "versions"))).toBe(false);
});

maybe(
  "the URL path installs, because a URL is the default --from",
  async () => {
    // The directory path is the test convenience; the shipping default is a
    // release URL (NATALIA_INSTALL_BASE, or the hosted one the header names).
    // The two paths share the verification but not the fetch, and a fetch that
    // silently mistreats the URL would ship a broken default. Served from this
    // process, so the test needs no network.
    const release = await fakeRelease();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const file = Bun.file(
          join(release, decodeURIComponent(new URL(request.url).pathname)),
        );
        return (await file.exists())
          ? new Response(file)
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const home = await mkdtemp(join(tmpdir(), "natalia-inst-url-"));
      const result = await install(`http://127.0.0.1:${server.port}/`, home);
      expect(result.code).toBe(0);
      const version = Bun.spawnSync(
        [join(home, "bin", "natalia"), "--version"],
        {
          stdout: "pipe",
        },
      );
      expect(version.stdout.toString().trim()).toBe("9.9.9-test");
      // And the subdirectory the [Files]-style loop exercises (plugins/one.js).
      expect(
        existsSync(join(home, "versions", "9.9.9-test", "plugins", "one.js")),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  },
);
