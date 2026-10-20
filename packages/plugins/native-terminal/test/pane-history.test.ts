/**
 * A pane's ↑/↓ history belongs to the pane, and survives the runtime.
 *
 * The user's spec for section C is a SESSION-level terminal: after the runtime
 * restarts, the tabs come back and so does what was typed in them. The shell's
 * own history cannot do that — it is one file per user, so every pane of every
 * session offers the same machine-wide list. The controller points the shell's
 * read-line at a per-session, per-pane file instead (`NATALIA_PANE_HISTORY`,
 * honoured by `shell-integration-pwsh.ps1`), and a restored pane comes back with
 * the same id, so it comes back with the same history.
 *
 * Driven against a REAL pwsh in a pty: the sequence is "run a command, let the
 * runtime go away, start the same pane id again, press Up" — and the recalled
 * line proves the history came from the file, because nothing in the second
 * process ever ran that command.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePwshPath } from "@anthelia/platform";
import { createPtyTerminalController } from "../src";

const pwshPath = resolvePwshPath(undefined);

async function canRunPwsh(): Promise<boolean> {
  if (!existsSync(pwshPath)) return false;
  const probe = Bun.spawnSync(
    [pwshPath, "-NoLogo", "-NoProfile", "-Command", '"ok"'],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (probe.exitCode !== 0) return false;
  const modules = Bun.spawnSync(
    [
      pwshPath,
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "if (Get-Module -ListAvailable -Name PSReadLine) { 'yes' } else { 'no' }",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  return modules.stdout.toString().trim().endsWith("yes");
}

test("a pane's ↑/↓ history follows the pane across a runtime restart", async () => {
  if (!(await canRunPwsh())) {
    // The same honest skip the pwsh e2e uses: a host without pwsh, or with a
    // pwsh whose PSReadLine is absent, cannot exercise a read-line history.
    console.warn(`skipped: no pwsh with PSReadLine at ${pwshPath}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-pane-history-"));
  const historyRoot = join(root, "runtime-home");
  const paneID = "term_history_probe";
  const sessionID = "ses_history_probe";
  const historyFile = join(
    historyRoot,
    "pane-history",
    sessionID,
    `${paneID}.txt`,
  );
  const controller = () =>
    createPtyTerminalController({
      workspaceRoot: root,
      publish: () => undefined,
      onPerformance: () => undefined,
      runtimeID: () => "runtime-test",
      userRuntimeHome: () => historyRoot,
    });

  const first = controller();
  try {
    await first.start({ command: pwshPath, cwd: root, id: paneID, sessionID });
    await Bun.sleep(3000);
    first.write(paneID, "echo HISTORY_SEED\r");
    await Bun.sleep(2500);
    expect(existsSync(historyFile)).toBe(true);
    const written = readFileSync(historyFile, "utf8");
    expect(written).toContain("echo HISTORY_SEED");
    const linesAfterFirstRun = written
      .split("\n")
      .filter((line) => line.trim()).length;
    await first.close();

    // The runtime is gone; a new one starts the SAME pane id (which is what the
    // saved layout restores), and its ↑/↓ buffer must already hold the command.
    const second = controller();
    await second.start({ command: pwshPath, cwd: root, id: paneID, sessionID });
    await Bun.sleep(3500);
    second.write(paneID, "\u001b[A");
    await Bun.sleep(1500);
    const pane = await second.snapshot(paneID);
    expect(
      pane.text,
      `pressing Up did not recall the pane's own history; pane tail:\n${pane.text.slice(-500)}`,
    ).toContain("echo HISTORY_SEED");
    // Seeding must not append the same entries again: the file is the pane's
    // history, and a runtime that restarts repeatedly may not grow it.
    const afterSecondStart = readFileSync(historyFile, "utf8");
    expect(
      afterSecondStart.split("\n").filter((line) => line.trim()).length,
    ).toBe(linesAfterFirstRun);
    await second.close();
  } finally {
    await first.close().catch(() => undefined);
  }
}, 90_000);
