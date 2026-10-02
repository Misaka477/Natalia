import { expect, test } from "bun:test";
import type { WorkspaceChangeOrigin } from "@anthelia/contracts";
import { createMutationRegistry } from "../src/mutation-registry";
import {
  createWorkspaceChangeAuditor,
  type WorkspaceChangeIdentity,
} from "../src/workspace-change-auditor";

test("register creates an open expected mutation", () => {
  const registry = createMutationRegistry();
  const key = registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified", "added"],
  });
  expect(key).toBe("c_1");
  expect(registry.pendingCount()).toBe(1);
});

test("match hits an in-scope path with an expected operation", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified", "added"],
  });
  const hit = registry.match({ path: "src/a.ts", operation: "modified" });
  expect(hit).toMatchObject({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
  });
});

test("match misses out-of-scope paths and unexpected operations", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified"],
  });
  expect(
    registry.match({ path: "lib/b.ts", operation: "modified" }),
  ).toBeUndefined();
  expect(
    registry.match({ path: "src/a.ts", operation: "deleted" }),
  ).toBeUndefined();
});

test("a settled mutation stops matching but keeps its record", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified"],
  });
  registry.settle("c_1");
  expect(
    registry.match({ path: "src/a.ts", operation: "modified" }),
  ).toBeUndefined();
  expect(registry.pendingCount()).toBe(0);
});

test("an operation identity matches without a turn", () => {
  const registry = createMutationRegistry();
  registry.register({
    operationID: "sandbox_merge_1",
    toolName: "sandbox_merge",
    authorizedPaths: ["."],
    expectedOperations: ["added", "modified", "deleted"],
  });
  expect(
    registry.match({ path: "built/out.txt", operation: "added" }),
  ).toMatchObject({ operationID: "sandbox_merge_1" });
});

test("forget drops an expected mutation entirely", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified"],
  });
  registry.forget("c_1");
  expect(registry.pendingCount()).toBe(0);
  expect(
    registry.match({ path: "src/a.ts", operation: "modified" }),
  ).toBeUndefined();
});

test("the auditor attributes a registry-matched hint to the tool", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified"],
  });
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
    resolveOrigin: (path) =>
      registry.match({ path, operation: "modified" })
        ? ("tool" as const)
        : undefined,
    resolveIdentity: (path) => {
      const hit = registry.match({ path, operation: "modified" });
      if (!hit) return undefined;
      const identity: WorkspaceChangeIdentity = {
        origin: "tool" as WorkspaceChangeOrigin,
      };
      if (hit.turnID) identity.turnID = hit.turnID;
      if (hit.callID) identity.callID = hit.callID;
      if (hit.operationID) identity.operationID = hit.operationID;
      if (hit.sessionID) identity.sessionID = hit.sessionID;
      if (hit.episodeID) identity.episodeID = hit.episodeID;
      return identity;
    },
    hasReliableIdentity: () => true,
  });
  auditor.observe({ path: "src/a.ts", operation: "modified" });
  const changes = auditor.reconcile(["src/a.ts"]);
  expect(changes[0]).toMatchObject({
    path: "src/a.ts",
    origin: "tool",
    attribution: "attributed",
    correlation: { turnID: "t_1", callID: "c_1" },
  });
});

test("the auditor leaves an unmatched hint unattributed", () => {
  const registry = createMutationRegistry();
  registry.register({
    turnID: "t_1",
    callID: "c_1",
    toolName: "write_file",
    authorizedPaths: ["src"],
    expectedOperations: ["modified"],
  });
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
    resolveOrigin: (path) =>
      registry.match({ path, operation: "modified" })
        ? ("tool" as const)
        : undefined,
    resolveIdentity: (path) => {
      const hit = registry.match({ path, operation: "modified" });
      if (!hit) return undefined;
      const identity: WorkspaceChangeIdentity = {
        origin: "tool" as WorkspaceChangeOrigin,
      };
      if (hit.turnID) identity.turnID = hit.turnID;
      if (hit.callID) identity.callID = hit.callID;
      if (hit.operationID) identity.operationID = hit.operationID;
      if (hit.sessionID) identity.sessionID = hit.sessionID;
      if (hit.episodeID) identity.episodeID = hit.episodeID;
      return identity;
    },
    hasReliableIdentity: () => true,
  });
  auditor.observe({ path: "lib/b.ts", operation: "modified" });
  const changes = auditor.reconcile(["lib/b.ts"]);
  expect(changes[0]).toMatchObject({
    path: "lib/b.ts",
    origin: "unknown",
    attribution: "unattributed",
  });
});
