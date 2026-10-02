import { expect, test } from "bun:test";
import { mkdtemp, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  renameWorkspaceFile,
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
  await symlink(outside, join(ws, "escape"));
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
