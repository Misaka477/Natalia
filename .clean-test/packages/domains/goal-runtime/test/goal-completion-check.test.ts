import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompletionCheck } from "@natalia/goal-runtime";

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
  const result = runCompletionCheck({ workspaceRoot: root, command: "true" });

  expect(result?.ok).toBe(true);
  expect(result?.command).toBe("true");
  expect(result?.detail).toBeUndefined();
});

test("a failing command reports the exit code and its output", async () => {
  const root = await workspace();
  const result = runCompletionCheck({
    workspaceRoot: root,
    command: "echo 'tests failed'; exit 3",
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
    command: "test -f marker.txt",
  });

  expect(result?.ok).toBe(true);
});

test("a huge output is bounded, because the result is read by the model", async () => {
  const root = await workspace();
  const result = runCompletionCheck({
    workspaceRoot: root,
    command: `printf 'x%.0s' $(seq 1 20000); exit 1`,
  });

  expect(result?.ok).toBe(false);
  // Bounded rather than dumped: an unbounded dump spends the context the check
  // is trying to protect.
  expect(result!.detail!.length).toBeLessThan(4_400);
  expect(result!.detail).toContain("more characters");
});
