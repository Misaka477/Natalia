import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { RuntimeClient } from "@anthelia/contracts";
import {
  acknowledgeDriftFindingViaRpc,
  collapseList,
  constitutionOverrideAffordance,
  constitutionRuleAffordance,
  overrideLine,
  overrideRequestFromDraft,
  overridesForRule,
  requestOverrideViaRpc,
  mergeWorkGraphState,
  createConstitutionRuleViaRpc,
  DRIFT_COLLAPSE_LIMIT,
  editConstitutionRuleViaRpc,
  loadGovernancePage,
  loadGovernanceSlices,
  promoteConstitutionDocRuleViaRpc,
  promoteGrowthTriggerViaRpc,
  removeConstitutionRuleViaRpc,
  reopenDriftFindingViaRpc,
  updateConstitutionDocRuleViaRpc,
  splitActivityRefs,
  updateConstitutionRuleViaRpc,
} from "../src/governance-panel";

test("loadGovernanceSlices handles data and all-empty surfaces", async () => {
  const filled = {
    constitutionRules: async () => [{ ruleID: "C-1" }],
    constitutionDocRules: async () => [{ id: "constitution:small-prs:1" }],
    decisionRecords: async () => ({
      items: [{ id: "decision:1" }],
      returned: 1,
      total: 1,
      truncated: false,
    }),
    evidenceRecords: async () => ({
      items: [{ taskID: "task:1" }],
      returned: 1,
      total: 1,
      truncated: false,
    }),
    completions: async () => ({
      items: [{ taskID: "task:1" }],
      returned: 1,
      total: 1,
      truncated: false,
    }),
    driftFindings: async () => ({
      items: [{ findingID: "DF-1" }],
      returned: 1,
      total: 1,
      truncated: false,
    }),
    notices: async () => [{ noticeID: "notice:1" }],
    workGraphNodes: async () => [{ nodeID: "wg:action:1" }],
    workGraphEdges: async () => [
      { sourceID: "a", targetID: "b", kind: "caused" },
    ],
    growthProposals: async () => [{ proposalID: "growth:1" }],
    growthTriggers: async () => [{ capability: "release-evidence" }],
    growthPromotions: async () => [{ promotionID: "promo:1" }],
    externalJoinedTasks: async () => [
      { externalTaskID: "terminal-bench/x", baselineSuccessRate: 0.3 },
    ],
  } as unknown as RuntimeClient;
  const data = await loadGovernanceSlices(filled, "ses_panel");
  expect(data.constitution).toHaveLength(1);
  expect(data.docRules).toHaveLength(1);
  expect(data.overrides).toEqual([]);
  expect(data.decisions).toHaveLength(1);
  expect(data.evidence).toHaveLength(1);
  expect(data.completions).toHaveLength(1);
  expect(data.drift).toHaveLength(1);
  expect(data.notices).toHaveLength(1);
  expect(data.workGraphNodes).toHaveLength(1);
  expect(data.workGraphEdges).toHaveLength(1);
  expect(data.growthProposals).toHaveLength(1);
  expect(data.growthTriggers).toHaveLength(1);
  expect(data.growthPromotions).toHaveLength(1);
  expect(data.externalJoinedTasks).toHaveLength(1);
  expect(data.errors).toEqual([]);

  const empty = await loadGovernanceSlices({} as RuntimeClient, "ses_panel");
  expect(empty).toEqual({
    constitution: [],
    docRules: [],
    overrides: [],
    decisions: [],
    evidence: [],
    completions: [],
    drift: [],
    notices: [],
    workGraphNodes: [],
    workGraphEdges: [],
    growthProposals: [],
    growthTriggers: [],
    growthPromotions: [],
    externalJoinedTasks: [],
    pageInfo: {
      decisions: { total: 0, truncated: false },
      evidence: { total: 0, truncated: false },
      completions: { total: 0, truncated: false },
      drift: { total: 0, truncated: false },
    },
    errors: [],
  });
});

test("the Growth and Eval tabs read their own surfaces, and one failure never blanks the other", async () => {
  // The four growth/eval faces are the consumer the self-iteration audit
  // found missing: implemented, contracted, routed — and read by nobody.
  // Each loads independently, so an unavailable face is a reported error
  // with the rest of the bundle intact.
  const runtime = {
    growthProposals: async () => [
      {
        proposalID: "growth:1",
        at: "2026-10-11T00:00:00.000Z",
        suggestions: [
          {
            kind: "tool",
            capability: "release-evidence",
            observations: 3,
            sources: ["completion:known_gap"],
            reason: "three completions named the same gap",
          },
        ],
        considered: { tasks: 4, gaps: 1 },
      },
    ],
    growthTriggers: async () => [
      {
        rule: "capability_gap",
        class: "skill",
        capability: "release-evidence",
        evidence: { observations: 3 },
        reason: "the gap kept costing the release",
      },
    ],
    growthPromotions: async () => [
      {
        promotionID: "promo:1",
        at: "2026-10-11T00:01:00.000Z",
        trigger: { capability: "release-evidence" },
        destination: "skill",
        approval: "human",
        next: "a human reviews the candidate",
      },
    ],
    externalJoinedTasks: async () => [
      {
        externalTaskID: "terminal-bench/x",
        baselineSuccessRate: 0.3,
        ourRuns: 4,
        ourSuccessRate: 0.5,
      },
    ],
  } as unknown as RuntimeClient;
  const bundle = await loadGovernanceSlices(runtime, "ses_growth");
  expect(bundle.growthProposals[0]).toMatchObject({
    proposalID: "growth:1",
    suggestions: [{ capability: "release-evidence", kind: "tool" }],
  });
  expect(bundle.growthTriggers[0]).toMatchObject({
    rule: "capability_gap",
    capability: "release-evidence",
  });
  expect(bundle.growthPromotions[0]).toMatchObject({
    destination: "skill",
    approval: "human",
  });
  expect(bundle.externalJoinedTasks[0]).toMatchObject({
    externalTaskID: "terminal-bench/x",
    ourRuns: 4,
    ourSuccessRate: 0.5,
  });
  expect(bundle.errors).toEqual([]);

  // A face that throws is reported by name; the other three still answer.
  const broken = {
    growthProposals: async () => {
      throw new Error("journal unreadable");
    },
    growthTriggers: async () => [],
    growthPromotions: async () => [],
    externalJoinedTasks: async () => [],
  } as unknown as RuntimeClient;
  const failed = await loadGovernanceSlices(broken, "ses_growth");
  expect(failed.growthProposals).toEqual([]);
  expect(failed.errors).toContain("GrowthProposals: journal unreadable");
  expect(failed.externalJoinedTasks).toEqual([]);
});

test("each governance tab reports its own load failure without blanking the rest", async () => {
  const factories: Array<{
    label: string;
    runtime: () => RuntimeClient;
  }> = [
    {
      label: "Constitution",
      runtime: () =>
        ({
          constitutionRules: async () => {
            throw new Error("constitution offline");
          },
        }) as unknown as RuntimeClient,
    },
    {
      label: "Decisions",
      runtime: () =>
        ({
          decisionRecords: async () => {
            throw new Error("decisions offline");
          },
        }) as unknown as RuntimeClient,
    },
    {
      label: "Evidence",
      runtime: () =>
        ({
          evidenceRecords: async () => {
            throw new Error("evidence offline");
          },
        }) as unknown as RuntimeClient,
    },
    {
      label: "Completions",
      runtime: () =>
        ({
          completions: async () => {
            throw new Error("completions offline");
          },
        }) as unknown as RuntimeClient,
    },
    {
      label: "Drift",
      runtime: () =>
        ({
          driftFindings: async () => {
            throw new Error("drift offline");
          },
        }) as unknown as RuntimeClient,
    },
    {
      label: "Notices",
      runtime: () =>
        ({
          notices: async () => {
            throw new Error("notices offline");
          },
        }) as unknown as RuntimeClient,
    },
  ];
  for (const { label, runtime } of factories) {
    const bundle = await loadGovernanceSlices(runtime(), "ses_panel");
    expect(bundle.errors).toHaveLength(1);
    expect(bundle.errors[0]).toContain(label);
    expect(bundle.errors[0]).toContain("offline");
    // A failed tab must not suppress the others.
    expect(
      bundle.constitution.length +
        bundle.decisions.length +
        bundle.evidence.length +
        bundle.completions.length +
        bundle.drift.length +
        bundle.notices.length,
    ).toBe(0);
  }
});

test("drift click action calls RPC, updates the journal, and reload observes the new status", async () => {
  const journal: any[] = [
    {
      findingID: "DF-ACTION",
      severity: "warning" as const,
      confidence: 0.7,
      originalObjective: "stay on scope",
      currentActivity: "testing another package",
      evidence: [],
      applicableConstraints: [],
      status: "open" as const,
      contractVersion: 1,
      ruleHits: [{ rule: "target_drift", confidence: 0.7 }],
    },
  ];
  const runtime = {
    driftFindings: async () => ({
      items: journal.map((finding) => ({ ...finding })),
      returned: journal.length,
      total: journal.length,
      truncated: false,
    }),
    acknowledgeDriftFinding: async (input: {
      findingID: string;
      status: "explained" | "disputed";
      rationale?: string;
    }) => {
      const finding = journal.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      if (!finding) return { acknowledged: false };
      finding.status = input.status;
      if (input.rationale) finding["rationale"] = input.rationale;
      return { acknowledged: true };
    },
  } as unknown as RuntimeClient;

  const before = await loadGovernanceSlices(runtime, "ses_action");
  expect(before.drift[0]).toMatchObject({ status: "open" });
  await acknowledgeDriftFindingViaRpc(
    runtime,
    "ses_action",
    "DF-ACTION",
    "explained",
    "the package was added to the accepted scope",
  );
  const after = await loadGovernanceSlices(runtime, "ses_action");
  expect(after.drift[0]).toMatchObject({
    status: "explained",
    rationale: "the package was added to the accepted scope",
  });
  expect(after.errors).toEqual([]);
});

test("drift dismiss then reopen (翻案) round-trips through the RPC and counts reopens", async () => {
  const journal: any[] = [
    {
      findingID: "DF-REOPEN",
      severity: "warning" as const,
      confidence: 0.7,
      originalObjective: "stay on scope",
      currentActivity: "testing another package",
      evidence: [],
      applicableConstraints: [],
      status: "open" as const,
      reopenedCount: 0,
      contractVersion: 1,
      ruleHits: [],
    },
  ];
  const runtime = {
    driftFindings: async () => ({
      items: journal.map((finding) => ({ ...finding })),
      returned: journal.length,
      total: journal.length,
      truncated: false,
    }),
    acknowledgeDriftFinding: async (input: {
      findingID: string;
      status: string;
    }) => {
      const finding = journal.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      if (!finding || finding.status !== "open") return { acknowledged: false };
      finding.status = input.status;
      return { acknowledged: true };
    },
    reopenDriftFinding: async (input: { findingID: string }) => {
      const finding = journal.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      if (!finding) return { reopened: false, reason: "unknown finding" };
      if (finding.status !== "dismissed" && finding.status !== "explained")
        return {
          reopened: false,
          reason: `only dismissed/explained (${finding.status})`,
        };
      finding.status = "open";
      finding.reopenedCount = (finding.reopenedCount ?? 0) + 1;
      return { reopened: true };
    },
  } as unknown as RuntimeClient;

  // Dismiss, then reopen.
  await acknowledgeDriftFindingViaRpc(
    runtime,
    "ses_reopen",
    "DF-REOPEN",
    "dismissed",
  );
  expect(
    (await loadGovernanceSlices(runtime, "ses_reopen")).drift[0],
  ).toMatchObject({
    status: "dismissed",
  });
  const reopened = await reopenDriftFindingViaRpc(
    runtime,
    "ses_reopen",
    "DF-REOPEN",
  );
  expect(reopened).toMatchObject({ reopened: true });
  const after = await loadGovernanceSlices(runtime, "ses_reopen");
  expect(after.drift[0]).toMatchObject({ status: "open", reopenedCount: 1 });

  // A second reopen is refused: the finding is open again.
  const second = await reopenDriftFindingViaRpc(
    runtime,
    "ses_reopen",
    "DF-REOPEN",
  );
  expect(second).toMatchObject({ reopened: false });
});

test("constitution actions call their RPCs and reload reflects update and tombstone", async () => {
  const journal: any[] = [
    {
      ruleID: "C-ACTION",
      statement: "no force push",
      scope: "project",
      priority: "high",
      source: "user",
      enforcement: "deny",
      overridePolicy: "forbidden",
      enabled: true,
    },
  ];
  const runtime = {
    constitutionRules: async () =>
      journal.filter((rule) => rule.enabled).map((rule) => ({ ...rule })),
    updateConstitutionRule: async (input: {
      ruleID: string;
      enabled?: boolean;
    }) => {
      const rule = journal.find(
        (candidate) => candidate.ruleID === input.ruleID,
      );
      if (!rule) return { updated: false };
      rule.enabled = input.enabled ?? rule.enabled;
      return { updated: true };
    },
    removeConstitutionRule: async (input: { ruleID: string }) => {
      const index = journal.findIndex((rule) => rule.ruleID === input.ruleID);
      if (index < 0) return { removed: false };
      journal.splice(index, 1);
      return { removed: true };
    },
  } as unknown as RuntimeClient;

  expect(
    (await loadGovernanceSlices(runtime, "ses_action")).constitution,
  ).toHaveLength(1);
  await updateConstitutionRuleViaRpc(runtime, "ses_action", "C-ACTION", false);
  expect(
    (await loadGovernanceSlices(runtime, "ses_action")).constitution,
  ).toHaveLength(0);
  // Tombstone removal is a separate call/RPC, not a silent edit.
  await updateConstitutionRuleViaRpc(runtime, "ses_action", "C-ACTION", true);
  await removeConstitutionRuleViaRpc(runtime, "ses_action", "C-ACTION");
  expect(
    (await loadGovernanceSlices(runtime, "ses_action")).constitution,
  ).toHaveLength(0);
});

test("constitution rule add/edit call their RPCs and reload reflects the changes", async () => {
  const journal: any[] = [];
  const runtime = {
    constitutionRules: async () => journal.map((rule) => ({ ...rule })),
    createConstitutionRule: async (input: any) => {
      const ruleID = "P-USER-1";
      journal.push({
        ruleID,
        statement: input.statement,
        enforcement: input.enforcement,
        scope: "project",
        source: "user",
        appliesTo: input.appliesTo,
      });
      return { created: true, ruleID };
    },
    updateConstitutionRule: async (input: any) => {
      const rule = journal.find(
        (candidate) => candidate.ruleID === input.ruleID,
      );
      if (!rule) return { updated: false };
      if (input.statement) rule.statement = input.statement;
      if (input.enforcement) rule.enforcement = input.enforcement;
      if (input.appliesTo) rule.appliesTo = input.appliesTo;
      return { updated: true };
    },
  } as unknown as RuntimeClient;

  const created = await createConstitutionRuleViaRpc(runtime, "ses_crud", {
    statement: "no force push",
    enforcement: "deny",
    appliesTo: { commandPattern: "git push --force" },
  });
  expect(created).toMatchObject({ created: true, ruleID: "P-USER-1" });
  expect(
    (await loadGovernanceSlices(runtime, "ses_crud")).constitution,
  ).toEqual([
    expect.objectContaining({
      ruleID: "P-USER-1",
      statement: "no force push",
      enforcement: "deny",
      source: "user",
    }),
  ]);

  await editConstitutionRuleViaRpc(runtime, "ses_crud", {
    ruleID: "P-USER-1",
    statement: "never force-push",
    enforcement: "approval",
  });
  expect(
    (await loadGovernanceSlices(runtime, "ses_crud")).constitution[0],
  ).toMatchObject({ statement: "never force-push", enforcement: "approval" });
});

test("constitution document rules load and promote into the journal rule set", async () => {
  const docRules = [
    {
      id: "constitution:never-force-push:1",
      source: "constitution",
      section: "Never force-push",
      statement: "Force-pushing rewrites shared history.",
      enforcement: "deny",
      annotated: true,
      appliesTo: { commandPattern: "git push --force" },
    },
    {
      id: "constitution:small-prs:2",
      source: "constitution",
      section: "Small PRs",
      statement: "Prefer small pull requests.",
      enforcement: "warn",
      annotated: false,
    },
  ];
  const journal: Array<{ ruleID: string }> = [];
  const promoteCalls: Array<{ id: string }> = [];
  const runtime = {
    constitutionDocRules: async () => docRules.map((rule) => ({ ...rule })),
    promoteConstitutionDocRule: async (input: { id: string }) => {
      promoteCalls.push({ id: input.id });
      const ruleID = `P-DOC-${input.id}`;
      journal.push({ ruleID });
      return { promoted: true, ruleID };
    },
    constitutionRules: async () => journal.map((rule) => ({ ...rule })),
  } as unknown as RuntimeClient;

  const bundle = await loadGovernanceSlices(runtime, "ses_doc");
  expect(bundle.docRules).toHaveLength(2);

  const result = await promoteConstitutionDocRuleViaRpc(
    runtime,
    "ses_doc",
    "constitution:never-force-push:1",
  );
  expect(result).toMatchObject({
    promoted: true,
    ruleID: "P-DOC-constitution:never-force-push:1",
  });
  expect(promoteCalls).toEqual([{ id: "constitution:never-force-push:1" }]);
  expect(journal).toHaveLength(1);
});

test("the Decisions read requests session scope by default and workspace scope on demand", async () => {
  const calls: Array<unknown> = [];
  const runtime = {
    decisionRecords: async (input: unknown) => {
      calls.push(input);
      return { items: [], returned: 0, total: 0, truncated: false };
    },
  } as unknown as RuntimeClient;

  await loadGovernanceSlices(runtime, "ses_scope", {
    decisionScope: "session",
  });
  expect(calls[0]).toMatchObject({ sessionID: "ses_scope", scope: "session" });
  await loadGovernanceSlices(runtime, "ses_scope", {
    decisionScope: "workspace",
  });
  expect(calls[1]).toMatchObject({
    sessionID: "ses_scope",
    scope: "workspace",
  });
});

test("splitActivityRefs trims and drops empty entries from a comma list", () => {
  expect(splitActivityRefs("deleted:a.rs, modified: b.ts ,, ")).toEqual([
    "deleted:a.rs",
    "modified: b.ts",
  ]);
  expect(splitActivityRefs("")).toEqual([]);
  expect(splitActivityRefs("single ref")).toEqual(["single ref"]);
});

test("collapseList keeps a short list whole with nothing hidden", () => {
  const items = ["a", "b", "c"];
  const collapsed = collapseList(items, false);
  expect(collapsed.shown).toEqual(items);
  expect(collapsed.hiddenCount).toBe(0);
});

test("collapseList bounds a long list to the limit and reports the hidden count", () => {
  const items = Array.from({ length: 20 }, (_, i) => `ref_${i}`);
  const collapsed = collapseList(items, false);
  expect(collapsed.shown).toHaveLength(DRIFT_COLLAPSE_LIMIT);
  expect(collapsed.shown[0]).toBe("ref_0");
  expect(collapsed.hiddenCount).toBe(20 - DRIFT_COLLAPSE_LIMIT);
});

test("collapseList reveals the whole list when expanded (the 'view all' path)", () => {
  const items = Array.from({ length: 20 }, (_, i) => `ref_${i}`);
  const expanded = collapseList(items, true);
  expect(expanded.shown).toHaveLength(20);
  expect(expanded.hiddenCount).toBe(0);
});

test("collapseList honours an explicit limit and the exact-boundary case", () => {
  const items = ["a", "b", "c"];
  // Exactly at the limit still fits whole — no toggle, nothing hidden.
  expect(collapseList(items, false, 3).hiddenCount).toBe(0);
  // One past the limit hides exactly one.
  const over = collapseList(items, false, 2);
  expect(over.shown).toEqual(["a", "b"]);
  expect(over.hiddenCount).toBe(1);
});

test("updateConstitutionDocRuleViaRpc forwards the edit (id + fields) to the RPC", async () => {
  const calls: Array<{ input: unknown; sessionID: string | undefined }> = [];
  const runtime = {
    updateConstitutionDocRule: async (
      input: unknown,
      sessionID: string | undefined,
    ) => {
      calls.push({ input, sessionID });
      return { updated: true };
    },
  } as unknown as RuntimeClient;

  const result = await updateConstitutionDocRuleViaRpc(runtime, "ses_doc", {
    id: "constitution:small-prs:2",
    statement: "Prefer small, single-purpose pull requests.",
    enforcement: "approval",
    appliesTo: { tools: ["shell"] },
  });
  expect(result).toEqual({ updated: true });
  expect(calls).toEqual([
    {
      input: {
        id: "constitution:small-prs:2",
        statement: "Prefer small, single-purpose pull requests.",
        enforcement: "approval",
        appliesTo: { tools: ["shell"] },
      },
      sessionID: "ses_doc",
    },
  ]);
});

test("constitution rows: only hard-protected rules lock, everything else edits", () => {
  // Per the user's decision: 硬保护不能删，其余用户可删改. Only the C-TERM-*
  // rules backed by hard-coded SELF_PROTECTION_PATTERNS are locked.
  expect(constitutionRuleAffordance({ ruleID: "C-TERM-001" })).toBe(
    "protected",
  );
  expect(constitutionRuleAffordance({ ruleID: "C-TERM-002" })).toBe(
    "protected",
  );
  expect(constitutionRuleAffordance({ ruleID: "C-TERM-003" })).toBe(
    "protected",
  );
  // Release-scope runtime-policy rules are user-editable, not locked.
  expect(constitutionRuleAffordance({ ruleID: "C-REL-001" })).toBe("editable");
  expect(constitutionRuleAffordance({ ruleID: "C-REL-002" })).toBe("editable");
  expect(constitutionRuleAffordance({ ruleID: "P-USER-abc" })).toBe("editable");
  // A rule without an id is never silently protected.
  expect(constitutionRuleAffordance({})).toBe("editable");
});

test("mergeWorkGraphState backfills durable nodes and de-dupes edges by content", () => {
  // The view-store holds one live node + one edge (keyed by its own id); the
  // RPC holds the same edge plus an older historical node. After a reload the
  // merged graph must contain both nodes and exactly one copy of the edge.
  const liveState = {
    workGraphNodes: {
      "wg:tool:t1:c1": {
        type: "workgraph.node_added" as const,
        id: "wg:tool:t1:c1",
        nodeID: "wg:tool:t1:c1",
        kind: "tool_call" as const,
        summary: "read_file done",
      },
    },
    workGraphEdges: {
      "wg:edge:caused:wg:tool:t1:c1": {
        type: "workgraph.edge_added" as const,
        id: "wg:edge:caused:wg:tool:t1:c1",
        sourceID: "wg:action:t1",
        targetID: "wg:tool:t1:c1",
        kind: "caused" as const,
      },
    },
  };
  const merged = mergeWorkGraphState(
    liveState,
    [
      {
        nodeID: "wg:action:t1",
        kind: "agent_action" as const,
        summary: "agent acted",
      },
      {
        nodeID: "wg:tool:t1:c1",
        kind: "tool_call" as const,
        summary: "read_file done",
      },
    ],
    [
      {
        sourceID: "wg:action:t1",
        targetID: "wg:tool:t1:c1",
        kind: "caused" as const,
      },
    ],
  );
  expect(Object.keys(merged.workGraphNodes).sort()).toEqual([
    "wg:action:t1",
    "wg:tool:t1:c1",
  ]);
  // Edge de-duped by content: the live and RPC copies collapse to one.
  expect(Object.values(merged.workGraphEdges)).toHaveLength(1);
});

test("mergeWorkGraphState without RPC data keeps the live graph intact", () => {
  const liveState = {
    workGraphNodes: {
      n1: {
        type: "workgraph.node_added" as const,
        id: "n1",
        nodeID: "n1",
        kind: "agent_action" as const,
        summary: "x",
      },
    },
    workGraphEdges: {},
  };
  const merged = mergeWorkGraphState(liveState, [], []);
  expect(Object.keys(merged.workGraphNodes)).toEqual(["n1"]);
});

test("governance lists paginate: first page + cursor appends the next", async () => {
  // A 120-row evidence list; the RPC honours limit/cursor and returns the
  // GovernancePage envelope (EI Phase 1).
  const all = Array.from({ length: 120 }, (_, i) => ({ taskID: `t${i}` }));
  const calls: Array<{ limit?: number; cursor?: string }> = [];
  const runtime = {
    evidenceRecords: async (
      input: { limit?: number; cursor?: string } = {},
    ) => {
      calls.push(input);
      const offset = input.cursor ? Number(input.cursor) : 0;
      const size = input.limit ?? all.length;
      const items = all.slice(offset, offset + size);
      const truncated = offset + items.length < all.length;
      return {
        items,
        returned: items.length,
        total: all.length,
        truncated,
        ...(truncated ? { nextCursor: String(offset + items.length) } : {}),
      };
    },
  } as unknown as RuntimeClient;

  const first = await loadGovernanceSlices(runtime, "ses_page", {
    pageSize: 50,
  });
  expect(first.evidence).toHaveLength(50);
  expect(first.pageInfo.evidence).toMatchObject({
    total: 120,
    truncated: true,
    nextCursor: "50",
  });

  const next = await loadGovernancePage(runtime, "evidence", "ses_page", {
    cursor: first.pageInfo.evidence!.nextCursor,
    limit: 50,
  });
  expect(calls.at(-1)).toMatchObject({ limit: 50, cursor: "50" });
  expect(next.items).toHaveLength(50);
  expect(next.pageInfo).toMatchObject({
    total: 120,
    truncated: true,
    nextCursor: "100",
  });

  // The last page is untruncated and has no cursor.
  const last = await loadGovernancePage(runtime, "evidence", "ses_page", {
    cursor: next.pageInfo.nextCursor,
    limit: 50,
  });
  expect(last.items).toHaveLength(20);
  expect(last.pageInfo).toMatchObject({ total: 120, truncated: false });
  expect(last.pageInfo.nextCursor).toBeUndefined();
});

test("drift six interactions (explained/disputed/dismissed/corrected/detour_declared + reopen) round-trip", async () => {
  const journal: any[] = [
    {
      findingID: "DF-SIX",
      severity: "warning" as const,
      confidence: 0.7,
      originalObjective: "stay on scope",
      currentActivity: "testing another package",
      evidence: [],
      applicableConstraints: [],
      status: "open" as const,
      contractVersion: 1,
    },
  ];
  const runtime = {
    driftFindings: async () => ({
      items: journal.map((finding) => ({ ...finding })),
      returned: journal.length,
      total: journal.length,
      truncated: false,
    }),
    acknowledgeDriftFinding: async (input: {
      findingID: string;
      status:
        | "explained"
        | "disputed"
        | "dismissed"
        | "corrected"
        | "detour_declared";
      rationale?: string;
    }) => {
      const finding = journal.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      // Only an open finding may be acknowledged into any of the five states.
      if (!finding || finding.status !== "open") return { acknowledged: false };
      finding.status = input.status;
      if (input.rationale) finding.rationale = input.rationale;
      return { acknowledged: true };
    },
    reopenDriftFinding: async (input: { findingID: string }) => {
      const finding = journal.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      if (
        !finding ||
        (finding.status !== "dismissed" && finding.status !== "explained")
      )
        return { reopened: false };
      finding.status = "open";
      finding.reopenedCount = (finding.reopenedCount ?? 0) + 1;
      return { reopened: true };
    },
  } as unknown as RuntimeClient;

  const cases: Array<{
    status:
      | "explained"
      | "disputed"
      | "dismissed"
      | "corrected"
      | "detour_declared";
    rationale?: string;
  }> = [
    { status: "explained", rationale: "audit: scope was formally extended" },
    { status: "disputed", rationale: "false positive: expected churn" },
    { status: "dismissed" },
    { status: "corrected", rationale: "plan: revert and re-scope the change" },
    { status: "detour_declared", rationale: "sanctioned detour: alt approach" },
  ];
  for (const { status, rationale } of cases) {
    // Each review starts from an open finding.
    journal[0].status = "open";
    delete journal[0].rationale;
    const result = await acknowledgeDriftFindingViaRpc(
      runtime,
      "ses_six",
      "DF-SIX",
      status,
      rationale,
    );
    expect(result).toMatchObject({ acknowledged: true });
    const after = await loadGovernanceSlices(runtime, "ses_six");
    expect(after.drift[0].status).toBe(status);
    if (rationale) expect(after.drift[0].rationale).toBe(rationale);
  }

  // The sixth interaction: reopen a dismissed finding back to open.
  journal[0].status = "dismissed";
  const reopened = await reopenDriftFindingViaRpc(runtime, "ses_six", "DF-SIX");
  expect(reopened).toMatchObject({ reopened: true });
  expect(
    (await loadGovernanceSlices(runtime, "ses_six")).drift[0],
  ).toMatchObject({ status: "open", reopenedCount: 1 });
});

test("the override affordance follows the rule's own overridePolicy", () => {
  // Ledger plan §3: critical/forbidden rules cannot be overridden — and the
  // RPC refuses them anyway, so the panel must not offer the action.
  expect(constitutionOverrideAffordance({ overridePolicy: "forbidden" })).toBe(
    "forbidden",
  );
  expect(
    constitutionOverrideAffordance({ overridePolicy: "user_scoped" }),
  ).toBe("requestable");
  expect(
    constitutionOverrideAffordance({ overridePolicy: "user_explicit" }),
  ).toBe("requestable");
  expect(constitutionOverrideAffordance({})).toBe("requestable");
});

test("the override draft validates the reason and omits empty scope fields", () => {
  // The reason is the only required field; the backend refuses an empty one
  // too, so the panel says it first.
  expect(
    overrideRequestFromDraft({
      ruleID: "C-006",
      reason: "  ",
      paths: "",
      taskID: "",
      expiresAt: "",
    }),
  ).toEqual({ ok: false, reason: "override requires a reason" });

  expect(
    overrideRequestFromDraft({
      ruleID: "C-006",
      reason: " one-off host write ",
      paths: " src/parser.ts , , src/lexer.ts ",
      taskID: "",
      expiresAt: "2026-10-01T00:00:00.000Z",
    }),
  ).toEqual({
    ok: true,
    input: {
      ruleID: "C-006",
      reason: "one-off host write",
      paths: ["src/parser.ts", "src/lexer.ts"],
      expiresAt: "2026-10-01T00:00:00.000Z",
    },
  });
  // No scope fields at all: the rule's whole scope, not "no scope".
  expect(
    overrideRequestFromDraft({
      ruleID: "C-010",
      reason: "the user asked directly",
      paths: "",
      taskID: " task_1 ",
      expiresAt: "",
    }),
  ).toEqual({
    ok: true,
    input: {
      ruleID: "C-010",
      reason: "the user asked directly",
      taskID: "task_1",
    },
  });
});

test("an override request goes through the RPC and the approval seam grants it", async () => {
  const seen: Array<{ input: unknown; sessionID?: string }> = [];
  const runtime = {
    requestOverride: async (input: unknown, sessionID?: string) => {
      seen.push({ input, sessionID });
      // The seam's grant path answers requested:true after the user's
      // approval; a refusal answers with the reason.
      return { requested: true, requestID: "override:C-006:1" };
    },
  } as unknown as RuntimeClient;

  const draft = overrideRequestFromDraft({
    ruleID: "C-006",
    reason: "one-off host write for the parser fix",
    paths: "src/parser.ts",
    taskID: "",
    expiresAt: "",
  });
  if (!draft.ok) throw new Error("unreachable");
  const result = await requestOverrideViaRpc(
    runtime,
    "ses_override",
    draft.input,
  );
  expect(result).toEqual({ requested: true, requestID: "override:C-006:1" });
  expect(seen).toEqual([
    {
      input: {
        ruleID: "C-006",
        reason: "one-off host write for the parser fix",
        paths: ["src/parser.ts"],
      },
      sessionID: "ses_override",
    },
  ]);
});

test("the overrides slice loads beside the constitution slice", async () => {
  const runtime = {
    constitutionRules: async () => [
      {
        ruleID: "C-006",
        statement: "sandbox only",
        scope: "project",
        priority: "high",
        source: "user",
        enforcement: "approval",
        overridePolicy: "user_scoped",
      },
    ],
    constitutionOverrides: async () => [
      {
        id: "override:C-006:1",
        ruleID: "C-006",
        reason: "one-off host write",
        approvedBy: "user",
        paths: ["src/parser.ts"],
      },
    ],
  } as unknown as RuntimeClient;
  const bundle = await loadGovernanceSlices(runtime, "ses_ov");
  expect(bundle.overrides).toEqual([
    {
      id: "override:C-006:1",
      ruleID: "C-006",
      reason: "one-off host write",
      approvedBy: "user",
      paths: ["src/parser.ts"],
    },
  ]);
  // The slice is per-rule addressable and each override renders its scope.
  expect(overridesForRule(bundle.overrides, "C-006")).toHaveLength(1);
  expect(overridesForRule(bundle.overrides, "C-999")).toEqual([]);
  expect(overrideLine(bundle.overrides[0]!)).toBe(
    "one-off host write (paths: src/parser.ts)",
  );
  expect(
    overrideLine({
      id: "o",
      ruleID: "C-010",
      reason: "the user asked",
      approvedBy: "user",
      taskID: "task_1",
      expiresAt: "2026-10-01T00:00:00.000Z",
    }),
  ).toBe("the user asked (task: task_1; expires: 2026-10-01T00:00:00.000Z)");
  // No scope fields: the bare reason, nothing invented.
  expect(
    overrideLine({
      id: "o2",
      ruleID: "C-013",
      reason: "whole-scope exception",
      approvedBy: "user",
    }),
  ).toBe("whole-scope exception");
});

test("the Growth trigger surface records a promotion and applies nothing", async () => {
  // L7: the button behind a Growth trigger row. It records the
  // `growth.promoted` fact through the RPC face — destination, required
  // approval, and who acts next — and applies NOTHING itself. The loop's
  // automation ends at this click on purpose.
  const promotions: Array<{ capability: string }> = [];
  const runtime = {
    growthProposals: async () => [],
    growthTriggers: async () => [
      {
        rule: "capability_gap",
        class: "skill",
        capability: "release-evidence",
        evidence: { observations: 3 },
        reason: "the gap kept costing the release",
      },
    ],
    growthPromotions: async () => [],
    externalJoinedTasks: async () => [],
    promoteGrowthTrigger: async (input: { capability: string }) => {
      promotions.push(input);
      return {
        promoted: true,
        destination: "skill",
        approval: "human",
        appliedBy: "skills.upsert",
        next: "a human reviews the candidate",
        reason:
          "class policy: a skill may auto-apply, the write still validates",
      };
    },
  } as unknown as RuntimeClient;
  const result = await promoteGrowthTriggerViaRpc(
    runtime,
    "ses_growth",
    "release-evidence",
  );
  expect(promotions).toEqual([{ capability: "release-evidence" }]);
  // The answer names the destination, the approval and the next actor —
  // and the promotion's own doc says it applies nothing.
  expect(result).toMatchObject({
    promoted: true,
    destination: "skill",
    approval: "human",
    next: "a human reviews the candidate",
  });
});

test("the Growth tab's queue reads the runtime's face and renders the pending rows", () => {
  // S8's panel side: the human appears HERE and only here. The rows come
  // from the runtime's face (the panel cannot import the intelligence
  // package), so an unreadable queue is an empty queue said out loud —
  // never a silent one, and never a throw that takes the tab down.
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "governance-panel.tsx"),
    "utf8",
  );
  expect(source).toContain("evolutionQueue");
  // The approve button hands the candidate to the validated boundary.
  expect(source).toContain("upsertSkill");
  // And a tab whose EVERY section is empty says ONE thing, not five
  // paragraphs: four sections that each say "nothing here" is a screen of
  // prose, and a person who opens it needs one answer ("is there anything
  // for me?"), which five paragraphs cannot give.
  expect(source).toContain("growthHasAnything");
  expect(source).toContain("进化数据还是空的");
  expect(source).toContain("没有对比数据");
  // And the delete dialog says what actually happens. "历史保留" was a
  // promise with no reader — the tombstone is journaled and the fold
  // excludes the rule, but no surface ever shows it, so the copy claimed a
  // benefit the user never receives.
  expect(source).toContain("规则立刻永久失效");
  expect(source).not.toContain("历史保留");
  // And an EMPTY queue costs one line, not three: the screen is already a
  // wall of empty sections, and this one adding a title + subtitle + an
  // empty-state box to say nothing was the wrong call.
  expect(source).toContain("fallback={");
  expect(source).toContain("进化队列：没有待审批的候选");
  // And the labels a reader needs are in the language the panel is read in
  // (the panel's interactive layer is Chinese; English labels here were
  // unreadable). The guard reads the TEMPLATE LITERALS, not bare words —
  // a bare-word check passes on the Chinese comment that explains them,
  // which is a guard with no teeth.
  expect(source).toContain("`训练集 ${");
  expect(source).toContain("`验证集 ${");
  expect(source).toContain("`封存集 ${");
  expect(source).toContain("七门逐门：");
  expect(source).toContain("基线（现在的）：");
  expect(source).toContain("本轮花费：");
  // And the section says who appears here.
  expect(source).toContain("进化队列（待你审批）");
});
