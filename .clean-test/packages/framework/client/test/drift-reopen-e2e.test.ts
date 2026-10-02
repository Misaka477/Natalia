import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider, waitFor } from "./e2e-harness";

const SESSION = "ses_e2e_drift_reopen" as SessionID;

async function attachClient(root: string) {
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);
  return client;
}

test("Phase 2 E2E: a dismissed drift finding can be reopened by the user and counts reopens", async () => {
  const root = await officialPluginWorkspace("drift-e2e-reopen");
  const client = await attachClient(root);

  // Open an advisory finding: no accepted contract + a change, so the
  // unverifiable_no_contract advisory fires.
  const opened = await client.evaluateDrift!(
    {
      objective: "refactor the parser tokenizer",
      currentActivity: "writing cooking recipes documentation",
      changes: [{ path: "docs/recipes.md", action: "modified" }],
    },
    SESSION,
  );
  expect(opened.opened).toBeGreaterThan(0);
  // evaluateDrift publishes the finding synchronously, so it is readable at once.
  const before = await client.driftFindings!({ sessionID: SESSION });
  const finding = before.items.find((f) => f.status === "open")!;
  expect(finding.reopenedCount).toBe(0);

  // Dismiss it, then reopen it (user-only 翻案).
  const dismissed = await client.acknowledgeDriftFinding!(
    { findingID: finding.findingID, status: "dismissed" },
    SESSION,
  );
  expect(dismissed.acknowledged).toBe(true);

  const reopened = await client.reopenDriftFinding!(
    { findingID: finding.findingID },
    SESSION,
  );
  expect(reopened.reopened).toBe(true);

  const afterReopen = await client.driftFindings!({ sessionID: SESSION });
  const reopenedFinding = afterReopen.items.find(
    (f) => f.findingID === finding.findingID,
  )!;
  expect(reopenedFinding.status).toBe("open");
  expect(reopenedFinding.reopenedCount).toBe(1);

  // A second reopen is refused: only a dismissed/explained finding reopens,
  // and this one is open again.
  const secondReopen = await client.reopenDriftFinding!(
    { findingID: finding.findingID },
    SESSION,
  );
  expect(secondReopen.reopened).toBe(false);
  expect(secondReopen.reason).toContain("open");

  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: a corrected drift finding cannot be reopened (its premise is gone)", async () => {
  const root = await officialPluginWorkspace("drift-e2e-reopen-corrected");
  const client = await attachClient(root);

  await client.evaluateDrift!(
    {
      objective: "refactor the parser tokenizer",
      currentActivity: "writing cooking recipes documentation",
      changes: [{ path: "docs/recipes.md", action: "modified" }],
    },
    SESSION,
  );
  const finding = (
    await client.driftFindings!({ sessionID: SESSION })
  ).items.find((f) => f.status === "open")!;

  // Corrected means the contract was revised to absorb the finding; reopening
  // it is meaningless, so the reopen is refused.
  await client.acknowledgeDriftFinding!(
    { findingID: finding.findingID, status: "corrected" },
    SESSION,
  );
  const reopened = await client.reopenDriftFinding!(
    { findingID: finding.findingID },
    SESSION,
  );
  expect(reopened.reopened).toBe(false);
  expect(reopened.reason).toContain("corrected");

  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: a warning/high finding is auto-injected into the main agent's next step; advisory is not", async () => {
  const root = await officialPluginWorkspace("drift-e2e-inject");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(SESSION);

  // A high finding: the applicable constraint forbids "delete" and the current
  // activity does it — constraint_violation_signal fires at high severity.
  const high = await client.evaluateDrift!(
    {
      objective: "clean up the workspace",
      currentActivity: "delete the old build artifacts",
      applicableConstraints: ["never delete files without approval"],
    },
    SESSION,
  );
  expect(high.opened).toBeGreaterThan(0);
  // Events flow through the async sink, so poll for the finding + injection.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "drift.finding_opened" && event.severity === "high",
      ) &&
      events.some(
        (event) =>
          event.type === "input.admitted" &&
          event.internal === true &&
          event.delivery === "next-step",
      ),
    { timeoutMs: 10_000 },
  );
  const highFinding = events.find(
    (event): event is Extract<RuntimeEvent, { type: "drift.finding_opened" }> =>
      event.type === "drift.finding_opened" && event.severity === "high",
  );
  expect(highFinding).toBeDefined();

  // The finding is auto-injected as an internal next-step input carrying the
  // findingID + rule summary (no chain-of-thought).
  const injected = events.find(
    (event): event is Extract<RuntimeEvent, { type: "input.admitted" }> =>
      event.type === "input.admitted" &&
      event.internal === true &&
      event.delivery === "next-step" &&
      event.text.includes(highFinding!.findingID),
  );
  expect(injected).toBeDefined();
  expect(injected!.text).toContain("drift_acknowledge");

  // An advisory finding (no accepted contract + a change -> unverifiable) is
  // NOT auto-injected — it is noise-level.
  const beforeAdvisory = events.filter(
    (event) => event.type === "input.admitted",
  ).length;
  await client.evaluateDrift!(
    {
      objective: "refactor the parser tokenizer",
      currentActivity: "writing cooking recipes documentation",
      changes: [{ path: "docs/recipes.md", action: "modified" }],
    },
    SESSION,
  );
  const advisoryFinding = events.find(
    (event): event is Extract<RuntimeEvent, { type: "drift.finding_opened" }> =>
      event.type === "drift.finding_opened" && event.severity === "advisory",
  );
  expect(advisoryFinding).toBeDefined();
  const afterAdvisory = events.filter(
    (event) => event.type === "input.admitted",
  ).length;
  // No new input.admitted for the advisory finding.
  expect(afterAdvisory).toBe(beforeAdvisory);
  expect(
    events.some(
      (event) =>
        event.type === "input.admitted" &&
        event.text.includes(advisoryFinding!.findingID),
    ),
  ).toBe(false);

  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: reopening a warning/high finding re-injects it for re-review (EI §3.5)", async () => {
  const root = await officialPluginWorkspace("drift-e2e-reopen-reinject");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(SESSION);

  // A high finding: the applicable constraint forbids "delete" and the current
  // activity does it — constraint_violation_signal fires at high severity, and
  // B3 auto-injects it into the main agent's next step.
  await client.evaluateDrift!(
    {
      objective: "clean up the workspace",
      currentActivity: "delete the old build artifacts",
      applicableConstraints: ["never delete files without approval"],
    },
    SESSION,
  );
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "drift.finding_opened" && event.severity === "high",
      ),
    { timeoutMs: 10_000 },
  );
  const finding = (
    await client.driftFindings!({ sessionID: SESSION })
  ).items.find((f) => f.severity === "high")!;
  const injectionsForFinding = () =>
    events.filter(
      (event): event is Extract<RuntimeEvent, { type: "input.admitted" }> =>
        event.type === "input.admitted" &&
        event.internal === true &&
        event.text.includes(finding.findingID),
    );
  // The original finding_opened already injected once.
  expect(injectionsForFinding().length).toBeGreaterThanOrEqual(1);

  // Dismiss, then reopen — the reopen re-injects for re-review.
  await client.acknowledgeDriftFinding!(
    { findingID: finding.findingID, status: "dismissed" },
    SESSION,
  );
  const reopened = await client.reopenDriftFinding!(
    { findingID: finding.findingID },
    SESSION,
  );
  expect(reopened.reopened).toBe(true);
  expect(reopened.reopenedCount).toBe(1);

  await waitFor(() => injectionsForFinding().length >= 2, {
    timeoutMs: 10_000,
  });
  const reinjection = injectionsForFinding().at(-1)!;
  // The re-review note tells the agent not to repeat its last rationale, and
  // the admission id is distinct from the original injection's.
  expect(reinjection.text).toContain("reopen #1");
  expect(reinjection.text).toContain("do not repeat the rationale");
  expect(reinjection.id).not.toBe(`turn_drift_${finding.findingID}`);

  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: a warning/high finding reaches the main agent's next provider request; advisory does not", async () => {
  const root = await officialPluginWorkspace("drift-e2e-b3-nextrequest");
  const requests: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: ProviderStreamRequest) {
        const messages = (
          request as { messages: Array<{ role: string; content: string }> }
        ).messages;
        requests.push(
          messages.map((message) => String(message.content ?? "")).join("\n"),
        );
        yield { type: "content" as const, text: "acknowledged" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(SESSION);

  // evaluateDrift opens a high finding and injects it as a next-step input.
  await client.evaluateDrift!(
    {
      objective: "clean up the workspace",
      currentActivity: "delete the old build artifacts",
      applicableConstraints: ["never delete files without approval"],
    },
    SESSION,
  );

  // The next turn's first provider request must carry the injected finding.
  await client.submitAndWait!("respond to the drift finding");
  expect(requests.length).toBeGreaterThanOrEqual(1);
  const firstRequest = requests[0]!;
  expect(firstRequest).toContain("internal drift finding");
  expect(firstRequest).toContain("constraint_violation_signal");
  expect(firstRequest).toContain("drift_acknowledge");
  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: the main agent's drift_acknowledge moves an open finding to explained (B3 close)", async () => {
  const root = await officialPluginWorkspace("drift-e2e-acknowledge");
  const events: RuntimeEvent[] = [];
  // The findingID is minted by the evaluator, so it is captured after
  // evaluateDrift and closed over by the scripted tool call below.
  let openFindingID: string | undefined;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          // The Main Agent answers the injected finding by acknowledging it as
          // explained with a rationale — the model's side of the B3 loop, the
          // step no E2E had proven before (the tool was registered and the
          // injection told the model to call it, but nothing exercised the
          // call -> status transition end to end).
          tool: () => ({
            name: "drift_acknowledge",
            arguments: {
              findingID: openFindingID!,
              status: "explained",
              rationale: "the deletions were within the approved cleanup scope",
            },
          }),
        },
        { text: "acknowledged the drift finding" },
      ],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(SESSION);

  // A high finding (constraint_violation_signal) opens and is auto-injected.
  const high = await client.evaluateDrift!(
    {
      objective: "clean up the workspace",
      currentActivity: "delete the old build artifacts",
      applicableConstraints: ["never delete files without approval"],
    },
    SESSION,
  );
  expect(high.opened).toBeGreaterThan(0);
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "drift.finding_opened" && event.severity === "high",
      ),
    { timeoutMs: 10_000 },
  );
  const highFinding = events.find(
    (event): event is Extract<RuntimeEvent, { type: "drift.finding_opened" }> =>
      event.type === "drift.finding_opened" && event.severity === "high",
  );
  expect(highFinding).toBeDefined();
  openFindingID = highFinding!.findingID;

  // The next turn delivers the injected finding; the scripted Main Agent calls
  // drift_acknowledge(explained) in response — closing the B3 loop.
  await client.submitAndWait!("respond to the drift finding");

  // The acknowledgement is recorded as a drift.finding_updated(explained): the
  // tool executed and transitioned the finding, not just returned text.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "drift.finding_updated" &&
          event.findingID === highFinding!.findingID &&
          event.status === "explained",
      ),
    { timeoutMs: 10_000 },
  );

  // And the read surface the panel consumes agrees the finding is no longer open.
  const findings = (await client.driftFindings!({ sessionID: SESSION }))
    .items as Array<{
    findingID: string;
    status: string;
  }>;
  const updated = findings.find((f) => f.findingID === highFinding!.findingID);
  expect(updated?.status).toBe("explained");

  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: evaluateDrift opens a no-progress finding from recentActions", async () => {
  const root = await officialPluginWorkspace("drift-e2e-no-progress-rpc");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(SESSION);

  // Eight tool_call actions with no progress marker -> the L4 no-progress rule.
  const result = await client.evaluateDrift!(
    {
      objective: "ship the feature",
      currentActivity: "reading files",
      recentActions: Array.from({ length: 8 }, () => ({
        kind: "tool_call" as const,
      })),
    },
    SESSION,
  );
  expect(result.opened).toBeGreaterThan(0);
  const finding = events.find(
    (event): event is Extract<RuntimeEvent, { type: "drift.finding_opened" }> =>
      event.type === "drift.finding_opened" &&
      (event.ruleHits ?? []).some((hit) => hit.rule === "no_progress"),
  );
  expect(finding).toBeDefined();
  expect(finding!.severity).toBe("advisory");
  expect(finding!.findingID).toBe("drift:no_progress:session:" + SESSION);
  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: evaluateDrift opens a failure-loop finding from recentFailures", async () => {
  const root = await officialPluginWorkspace("drift-e2e-failure-loop");
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [{ text: "standby" }],
      navi: [{ text: "standby" }],
      nia: [{ text: "standby" }],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(SESSION);

  // Three identical failed tool calls -> the L4 failure-loop rule (warning).
  const result = await client.evaluateDrift!(
    {
      objective: "fix the build",
      currentActivity: "retrying the same command",
      recentFailures: [
        { toolName: "run_shell", key: "k1" },
        { toolName: "run_shell", key: "k1" },
        { toolName: "run_shell", key: "k1" },
      ],
    },
    SESSION,
  );
  expect(result.opened).toBeGreaterThan(0);
  const finding = events.find(
    (event): event is Extract<RuntimeEvent, { type: "drift.finding_opened" }> =>
      event.type === "drift.finding_opened" &&
      (event.ruleHits ?? []).some((hit) => hit.rule === "failure_loop"),
  );
  expect(finding).toBeDefined();
  expect(finding!.severity).toBe("warning");
  await client.dispose?.();
}, 30_000);
