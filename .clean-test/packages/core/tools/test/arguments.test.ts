import { expect, test } from "bun:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { workspacePath } from "../src";

const root = resolve(tmpdir(), "natalia-workspace-path-fixture");

test("workspacePath resolves in-workspace relative paths", () => {
  expect(workspacePath(root, "src/index.ts")).toBe(join(root, "src/index.ts"));
  expect(workspacePath(root, "./a/b.txt")).toBe(join(root, "a/b.txt"));
  // An absolute path that is inside the workspace is allowed.
  expect(workspacePath(root, join(root, "inside.ts"))).toBe(
    join(root, "inside.ts"),
  );
});

test("workspacePath refuses paths that leave the workspace", () => {
  for (const escape of [
    "..",
    "../outside.txt",
    "a/../../b",
    "../../etc/passwd",
  ]) {
    expect(() => workspacePath(root, escape), escape).toThrow(
      /path escapes workspace/,
    );
  }
  // An absolute path outside the workspace is refused.
  expect(() =>
    workspacePath(root, resolve(tmpdir(), "definitely-outside.txt")),
  ).toThrow(/path escapes workspace/);
});

test("workspacePath allows in-workspace names that merely start with '..'", () => {
  // A file whose name starts with ".." is a legitimate in-workspace path, not an
  // escape: the escape check matches the whole leading segment, not a ".." prefix.
  const dotdot = workspacePath(root, "..config");
  expect(isAbsolute(dotdot)).toBe(true);
  expect(relative(root, dotdot)).toBe("..config");
  expect(() => workspacePath(root, "nested/..data")).not.toThrow();
});
