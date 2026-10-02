import { expect, test } from "bun:test";
import {
  buildDriftFindingUpdate,
  createDriftEvaluator,
  DRIFT_CONTRACT_VERSION,
  DRIFT_FINDING_WRITER_OWNER,
  pathInScope,
  proseRelevanceQuestion,
  targetDriftAbsorbedByScope,
} from "../src";

function makeEvaluator(open: ReadonlySet<string> = new Set()) {
  return createDriftEvaluator({ openFindingIDs: () => open });
}

test("the drift finding writer owner is fixed", () => {
  expect(DRIFT_FINDING_WRITER_OWNER).toBe("DriftEvaluator");
});

test("no drift when activity overlaps the objective", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "add a typed HTTP client",
    currentActivity: "adding a typed HTTP client",
    applicableConstraints: [],
    changes: [
      { action: "modified", path: "src/http.ts", summary: "typed client" },
    ],
    evidenceRefs: ["validated"],
    contract: {
      planID: "plan:1",
      scope: [],
      verification: [],
      constraints: [],
    },
  });
  expect(findings).toEqual([]);
});

test("no accepted contract opens an advisory unverifiable finding", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "implement user authentication",
    currentActivity: "refactoring the css theme",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(findings).toHaveLength(1);
  const finding = findings[0]!;
  expect(finding.type).toBe("drift.finding_opened");
  expect(finding.severity).toBe("advisory");
  expect(finding.confidence).toBeGreaterThan(0.4);
  expect(finding.originalObjective).toContain("authentication");
  expect(finding.currentActivity).toContain("css theme");
  expect(finding.evidence).toContain("reference:no_accepted_contract");
});

test("a long activity list is bounded by item, never mid-item", () => {
  const evaluator = makeEvaluator();
  // A normal turn's change set is stored whole — the finding keeps every ref so
  // the card can offer "view all" with nothing lost at the data layer.
  const normal = Array.from(
    { length: 40 },
    (_, index) => `deleted:packages/kernel/src/file_${index}.rs`,
  );
  const whole = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_items",
    objective: "implement user authentication",
    currentActivity: normal.join(", "),
    applicableConstraints: [],
    changes: [{ path: "src/lib.rs", action: "modified" }],
    evidenceRefs: [],
  });
  expect(whole).toHaveLength(1);
  expect(whole[0]!.currentActivity).toContain("file_39.rs");
  expect(whole[0]!.currentActivity).not.toContain("more");

  // A pathological turn past the cap is bounded by ITEM (never mid-item), with
  // the dropped count stated — so the card is bounded but never cuts a ref in
  // half ("deleted:" -> "dele") and never lies about what it dropped.
  const pathological = Array.from(
    { length: 600 },
    (_, index) => `deleted:packages/kernel/src/file_${index}.rs`,
  );
  const bounded = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_items_cap",
    objective: "implement user authentication",
    currentActivity: pathological.join(", "),
    applicableConstraints: [],
    changes: [{ path: "src/lib.rs", action: "modified" }],
    evidenceRefs: [],
  });
  expect(bounded).toHaveLength(1);
  const finding = bounded[0]!;
  expect(finding.currentActivity).toContain("file_499.rs");
  expect(finding.currentActivity).not.toContain("file_500.rs");
  expect(finding.currentActivity).toContain("\u2026+100 more");
});

test("a forbidden activity signal opens a high finding with the constraint", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "finish the docs",
    currentActivity: "commit the generated files to the repo",
    applicableConstraints: ["never commit generated files"],
    changes: [{ action: "added", path: "dist/out.js" }],
    evidenceRefs: [],
  });
  expect(findings.length).toBeGreaterThan(0);
  const finding = findings.find((f) => f.severity === "high");
  expect(finding).toBeDefined();
  expect(finding?.severity).toBe("high");
  expect(finding?.applicableConstraints[0]).toContain("never commit");
  expect(
    finding?.evidence.some((entry) => entry.startsWith("constraint:")),
  ).toBe(true);
});

test("a verify objective with no evidence and changed files opens a warning", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "verify the build passes",
    currentActivity: "verify the build passes",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/lib.ts" }],
    evidenceRefs: [],
  });
  const finding = findings.find((f) => f.severity === "warning");
  expect(finding).toBeDefined();
  expect(finding?.evidence).toContain("completion:no_evidence_refs");
});

test("an already-open finding is not reopened", () => {
  const findingID = "drift:unverifiable_no_contract:t_1:ses_1";
  const evaluator = makeEvaluator(new Set([findingID]));
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "implement authentication",
    currentActivity: "refactoring css",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/theme.css" }],
    evidenceRefs: [],
  });
  expect(findings.some((f) => f.findingID === findingID)).toBe(false);
});

test("drift findings carry no secrets", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "implement authentication",
    currentActivity: "commit api_key=supersecret to the repo",
    applicableConstraints: ["never commit secrets"],
    changes: [{ action: "added", path: "config.json" }],
    evidenceRefs: [],
  });
  const serialized = JSON.stringify(findings);
  expect(serialized).not.toContain("supersecret");
});

test("buildDriftFindingUpdate records the rationale acknowledgement", () => {
  const event = buildDriftFindingUpdate({
    id: "drift:abc:drift:x",
    findingID: "drift:x",
    status: "explained",
    rationale: "the css refactor was a prerequisite",
  });
  expect(event).toMatchObject({
    type: "drift.finding_updated",
    findingID: "drift:x",
    status: "explained",
    rationale: "the css refactor was a prerequisite",
  });
});

test("buildDriftFindingUpdate redacts secrets from the rationale", () => {
  const event = buildDriftFindingUpdate({
    id: "drift:abc:drift:y",
    findingID: "drift:y",
    status: "dismissed",
    rationale: "api_key=supersecret is not involved",
  });
  expect(JSON.stringify(event)).not.toContain("supersecret");
  expect(event.rationale).toContain("[REDACTED]");
});

test("a dependency manifest change unrelated to the objective opens an advisory", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "implement the credential handler",
    currentActivity: "implement the credential handler",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "package.json" }],
    evidenceRefs: ["validated"],
  });
  const dep = findings.find((f) => f.findingID.includes("dependency_signal"));
  expect(dep).toBeDefined();
  expect(dep?.severity).toBe("advisory");
  expect(dep?.evidence).toContain("dependency:package.json");
});

test("a dependency change when the objective is about dependencies opens nothing", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "update the dependencies and lockfile",
    currentActivity: "update the dependencies and lockfile",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "bun.lock" }],
    evidenceRefs: [],
    contract: {
      planID: "plan:1",
      scope: [],
      verification: [],
      constraints: [],
    },
  });
  expect(findings).toEqual([]);
});

test("a change outside the objective's named target opens a target_drift advisory", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: 'refactor the "src/auth" module',
    currentActivity: 'refactor the "src/auth" module',
    applicableConstraints: [],
    changes: [{ action: "modified", path: "dist/out.js" }],
    evidenceRefs: [],
    contract: {
      planID: "plan:1",
      scope: [],
      verification: [],
      constraints: [],
    },
  });
  const drift = findings.find((f) => f.findingID.includes("target_drift"));
  expect(drift).toBeDefined();
  expect(
    drift?.evidence.some((entry) => entry.startsWith("outside_target:")),
  ).toBe(true);
});

test("a change inside the objective's named target opens nothing", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: 'refactor the "src/auth" module',
    currentActivity: 'refactor the "src/auth" module',
    applicableConstraints: [],
    changes: [{ action: "modified", path: "src/auth/credential.ts" }],
    evidenceRefs: [],
  });
  expect(findings.some((f) => f.findingID.includes("target_drift"))).toBe(
    false,
  );
});

test("minimumConfidence tuning suppresses weak signals", () => {
  const evaluator = createDriftEvaluator({
    openFindingIDs: () => new Set(),
    minimumConfidence: 0.8,
  });
  // dependency_signal has confidence 0.55 and target_drift 0.6: both below 0.8.
  const findings = evaluator.evaluate({
    sessionID: "ses_1",
    turnID: "t_1",
    objective: "implement the credential handler",
    currentActivity: "implement the credential handler",
    applicableConstraints: [],
    changes: [{ action: "modified", path: "package.json" }],
    evidenceRefs: [],
  });
  expect(findings).toEqual([]);
});

test("CJK objectives score overlap instead of reading as zero (EI §8.6)", () => {
  // The old word-only metric split Chinese into zero tokens, so every CJK
  // objective looked like total mismatch. The CJK-aware metric now scores the
  // bigram overlap, so an on-track activity asks no prose-relevance question.
  const question = proseRelevanceQuestion({
    objective: "把运行时提示词改成静态加运行时上下文",
    currentActivity: "把运行时提示词改成静态加运行时上下文的改动",
    applicableConstraints: [],
    changes: [{ path: "packages/framework/runtime/src", action: "edit" }],
    evidenceRefs: [],
  });
  expect(question).toBeUndefined();
});

test("proseRelevanceQuestion asks when there is no contract and the activity is unrelated", () => {
  // No contract + unrelated activity -> the 问通道 asks; it is not a finding.
  const question = proseRelevanceQuestion({
    sessionID: "ses_1",
    objective: "implement user authentication",
    currentActivity: "writing cooking recipes documentation",
    applicableConstraints: [],
    changes: [{ path: "docs/recipes.md", action: "edit" }],
    evidenceRefs: [],
  });
  expect(question).toContain("关联不大");
  expect(question).toContain("implement user authentication");
  // With a contract the judge channel governs, so no prose question.
  expect(
    proseRelevanceQuestion({
      objective: "implement user authentication",
      currentActivity: "writing cooking recipes documentation",
      applicableConstraints: [],
      changes: [],
      evidenceRefs: [],
      contract: {
        planID: "plan:1",
        scope: [],
        verification: [],
        constraints: [],
      },
    }),
  ).toBeUndefined();
});

test("an accepted contract is the R: scope matches are not drift and its constraints bind", () => {
  const { evaluate } = createDriftEvaluator({
    openFindingIDs: () => new Set(),
  });
  // The activity matches the committed scope even though the objective
  // sentence does not — no mismatch finding.
  const scopeFindings = evaluate({
    objective: "rewrite the entire runtime",
    currentActivity: "edit:packages/framework/runtime/src",
    applicableConstraints: [],
    changes: [
      { path: "packages/framework/runtime/src/provider.ts", action: "edit" },
    ],
    evidenceRefs: [],
    contract: {
      planID: "plan:1",
      scope: ["packages/framework/runtime/src"],
      verification: [],
      constraints: ["never commit directly"],
    },
  });
  // A contract governs the judge channel, so no prose-relevance question.
  expect(
    proseRelevanceQuestion({
      objective: "rewrite the entire runtime",
      currentActivity: "edit:packages/framework/runtime/src",
      applicableConstraints: [],
      changes: [],
      evidenceRefs: [],
      contract: {
        planID: "plan:1",
        scope: ["packages/framework/runtime/src"],
        verification: [],
        constraints: [],
      },
    }),
  ).toBeUndefined();
  // The contract's own constraint is as binding as a seeded rule.
  const constraintFindings = evaluate({
    objective: "ship the change",
    currentActivity: "git commit the change",
    applicableConstraints: [],
    changes: [{ path: "src", action: "edit" }],
    evidenceRefs: [],
    contract: {
      planID: "plan:1",
      scope: [],
      verification: [],
      constraints: ["never commit directly"],
    },
  });
  const constraintFinding = constraintFindings.find(
    (f) =>
      f.severity === "high" &&
      f.ruleHits?.some((h) => h.rule === "constraint_violation_signal"),
  );
  expect(constraintFinding).toBeDefined();
  // The contract's own constraint is the evidence — the session's
  // applicableConstraints stays empty because the rule fired on the R.
  expect(constraintFinding!.evidence.join("\n")).toContain(
    "never commit directly",
  );
  expect(constraintFinding!.planID).toBe("plan:1");
});

test("changes without a contract produce only the advisory unverifiable finding (EI §3.8 P-1.b)", () => {
  const { evaluate } = createDriftEvaluator({
    openFindingIDs: () => new Set(),
  });
  const findings = evaluate({
    objective: "edit the app",
    currentActivity: "edit the app:src/app.ts",
    applicableConstraints: [],
    changes: [{ path: "src/app.ts", action: "edit" }],
    evidenceRefs: [],
  });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    severity: "advisory",
  });
  expect(findings[0]!.planID).toBeUndefined();
  expect(findings[0]!.ruleHits).toEqual([
    { rule: "unverifiable_no_contract", confidence: 0.5 },
  ]);
  expect(findings[0]!.evidence).toContain("reference:no_accepted_contract");
});

test("every finding carries contractVersion and ruleHits (EI §8.6)", () => {
  const { evaluate } = createDriftEvaluator({
    openFindingIDs: () => new Set(),
  });
  const findings = evaluate({
    objective: "verify the parser",
    currentActivity: "edit:12 actions without parser files",
    applicableConstraints: [],
    changes: [{ path: "packages/x/src", action: "edit" }],
    evidenceRefs: [],
    contract: {
      planID: "plan:1",
      scope: [],
      verification: [],
      constraints: [],
    },
  });
  const evidenceGap = findings.find((finding) =>
    finding.ruleHits?.some((hit) => hit.rule === "evidence_gap"),
  );
  expect(evidenceGap).toBeDefined();
  expect(evidenceGap!.contractVersion).toBe(DRIFT_CONTRACT_VERSION);
  expect(
    evidenceGap!.ruleHits!.some((hit) => hit.rule === "evidence_gap"),
  ).toBe(true);
});

test("no-progress window opens an advisory finding after K actions with no marker", () => {
  const evaluator = makeEvaluator();
  // 8 plain tool_call actions, no progress marker.
  const actions = Array.from({ length: 8 }, () => ({
    kind: "tool_call" as const,
  }));
  const findings = evaluator.evaluate({
    sessionID: "ses_np",
    turnID: "t_np",
    objective: "ship the feature",
    currentActivity: "reading files",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentActions: actions,
  });
  const finding = findings.find((f) =>
    f.ruleHits?.some((h) => h.rule === "no_progress"),
  );
  expect(finding).toBeDefined();
  expect(finding!.severity).toBe("advisory");
  // Session-scoped: the findingID carries no turnID.
  expect(finding!.findingID).toBe("drift:no_progress:session:ses_np");
});

test("no-progress does not fire when a progress marker is in the window", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_np",
    turnID: "t_np",
    objective: "ship the feature",
    currentActivity: "reading files",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentActions: [
      ...Array.from({ length: 7 }, () => ({ kind: "tool_call" as const })),
      { kind: "workspace_change" as const },
    ],
  });
  expect(
    findings.some((f) => f.ruleHits?.some((h) => h.rule === "no_progress")),
  ).toBe(false);
});

test("no-progress does not fire before the window is full", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_np",
    turnID: "t_np",
    objective: "ship the feature",
    currentActivity: "reading files",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentActions: Array.from({ length: 7 }, () => ({
      kind: "tool_call" as const,
    })),
  });
  expect(
    findings.some((f) => f.ruleHits?.some((h) => h.rule === "no_progress")),
  ).toBe(false);
});

test("failure loop opens a warning at the threshold and carries only the tool name + count", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_fl",
    turnID: "t_fl",
    objective: "fix the build",
    currentActivity: "retrying the same command",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentFailures: [
      { toolName: "run_shell", key: "abc123" },
      { toolName: "run_shell", key: "abc123" },
      { toolName: "run_shell", key: "abc123" },
    ],
  });
  const finding = findings.find((f) =>
    f.ruleHits?.some((h) => h.rule === "failure_loop"),
  );
  expect(finding).toBeDefined();
  expect(finding!.severity).toBe("warning");
  expect(finding!.findingID).toBe("drift:failure_loop:session:ses_fl");
  // Evidence carries the tool name + count, never the raw key/args.
  expect(
    finding!.evidence.some((e) => e.includes("failure_loop:run_shell:3x")),
  ).toBe(true);
  expect(finding!.evidence.some((e) => e.includes("abc123"))).toBe(false);
});

test("failure loop does not fire below the threshold or across different keys", () => {
  const evaluator = makeEvaluator();
  const below = evaluator.evaluate({
    sessionID: "ses_fl",
    turnID: "t_fl",
    objective: "fix the build",
    currentActivity: "retrying",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentFailures: [
      { toolName: "run_shell", key: "abc123" },
      { toolName: "run_shell", key: "abc123" },
    ],
  });
  expect(
    below.some((f) => f.ruleHits?.some((h) => h.rule === "failure_loop")),
  ).toBe(false);
  const distinct = evaluator.evaluate({
    sessionID: "ses_fl",
    turnID: "t_fl",
    objective: "fix the build",
    currentActivity: "retrying",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentFailures: [
      { toolName: "run_shell", key: "abc123" },
      { toolName: "run_shell", key: "def456" },
      { toolName: "run_shell", key: "ghi789" },
    ],
  });
  expect(
    distinct.some((f) => f.ruleHits?.some((h) => h.rule === "failure_loop")),
  ).toBe(false);
});

test("a change matching a deny constitution rule opens a high constitution_conflict finding", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_cc",
    turnID: "t_cc",
    objective: "ship the change",
    currentActivity: "edit:secrets.env",
    applicableConstraints: [],
    changes: [{ path: "secrets.env", action: "modified" }],
    evidenceRefs: [],
    constitutionHits: [{ ruleID: "C-TERM-001", enforcement: "deny" }],
  });
  const finding = findings.find((f) =>
    (f.ruleHits ?? []).some((h) => h.rule === "constitution_conflict"),
  );
  expect(finding).toBeDefined();
  expect(finding!.severity).toBe("high");
  expect(finding!.evidence).toContain("constitution:C-TERM-001");
});

test("a warn/approval constitution hit does not open a conflict finding", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_cc",
    turnID: "t_cc",
    objective: "ship the change",
    currentActivity: "edit:foo.ts",
    applicableConstraints: [],
    changes: [{ path: "foo.ts", action: "modified" }],
    evidenceRefs: [],
    constitutionHits: [{ ruleID: "C-X", enforcement: "warn" }],
  });
  expect(
    findings.some((f) =>
      (f.ruleHits ?? []).some((h) => h.rule === "constitution_conflict"),
    ),
  ).toBe(false);
});

test("pathInScope matches the target itself and anything nested under it", () => {
  expect(pathInScope("packages/a", ["packages/a"])).toBe(true);
  expect(pathInScope("packages/a/x.ts", ["packages/a"])).toBe(true);
  expect(pathInScope("packages/b/x.ts", ["packages/a"])).toBe(false);
  // A prefix without a path boundary is not a scope hit.
  expect(pathInScope("packages/ab/x.ts", ["packages/a"])).toBe(false);
});

test("a target_drift finding is auto-corrected only when the scope absorbs it", () => {
  const finding = {
    planID: "plan_1",
    evidence: [
      "outside_target:packages/b/x.ts",
      "outside_target:packages/b/y.ts",
    ],
  };
  // The revised scope covers every flagged path -> the premise is gone.
  expect(
    targetDriftAbsorbedByScope({
      finding,
      planID: "plan_1",
      scope: ["packages/a", "packages/b"],
    }),
  ).toBe(true);
  // One path left outside -> not corrected.
  expect(
    targetDriftAbsorbedByScope({
      finding: {
        planID: "plan_1",
        evidence: ["outside_target:packages/b/x.ts"],
      },
      planID: "plan_1",
      scope: ["packages/a"],
    }),
  ).toBe(false);
  // A different plan, a non-target_drift finding, or a planless finding: never.
  expect(
    targetDriftAbsorbedByScope({
      finding,
      planID: "plan_2",
      scope: ["packages/b"],
    }),
  ).toBe(false);
  expect(
    targetDriftAbsorbedByScope({
      finding: {
        planID: "plan_1",
        evidence: ["reference:no_accepted_contract"],
      },
      planID: "plan_1",
      scope: ["packages/b"],
    }),
  ).toBe(false);
  expect(
    targetDriftAbsorbedByScope({
      finding: { evidence: ["outside_target:packages/b/x.ts"] },
      planID: "plan_1",
      scope: ["packages/b"],
    }),
  ).toBe(false);
});

test("target_drift evidence shape matches the auto-correction parser", () => {
  const evaluator = makeEvaluator();
  const findings = evaluator.evaluate({
    sessionID: "ses_td",
    turnID: "t_td",
    objective: "ship it",
    currentActivity: "modify:packages/b/x.ts",
    applicableConstraints: [],
    changes: [{ path: "packages/b/x.ts", action: "modified" }],
    evidenceRefs: [],
    contract: { planID: "plan_1", scope: ["packages/a"] },
  });
  const targetDrift = findings.find((f) =>
    (f.ruleHits ?? []).some((h) => h.rule === "target_drift"),
  );
  expect(targetDrift).toBeDefined();
  expect(Array.isArray(targetDrift!.evidence)).toBe(true);
  expect(
    targetDrift!.evidence.some((entry) => entry.startsWith("outside_target:")),
  ).toBe(true);
  expect(targetDrift!.planID).toBe("plan_1");
});

test("an open invariant violation is a drift signal — the D3 linkage", async () => {
  const evaluator = makeEvaluator();
  const base = {
    sessionID: "ses_inv",
    turnID: "t_inv",
    objective: "fix the parser",
    currentActivity: "rewriting config",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    recentActions: [{ kind: "tool_call" as const }],
    recentFailures: [],
  };
  // The behaviour path (no contract, no changes) carries the linkage: a
  // broken data relation needs no WorkContract to be a fact.
  const withHits = evaluator.evaluateBehavior({
    ...base,
    invariantHits: [
      {
        code: "session.projection_incomplete",
        at: "2026-01-01T00:00:00.000Z",
        detail: "ses_inv ran turns",
      },
    ],
  });
  expect(withHits).toHaveLength(1);
  expect(withHits[0]).toMatchObject({
    severity: "warning",
  });
  expect(withHits[0]!.ruleHits).toEqual([
    { rule: "invariant_violation", confidence: 0.75 },
  ]);
  // Secret-safe citation only: code + timestamp, never the detail prose.
  expect(withHits[0]!.evidence).toEqual([
    "invariant:session.projection_incomplete@2026-01-01T00:00:00.000Z",
  ]);
  expect(withHits[0]!.evidence!.join()).not.toContain("ran turns");

  // No open violations -> this rule stays quiet.
  expect(evaluate(base)).toEqual([]);
});

test("an already-open invariant finding is not reopened", () => {
  const open = new Set(["drift:invariant_violation:session:ses_inv"]);
  const evaluator = createDriftEvaluator({ openFindingIDs: () => open });
  const findings = evaluator.evaluateBehavior({
    sessionID: "ses_inv",
    turnID: "t_2",
    objective: "o",
    currentActivity: "",
    applicableConstraints: [],
    changes: [],
    evidenceRefs: [],
    invariantHits: [{ code: "c", at: "2026-01-01T00:00:00.000Z", detail: "d" }],
  });
  expect(findings).toEqual([]); // one fact per divergence, not per evaluation
});

function evaluate(
  signal: Parameters<ReturnType<typeof makeEvaluator>["evaluate"]>[0],
) {
  return makeEvaluator().evaluate(signal);
}
