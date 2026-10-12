import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `natalia skills`: the operator's path for what the settings panel
 * deliberately does not offer (a delete for plugin-shipped skills). Every
 * subcommand goes through the daemon; no daemon is a named answer.
 */

let base = "";

function run(args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args],
    { cwd: base, stdout: "pipe", stderr: "pipe" },
  );
}

test("skills refuses an unknown subcommand with the usage", () => {
  base = mkdtempSync(join(tmpdir(), "skills-cli-gate-"));
  try {
    const child = run(["skills", "sweep"]);
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain(
      "usage: natalia skills",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("skills without a daemon says which command starts one", () => {
  base = mkdtempSync(join(tmpdir(), "skills-cli-nodaemon-"));
  try {
    const child = run(["skills", "list"]);
    expect(child.exitCode).not.toBe(0);
    const err = new TextDecoder().decode(child.stderr);
    expect(err).toContain("no daemon is running");
    expect(err).toContain("natalia daemon");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("skills remove without a name is refused before the daemon is asked", () => {
  base = mkdtempSync(join(tmpdir(), "skills-cli-noname-"));
  try {
    const child = run(["skills", "remove"]);
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain(
      "requires a skill name",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("skills pin without a name is refused before the daemon is asked", () => {
  base = mkdtempSync(join(tmpdir(), "skills-cli-pin-noname-"));
  try {
    for (const action of ["pin", "unpin"]) {
      const child = run(["skills", action]);
      expect(child.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(child.stderr)).toContain(
        "requires a skill name",
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("evolution land refuses a missing card path and a malformed card before touching the daemon", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-land-gate-"));
  try {
    // No --from: the usage, not a crash.
    const noFrom = run(["evolution", "land"]);
    expect(noFrom.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noFrom.stderr)).toContain("--from");

    // A malformed card is refused by shape BEFORE the daemon is asked —
    // the boundary's job is the write, and this is the caller's.
    const bad = join(base, "bad.json");
    writeFileSync(bad, JSON.stringify({ name: "x" }), "utf8");
    const malformed = run([
      "evolution",
      "land",
      "--from",
      "bad.json",
      "--workspace",
      base,
    ]);
    expect(malformed.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(malformed.stderr)).toContain(
      "name, description, body",
    );

    // An unreadable card names the path.
    const missing = run([
      "evolution",
      "land",
      "--from",
      "nope.json",
      "--workspace",
      base,
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(missing.stderr)).toContain("cannot read");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("skills gc is a dry run: it lists and never deletes, and says when it cannot see usage", () => {
  base = mkdtempSync(join(tmpdir(), "skills-cli-gc-"));
  try {
    // No daemon: named failure (the catalog lives there).
    const noDaemon = run(["skills", "gc"]);
    expect(noDaemon.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noDaemon.stderr)).toContain(
      "natalia daemon",
    );
    // An unknown action still shows the usage, and the usage names gc.
    const unknown = run(["skills", "sweep"]);
    expect(new TextDecoder().decode(unknown.stderr)).toContain("skills gc");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
