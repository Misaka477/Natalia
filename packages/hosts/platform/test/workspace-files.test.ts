import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  globWorkspaceFilesBounded,
  grepWorkspaceFilesBounded,
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
