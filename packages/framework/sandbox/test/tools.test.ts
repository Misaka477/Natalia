import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SnapshotSandboxManager,
  detectPromoteCommand,
  sandboxSelfDiffTool,
  sandboxToolFamily,
  sandboxTools,
  validationFailure,
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

test("detectPromoteCommand reads the workspace's own project markers", async () => {
  const npmRoot = await mkdtemp(join(tmpdir(), "natalia-promote-npm-"));
  await writeFile(join(npmRoot, "package.json"), "{}\n");
  expect(detectPromoteCommand(npmRoot)).toEqual({
    command: "npm run typecheck",
    marker: "package.json",
  });

  const cmakeRoot = await mkdtemp(join(tmpdir(), "natalia-promote-cmake-"));
  await writeFile(join(cmakeRoot, "CMakeLists.txt"), "project(x)\n");
  expect(detectPromoteCommand(cmakeRoot)).toEqual({
    command: "cmake -S . -B build && cmake --build build",
    marker: "CMakeLists.txt",
  });

  const rustRoot = await mkdtemp(join(tmpdir(), "natalia-promote-rust-"));
  await writeFile(join(rustRoot, "Cargo.toml"), "[package]\n");
  expect(detectPromoteCommand(rustRoot)).toEqual({
    command: "cargo check",
    marker: "Cargo.toml",
  });

  const pyRoot = await mkdtemp(join(tmpdir(), "natalia-promote-py-"));
  await writeFile(join(pyRoot, "pyproject.toml"), "[project]\n");
  expect(detectPromoteCommand(pyRoot)).toEqual({
    command: "python -m compileall .",
    marker: "pyproject.toml",
  });

  // The first marker wins: a workspace carrying several declares its primary
  // build by which file sits at its root.
  const bothRoot = await mkdtemp(join(tmpdir(), "natalia-promote-both-"));
  await writeFile(join(bothRoot, "CMakeLists.txt"), "project(x)\n");
  await writeFile(join(bothRoot, "Cargo.toml"), "[package]\n");
  expect(detectPromoteCommand(bothRoot)?.marker).toBe("CMakeLists.txt");

  // No recognizable marker: the caller must ask, not guess.
  const bareRoot = await mkdtemp(join(tmpdir(), "natalia-promote-bare-"));
  expect(detectPromoteCommand(bareRoot)).toBeUndefined();
});

test("sandbox_merge validates with the marker's command, the config's, or refuses (T-09)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-cmake-"));
  await writeFile(join(root, "CMakeLists.txt"), "project(merge)\n");
  // A manager that records the command instead of running it: the assertion
  // is which command the merge chose, not whether cmake exists here.
  const commands: string[] = [];
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const contextFor = (runtimeConfig?: () => unknown) =>
    ({
      workspaceRoot: root,
      sandboxes: {
        async promoteWithValidation(_id: string, input: { command: string }) {
          commands.push(input.command);
          return { changedFiles: [] };
        },
        updateEvent: () => ({}),
        auditEvent: () => ({}),
      },
      ...(runtimeConfig ? { runtimeConfig } : {}),
      onSandboxEvent: () => undefined,
      onWorkspaceChange: () => undefined,
      sandboxMergeAuthorize: async () => undefined,
    }) as never;

  await tools.get("sandbox_merge")!.execute({ id: "sb.1" }, contextFor());
  // The CMake project is validated by its own toolchain, not npm.
  expect(commands).toEqual(["cmake -S . -B build && cmake --build build"]);

  await tools.get("sandbox_merge")!.execute(
    { id: "sb.2" },
    contextFor(() => ({ sandbox: { promoteCommand: "  true  " } })),
  );
  // The configured command wins over the marker (and its whitespace is trimmed).
  expect(commands[1]).toBe("true");
});

test("sandbox_merge's buildCommand outranks the marker and the config (P0-2)", async () => {
  // The 2026-10-08 audit's P0-2: a CMake workspace could never promote,
  // because the gate's contract is `npm run typecheck` + package.json and no
  // parameter could say otherwise — while `team_review` carries one. Now the
  // caller names the project's own toolchain.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-cmd-"));
  await writeFile(join(root, "CMakeLists.txt"), "project(merge)\n");
  const commands: string[] = [];
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: {
      async promoteWithValidation(_id: string, input: { command: string }) {
        commands.push(input.command);
        return { changedFiles: [] };
      },
      updateEvent: () => ({}),
      auditEvent: () => ({}),
    },
    runtimeConfig: () => ({ sandbox: { promoteCommand: "configured-cmd" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;

  await tools
    .get("sandbox_merge")!
    .execute({ id: "sb.1", buildCommand: "  make -j4  " }, context);
  // The explicit command wins over both the config and the marker, and its
  // whitespace is trimmed.
  expect(commands).toEqual(["make -j4"]);
  // The parameter is declared, so a model can discover it.
  const properties = (
    tools.get("sandbox_merge")!.parameters as {
      properties: Record<string, unknown>;
    }
  ).properties;
  expect(Object.keys(properties)).toContain("buildCommand");
});

test("sandbox_merge refuses a workspace with no marker and no configured command", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-bare-"));
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await expect(
    tools.get("sandbox_merge")!.execute({ id: "sb.x" }, {
      workspaceRoot: root,
      sandboxes: {},
      onSandboxEvent: () => undefined,
      onWorkspaceChange: () => undefined,
      sandboxMergeAuthorize: async () => undefined,
    } as never),
  ).rejects.toThrow(/sandbox_merge needs a validation command/u);
  // The refusal names every marker it looked for and the setting to use.
  await expect(
    tools.get("sandbox_merge")!.execute({ id: "sb.x" }, {
      workspaceRoot: root,
      sandboxes: {},
      onSandboxEvent: () => undefined,
      onWorkspaceChange: () => undefined,
      sandboxMergeAuthorize: async () => undefined,
    } as never),
  ).rejects.toThrow(/sandbox\.promoteCommand/u);
});

test("sandbox_delete names what the deletion discarded (T-10)", async () => {
  // The result used to be bare arrays — pendingChanges and runningResources
  // — so a caller could not tell whether the delete happened at all, and a
  // sandbox with unmerged work reported its loss as a list of files rather
  // than the fact that this deletion discards them.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-delete-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;

  await tools.get("sandbox_create")!.execute({ id: "gone.1" }, context);
  await tools
    .get("sandbox_write")!
    .execute(
      { id: "gone.1", path: "unmerged.txt", content: "never merged\n" },
      context,
    );
  const deleted = JSON.parse(
    await tools.get("sandbox_delete")!.execute({ id: "gone.1" }, context),
  ) as {
    deleted?: boolean;
    discardedChanges?: number;
    discardedPaths?: string[];
    pendingChanges: Array<{ path: string }>;
  };
  // The operation's own fact, and the discard it performed.
  expect(deleted.deleted).toBe(true);
  expect(deleted.discardedChanges).toBe(1);
  expect(deleted.discardedPaths).toEqual(["unmerged.txt"]);
  // The full list the discard refers to is still carried.
  expect(deleted.pendingChanges.map((change) => change.path)).toEqual([
    "unmerged.txt",
  ]);
  // The sandbox is really gone: the manager no longer knows it.
  await expect(manager.delete("gone.1")).rejects.toThrow(/unknown sandbox/i);
});

test("sandbox_delete of a clean sandbox reports a zero discard, not a silent success", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-clean-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "clean.1" }, context);
  const deleted = JSON.parse(
    await tools.get("sandbox_delete")!.execute({ id: "clean.1" }, context),
  ) as {
    deleted?: boolean;
    discardedChanges?: number;
    discardedPaths?: string[];
  };
  expect(deleted.deleted).toBe(true);
  expect(deleted.discardedChanges).toBe(0);
  expect(deleted.discardedPaths).toEqual([]);
});

test("sandbox_rollback refuses with a reason, not a bare false (T-11)", async () => {
  // A rollback with nothing to undo used to answer {restored: false,
  // restoredPaths: []} — indistinguishable from a mute backend. The reason
  // names the obstacle.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-rb-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "rb.1" }, context);
  // No promotion ever ran, so there is no rollback point.
  const refused = JSON.parse(
    await tools.get("sandbox_rollback")!.execute({ id: "rb.1" }, context),
  ) as { restored: boolean; reason?: string };
  expect(refused.restored).toBe(false);
  expect(refused.reason).toContain("rb.1");
  expect(refused.reason).toContain("last-known-good");
});

test("no promote path hardcodes a toolchain default (T-09 regression guard)", async () => {
  // The 2026-10-07 smoke run: a CMake/C workspace's sandbox_merge ran
  // `npm run typecheck` (the client runtime's hardcoded fallback), failed on
  // the absent package.json with exit 254, and the merge never landed. The
  // command now comes from the config, then from the workspace's own
  // markers, then a refusal — never a default. This pins that across both
  // surfaces: the sandbox tool family and the client runtime bridge.
  const sandboxToolSource = await Bun.file(
    new URL("../src/tools.ts", import.meta.url),
  ).text();
  expect(sandboxToolSource.includes('?? "npm run typecheck"')).toBe(false);
  expect(sandboxToolSource.includes('|| "npm run typecheck"')).toBe(false);
  const clientBridge = await Bun.file(
    new URL(
      "../../../framework/client/src/runtime/sandbox-runtime.ts",
      import.meta.url,
    ),
  ).text();
  expect(clientBridge.includes('|| "npm run typecheck"')).toBe(false);
  expect(clientBridge.includes("detectPromoteCommand")).toBe(true);
  // CMake workspaces resolve to cmake, not to a JS toolchain.
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-cmake-"));
  await writeFile(join(root, "CMakeLists.txt"), "project(demo C)\n");
  expect(detectPromoteCommand(root)).toEqual({
    command: "cmake -S . -B build && cmake --build build",
    marker: "CMakeLists.txt",
  });
  rmSync(root, { recursive: true, force: true });
});

test("sandbox_delete's discarded count is the number of paths, not of rows (P1-14)", async () => {
  // The 2026-10-08 audit's P1-14: `discardedPaths` listed the same path
  // repeatedly and `discardedChanges` counted the rows — `package.json`
  // twice with `discardedChanges: 3` for two real paths. A caller approves
  // the destruction of N paths, so N must be the number of paths.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-dup-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "dup.1" }, context);
  // The same path, written twice: one real path, two change rows.
  await tools
    .get("sandbox_write")!
    .execute({ id: "dup.1", path: "a.txt", content: "one\n" }, context);
  await tools
    .get("sandbox_write")!
    .execute({ id: "dup.1", path: "a.txt", content: "two\n" }, context);
  await tools
    .get("sandbox_write")!
    .execute({ id: "dup.1", path: "b.txt", content: "other\n" }, context);
  const deleted = JSON.parse(
    await tools.get("sandbox_delete")!.execute({ id: "dup.1" }, context),
  ) as { discardedChanges?: number; discardedPaths?: string[] };
  // Two paths, named once each, and the count agrees.
  expect(deleted.discardedPaths).toEqual(["a.txt", "b.txt"]);
  expect(deleted.discardedChanges).toBe(2);
});

test("sandbox_list shows what exists, and what holds unmerged work (P2-18)", async () => {
  // The 2026-10-08 audit's P2-18: the model could not see the sandboxes at
  // all — every sandbox tool takes an id, and nothing enumerated them, so a
  // workspace accumulated 14 sandboxes (56MB) with no way to notice.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-list-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "seen.1" }, context);
  await tools.get("sandbox_create")!.execute({ id: "dirty.1" }, context);
  await tools
    .get("sandbox_write")!
    .execute(
      { id: "dirty.1", path: "unmerged.txt", content: "never merged\n" },
      context,
    );
  const listed = JSON.parse(
    await tools.get("sandbox_list")!.execute({}, context),
  ) as {
    total: number;
    sandboxes: Array<{ id: string; changedFiles: number }>;
  };
  expect(listed.total).toBe(2);
  // One line per sandbox, and the two facts a reader acts on.
  expect(listed.sandboxes.map((entry) => entry.id).sort()).toEqual([
    "dirty.1",
    "seen.1",
  ]);
  expect(
    listed.sandboxes.find((entry) => entry.id === "dirty.1")?.changedFiles,
  ).toBe(1);
  expect(
    listed.sandboxes.find((entry) => entry.id === "seen.1")?.changedFiles,
  ).toBe(0);
});

test("idle collection reclaims clean sandboxes and keeps unmerged work (P2-18)", async () => {
  // The 2026-10-08 audit's P2-18, second half: a workspace had accumulated
  // 14 stale sandboxes (56MB) with nothing able to reclaim them.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-ttl-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    // The TTL config the create tool reads.
    runtimeConfig: () => ({ sandbox: { maxIdleHours: 0, maxSandboxes: 2 } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "old.1" }, context);
  await tools.get("sandbox_create")!.execute({ id: "old.2" }, context);
  await tools.get("sandbox_create")!.execute({ id: "old.3" }, context);
  // One of them holds unmerged work: that is a reader's unfinished work, not
  // garbage, and it is never collected.
  await tools
    .get("sandbox_write")!
    .execute({ id: "old.3", path: "keep.txt", content: "unmerged\n" }, context);
  // The next create enforces the cap: the workspace is back to two.
  await tools.get("sandbox_create")!.execute({ id: "new.1" }, context);
  const ids = (await manager.list()).map((entry) => entry.id);
  expect(ids).toHaveLength(2);
  expect(ids).toContain("new.1");
  expect(ids).toContain("old.3");
  // The oldest CLEAN one went, not the one with work in it.
  expect(ids).not.toContain("old.1");
});

test("a validation command's own output is never merged into the host (F1)", async () => {
  // The 2026-10-10 sweep's F1: validation runs inside the candidate, so what
  // it builds lands in the candidate — and the merge then promoted the
  // validation's own artifacts into the host. The audit measured
  // `.cmake-verify/` (a static library, a Makefile, a cache file with the
  // sandbox's absolute path) merged into the real workspace.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-f1-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "f1.1" }, context);
  await tools
    .get("sandbox_write")!
    .execute(
      { id: "f1.1", path: "model-change.txt", content: "mine\n" },
      context,
    );
  // The validation command ITSELF builds something — that output belongs to
  // the validation, not to the model's change. (A separate `sandbox_execute`
  // before the merge would be the model's own change and SHOULD merge; the
  // leak the audit measured was the validation's own build output.)
  const withBuild = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({
      // A path `.nataliaignore` does NOT cover — the audit's `.cmake-verify/`
      // was exactly that, which is why it reached the host.
      sandbox: {
        promoteCommand: "mkdir -p verify-out && echo x > verify-out/cache.txt",
      },
    }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  const answer = String(
    await tools.get("sandbox_merge")!.execute({ id: "f1.1" }, withBuild),
  );
  // The merge reports the model's change.
  expect(answer).toContain("model-change.txt");
  // The validation's build output never reached the host.
  expect(await existsSync(join(root, "verify-out", "cache.txt"))).toBe(false);
  expect(await existsSync(join(root, "model-change.txt"))).toBe(true);
});

test("a merge answer is capped, and says so (F2)", async () => {
  // The 2026-10-10 sweep's F2: the answer was `JSON.stringify(changes, null,
  // 2)` with no cap — one added file produced 117 pages / 5.87 MB, and a
  // sweep spilled ~11.9 MB into `.natalia/tool-output/`. The tool declared
  // `maxLines` and never read it.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-f2-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "f2.1" }, context);
  // A change big enough that its JSON is many lines.
  await tools.get("sandbox_write")!.execute(
    {
      id: "f2.1",
      path: "big.txt",
      content: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"),
    },
    context,
  );
  const answer = String(
    await tools.get("sandbox_merge")!.execute({ id: "f2.1" }, context),
  );
  // The cap is the answer's, and it names what it held back.
  expect(answer).toContain("more line(s) omitted");
  expect(answer).toContain("1 file(s) changed");
  // The merge still landed.
  expect(await existsSync(join(root, "big.txt"))).toBe(true);
  // And `maxLines` is honoured: a second sandbox with the same shape answers
  // with more lines when the caller asks.
  await tools.get("sandbox_create")!.execute({ id: "f2.2" }, context);
  await tools.get("sandbox_write")!.execute(
    {
      id: "f2.2",
      path: "big2.txt",
      content: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"),
    },
    context,
  );
  const wide = String(
    await tools
      .get("sandbox_merge")!
      .execute({ id: "f2.2", maxLines: 5000 }, context),
  );
  expect(wide.split("\n").length).toBeGreaterThan(answer.split("\n").length);
  // The byte cap still applies at any line count — a wider `maxLines` buys
  // lines, not an unbounded answer.
  expect(Buffer.byteLength(wide, "utf8")).toBeLessThanOrEqual(20_000);
});

test("a rollback removes the directories an addition made (F3)", async () => {
  // The 2026-10-10 sweep's F3: `sandbox_rollback` reported `restored: true`
  // while leaving `.cmake-verify/` as 0 files / 11 empty directories — 80 paths
  // listed, the tree still shaped by the thing that was undone. A rollback
  // that says it restored and leaves the shape behind is a lie the workspace
  // pays for.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-sandbox-f3-"));
  await writeFile(join(root, "base.txt"), "base\n");
  const manager = new SnapshotSandboxManager(root);
  await manager.initialize();
  const tools = new Map(
    sandboxToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const context = {
    workspaceRoot: root,
    sandboxes: manager,
    runtimeConfig: () => ({ sandbox: { promoteCommand: "true" } }),
    onSandboxEvent: () => undefined,
    onWorkspaceChange: () => undefined,
    sandboxMergeAuthorize: async () => undefined,
  } as never;
  await tools.get("sandbox_create")!.execute({ id: "f3.1" }, context);
  await tools
    .get("sandbox_write")!
    .execute(
      { id: "f3.1", path: "deep/nested/dir/file.txt", content: "new\n" },
      context,
    );
  await tools.get("sandbox_merge")!.execute({ id: "f3.1" }, context);
  expect(existsSync(join(root, "deep/nested/dir/file.txt"))).toBe(true);
  const rolled = JSON.parse(
    String(
      await tools.get("sandbox_rollback")!.execute({ id: "f3.1" }, context),
    ),
  ) as { restored: boolean };
  expect(rolled.restored).toBe(true);
  // The file is gone AND the directories it arrived in are gone with it.
  expect(existsSync(join(root, "deep/nested/dir/file.txt"))).toBe(false);
  expect(existsSync(join(root, "deep"))).toBe(false);
  // What predated the promotion is untouched.
  expect(existsSync(join(root, "base.txt"))).toBe(true);
});

test("a sandboxed subagent's own diff needs no id and names no other candidate", async () => {
  // T6-4: a sandboxed child used to get no sandbox surface at all, so every
  // `sandbox_*` tool threw "sandbox runtime unavailable" — it could not look
  // at the diff it was about to hand back and settled blind. It gets exactly
  // one tool: its OWN candidate's preview, with no id parameter, because the
  // only sandbox it may read is the one it runs in.
  const tool = sandboxSelfDiffTool();
  expect(tool.name).toBe("sandbox_diff");
  expect(tool.requiresApproval).toBe(false);
  // No id to name: a child that could pass one could read another
  // candidate's work.
  expect(tool.parameters).toMatchObject({
    type: "object",
    properties: {},
    required: [],
  });

  // With the self surface present, it answers.
  const changes = [
    { kind: "modify", path: "a.txt", additions: 1, deletions: 1 },
  ];
  const answered = await tool.execute({}, {
    sandboxSelf: { id: "child", preview: async () => changes },
  } as never);
  expect(JSON.parse(answered as string)).toEqual(changes);

  // Without it (a main-agent context, or a non-sandboxed child), it refuses
  // rather than falling back to the host service.
  await expect(tool.execute({}, {} as never)).rejects.toThrow(
    /only available inside a sandboxed subagent/u,
  );
});

test("a sandboxed subagent's own diff needs no id and names no other candidate", async () => {
  // T6-4: a sandboxed child used to get no sandbox surface at all, so every
  // `sandbox_*` tool threw "sandbox runtime unavailable" — it could not look
  // at the diff it was about to hand back and settled blind. It gets exactly
  // one tool: its OWN candidate's preview, with no id parameter, because the
  // only sandbox it may read is the one it runs in.
  const tool = sandboxSelfDiffTool();
  expect(tool.name).toBe("sandbox_diff");
  expect(tool.requiresApproval).toBe(false);
  // No id to name: a child that could pass one could read another
  // candidate's work.
  expect(tool.parameters).toMatchObject({
    type: "object",
    properties: {},
    required: [],
  });

  // With the self surface present, it answers.
  const changes = [
    { kind: "modify", path: "a.txt", additions: 1, deletions: 1 },
  ];
  const answered = await tool.execute({}, {
    sandboxSelf: { id: "child", preview: async () => changes },
  } as never);
  expect(JSON.parse(answered as string)).toEqual(changes);

  // Without it (a main-agent context, or a non-sandboxed child), it refuses
  // rather than falling back to the host service.
  await expect(tool.execute({}, {} as never)).rejects.toThrow(
    /only available inside a sandboxed subagent/u,
  );
});

test("a failed validation never ends at a bare colon (F13)", () => {
  // The sweep measured `failed validation (exit 3): ` with nothing after the
  // colon — the command's output was not captured, and the message stopped
  // there. A caller learned the exit code and nothing else.
  // With output, the output rides.
  expect(
    validationFailure("sbx.1", "ctest", {
      exitCode: 3,
      output: "3 tests failed",
    }),
  ).toContain("3 tests failed");
  // Without it, the message SAYS so and carries the command, so the failure is
  // actionable rather than a dead end.
  const empty = validationFailure("sbx.1", "ctest --output-on-failure", {
    exitCode: 3,
    output: "",
  });
  expect(empty).toContain("no captured output");
  expect(empty).toContain("ctest --output-on-failure");
  expect(empty).not.toMatch(/:\s*$/u);
  // Whitespace-only output is the same case as empty.
  const blank = validationFailure("sbx.1", "ctest", {
    exitCode: 3,
    output: "  \n ",
  });
  expect(blank).toContain("no captured output");
});
