import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SnapshotSandboxManager,
  sandboxToolFamily,
  sandboxTools,
  WorkspaceSandboxManager,
  WorktreeSandboxManager,
} from "../src";

async function git(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim());
  return stdout.trim();
}

test("the sandbox family describes the tools it ships", () => {
  const family = sandboxToolFamily();
  expect(family.id).toBe("sandbox");
  expect(family.scope).toBe("workspace");
  expect(family.tools.map((tool) => tool.name)).toEqual(
    sandboxTools().map((tool) => tool.name),
  );
});

test("sandbox tools refuse without a sandbox manager", async () => {
  const tool = sandboxToolFamily().tools.find(
    (candidate) => candidate.name === "sandbox_create",
  )!;
  // sandbox_create validates its arguments before it reaches the manager, so
  // the refusal is "no sandbox manager" only once the input is well-formed.
  await expect(
    tool.execute({ id: "probe", path: "probe" }, {
      workspaceRoot: "/tmp",
    } as never),
  ).rejects.toThrow(
    /sandbox manager is unavailable|requires a sandbox manager|sandbox/u,
  );
});

test("sandbox tools run through the worktree backend (create/write/merge)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-wt-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@natalia"]);
  await git(root, ["config", "user.name", "Natalia Test"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const manager = new WorktreeSandboxManager(root);
  await manager.initialize();
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );

  await tools.get("sandbox_create")!.execute({ id: "wt.1" }, context);
  // The sandbox is a real worktree on a candidate branch.
  expect(await manager.exists("wt.1")).toBe(true);

  await tools
    .get("sandbox_write")!
    .execute({ id: "wt.1", path: "file.txt", content: "edited\n" }, context);

  const merged = await tools
    .get("sandbox_merge")!
    .execute({ id: "wt.1" }, context);
  expect(JSON.parse(merged)).toContainEqual(
    expect.objectContaining({ path: "file.txt", kind: "modify" }),
  );
  // The write was promoted into the system branch: the workspace file changed.
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("edited\n");
  expect(await manager.lastKnownGoodCommit()).toBeDefined();
});

test("sandbox tools run through the git-free snapshot backend (no git needed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-snap-"));
  await writeFile(join(root, "file.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );

  await tools.get("sandbox_create")!.execute({ id: "snap.1" }, context);
  await tools
    .get("sandbox_write")!
    .execute({ id: "snap.1", path: "file.txt", content: "edited\n" }, context);

  const merged = await tools
    .get("sandbox_merge")!
    .execute({ id: "snap.1" }, context);
  expect(JSON.parse(merged)).toContainEqual(
    expect.objectContaining({ path: "file.txt", kind: "modify" }),
  );
  // Promoted into the host — no git anywhere in the workspace.
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("edited\n");
  expect(await manager.hasLastKnownGood("snap.1")).toBe(true);

  // Rollback restores the host to the pre-promotion state.
  await manager.rollback("snap.1");
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
});

test("sandbox_create reads the resolved config service (runtimeConfig) to name its backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-backend-"));
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tool = sandboxToolFamily().tools.find(
    (candidate) => candidate.name === "sandbox_create",
  )!;
  const created = await tool.execute({ id: "cfg.1" }, {
    workspaceRoot: root,
    sandboxes: manager,
    // The resolved config service: sandbox.backend=worktree was configured.
    runtimeConfig: () => ({ sandbox: { backend: "worktree" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
  } as never);
  const parsed = JSON.parse(created) as { backend?: string };
  // The tool family consumed the runtime.config service by name — the D2
  // service is genuinely used by a real production tool, not just plugins.
  expect(parsed.backend).toBe("worktree");
});
test("sandbox tools create execute diff and merge through the registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-sandbox-"));
  const events: string[] = [];
  const context = {
    workspaceRoot: root,
    sandboxes: new WorkspaceSandboxManager(join(root, ".natalia", "sandboxes")),
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: (event: { type: string }) => events.push(event.type),
  };
  const tools = new Map(sandboxTools().map((tool) => [tool.name, tool]));
  await tools.get("sandbox_create")!.execute({ id: "box" }, context);
  expect(
    await tools
      .get("sandbox_execute")!
      .execute({ id: "box", command: "printf sandbox-tool-ok" }, context),
  ).toContain("sandbox-tool-ok");
  await tools
    .get("sandbox_write")!
    .execute(
      { id: "box", path: "nested/note.txt", content: "sandbox content" },
      context,
    );
  expect(
    await tools.get("sandbox_diff")!.execute({ id: "box" }, context),
  ).toContain("nested/note.txt");
  await tools.get("sandbox_merge")!.execute({ id: "box" }, context);
  expect(await readFile(join(root, "nested", "note.txt"), "utf8")).toBe(
    "sandbox content",
  );
  expect(events).toContain("sandbox.update");
  const resource = JSON.parse(
    await tools.get("sandbox_resource_start")!.execute(
      {
        id: "box",
        resourceID: "resource_tool",
        command: "printf tool-resource; sleep 30",
      },
      context,
    ),
  ) as { id: string };
  await waitForOutput(
    async () =>
      tools
        .get("sandbox_resource_output")!
        .execute({ id: "box", resourceID: resource.id }, context),
    "tool-resource",
  );
  expect(
    await tools.get("sandbox_resource_list")!.execute({ id: "box" }, context),
  ).toContain("resource_tool");
  await tools
    .get("sandbox_resource_stop")!
    .execute({ id: "box", resourceID: resource.id }, context);
  await tools.get("sandbox_delete")!.execute({ id: "box" }, context);
  expect(events).toContain("sandbox.audit");
});

async function waitForOutput(read: () => Promise<string>, expected = "ready") {
  for (let index = 0; index < 50; index++) {
    if ((await read()).includes(expected)) return;
    await Bun.sleep(20);
  }
}

test("sandbox_rollback undoes a promotion and clears the same gate as the merge", async () => {
  // It rewrites host files, so it must not be a weaker path than the merge it
  // undoes — the authorization runs before the host is touched.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-rollback-"));
  await writeFile(join(root, "file.txt"), "before\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const sandbox = await manager.create("sb_tool");
  await writeFile(join(sandbox.root, "file.txt"), "promoted\n");
  await manager.promoteWithValidation("sb_tool", {
    command: "true",
    hostRoot: root,
  });
  const events: unknown[] = [];
  const authorized: string[][] = [];
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    sandboxMergeAuthorize: async ({ paths }: { paths: string[] }) => {
      authorized.push(paths);
    },
    onSandboxEvent: (event: unknown) => events.push(event),
    onWorkspaceChange: () => {},
  } as never;
  const tool = sandboxTools().find((t) => t.name === "sandbox_rollback")!;

  const output = await tool.execute({ id: "sb_tool" }, context);

  expect(authorized).toHaveLength(1);
  expect(JSON.parse(output as string).restored).toBe(true);
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("before\n");
  // The transition is reported as an audit fact, not left as a silent rewrite.
  expect(
    events.some(
      (event) =>
        (event as { type: string; action?: string }).type === "sandbox.audit" &&
        (event as { action?: string }).action === "rollback",
    ),
  ).toBe(true);
});

test("a second candidate from the same base is refused and the first survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-conflicted-"));
  await writeFile(join(root, "shared.ts"), "BASE\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  // Both candidates are created before either is promoted — which is what a
  // fan-out does: spawn the batch, then review it. A sandbox created after a
  // promotion would snapshot the promoted host and have nothing to conflict with.
  const first = await manager.create("sb_one");
  const other = await manager.create("sb_two");
  await writeFile(join(first.root, "shared.ts"), "ONE\n");
  await writeFile(join(other.root, "shared.ts"), "TWO\n");
  await manager.promoteWithValidation("sb_one", {
    command: "true",
    hostRoot: root,
  });

  await expect(
    manager.promoteWithValidation("sb_two", {
      command: "true",
      hostRoot: root,
    }),
  ).rejects.toThrow(/conflicts with changes already on the host/);
  // The first candidate's work survived the refusal.
  expect(await readFile(join(root, "shared.ts"), "utf8")).toBe("ONE\n");
});
