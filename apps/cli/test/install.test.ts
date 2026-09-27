import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * D2 (install study): the one-command install onto a clean machine —
 * fetch, verify, land, prove it runs. The supply-chain acceptance is the
 * tampered-file case: a single flipped byte aborts with NOTHING installed.
 *
 * Both installer paths are exercised: a local release directory (cp) and
 * URL mode over file:// (curl) — the same fetch code a hosted release
 * would hit, without pretending a channel exists before D5.
 */

let base = "";
const repoRoot = resolve(import.meta.dir, "../../..");
const installer = join(repoRoot, "scripts", "install.sh");
const FIXTURE_VERSION = "9.9.9-fixture";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "natalia-install-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function fixtureRelease(name: string): string {
  const dir = join(base, `${name}-release`);
  mkdirSync(join(dir, "plugins", "dummy"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${FIXTURE_VERSION}\n`);
  const binary = join(dir, "natalia");
  writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${FIXTURE_VERSION}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(binary, 0o755);
  writeFileSync(join(dir, "plugins", "dummy", "plugin.json"), `{"id":"dummy"}`);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name: "natalia", version: FIXTURE_VERSION }) + "\n",
  );
  // The standard two-column digests, exactly as build-standalone emits.
  const files = ["natalia", "plugins/dummy/plugin.json"];
  const sums = files
    .map(
      (file) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, file)))
          .digest("hex")}  ${file}`,
    )
    .join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);
  return dir;
}

function seededHome(name: string): string {
  const home = join(base, `${name}-home`);
  mkdirSync(join(home, "stores", "ws-one", "sessions", "ses_a"), {
    recursive: true,
  });
  writeFileSync(
    join(home, "stores", "ws-one", "sessions", "ses_a", "rescue.txt"),
    "RESCUE-RING",
  );
  return home;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of require("node:fs").readdirSync(current, {
      withFileTypes: true,
    })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[full.slice(dir.length + 1)] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
    }
  };
  walk(dir);
  return out;
}

function install(args: string[]) {
  return spawnSync("bash", [installer, ...args], { encoding: "utf8" });
}

test("a clean home installs from a local release and the result runs", () => {
  const release = fixtureRelease("local");
  const home = seededHome("local");
  const before = snapshot(join(home, "stores"));

  const result = install(["--from", release, "--home", home]);
  expect(result.stderr).not.toContain("FAILED");
  expect(result.status).toBe(0);

  // Layout: the versioned tree plus a bin entry that answers.
  const bin = join(home, "bin", "natalia");
  expect(lstatSync(bin).isSymbolicLink()).toBe(true);
  expect(
    spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim(),
  ).toBe(FIXTURE_VERSION);
  // The study's promise: stores are never the installer's to touch.
  expect(snapshot(join(home, "stores"))).toEqual(before);
  // The first-run guidance is printed, not auto-executed (an installer
  // must not launch an interactive TUI).
  expect(result.stdout).toContain("next: natalia doctor");
});

test("a tampered byte fails verification with nothing installed", () => {
  const release = fixtureRelease("tampered");
  // Flip a byte AFTER the digests were generated.
  const target = join(release, "plugins", "dummy", "plugin.json");
  writeFileSync(target, `{"id":"tammpd"}`);
  const home = seededHome("tampered");
  const before = snapshot(join(home, "stores"));

  const result = install(["--from", release, "--home", home]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("checksum verification FAILED");
  expect(existsSync(join(home, "versions"))).toBe(false);
  expect(existsSync(join(home, "bin", "natalia"))).toBe(false);
  expect(snapshot(join(home, "stores"))).toEqual(before);
});

test("URL mode fetches over file:// — the hosted path without a channel", () => {
  const release = fixtureRelease("url");
  const home = seededHome("url");
  const result = install(["--from", `file://${release}`, "--home", home]);
  expect(result.status).toBe(0);
  expect(
    spawnSync(join(home, "bin", "natalia"), ["--version"], {
      encoding: "utf8",
    }).stdout.trim(),
  ).toBe(FIXTURE_VERSION);
});

test("re-running replaces the same version cleanly", () => {
  const release = fixtureRelease("rerun");
  const home = seededHome("rerun");
  expect(install(["--from", release, "--home", home]).status).toBe(0);
  const again = install(["--from", release, "--home", home]);
  expect(again.status).toBe(0);
  expect(
    spawnSync(join(home, "bin", "natalia"), ["--version"], {
      encoding: "utf8",
    }).stdout.trim(),
  ).toBe(FIXTURE_VERSION);
});

test("the real release artifact installs and answers --version (gated)", () => {
  const version = (
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const platform = `${process.platform}-${process.arch}`;
  const release = join(repoRoot, "dist", "release", version, platform);
  if (!existsSync(join(release, "SHA256SUMS"))) return; // needs `npm run release:build`
  const home = seededHome("real");
  const result = install(["--from", release, "--home", home]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`natalia ${version} installed`);
  const output = spawnSync(join(home, "bin", "natalia"), ["--version"], {
    encoding: "utf8",
  });
  expect(output.status).toBe(0);
  expect(output.stdout.trim()).toBe(version);
});

test("install.ps1 exists for the Windows face (execution gated on pwsh)", () => {
  expect(existsSync(join(repoRoot, "scripts", "install.ps1"))).toBe(true);
  const pwsh = spawnSync("pwsh", ["--version"], { encoding: "utf8" });
  if (pwsh.status !== 0) return; // this harness has no PowerShell — recorded in the landing doc
  // With pwsh present: the same fixture semantics apply (dir mode).
  const release = fixtureRelease("windows");
  const home = seededHome("windows");
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      join(repoRoot, "scripts", "install.ps1"),
      "-From",
      // The ps1 fetches each listed file through Invoke-WebRequest, which
      // needs a URI — the same file:// form the sh installer's fixture
      // uses (a bare directory path is not a URI on any platform).
      pathToFileURL(release).href,
      "-NataliaHome",
      home,
    ],
    { encoding: "utf8" },
  );
  // The fixture ships a sh-script "natalia", not natalia.exe — the ps1's
  // layout assertions run against natalia.exe, so this gate only checks the
  // script parses and starts (a parse failure exits non-zero immediately).
  expect(result.status === 0 || result.stderr.includes("natalia.exe")).toBe(
    true,
  );
});
