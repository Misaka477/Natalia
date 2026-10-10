import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendInstanceEvent,
  loadInstanceGovernance,
  resolveGovernanceRoot,
  testGovernanceRootFor,
} from "../src/instance-store";

test("the test override answers only for the workspace it was set for", () => {
  // The seam is process-global, so under `bun test --max-concurrency=N` one
  // file's value used to answer another file's `governanceViews(itsWorkspace)`
  // — rules read back from a different workspace, and a revoke for a rule that
  // was never in this workspace's set. The override is bound to its workspace
  // now: it answers for that one, and a stale value falls through to the
  // workspace's own path.
  const previous = process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  try {
    const workspace = "/tmp/gov-workspace";
    process.env.NATALIA_TEST_GOVERNANCE_ROOT = testGovernanceRootFor(workspace);
    // Its own workspace: the override wins (the ledger lives beside it).
    expect(resolveGovernanceRoot(workspace)).toBe(
      testGovernanceRootFor(workspace),
    );
    // No workspace to belong to: the override is the whole answer.
    expect(resolveGovernanceRoot()).toBe(testGovernanceRootFor(workspace));
    // A DIFFERENT workspace: the stale value does not answer for it.
    expect(resolveGovernanceRoot("/tmp/other-workspace")).toBe(
      "/tmp/other-workspace/.natalia/governance",
    );
  } finally {
    if (previous === undefined) delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
    else process.env.NATALIA_TEST_GOVERNANCE_ROOT = previous;
  }
});

test("resolveGovernanceRoot is workspace-scoped, not plugin-store scoped", () => {
  expect(resolveGovernanceRoot("/workspace/a")).toBe(
    "/workspace/a/.natalia/governance",
  );
  expect(resolveGovernanceRoot("/workspace/b")).toBe(
    "/workspace/b/.natalia/governance",
  );
});

test("append and load round-trip constitution facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-gov-store-"));
  appendInstanceEvent(root, "constitution.jsonl", {
    type: "constitution.rule_added",
    id: "constitution:c-rel-001",
    ruleID: "C-REL-001",
    statement: "默认不 commit/push",
    scope: "release",
    priority: "critical",
    source: "policy",
    enforcement: "deny",
    overridePolicy: "user_scoped",
  });
  const loaded = loadInstanceGovernance(root);
  expect(loaded.degraded).toBe(false);
  expect(loaded.events).toHaveLength(1);
  expect(loaded.events[0]).toMatchObject({ ruleID: "C-REL-001" });
});

test("truncated jsonl is degraded and empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-gov-trunc-"));
  await writeFile(join(root, "decisions.jsonl"), "{not json\n");
  const loaded = loadInstanceGovernance(root);
  expect(loaded.degraded).toBe(true);
  expect(loaded.events).toEqual([]);
});

test("a stale override from another test file cannot answer for this workspace", () => {
  // The concrete leak, end to end: file A's runtime is running (its override
  // is set), and file B in the SAME worker process asks for its own
  // workspace's governance. B must get B's ledger, not A's.
  const previous = process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  try {
    const workspaceA = "/tmp/gov-leak-a";
    const workspaceB = "/tmp/gov-leak-b";
    // File A's harness sets its own root, as the real one does.
    process.env.NATALIA_TEST_GOVERNANCE_ROOT =
      testGovernanceRootFor(workspaceA);
    // File B resolves its own — and reads ITS instance store, not A's.
    const rootB = resolveGovernanceRoot(workspaceB);
    expect(rootB).toBe(`${workspaceB}/.natalia/governance`);
    // A rule written into B's store is visible to B, and a rule that exists
    // only in A's is not: that is the contradiction F-C fixed, and this is
    // what stops it coming back through the test seam.
    appendInstanceEvent(rootB, "constitution.jsonl", {
      type: "constitution.rule_added",
      id: "constitution:c-leak-b",
      ruleID: "C-LEAK-B",
      statement: "belongs to workspace B",
      enforcement: "warn",
      scope: "release",
      priority: "high",
      source: "policy",
      overridePolicy: "forbidden",
      at: "2026-10-10T00:00:00.000Z",
    } as never);
    const ruleIDOf = (event: { type: string }) =>
      event.type === "constitution.rule_added"
        ? (event as { ruleID?: string }).ruleID
        : undefined;
    const b = loadInstanceGovernance(rootB);
    expect(b.events.some((event) => ruleIDOf(event) === "C-LEAK-B")).toBe(true);
    const a = loadInstanceGovernance(testGovernanceRootFor(workspaceA));
    expect(a.events.some((event) => ruleIDOf(event) === "C-LEAK-B")).toBe(
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
    else process.env.NATALIA_TEST_GOVERNANCE_ROOT = previous;
  }
});
