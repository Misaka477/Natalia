import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompletionCheck } from "@natalia/goal-runtime";

/**
 * The check runs the WORKSPACE's configured command through the host's own
 * shell (`shell: true`), so the fixtures spell the host's dialect: a POSIX
 * `true` is not a Windows command, and a fixture that forgot the platform
 * failed four tests there for a reason that had nothing to do with the
 * check itself. Each helper is the same behaviour in both shells.
 */
const onWindows = process.platform === "win32";
const passCmd = "exit 0";
const failCmd = onWindows
  ? "echo tests failed & exit 3"
  : "echo 'tests failed'; exit 3";
const cwdCmd = onWindows ? "if exist marker.txt exit 0" : "test -f marker.txt";
const hugeCmd =
  "node -e \"process.stdout.write('x'.repeat(20000)); process.exit(1)\"";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "natalia-goal-check-"));
}

test("no configured command means no check at all", () => {
  // An invented default would fail every workspace with no test suite, and a
  // silently passing one would be theatre.
  expect(
    runCompletionCheck({ workspaceRoot: "/tmp", command: undefined }),
  ).toBeUndefined();
});

test("a passing command reports success with no detail", async () => {
  const root = await workspace();
  const result = runCompletionCheck({ workspaceRoot: root, command: passCmd });

  expect(result?.ok).toBe(true);
  expect(result?.command).toBe(passCmd);
  expect(result?.detail).toBeUndefined();
});

test("a failing command reports the exit code and its output", async () => {
  const root = await workspace();
  const result = runCompletionCheck({
    workspaceRoot: root,
    command: failCmd,
  });

  expect(result?.ok).toBe(false);
  expect(result?.detail).toContain("Exit code 3");
  // The output is shown to the model so it can see why it was refused.
  expect(result?.detail).toContain("tests failed");
});

test("the command runs in the workspace root", async () => {
  const root = await workspace();
  await writeFile(join(root, "marker.txt"), "here");
  const result = runCompletionCheck({
    workspaceRoot: root,
    command: cwdCmd,
  });

  expect(result?.ok).toBe(true);
});

test("a huge output is bounded, because the result is read by the model", async () => {
  const root = await workspace();
  const result = runCompletionCheck({
    workspaceRoot: root,
    command: hugeCmd,
  });

  expect(result?.ok).toBe(false);
  // Bounded rather than dumped: an unbounded dump spends the context the check
  // is trying to protect.
  expect(result!.detail!.length).toBeLessThan(4_400);
  expect(result!.detail).toContain("more characters");
});
