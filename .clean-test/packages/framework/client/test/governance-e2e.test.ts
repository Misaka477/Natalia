import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  projectedCompletions,
  projectedDecisionRecords,
  projectedEvidenceRecords,
  projectedWorkContracts,
  projectedWorkGraphEdges,
  projectedWorkGraphNodes,
} from "@anthelia/session";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import {
  createScriptedProvider,
  reduceRuntimeEvents,
  waitFor,
} from "./e2e-harness";

const MAIN_SESSION = "ses_e2e_governance_write" as SessionID;

test("Phase 0 E2E: record tools land journal facts that agree across projections, runtime reads and view-store", async () => {
  const root = await officialPluginWorkspace("governance-e2e-write");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: MAIN_SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: {
            name: "record_decision",
            arguments: {
              decision:
                "append runtime context instead of mutating the system prompt",
              rationale: ["keeps the cacheable prefix stable"],
              alternatives: [
                {
                  option: "rewrite the system prompt per turn",
                  rejectedReason: "breaks prompt-cache prefix stability",
                },
              ],
              consequences: ["a context block is appended per turn"],
            },
          },
        },
        {
          tool: {
            name: "record_validation",
            arguments: {
              taskID: "plan:e2e:s1",
              objective: "the e2e workspace validation runner is wired",
              command: "true",
            },
          },
        },
        {
          tool: {
            name: "record_completion",
            arguments: {
              taskID: "plan:e2e:s1",
              objective:
                "record a completion card for the zero-window write path",
              changeSummary: "wired record_decision/validation/completion",
              validations: [
                {
                  command: "true",
                  result: "passed",
                  safeSummary: "the validation runner returned success",
                },
              ],
              knownGaps: [],
              rollbackState: "clean",
              changePaths: [
                "packages/framework/client/src/runtime/record-tools.ts",
              ],
            },
          },
        },
        { text: "governance facts recorded" },
      ],
      nia: [{ text: "audit wake observed" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(MAIN_SESSION);
  await client.submitAndWait!("record the governance facts");
  await waitFor(
    () =>
      events.some((event) => event.type === "completion.recorded") &&
      events.some((event) => event.type === "decision.recorded") &&
      events.some((event) => event.type === "evidence.recorded"),
    { timeoutMs: 10_000 },
  );

  // 1. Journal: each production write is one durable fact.
  const decisionEvents = events.filter(
    (event) => event.type === "decision.recorded",
  );
  const evidenceEvents = events.filter(
    (event) => event.type === "evidence.recorded",
  );
  const completionEvents = events.filter(
    (event) => event.type === "completion.recorded",
  );
  expect(decisionEvents).toHaveLength(1);
  expect(evidenceEvents).toHaveLength(1);
  expect(completionEvents).toHaveLength(1);
  expect(decisionEvents[0]).toMatchObject({
    decision: "append runtime context instead of mutating the system prompt",
    rationale: ["keeps the cacheable prefix stable"],
  });
  expect(evidenceEvents[0]).toMatchObject({
    taskID: "plan:e2e:s1",
    status: "validated",
  });
  expect(completionEvents[0]).toMatchObject({
    taskID: "plan:e2e:s1",
  });

  // 2. Projection reaches the same facts from the journal.
  expect(projectedDecisionRecords(events)).toHaveLength(1);
  expect(projectedEvidenceRecords(events)).toHaveLength(1);
  expect(projectedCompletions(events)).toHaveLength(1);

  // 3. Runtime read surfaces answer with the same records (not raw event rows).
  const decisions = await client.decisionRecords!(MAIN_SESSION);
  const evidence = await client.evidenceRecords!({ sessionID: MAIN_SESSION });
  const completions = await client.completions!({ sessionID: MAIN_SESSION });
  expect(decisions.items).toHaveLength(1);
  expect(decisions.items[0]).toMatchObject({
    decision: "append runtime context instead of mutating the system prompt",
  });
  expect(decisions.items[0]!.id).toStartWith("decision:");
  expect(evidence.items).toHaveLength(1);
  expect(evidence.items[0]).toMatchObject({
    taskID: "plan:e2e:s1",
    status: "validated",
  });
  expect(completions.items).toHaveLength(1);
  expect(completions.items[0]).toMatchObject({
    taskID: "plan:e2e:s1",
    changeSummary: "wired record_decision/validation/completion",
  });

  // 4. The host view-store projection (the third-party UI contract) converges
  // on the same records and work-graph facts.
  const state = reduceRuntimeEvents(events);
  expect(state.decisions.map((record) => record.id)).toEqual(
    decisions.items.map((record) => record.id),
  );
  expect(state.evidence.map((record) => record.taskID)).toEqual(
    evidence.items.map((record) => record.taskID),
  );
  expect(state.completions.map((record) => record.taskID)).toEqual(
    completions.items.map((record) => record.taskID),
  );
  const nodes = Object.values(state.workGraphNodes);
  expect(nodes.some((node) => node.kind === "decision")).toBe(true);
  expect(nodes.some((node) => node.kind === "validation")).toBe(true);
  expect(
    Object.values(state.workGraphEdges).some(
      (edge) => edge.kind === "validated_by",
    ),
  ).toBe(true);
  expect(
    projectedWorkGraphNodes(events).some((node) => node.kind === "decision"),
  ).toBe(true);
  expect(
    projectedWorkGraphEdges(events).some(
      (edge) => edge.kind === "validated_by",
    ),
  ).toBe(true);
  await client.dispose?.();
}, 30_000);

test("Phase -1 E2E: Navi plan_propose lands a user accepted WorkContract read by projection and view-store", async () => {
  const root = await officialPluginWorkspace("governance-e2e-contract");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e2e_contract" as SessionID,
    permissionMode: "ask",
    provider: createScriptedProvider({
      navi: [
        {
          tool: (context) => ({
            name: "plan_propose",
            arguments: {
              planID,
              scope: ["packages/framework/client/src/runtime"],
              verification: ["bun test packages/framework/client"],
              constraints: ["no new runtime dependency"],
            },
          }),
        },
        { text: "contract proposed" },
      ],
      main: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!("ses_e2e_contract" as SessionID);
  await client.planDocWrite!({
    path: "plans/e2e-contract.md",
    content: "# E2E contract\n\n- one concrete step\n",
    title: "E2E contract",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-contract.md",
    title: "E2E contract",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.naviChat!.submit({ text: "propose the contract" });
  await waitFor(
    () => events.some((event) => event.type === "work_contract.accepted"),
    { timeoutMs: 10_000 },
  );

  expect(
    events.filter((event) => event.type === "work_contract.drafted"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "work_contract.accepted"),
  ).toHaveLength(1);
  const contracts = projectedWorkContracts(events);
  expect(contracts).toHaveLength(1);
  expect(contracts[0]).toMatchObject({
    planID,
    status: "current",
    acceptedBy: "user",
    scope: ["packages/framework/client/src/runtime"],
    verification: ["bun test packages/framework/client"],
    constraints: ["no new runtime dependency"],
  });
  const state = reduceRuntimeEvents(events);
  expect(state.workContracts[planID]).toMatchObject({
    status: "current",
    acceptedBy: "user",
    scope: ["packages/framework/client/src/runtime"],
  });
  await client.dispose?.();
}, 30_000);

test("Phase 0 E2E: Nia audit_report writes evidence visible to projection and runtime reads", async () => {
  const root = await officialPluginWorkspace("governance-e2e-audit");
  // EI E2: the audit evidence must carry the same repository refs as every
  // other evidence writer. A seed commit gives the workspace a HEAD to stamp.
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  await writeFile(join(root, "refs-seed.txt"), "seed");
  git(["add", "refs-seed.txt"]);
  const committed = git(["commit", "-q", "-m", "seed"]).success;
  const gitHead = committed
    ? git(["rev-parse", "HEAD"]).stdout.toString().trim()
    : undefined;
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_e2e_audit" as SessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      nia: [
        {
          tool: (context) => ({
            name: "audit_report",
            arguments: { planID, verdict: "passed" },
          }),
        },
        { text: "audit submitted" },
      ],
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_e2e_audit" as SessionID);
  await client.planDocWrite!({
    path: "plans/e2e-audit.md",
    content: "# E2E audit\n",
    title: "E2E audit",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-audit.md",
    title: "E2E audit",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.niaChat!.submit({ text: "audit the plan" });
  await waitFor(
    () => events.some((event) => event.type === "evidence.recorded"),
    { timeoutMs: 10_000 },
  );

  const projected = projectedEvidenceRecords(events);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({
    taskID: planID,
    status: "validated",
  });
  // EI E2: the audit evidence stamps the repository refs of the tree it audited.
  if (gitHead !== undefined) {
    expect(projected[0]).toMatchObject({ commit: gitHead });
  }
  const evidence = await client.evidenceRecords!({
    sessionID: "ses_e2e_audit",
  });
  expect(evidence.items).toHaveLength(1);
  expect(evidence.items[0]).toMatchObject({
    taskID: planID,
    status: "validated",
  });
  if (gitHead !== undefined) {
    expect(evidence.items[0]).toMatchObject({ commit: gitHead });
  }
  const state = reduceRuntimeEvents(events);
  expect(state.evidence).toHaveLength(1);
  expect(state.evidence[0]).toMatchObject({ taskID: planID });
  await client.dispose?.();
}, 30_000);

test("decisions are session-scoped unless explicitly promoted to workspace scope", async () => {
  const root = await officialPluginWorkspace("governance-e2e-decision-scope");
  const pluginStoreRoot = join(root, "plugin-store");
  const first = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot,
    sessionID: "ses_scope_a" as SessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "ready a" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  first.start(() => undefined);
  await first.sessionAttach!("ses_scope_a" as SessionID);
  await first.recordDecision!({ decision: "session A private choice" });
  const firstSession = await first.decisionRecords!({ scope: "session" });
  expect(firstSession.items).toContainEqual(
    expect.objectContaining({
      decision: "session A private choice",
      scope: "session",
    }),
  );

  const second = createRealRuntimeClient({
    workspaceRoot: root,
    pluginStoreRoot,
    sessionID: "ses_scope_b" as SessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "ready b" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  second.start(() => undefined);
  await second.sessionAttach!("ses_scope_b" as SessionID);
  // A default session read must not leak session A's decision.
  const secondSession = await second.decisionRecords!({ scope: "session" });
  expect(secondSession.items).not.toContainEqual(
    expect.objectContaining({ decision: "session A private choice" }),
  );

  // Only an explicit workspace promotion crosses the session boundary.
  await first.recordDecision!({
    decision: "workspace shared choice",
    scope: "workspace",
  });
  const shared = await second.decisionRecords!({ scope: "workspace" });
  expect(shared.items).toContainEqual(
    expect.objectContaining({
      decision: "workspace shared choice",
      scope: "workspace",
    }),
  );
  // The explicit workspace record does not silently appear in the session
  // default view either.
  const secondSessionAfter = await second.decisionRecords!({
    scope: "session",
  });
  expect(secondSessionAfter.items).not.toContainEqual(
    expect.objectContaining({ decision: "workspace shared choice" }),
  );
  await first.dispose?.();
  await second.dispose?.();
}, 30_000);

test("Phase -1 E2E: constitution doc rules are read and promoted into journal rules", async () => {
  const root = await officialPluginWorkspace("governance-e2e-constitution");
  const sessionID = "ses_e2e_constitution" as SessionID;
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "constitution.md"),
    [
      "# Project constitution",
      "",
      "## Never force-push",
      "",
      "Force-pushing rewrites shared history.",
      "",
      "<!-- enforcement: deny -->",
      '<!-- appliesTo: { commandPattern: "git push --force" } -->',
      "",
      "## Small pull requests",
      "",
      "Prefer small, reviewable pull requests.",
      "",
      "## Block rm -rf",
      "",
      "<!-- enforcement: deny -->",
    ].join("\n"),
    "utf8",
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  // 1. The read surface parses the document into enforcement-tagged rules.
  const docRules = await client.constitutionDocRules!(sessionID);
  const forcePush = docRules.find(
    (rule) => rule.section === "Never force-push",
  );
  expect(forcePush).toMatchObject({
    enforcement: "deny",
    annotated: true,
    appliesTo: { commandPattern: "git push --force" },
  });
  const smallPRs = docRules.find(
    (rule) => rule.section === "Small pull requests",
  );
  expect(smallPRs).toMatchObject({ enforcement: "warn", annotated: false });
  const blockRm = docRules.find((rule) => rule.section === "Block rm -rf");
  expect(blockRm).toMatchObject({ enforcement: "deny", annotated: true });
  expect(blockRm!.appliesTo).toBeUndefined();

  // 2. A deny rule without an appliesTo anchor is refused (unenforceable hard rule).
  const refused = await client.promoteConstitutionDocRule!(
    { id: blockRm!.id },
    sessionID,
  );
  expect(refused.promoted).toBe(false);
  expect(refused.reason).toContain("appliesTo");

  // 3. A deny rule with an anchor promotes into a journal rule (source user).
  const promoted = await client.promoteConstitutionDocRule!(
    { id: forcePush!.id },
    sessionID,
  );
  expect(promoted.promoted).toBe(true);
  expect(promoted.ruleID).toStartWith("P-DOC-");

  // 4. The promoted rule is now a journal constitution rule the runtime reads.
  // (Publishing the rule_added event is synchronous on the session event sink,
  // so the read surface sees it immediately.)
  const rules = await client.constitutionRules!(sessionID);
  const promotedRule = rules.find((rule) => rule.ruleID === promoted.ruleID);
  expect(promotedRule).toMatchObject({
    source: "user",
    enforcement: "deny",
    scope: "project",
    appliesTo: { commandPattern: "git push --force" },
  });

  // 5. The soft -> hard promote of a prose (warn) rule also lands as a journal
  // rule — warn needs no appliesTo anchor.
  const promotedWarn = await client.promoteConstitutionDocRule!(
    { id: smallPRs!.id },
    sessionID,
  );
  expect(promotedWarn.promoted).toBe(true);
  const rulesAfterWarn = await client.constitutionRules!(sessionID);
  const promotedWarnRule = rulesAfterWarn.find(
    (rule) => rule.ruleID === promotedWarn.ruleID,
  );
  expect(promotedWarnRule).toMatchObject({
    source: "user",
    enforcement: "warn",
    scope: "project",
  });
  expect(promotedWarnRule!.appliesTo).toBeUndefined();
  await client.dispose?.();
}, 30_000);

test("Phase -1 E2E: a user can add, edit, disable and delete a constitution rule", async () => {
  const root = await officialPluginWorkspace(
    "governance-e2e-constitution-crud",
  );
  const sessionID = "ses_e2e_constitution_crud" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  // 1. Add a user rule (a deny rule needs an appliesTo anchor).
  const created = await client.createConstitutionRule!(
    {
      statement: "never force-push to shared branches",
      enforcement: "deny",
      appliesTo: { commandPattern: "git push --force" },
    },
    sessionID,
  );
  expect(created.created).toBe(true);
  expect(created.ruleID).toStartWith("P-USER-");
  const ruleID = created.ruleID!;
  let rules = await client.constitutionRules!(sessionID);
  expect(rules.find((rule) => rule.ruleID === ruleID)).toMatchObject({
    statement: "never force-push to shared branches",
    enforcement: "deny",
    source: "user",
    scope: "project",
    appliesTo: { commandPattern: "git push --force" },
  });

  // 2. An anchor-less deny rule is refused.
  const refused = await client.createConstitutionRule!(
    { statement: "no rm", enforcement: "deny" },
    sessionID,
  );
  expect(refused.created).toBe(false);
  expect(refused.reason).toContain("appliesTo");

  // 3. Edit (tighten/enforce): change the statement + enforcement.
  const edited = await client.updateConstitutionRule!(
    {
      ruleID,
      statement: "never force-push, anywhere",
      enforcement: "approval",
      appliesTo: { commandPattern: "git push --force" },
    },
    sessionID,
  );
  expect(edited.updated).toBe(true);
  rules = await client.constitutionRules!(sessionID);
  expect(rules.find((rule) => rule.ruleID === ruleID)).toMatchObject({
    statement: "never force-push, anywhere",
    enforcement: "approval",
  });

  // 4. Disable -> filtered from the effective set.
  await client.updateConstitutionRule!({ ruleID, enabled: false }, sessionID);
  rules = await client.constitutionRules!(sessionID);
  expect(rules.some((rule) => rule.ruleID === ruleID)).toBe(false);

  // 5. Delete -> tombstone.
  const removed = await client.removeConstitutionRule!({ ruleID }, sessionID);
  expect(removed.removed).toBe(true);
  await client.dispose?.();
}, 30_000);

test("Phase -1 E2E: a user edits a soft constitution doc rule and it is written back (EI §3.8 P-1.c)", async () => {
  const root = await officialPluginWorkspace(
    "governance-e2e-constitution-docedit",
  );
  const sessionID = "ses_e2e_constitution_docedit" as SessionID;
  const constitutionPath = join(root, ".natalia", "constitution.md");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    constitutionPath,
    [
      "# Project constitution",
      "",
      "## Never force-push",
      "",
      "Force-pushing rewrites shared history.",
      "",
      "<!-- enforcement: deny -->",
      '<!-- appliesTo: { commandPattern: "git push --force" } -->',
      "",
      "## Small pull requests",
      "",
      "Prefer small, reviewable pull requests.",
    ].join("\n"),
    "utf8",
  );
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  const before = await client.constitutionDocRules!(sessionID);
  const smallPRs = before.find(
    (rule) => rule.section === "Small pull requests",
  )!;
  const forcePush = before.find((rule) => rule.section === "Never force-push")!;
  expect(smallPRs.enforcement).toBe("warn");

  // 1. Edit a prose rule's statement — the document is rewritten in place.
  const edited = await client.updateConstitutionDocRule!(
    {
      id: smallPRs.id,
      statement: "Prefer small, single-purpose pull requests under 400 lines.",
    },
    sessionID,
  );
  expect(edited.updated).toBe(true);
  const onDisk = await readFile(constitutionPath, "utf8");
  expect(onDisk).toContain("under 400 lines");
  // The other section is untouched.
  expect(onDisk).toContain("Force-pushing rewrites shared history.");
  const afterStatement = await client.constitutionDocRules!(sessionID);
  expect(
    afterStatement.find((rule) => rule.section === "Small pull requests")!
      .statement,
  ).toBe("Prefer small, single-purpose pull requests under 400 lines.");

  // 2. Annotate the prose rule into a hard approval rule with an anchor — the
  // HTML-comment annotations are synced into the document.
  const annotated = await client.updateConstitutionDocRule!(
    {
      id: smallPRs.id,
      enforcement: "approval",
      appliesTo: { tools: ["shell"] },
    },
    sessionID,
  );
  expect(annotated.updated).toBe(true);
  const annotatedDisk = await readFile(constitutionPath, "utf8");
  expect(annotatedDisk).toContain("<!-- enforcement: approval -->");
  expect(annotatedDisk).toContain('tools: ["shell"]');
  const afterAnnotate = await client.constitutionDocRules!(sessionID);
  expect(
    afterAnnotate.find((rule) => rule.section === "Small pull requests"),
  ).toMatchObject({
    enforcement: "approval",
    annotated: true,
    appliesTo: { tools: ["shell"] },
  });

  // 3. A deny edit that clears the appliesTo anchor is refused (unenforceable
  // hard rule) and writes nothing.
  const beforeRefusal = await readFile(constitutionPath, "utf8");
  const refused = await client.updateConstitutionDocRule!(
    { id: smallPRs.id, statement: "x", enforcement: "deny", appliesTo: {} },
    sessionID,
  );
  expect(refused.updated).toBe(false);
  expect(refused.reason).toContain("appliesTo");
  expect(await readFile(constitutionPath, "utf8")).toBe(beforeRefusal);

  // 4. An unknown rule id is reported, not thrown.
  const unknown = await client.updateConstitutionDocRule!(
    { id: "constitution:nope:9", statement: "x" },
    sessionID,
  );
  expect(unknown.updated).toBe(false);

  // The hard deny rule edited earlier stays intact (its id is stable).
  const finalRules = await client.constitutionDocRules!(sessionID);
  expect(
    finalRules.find((rule) => rule.section === "Never force-push"),
  ).toMatchObject({
    enforcement: "deny",
    appliesTo: { commandPattern: "git push --force" },
  });

  await client.dispose?.();
}, 30_000);

test("Phase -1 E2E: hard-protected rules refuse edits, other release rules stay user-editable", async () => {
  const root = await officialPluginWorkspace(
    "governance-e2e-constitution-protection",
  );
  const sessionID = "ses_e2e_constitution_protection" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);

  // The five seeded self-protection rules are present.
  const seeded = await client.constitutionRules!(sessionID);
  expect(seeded.find((rule) => rule.ruleID === "C-TERM-001")).toMatchObject({
    scope: "release",
    enforcement: "deny",
  });
  expect(seeded.find((rule) => rule.ruleID === "C-REL-001")).toMatchObject({
    scope: "release",
    enforcement: "approval",
  });

  // Hard-coded runtime protection (C-TERM-*): the guarantee survives a journal
  // edit, so the runtime refuses both editing and deleting the rule.
  const termEdit = await client.updateConstitutionRule!(
    { ruleID: "C-TERM-001", statement: "loosen it" },
    sessionID,
  );
  expect(termEdit.updated).toBe(false);
  const termRemove = await client.removeConstitutionRule!(
    { ruleID: "C-TERM-002" },
    sessionID,
  );
  expect(termRemove.removed).toBe(false);

  // Other release-scope rules are runtime policy, not hard-coded: the user can
  // edit and delete them (per the decision 硬保护不能删，其余用户可删改).
  const relEdit = await client.updateConstitutionRule!(
    { ruleID: "C-REL-001", statement: "git writes need approval (edited)" },
    sessionID,
  );
  expect(relEdit.updated).toBe(true);
  let rules = await client.constitutionRules!(sessionID);
  expect(rules.find((rule) => rule.ruleID === "C-REL-001")).toMatchObject({
    statement: "git writes need approval (edited)",
  });
  const relRemove = await client.removeConstitutionRule!(
    { ruleID: "C-REL-002" },
    sessionID,
  );
  expect(relRemove.removed).toBe(true);
  rules = await client.constitutionRules!(sessionID);
  expect(rules.some((rule) => rule.ruleID === "C-REL-002")).toBe(false);
  await client.dispose?.();
}, 30_000);

test("Phase -1 E2E: a scoped override round-trips request -> approval -> grant -> read", async () => {
  const root = await officialPluginWorkspace("governance-e2e-override");
  const sessionID = "ses_e2e_override" as SessionID;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    // The interactive mode: the grant is the user's approval, answered
    // from the event sink exactly the way the UI answers it.
    permissionMode: "ask",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(sessionID);

  const created = await client.createConstitutionRule!(
    {
      statement: "default project changes must happen in a sandbox",
      enforcement: "warn",
    },
    sessionID,
  );
  expect(created.created).toBe(true);
  const ruleID = created.ruleID!;
  // The rule's own policy must permit the request in the first place.
  const rules = await client.constitutionRules!(sessionID);
  expect(rules.find((rule) => rule.ruleID === ruleID)?.overridePolicy).not.toBe(
    "forbidden",
  );

  const requested = await client.requestOverride!(
    {
      ruleID,
      reason: "one-off host write for the parser fix",
      paths: ["src/parser.ts"],
    },
    sessionID,
  );
  expect(requested.requested).toBe(true);

  // The read face answers the grant — with the scope it was granted for.
  const overrides = await client.constitutionOverrides!(sessionID);
  expect(overrides).toHaveLength(1);
  expect(overrides[0]).toMatchObject({
    ruleID,
    reason: "one-off host write for the parser fix",
    approvedBy: "user",
    paths: ["src/parser.ts"],
  });
  // The grant is a durable journal fact (the audit trail), not UI state.
  expect(
    events.some((event) => event.type === "constitution.override_granted"),
  ).toBe(true);

  // A forbidden rule is refused before any grant exists — the plan's
  // "critical/forbidden 不可 override", enforced at the request.
  const refused = await client.requestOverride!(
    { ruleID: "C-TERM-001", reason: "please" },
    sessionID,
  );
  expect(refused.requested).toBe(false);
  expect(refused.reason).toBe("override forbidden");

  await client.dispose?.();
}, 30_000);
