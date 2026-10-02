import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendInstanceEvent,
  loadInstanceGovernance,
  resolveGovernanceRoot,
} from "../src/instance-store";

test("resolveGovernanceRoot prefers the test override", () => {
  const previous = process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  process.env.NATALIA_TEST_GOVERNANCE_ROOT = "/tmp/gov-test";
  expect(resolveGovernanceRoot("/unused/workspace")).toBe("/tmp/gov-test");
  if (previous === undefined) delete process.env.NATALIA_TEST_GOVERNANCE_ROOT;
  else process.env.NATALIA_TEST_GOVERNANCE_ROOT = previous;
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
