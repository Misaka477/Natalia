import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MutationRegistry,
  WorkspaceFilesController,
  WorkspaceWriteLock,
} from "../src";
import { workspaceFiles, workspaceMutations, workspaceWriteLock } from "../src";
import {
  createMutationRegistry,
  createWorkspaceFilesController,
  createWorkspaceWriteLock,
  findWorkspaceFiles,
  invalidateWorkspaceFiles,
  type WorkspaceMutationIdentity,
} from "../src";

test("workspace framework services construct and release their resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-workspace-services-"));
  const mutations: MutationRegistry = createMutationRegistry();
  const files: WorkspaceFilesController = createWorkspaceFilesController({
    workspaceRoot: root,
    listPaths: async () => ["main.ts"],
    resolveMutation: (path) => {
      const mutation = mutations.match({ path, operation: "modified" });
      if (!mutation) return undefined;
      const identity: WorkspaceMutationIdentity = {
        origin: mutation.operationID ? "sandbox_merge" : "tool",
      };
      if (mutation.turnID) identity.turnID = mutation.turnID;
      if (mutation.callID) identity.callID = mutation.callID;
      if (mutation.operationID) identity.operationID = mutation.operationID;
      if (mutation.sessionID) identity.sessionID = mutation.sessionID;
      if (mutation.episodeID) identity.episodeID = mutation.episodeID;
      return identity;
    },
  });
  const writeLock: WorkspaceWriteLock = createWorkspaceWriteLock();

  try {
    expect(workspaceWriteLock.id).toBe("workspace.writeLock");
    expect(workspaceMutations.id).toBe("workspace.mutations");
    expect(workspaceFiles.id).toBe("workspace.files");

    await files.init();
    expect(files.observationStatus()).toMatchObject({
      health: "healthy",
    });

    const release = await writeLock.acquire();
    expect(release).toBeTypeOf("function");
    release();

    mutations.register({
      callID: "call-1",
      toolName: "edit_file",
      authorizedPaths: ["main.ts"],
      expectedOperations: ["modified"],
    });
    expect(
      mutations.match({ path: "main.ts", operation: "modified" }),
    ).toMatchObject({ callID: "call-1" });
    mutations.settle("call-1");
    expect(mutations.pendingCount()).toBe(0);

    await writeFile(join(root, "main.ts"), "const needle = true\n");
    // The service init warms the catalog cache; make the direct read
    // deterministic instead of depending on fs.watch delivery timing.
    invalidateWorkspaceFiles(root);
    const found = await findWorkspaceFiles({ workspaceRoot: root, limit: 50 });
    expect(found.map((file) => file.path)).toContain("main.ts");

    await expect(files.reconcile()).resolves.toBeDefined();
  } finally {
    files.close();
    await rm(root, { recursive: true, force: true });
  }
});
