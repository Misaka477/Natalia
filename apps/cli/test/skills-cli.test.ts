import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
