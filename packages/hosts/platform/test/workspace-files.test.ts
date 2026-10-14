import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
  renameWorkspaceFile,
  runTrashCommand,
  writeWorkspaceFile,
} from "../src/index";

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

const exists = (p: string) =>
  stat(p)
    .then(() => true)
    .catch(() => false);

test("createWorkspaceFile cannot escape the workspace through a symlinked directory", async () => {
  const ws = await tmp("natalia-ws-create-");
  const outside = await tmp("natalia-outside-");
  // A junction on Windows: an unprivileged process cannot create a
  // directory symlink there (EPERM), and a junction is what the
  // resolver sees through realpath either way — the property under test
  // is the escape detection, not the link kind.
  await symlink(
    outside,
    join(ws, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  // Lexically inside the workspace, but `escape` is a symlink pointing out.
  await expect(
    createWorkspaceFile({
      workspaceRoot: ws,
      path: "escape/evil.txt",
      content: "x",
    }),
  ).rejects.toThrow(/must remain inside workspace/);
  expect(await exists(join(outside, "evil.txt"))).toBe(false);
});

test("createWorkspaceFile still creates a deep new path inside the workspace", async () => {
  const ws = await tmp("natalia-ws-deep-");
  const result = await createWorkspaceFile({
    workspaceRoot: ws,
    path: "a/b/c/deep.txt",
    content: "ok",
  });
  expect(result.created).toBe(true);
  expect(await exists(join(ws, "a/b/c/deep.txt"))).toBe(true);
});

test("workspace write ops reject absolute and .. paths before touching disk", async () => {
  const ws = await tmp("natalia-ws-reject-");
  await expect(
    createWorkspaceFile({
      workspaceRoot: ws,
      path: "../escape.txt",
      content: "x",
    }),
  ).rejects.toThrow(/must remain inside workspace/);
  await expect(
    writeWorkspaceFile({ workspaceRoot: ws, path: "/etc/evil", content: "x" }),
  ).rejects.toThrow(/must remain inside workspace/);
  await expect(
    deleteWorkspaceFile({ workspaceRoot: ws, path: "../x" }),
  ).rejects.toThrow(/must remain inside workspace/);
  await expect(
    renameWorkspaceFile({ workspaceRoot: ws, path: "../a", newPath: "b" }),
  ).rejects.toThrow(/must remain inside workspace/);
  // A rename destination that escapes is refused too.
  await writeWorkspaceFile({
    workspaceRoot: ws,
    path: "src.txt",
    content: "x",
  });
  await expect(
    renameWorkspaceFile({
      workspaceRoot: ws,
      path: "src.txt",
      newPath: "../out.txt",
    }),
  ).rejects.toThrow(/must remain inside workspace/);
});

test(".natalia/plans is searchable; the runtime's internals are not (F7)", async () => {
  // The 2026-10-10 sweep's F7: `.natalia` was in the blanket ignored set, so
  // the plan documents — the working contract every agent reads — were
  // invisible to the tools meant to find them. A hand-built plan document was
  // unfindable by glob/grep and unpicked by the registry scan.
  const root = await mkdtemp(join(tmpdir(), "natalia-f7-"));
  for (const dir of [
    ".natalia/plans",
    ".natalia/tool-output",
    ".natalia/sessions",
    "node_modules/dep",
  ])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, ".natalia/plans/my-plan.md"), "# plan\n");
  await writeFile(join(root, ".natalia/tool-output/spill.log"), "spill\n");
  await writeFile(join(root, ".natalia/sessions/s.json"), "{}\n");
  await writeFile(join(root, "node_modules/dep/index.ts"), "dep\n");
  await writeFile(join(root, "src.ts"), "src\n");
  const markdown = await globWorkspaceFilesBounded({
    workspaceRoot: root,
    pattern: "**/*.md",
  });
  // The plan is found by a general search.
  expect(markdown.paths).toContain(".natalia/plans/my-plan.md");
  const types = await globWorkspaceFilesBounded({
    workspaceRoot: root,
    pattern: "**/*.ts",
  });
  // Runtime internals and dependencies are still out.
  expect(types.paths).toEqual(["src.ts"]);
  // And the plan's CONTENT is greppable.
  const hits = await grepWorkspaceFilesBounded({
    workspaceRoot: root,
    pattern: "plan",
  });
  expect(hits.matches.map((match) => match.path)).toContain(
    ".natalia/plans/my-plan.md",
  );
  await rm(root, { recursive: true, force: true });
});

// The workspace UI offers delete on directories and files alike, and the
// Windows trash API is TWO functions: DeleteFile fails on a directory with
// "could not find the file" (exit 1), which is what made deleting a
// directory from the workspace silently do nothing on Windows while Linux
// (gio trash) accepted it. The dispatch and the refusal message are pinned
// here with the platform and the spawn injected, so the Windows branch is
// proven from any host.
describe("deleteWorkspaceFile trash dispatch", () => {
  const fakeStat = (isDirectory: boolean) => async () => ({
    isDirectory: () => isDirectory,
  });
  const recorder =
    (calls: string[], fail?: string) =>
    async (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      if (fail && command === fail)
        throw new Error(command + " is not installed");
    };

  test("windows: a directory goes to DeleteDirectory, not the file API", async () => {
    const ws = await tmp("natalia-ws-del-dir-");
    const calls: string[] = [];
    const result = await deleteWorkspaceFile({
      workspaceRoot: ws,
      path: "src",
      os: "win32",
      statPath: fakeStat(true),
      runTrash: recorder(calls),
    });
    expect(result).toEqual({ deleted: true, trash: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("DeleteDirectory");
    expect(calls[0]).not.toContain("DeleteFile");
  });

  test("windows: a file goes to DeleteFile", async () => {
    const ws = await tmp("natalia-ws-del-file-");
    const calls: string[] = [];
    await deleteWorkspaceFile({
      workspaceRoot: ws,
      path: "src.ts",
      os: "win32",
      statPath: fakeStat(false),
      runTrash: recorder(calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("DeleteFile");
    expect(calls[0]).not.toContain("DeleteDirectory");
  });

  test("windows: a single quote in the path is escaped, not injected", async () => {
    const ws = await tmp("natalia-ws-del-quote-");
    const calls: string[] = [];
    await deleteWorkspaceFile({
      workspaceRoot: ws,
      path: "it's-a-dir",
      os: "win32",
      statPath: fakeStat(true),
      runTrash: recorder(calls),
    });
    expect(calls[0]).toContain("it''s-a-dir");
  });

  test("darwin: the Finder path is unchanged for both types", async () => {
    const ws = await tmp("natalia-ws-del-darwin-");
    const calls: string[] = [];
    await deleteWorkspaceFile({
      workspaceRoot: ws,
      path: "src",
      os: "darwin",
      statPath: fakeStat(true),
      runTrash: recorder(calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("osascript");
    expect(calls[0]).toContain("Finder");
  });

  test("linux: gio first, trash-put as the fallback", async () => {
    const ws = await tmp("natalia-ws-del-linux-");
    const calls: string[] = [];
    await deleteWorkspaceFile({
      workspaceRoot: ws,
      path: "src",
      os: "linux",
      statPath: fakeStat(true),
      runTrash: recorder(calls, "gio"),
    });
    expect(calls).toEqual([
      expect.stringContaining("gio trash"),
      expect.stringContaining("trash-put"),
    ]);
  });

  test("a failing trash command surfaces its stderr in the refusal", async () => {
    // The real runner, driven by a command that exits non-zero and writes
    // to stderr: the runtime itself running a failing script. The old
    // message was "failed to move to trash: powershell.exe" — true, and
    // actionable in no way.
    await expect(
      runTrashCommand(process.execPath, [
        "-e",
        "console.error('boom'); process.exit(3)",
      ]),
    ).rejects.toThrow(/failed to move to trash via .*boom/u);
  });

  test("a missing trash binary is a refusal, not a raw ENOENT", async () => {
    await expect(
      runTrashCommand("natalia-no-such-trash-binary", []),
    ).rejects.toThrow(
      /failed to move to trash via natalia-no-such-trash-binary/u,
    );
  });
});
