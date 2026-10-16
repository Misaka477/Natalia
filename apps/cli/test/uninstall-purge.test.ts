import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exportStores,
  nataliaHome,
  nataliaHomeForExecutable,
  listPurgeTargets,
  purgeConfirmation,
  purgeData,
  purgeWorkspaceState,
  resolvePurgeGate,
  uninstallProgram,
} from "../src/store-maintenance";

/**
 * D4 (install study): the exit-phase data plane. The headline case is the
 * master plan's DoD #6 — uninstall never touches the life-preserving
 * store, byte for byte, and a reinstall finds the rescue ring exactly
 * where the message said it stayed.
 *
 * The case below pins the OTHER half, which was wrong: what purge deletes.
 */
test("purge removes everything the home holds, not a list that only looks complete", async () => {
  const home = fixtureHome("purge-discovery");
  // Every child a real home now carries. The list purge used to name was
  // `stores`, `logs` and `config.json` — the config has not lived at the
  // home root for several releases, and every one of these was silently
  // outside it, so "remove the configuration" left the configuration, the
  // workspaces, the skills, the installed plugins and the interface layout
  // exactly where they were.
  for (const entry of [
    "stores",
    "logs",
    "vault",
    "skills",
    "cache",
    "run",
    "plugin-store",
    "composition.d",
  ]) {
    mkdirSync(join(home, entry), { recursive: true });
    writeFileSync(join(home, entry, "payload"), entry);
  }
  writeFileSync(join(home, "config.json"), "{}");
  writeFileSync(join(home, "workspaces.json"), "[]");
  writeFileSync(join(home, "tui.json"), "{}");

  // What the confirmation is shown, before anything is deleted: the names of
  // what will go — a store count and a config size cannot tell a reader that
  // their workspaces and plugins are about to disappear.
  const targets = await listPurgeTargets(home);
  expect(targets.entries).toContain("workspaces.json");
  expect(targets.entries).toContain("plugin-store");
  expect(targets.entries).toContain("skills");
  // The program is not data.
  expect(targets.entries).not.toContain("bin");
  expect(targets.entries).not.toContain("versions");

  const { removed } = await purgeData(home);
  expect(removed).toContain("config.json");
  expect(removed).toContain("workspaces.json");
  expect(removed).toContain("plugin-store");
  expect(removed).toContain("skills");
  expect(removed).toContain("stores");
  // Nothing of the data is left behind, so a reinstall genuinely starts clean.
  expect(
    readdirSync(home).filter((name) => name !== "bin" && name !== "versions"),
  ).toEqual([]);
  // And the program survived, because deleting it is uninstall's business.
  expect(readdirSync(join(home, "bin"))).toEqual(["natalia"]);
  expect(readdirSync(join(home, "versions"))).toEqual(["0.0.0"]);
});

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "uninstall-purge-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function fixtureHome(name: string): string {
  const home = join(base, `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "natalia"), "ELF-fake-binary");
  mkdirSync(join(home, "versions", "0.0.0"), { recursive: true });
  writeFileSync(join(home, "versions", "0.0.0", "natalia"), "ELF-fake-binary");
  mkdirSync(join(home, "stores", "ws-one", "sessions", "ses_a"), {
    recursive: true,
  });
  writeFileSync(
    join(home, "stores", "ws-one", "sessions", "ses_a", "rescue.txt"),
    "RESCUE-RING",
  );
  mkdirSync(join(home, "stores", "ws-one", "objects"), { recursive: true });
  writeFileSync(join(home, "stores", "ws-one", "objects", "o1"), "blob-data");
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "logs", "run.log"), "log-line\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 4 }));
  return home;
}

/** Byte identity of a tree: path -> sha256 of contents. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
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

test("DoD #6: uninstall removes the program and never touches the store", async () => {
  const home = fixtureHome("dod6");
  const before = snapshot(join(home, "stores"));
  // The snapshot's keys carry the platform separator (they are
  // join()-built paths), so the rescue-ring key must be joined too — a
  // hardcoded forward-slash key is simply absent on Windows.
  const rescueKey = join("ws-one", "sessions", "ses_a", "rescue.txt");
  expect(before[rescueKey]).toBeDefined();

  const report = await uninstallProgram(home);
  expect(report.programPresent).toBe(true);
  expect(report.removed).toEqual(["bin", "versions"]);
  expect(() => statSync(join(home, "bin"))).toThrow(); // gone
  expect(snapshot(join(home, "stores"))).toEqual(before); // byte for byte
  // The message carries the study's promise verbatim in spirit.
  expect(report.message).toContain(join(home, "stores"));
  expect(report.message).toContain("reinstall to recover");

  // Reinstall (the program comes back): the rescue ring is exactly where
  // the message said — recovery is possible, nothing was lost.
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "natalia"), "ELF-fake-binary-again");
  expect(
    readFileSync(
      join(home, "stores", "ws-one", "sessions", "ses_a", "rescue.txt"),
      "utf8",
    ),
  ).toBe("RESCUE-RING");
});

test("uninstall without a program still leaves the store alone and says so", async () => {
  const home = fixtureHome("bare");
  rmSync(join(home, "bin"), { recursive: true, force: true });
  rmSync(join(home, "versions"), { recursive: true, force: true });
  const before = snapshot(join(home, "stores"));
  const report = await uninstallProgram(home);
  expect(report.programPresent).toBe(false);
  expect(report.removed).toEqual([]);
  expect(snapshot(join(home, "stores"))).toEqual(before);
  expect(report.message).toContain("preserved");
});

test("the purge gate: pipes refuse, TTYs ask, --yes proceeds", () => {
  expect(resolvePurgeGate({ yes: false, isTTY: false })).toMatchObject({
    proceed: false,
    ask: false,
    reason: expect.stringContaining("store export"),
  });
  expect(resolvePurgeGate({ yes: false, isTTY: true })).toMatchObject({
    proceed: false,
    ask: true,
  });
  expect(resolvePurgeGate({ yes: true, isTTY: false })).toEqual({
    proceed: true,
    ask: false,
  });
  // The double confirmation's phrase.
  expect(purgeConfirmation("purge")).toBe(true);
  expect(purgeConfirmation("  PURGE  ")).toBe(true);
  expect(purgeConfirmation("purged")).toBe(false);
  expect(purgeConfirmation("")).toBe(false);
});

test("the purge listing names every workspace, its size and sessions", async () => {
  const home = fixtureHome("listing");
  const targets = await listPurgeTargets(home);
  expect(targets.stores).toHaveLength(1);
  expect(targets.stores[0]).toMatchObject({
    workspaceID: "ws-one",
    sessions: 1,
  });
  expect(targets.stores[0]!.bytes).toBeGreaterThan(0);
  expect(targets.logsBytes).toBeGreaterThan(0);
  expect(targets.hasConfig).toBe(true);
});

test("purge deletes data only — the program is uninstall's business", async () => {
  const home = fixtureHome("separation");
  const { removed } = await purgeData(home);
  expect(removed.sort()).toEqual(["config.json", "logs", "stores"]);
  expect(() => statSync(join(home, "stores"))).toThrow();
  expect(() => statSync(join(home, "logs"))).toThrow();
  // bin/ and versions/ survive a purge: data deletion never hides behind
  // the program-removal door (and vice versa).
  expect(readFileSync(join(home, "bin", "natalia"), "utf8")).toBe(
    "ELF-fake-binary",
  );
});

test("store export archives the stores with a verifying manifest", async () => {
  const home = fixtureHome("export");
  const before = snapshot(join(home, "stores"));
  const dest = join(base, `exported-${randomUUID().slice(0, 8)}`);
  const report = await exportStores(home, dest);
  expect(report.files).toBeGreaterThan(0);
  const manifest = JSON.parse(readFileSync(report.manifest, "utf8")) as {
    name: string;
    files: Array<{ file: string; sha256: string }>;
  };
  expect(manifest.name).toBe("natalia-stores");
  // Every archived file verifies against the manifest (tamper-evidence),
  // and the original store was only read.
  const target = manifest.files.find((file) =>
    file.file.endsWith("rescue.txt"),
  );
  expect(target).toBeDefined();
  const archived = readFileSync(join(dest, target!.file));
  expect(createHash("sha256").update(archived).digest("hex")).toBe(
    target!.sha256,
  );
  expect(archived.toString("utf8")).toBe("RESCUE-RING");
  expect(snapshot(join(home, "stores"))).toEqual(before);
});

test("an installed binary derives its home from the install layout", () => {
  // The bug: installing to /tmp/x then running uninstall reported "no
  // program files under ~/.natalia" — the home came from the default, so
  // the real install stayed and the real home's stores were counted.
  const saved = process.env.NATALIA_HOME;
  try {
    delete process.env.NATALIA_HOME;
    // bin/natalia (the installer's symlink target resolves through it)
    expect(nataliaHomeForExecutable("/opt/natalia/bin/natalia")).toBe(
      "/opt/natalia",
    );
    // versions/<v>/natalia (what process.execPath usually is)
    expect(
      nataliaHomeForExecutable("/opt/natalia/versions/0.0.0-m13/natalia"),
    ).toBe("/opt/natalia");
    // A dev run (bun) has no install layout: the default stands.
    expect(nataliaHomeForExecutable("/usr/bin/bun")).toBeUndefined();
    // The env override still wins over both. nataliaHome() returns
    // resolve(NATALIA_HOME), so the expected value is the resolved spelling
    // — which is the literal on POSIX and the drive-absolute form on Windows.
    process.env.NATALIA_HOME = "/explicit/home";
    expect(nataliaHome()).toBe(resolve("/explicit/home"));
  } finally {
    if (saved === undefined) delete process.env.NATALIA_HOME;
    else process.env.NATALIA_HOME = saved;
  }
});

test("the workspace purge removes Natalia's state, never the project folder", async () => {
  // The other half of "delete my data": each registered workspace's own
  // `<workspace>/.natalia`. The registry is the only list of the workspaces,
  // so it is read first — and the PROJECT FOLDER the state sits in is the
  // user's, never this command's to remove.
  const base = mkdtempSync(join(tmpdir(), "natalia-purge-workspaces-"));
  const home = join(base, "home");
  const withState = join(base, "with-state");
  const withoutState = join(base, "without-state");
  mkdirSync(join(home), { recursive: true });
  mkdirSync(join(withState, ".natalia", "stores"), { recursive: true });
  mkdirSync(join(withoutState), { recursive: true });
  writeFileSync(join(withState, ".natalia", "stores", "session.json"), "{}\n");
  writeFileSync(
    join(home, "workspaces.json"),
    JSON.stringify(
      [
        { path: withState, title: "with state", active: true },
        { path: withoutState, title: "already clean", active: false },
        // A malformed entry must not abort the pass: it is skipped.
        { title: "no path" },
      ],
      null,
      2,
    ),
  );

  const report = await purgeWorkspaceState(home);
  expect(report).toEqual([
    { root: withState, removed: true },
    { root: withoutState, removed: false },
  ]);
  // The state is gone, and the folder the user chose is not.
  expect(existsSync(join(withState, ".natalia"))).toBe(false);
  expect(existsSync(withState)).toBe(true);

  // A home with nothing to read: nothing to delete, and no throw.
  expect(await purgeWorkspaceState(join(base, "no-such-home"))).toEqual([]);

  rmSync(base, { recursive: true, force: true });
});
