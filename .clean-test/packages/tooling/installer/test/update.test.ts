import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_EXIT_CONCURRENT,
  UPDATE_LOCK_MAX_AGE_MS,
  UPDATE_RECEIPT_KEEP,
  markLockStale,
  resolveUpdateHome,
  stagedPath,
  updateProgram,
} from "../src/update";

/**
 * D3a — `natalia update` core: check → verify-at-source → stage →
 * atomic swap → EXACT --version probe → automatic rollback. The
 * acceptance in miniature: a bad binary never stays linked, the old
 * one always still answers. Fixtures are real shell binaries probed
 * exactly as production probes them.
 */

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function shell(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

type BinaryMode = "ok" | "wrong-version" | "crash";
const binary = (printed: string, mode: BinaryMode = "ok") =>
  mode === "ok"
    ? `#!/bin/sh\nprintf '%s\\n' "${printed}"\n`
    : mode === "wrong-version"
      ? `#!/bin/sh\nprintf '%s\\n' "9.9.9"\n`
      : `#!/bin/sh\nexit 1\n`;

/** An installed home exactly as install.sh lays it out (relative link). */
function makeHome(version = "1.0.0"): string {
  const home = mkdtempSync(join(tmpdir(), "natalia-update-home-"));
  homes.push(home);
  mkdirSync(join(home, "versions", version), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  shell(join(home, "versions", version, "natalia"), binary(version));
  symlinkSync(`../versions/${version}/natalia`, join(home, "bin", "natalia"));
  return home;
}

/** A release directory exactly as release:build lays it out — including a
 * subdirectory entry, because real sums are tree paths. */
function makeRelease(
  version: string,
  mode: BinaryMode = "ok",
  extra: { corruptNataliaHash?: boolean; noVersion?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "natalia-update-rel-"));
  homes.push(dir);
  shell(join(dir, "natalia"), binary(version, mode));
  if (!extra.noVersion) writeFileSync(join(dir, "VERSION"), `${version}\n`);
  mkdirSync(join(dir, "plugins", "demo"), { recursive: true });
  writeFileSync(join(dir, "plugins", "demo", "x.txt"), "payload\n");
  const files = [
    "natalia",
    ...(extra.noVersion ? [] : ["VERSION"]),
    "plugins/demo/x.txt",
  ];
  const lines = files.map((name) => {
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    let hex = sha(bytes);
    if (extra.corruptNataliaHash && name === "natalia")
      hex = (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    return `${hex}  ${name}`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return dir;
}

const readReceipt = (home: string, index = -1): Record<string, unknown> => {
  const dir = join(home, "receipts");
  const list = readdirSync(dir)
    .filter((n) => n.startsWith("update-"))
    .sort();
  const name = list.at(index);
  if (!name) throw new Error(`no receipt at index ${index} in ${dir}`);
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
    string,
    unknown
  >;
};

test("switched: staged tree lands, the relative link flips, the probe proves it, receipt records every step", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0");
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("switched");
  expect(result.exitCode).toBe(0);
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/2.0.0/natalia",
  );
  // the recursive walk: a subdir entry from the sums landed too
  expect(
    existsSync(join(home, "versions", "2.0.0", "plugins", "demo", "x.txt")),
  ).toBe(true);
  const receipt = readReceipt(home);
  expect(receipt.outcome).toBe("switched");
  expect(receipt.fromVersion).toBe("1.0.0");
  expect(receipt.toVersion).toBe("2.0.0");
  expect((receipt.probe as { version?: string }).version).toBe("2.0.0");
  expect((receipt.steps as Array<{ name: string }>).map((s) => s.name)).toEqual(
    ["locate", "detect", "verify", "version", "stage", "swap", "probe"],
  );
  expect(existsSync(join(home, ".natalia-update-in-progress"))).toBe(false);
  // idempotent second run on the same source: still switched, no damage
  const again = await updateProgram({ home, from: rel });
  expect(again.outcome).toBe("switched");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/2.0.0/natalia",
  );
});

test("a wrong-version binary rolls the link back and drops the failed stage (the acceptance)", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0", "wrong-version");
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("rolled_back");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("self-check");
  expect(result.reason).toContain("expected=2.0.0");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/1.0.0/natalia",
  );
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);
  const receipt = readReceipt(home);
  expect(receipt.outcome).toBe("rolled_back");
  // the OLD binary still answers — an update may never leave the install dead
  const probe = Bun.spawnSync([join(home, "bin", "natalia"), "--version"], {
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(probe.stdout).trim()).toBe("1.0.0");
});

test("a crashing binary rolls back too (the probe's exit code is part of the gate)", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0", "crash");
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("rolled_back");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/1.0.0/natalia",
  );
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);
});

test("concurrent is a contract, not an error: exit 2, no receipt, no staging, lock untouched", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0");
  const lock = join(home, ".natalia-update-in-progress");
  writeFileSync(lock, `99999\n${new Date().toISOString()}\n`);
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("concurrent");
  expect(result.exitCode).toBe(UPDATE_EXIT_CONCURRENT);
  expect(result.receiptPath).toBeUndefined();
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);
  expect(readFileSync(lock, "utf8")).toContain("99999"); // not stolen
});

test("a stale lock heals (its owner cannot still be copying after the ceiling)", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0");
  writeFileSync(join(home, ".natalia-update-in-progress"), "99998\n");
  markLockStale(home, UPDATE_LOCK_MAX_AGE_MS + 60_000);
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("switched");
});

test("verify BEFORE touch: a checksum mismatch refuses without creating anything", async () => {
  const home = makeHome();
  const rel = makeRelease("2.0.0", "ok", { corruptNataliaHash: true });
  const result = await updateProgram({ home, from: rel });
  expect(result.outcome).toBe("refused");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("checksum mismatch for natalia");
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/1.0.0/natalia",
  );
  expect(existsSync(join(home, ".natalia-update-in-progress"))).toBe(false);
});

test("a release without VERSION and an uninstalled home are refused with honest reasons", async () => {
  const home = makeHome();
  const noVersion = makeRelease("2.0.0", "ok", { noVersion: true });
  const refused = await updateProgram({ home, from: noVersion });
  expect(refused.outcome).toBe("refused");
  expect(refused.reason).toContain("missing VERSION");
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);

  const empty = mkdtempSync(join(tmpdir(), "natalia-update-empty-"));
  homes.push(empty);
  const missing = await updateProgram({
    home: empty,
    from: makeRelease("3.0.0"),
  });
  expect(missing.outcome).toBe("not-installed");
  expect(missing.exitCode).toBe(1);
  expect(missing.reason).toContain("install.sh");
});

test("sums may be tree paths but never escape the staging root (anti-escape, validatePluginPath's rule)", () => {
  const root = "/rel";
  expect(stagedPath(root, "natalia")).toBe("/rel/natalia");
  expect(stagedPath(root, "plugins/demo/x.txt")).toBe(
    "/rel/plugins/demo/x.txt",
  );
  expect(() => stagedPath(root, "../evil")).toThrow(/escapes the release/u);
  expect(() => stagedPath(root, "/abs")).toThrow(/escapes the release/u);
});

test("receipts prove-and-keep: retention prunes to the last KEEP", async () => {
  const home = makeHome();
  const dir = join(home, "receipts");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < UPDATE_RECEIPT_KEEP + 3; i += 1)
    writeFileSync(
      join(
        dir,
        `update-2020-01-${String(i).padStart(2, "0")}T00-00-00.000Z-1.json`,
      ),
      "{}",
    );
  const result = await updateProgram({ home, from: makeRelease("2.0.0") });
  expect(result.outcome).toBe("switched");
  const left = readdirSync(dir).filter((n) => n.startsWith("update-"));
  expect(left.length).toBe(UPDATE_RECEIPT_KEEP);
});

test("resolveUpdateHome follows install.sh's rule: NATALIA_HOME wins, else $HOME/.natalia", () => {
  expect(resolveUpdateHome({ NATALIA_HOME: "/custom", HOME: "/u" })).toBe(
    "/custom",
  );
  expect(resolveUpdateHome({ HOME: "/u" })).toBe(join("/u", ".natalia"));
  expect(resolveUpdateHome({ HOME: "/u" }, "/override")).toBe("/override");
  expect(() => resolveUpdateHome({})).toThrow(/NATALIA_HOME/u);
});
