import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectWorkspaceGitDiff,
  parseStatusLine,
} from "../src/runtime/workspace-runtime";

async function git(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout;
}

test("parseStatusLine unwraps quoted paths and rename records", () => {
  expect(parseStatusLine('?? "file with space.txt"')).toEqual({
    path: "file with space.txt",
    operation: "added",
    untracked: true,
  });
  expect(parseStatusLine("R  old.ts -> new.ts")).toEqual({
    path: "new.ts",
    operation: "renamed",
    oldPath: "old.ts",
    untracked: false,
  });
  expect(parseStatusLine(" M src/app.ts")).toEqual({
    path: "src/app.ts",
    operation: "modified",
    untracked: false,
  });
});

test("collectWorkspaceGitDiff returns empty for a non-git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-git-diff-none-"));
  await writeFile(join(root, "readme.txt"), "hello\n");
  expect(await collectWorkspaceGitDiff(root)).toEqual([]);
});

test("collectWorkspaceGitDiff reports tracked and untracked worktree files", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-git-diff-worktree-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "natalia@example.com"]);
  await git(root, ["config", "user.name", "Natalia"]);
  await writeFile(join(root, "tracked.ts"), "const a = 1;\n");
  await git(root, ["add", "tracked.ts"]);
  await git(root, ["commit", "-m", "init"]);
  await writeFile(join(root, "tracked.ts"), "const a = 2;\n");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "new.ts"), "export const n = 1;\n");
  const changes = await collectWorkspaceGitDiff(root, {
    from: "HEAD",
    to: "WORKTREE",
  });
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "tracked.ts",
        operation: "modified",
      }),
      expect.objectContaining({
        path: "nested/new.ts",
        operation: "added",
      }),
    ]),
  );
  const modified = changes.find((change) => change.path === "tracked.ts");
  expect(modified?.patch).toContain("-const a = 1;");
  expect(modified?.patch).toContain("+const a = 2;");
  const added = changes.find((change) => change.path === "nested/new.ts");
  expect(added?.patch).toContain("+export const n = 1;");
});
