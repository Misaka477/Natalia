import { expect, test } from "bun:test";
import { createWorkspaceChangeAuditor } from "../src/workspace-change-auditor";

test("a single hint reconciles into one confirmed change", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "src/a.ts", operation: "modified" });
  const changes = auditor.reconcile(["src/a.ts", "src/b.ts"]);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    workspaceRoot: "/srv/project",
    path: "src/a.ts",
    operation: "modified",
    origin: "unknown",
    attribution: "unattributed",
  });
});

test("a path absent at reconcile confirms as deleted", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "gone.txt", operation: "modified" });
  const changes = auditor.reconcile(["still-here.txt"]);
  expect(changes[0]?.operation).toBe("deleted");
});

test("a deleted hint stays deleted even if the path reappears", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "f.txt", operation: "deleted" });
  const changes = auditor.reconcile(["f.txt"]);
  expect(changes[0]?.operation).toBe("deleted");
});

test("a burst of events for one path coalesces to a single change", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "a.txt", operation: "added" });
  auditor.observe({ path: "a.txt", operation: "modified" });
  auditor.observe({ path: "a.txt", operation: "modified" });
  auditor.observe({ path: "b.txt", operation: "modified" });
  const changes = auditor.reconcile(["a.txt", "b.txt"]);
  expect(changes).toHaveLength(2);
  const a = changes.find((change) => change.path === "a.txt");
  expect(a?.operation).toBe("modified");
});

test("reconcile clears the pending buffer", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "a.txt", operation: "modified" });
  auditor.reconcile(["a.txt"]);
  expect(auditor.reconcile(["a.txt"])).toEqual([]);
});

test("a known origin attributes the change", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
    resolveOrigin: (path) =>
      path.startsWith("src/") ? ("tool" as const) : undefined,
    hasReliableIdentity: () => true,
  });
  auditor.observe({ path: "src/a.ts", operation: "modified" });
  auditor.observe({ path: "lib/b.ts", operation: "modified" });
  const changes = auditor.reconcile(["src/a.ts", "lib/b.ts"]);
  const toolChange = changes.find((change) => change.path === "src/a.ts");
  expect(toolChange?.origin).toBe("tool");
  expect(toolChange?.attribution).toBe("attributed");
  const unknownChange = changes.find((change) => change.path === "lib/b.ts");
  expect(unknownChange?.attribution).toBe("unattributed");
});

test("an indeterminate window marks confirmed changes indeterminate", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
    resolveOrigin: () => "tool" as const,
    hasReliableIdentity: () => true,
  });
  auditor.markIndeterminate();
  auditor.observe({ path: "src/a.ts", operation: "modified" });
  const changes = auditor.reconcile(["src/a.ts"]);
  expect(changes[0]?.attribution).toBe("indeterminate");
});

test("degraded health is carried through the confirmed change", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.setHealth("degraded", "inotify_limit");
  auditor.observe({ path: "a.txt", operation: "modified" });
  const changes = auditor.reconcile(["a.txt"]);
  expect(changes[0]?.health).toBe("degraded");
  expect(changes[0]?.healthReason).toBe("inotify_limit");
});

test("recovering to healthy clears the indeterminate flag", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.markIndeterminate();
  auditor.setHealth("healthy");
  auditor.observe({ path: "a.txt", operation: "modified" });
  const changes = auditor.reconcile(["a.txt"]);
  expect(changes[0]?.attribution).not.toBe("indeterminate");
});

test("status reports health and pending count", () => {
  const auditor = createWorkspaceChangeAuditor({
    workspaceRoot: "/srv/project",
  });
  auditor.observe({ path: "a.txt", operation: "modified" });
  expect(auditor.status()).toMatchObject({ health: "healthy", pending: 1 });
});
