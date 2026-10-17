/**
 * A pane whose command names a SHELL is an interactive shell, flags and all.
 *
 * Measured defect this pins: the model opened a pane with
 * `command: "powershell -NoLogo -NoProfile"` (its own words for "give me
 * PowerShell"), and the argv builder treated any extra word as a command —
 *
 *     pwsh -NoLogo -NoProfile -NonInteractive -Command "…; powershell -NoLogo -NoProfile"
 *
 * — so the inner shell had nothing to read and exited at once: the pane's PTY
 * died 731ms after start (`terminal.timeline exit actor:"system"` right after a
 * `status:"running"` start), and every later `send_line`/`snapshot` answered
 * "terminal session has exited". `cmd.exe` had the same fate by a different
 * route: no integration script, so it fell through to the executor and was
 * wrapped as a one-shot command too.
 */
import { expect, test } from "bun:test";
import { interactiveShellArgv } from "../src/shell-integration-argv";

const argsOf = (argv: string[] | undefined) => (argv ?? []).slice(1);

test("a PowerShell named with only switches stays an interactive shell", () => {
  const argv = interactiveShellArgv("powershell -NoLogo -NoProfile", "win32");
  expect(argv).toBeDefined();
  const args = argsOf(argv);
  // Interactive: the pane keeps its shell and its integration, and this is the
  // exact pair the model asked for.
  expect(args).toContain("-NoExit");
  expect(args).toContain("-Command");
  // No `-NonInteractive`: that is what made the pane's own shell the last thing
  // it would run.
  expect(args).not.toContain("-NonInteractive");
  // The caller's switches ride in FRONT of `-Command`, deduped: the integration
  // already passes `-NoLogo`, so it must not appear twice, and `-NoProfile` (the
  // caller's) must survive.
  expect(args.filter((arg) => arg === "-NoLogo")).toHaveLength(1);
  expect(args).toContain("-NoProfile");
  expect(args.indexOf("-NoProfile")).toBeLessThan(args.indexOf("-Command"));
  // No nesting: the shell is not run as a command inside another shell. The last
  // argument is the integration script's dot-source, not a second `powershell`.
  expect(args.at(-1)).toContain("shell-integration-pwsh.ps1");
  expect(args.at(-1)?.startsWith(". ")).toBe(true);
});

test("pwsh with switches is the same shape", () => {
  const args = argsOf(interactiveShellArgv("pwsh -NoLogo -NoProfile", "win32"));
  expect(args).toContain("-Interactive");
  expect(args).toContain("-NoExit");
  expect(args).not.toContain("-NonInteractive");
  expect(args.at(-1)).toContain("shell-integration-pwsh.ps1");
});

test("a shell we do not integrate is still an interactive pane", () => {
  // cmd.exe has no integration script. Before this it became
  // `pwsh -NonInteractive -Command "…; cmd.exe"` and the pane died at once.
  const argv = interactiveShellArgv("cmd.exe", "win32");
  expect(argv).toBeDefined();
  expect(argv?.[0]?.toLowerCase()).toContain("cmd");
  expect(argsOf(argv)).toEqual([]);
  // With its own switches, they are passed through to the shell.
  const withFlags = interactiveShellArgv("cmd.exe /k", "win32");
  expect(withFlags?.[0]?.toLowerCase()).toContain("cmd");
  expect(argsOf(withFlags)).toEqual(["/k"]);
});

test("a real command is still a command, not a shell", () => {
  // The rule that must not weaken: a command that merely CONTAINS a shell's name
  // stays under the executor's wrapper.
  expect(
    interactiveShellArgv("exec bash --norc --noprofile", "win32"),
  ).toBeUndefined();
  // A non-shell program with a switch is not a shell either — `echo -n` would be
  // a pane that runs once and dies, the same bug wearing the opposite mask.
  expect(interactiveShellArgv("echo -n", "win32")).toBeUndefined();
  expect(interactiveShellArgv("python -V", "win32")).toBeUndefined();
});
