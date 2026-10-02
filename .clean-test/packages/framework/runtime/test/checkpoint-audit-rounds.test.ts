import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { ContextLedger, initializeDefaultCheckpointStore } from "../src";

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "natalia-audit-rounds-"));
  const ledger = new ContextLedger();
  ledger.add({ id: "user", role: "user", content: "start" });
  const store = await initializeDefaultCheckpointStore({
    sessionID: "ses_audit_rounds" as import("@anthelia/contracts").SessionID,
    workspaceRoot: root,
    context: ledger,
  });
  return { root, ledger, store };
}

test("audit round checkpoints are listed and diffable across rounds", async () => {
  const { root, ledger, store } = await makeStore();
  await writeFile(join(root, "src.txt"), "one\n");
  ledger.add({ id: "a1", role: "assistant", content: "write one" });
  const round1 = await store.createAuditRoundCheckpoint({
    planID: "plan_rounds",
    round: 1,
    verdict: "gaps",
    context: ledger,
    step: ledger.journalStatus().messageCount,
    sessionID: "ses_audit_rounds" as import("@anthelia/contracts").SessionID,
  });
  await writeFile(join(root, "src.txt"), "one\ntwo\n");
  ledger.add({ id: "a2", role: "assistant", content: "write two" });
  const round2 = await store.createAuditRoundCheckpoint({
    planID: "plan_rounds",
    round: 2,
    verdict: "gaps",
    context: ledger,
    step: ledger.journalStatus().messageCount,
    sessionID: "ses_audit_rounds" as import("@anthelia/contracts").SessionID,
  });
  await writeFile(join(root, "src.txt"), "one\ntwo\nthree\n");
  const current = await store.diffCheckpoints(
    { kind: "round", planID: "plan_rounds", round: 2 },
    { kind: "current" },
  );
  const between = await store.diffCheckpoints(
    { kind: "round", planID: "plan_rounds", round: 1 },
    { kind: "round", planID: "plan_rounds", round: 2 },
  );

  expect(round1.reason).toBe("audit_round");
  expect(round2.metadata).toMatchObject({
    kind: "audit_round",
    planID: "plan_rounds",
    round: 2,
  });
  expect(await store.listAuditRounds("plan_rounds")).toEqual([
    expect.objectContaining({ round: 1, verdict: "gaps" }),
    expect.objectContaining({ round: 2, verdict: "gaps" }),
  ]);
  const auditRecords = await store.listCheckpointsByKind("audit");
  expect(auditRecords.map((record) => record.reason)).toEqual(
    expect.arrayContaining(["baseline", "audit_round", "audit_round"]),
  );
  expect(between).toHaveLength(1);
  expect(between[0]?.path).toBe("src.txt");
  expect(between[0]?.operation).toBe("modified");
  expect(current).toHaveLength(1);
  expect(current[0]?.after).toContain("three");
});

test("duplicate audit round is rejected", async () => {
  const { ledger, store } = await makeStore();
  const input = {
    planID: "plan_rounds",
    round: 1,
    verdict: "passed" as const,
    context: ledger,
    step: 1,
    sessionID: "ses_audit_rounds" as import("@anthelia/contracts").SessionID,
  };
  await store.createAuditRoundCheckpoint(input);
  await expect(store.createAuditRoundCheckpoint(input)).rejects.toThrow(
    /audit round already exists/u,
  );
});
