import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { projectedWorkContracts } from "@anthelia/session";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();
import { createScriptedProvider, waitFor } from "./e2e-harness";

const SESSION = "ses_e2e_detour" as SessionID;

test("Phase 2 E2E: an approved detour absorbs its deltas into a new accepted contract (v+1)", async () => {
  const root = await officialPluginWorkspace("detour-e2e-approve");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "ask",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "plan_propose",
            arguments: {
              planID,
              scope: ["packages/a"],
              verification: ["bun test packages/a"],
            },
          }),
        },
        {
          tool: () => ({
            name: "detour_declare",
            arguments: {
              planID,
              currentVersion: 1,
              reason: "the fix also needs the shared util package",
              scopeDelta: ["packages/b"],
            },
          }),
        },
        { text: "detour declared" },
      ],
      navi: [{ text: "s" }],
      nia: [{ text: "s" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      (event.scope === "work_contract" || event.scope === "detour")
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/e2e-detour.md",
    content: "# E2E detour\n\n- one concrete step\n",
    title: "E2E detour",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-detour.md",
    title: "E2E detour",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose the contract then declare a detour");

  const requested = events.find(
    (event): event is Extract<RuntimeEvent, { type: "detour.requested" }> =>
      event.type === "detour.requested",
  )!;
  expect(requested).toMatchObject({
    planID,
    currentVersion: 1,
    reason: "the fix also needs the shared util package",
    scopeDelta: ["packages/b"],
    requestedBy: "model",
  });

  const accepted = projectedWorkContracts(events).find(
    (contract) => contract.planID === planID,
  )!;
  expect(accepted).toMatchObject({
    status: "current",
    version: 2,
    scope: ["packages/a", "packages/b"],
    verification: ["bun test packages/a"],
  });
  // EI Open Question "Nia 绕路 gate 留痕提示": the gate card tells the user, at
  // the decision point, that Nia's review is asynchronous and a no-opinion
  // approval is recorded as unavailable.
  const detourGate = events.find(
    (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
      event.type === "approval.request" && event.scope === "detour",
  );
  expect(detourGate).toBeDefined();
  expect(detourGate!.preview).toContain("无看法批准");
  // Nia was woken to review but did not weigh in before the user decided, so
  // her opinion is recorded as unavailable (the gate proceeded without it).
  const niaReview = events.find(
    (event): event is Extract<RuntimeEvent, { type: "detour.reviewed" }> =>
      event.type === "detour.reviewed",
  );
  expect(niaReview).toMatchObject({
    detourID: requested.detourID,
    verdict: "unavailable",
    reviewedBy: "nia",
  });
  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: a stale detour and an overlapping scopeDelta are rejected before the gate", async () => {
  const root = await officialPluginWorkspace("detour-e2e-reject");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "ask",
    provider: createScriptedProvider({
      main: [
        {
          // Establish v1 with scope packages/a.
          tool: () => ({
            name: "plan_propose",
            arguments: {
              planID,
              scope: ["packages/a"],
              verification: ["bun test packages/a"],
            },
          }),
        },
        {
          // Stale currentVersion (contract is v1, declare against v9).
          tool: () => ({
            name: "detour_declare",
            arguments: {
              planID,
              currentVersion: 9,
              reason: "stale lock",
              scopeDelta: ["packages/b"],
            },
          }),
        },
        {
          // Overlapping scopeDelta (packages/a is already committed).
          tool: () => ({
            name: "detour_declare",
            arguments: {
              planID,
              currentVersion: 1,
              reason: "overlap",
              scopeDelta: ["packages/a"],
            },
          }),
        },
        { text: "done" },
      ],
      navi: [{ text: "s" }],
      nia: [{ text: "s" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request" && event.scope === "work_contract")
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/e2e-detour.md",
    content: "# E2E detour\n",
    title: "E2E detour",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-detour.md",
    title: "E2E detour",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose then attempt invalid detours");

  // The contract is v1; neither a stale lock nor an overlapping scopeDelta
  // reaches the journal or the gate.
  const accepted = events.filter(
    (event) => event.type === "work_contract.accepted",
  );
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ planVersion: 1 });
  expect(events.some((event) => event.type === "detour.requested")).toBe(false);
  expect(
    events.some(
      (event) => event.type === "approval.request" && event.scope === "detour",
    ),
  ).toBe(false);
  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: Nia reviews a requested detour and records detour.reviewed (reference only)", async () => {
  const root = await officialPluginWorkspace("detour-e2e-nia-review");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "ask",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "plan_propose",
            arguments: {
              planID,
              scope: ["packages/a"],
              verification: ["bun test packages/a"],
            },
          }),
        },
        {
          tool: () => ({
            name: "detour_declare",
            arguments: {
              planID,
              currentVersion: 1,
              reason: "the fix also needs the shared util package",
              scopeDelta: ["packages/b"],
            },
          }),
        },
        { text: "detour declared" },
      ],
      navi: [{ text: "s" }],
      // The detour_declare wake prompts Nia to review the detour; her turn
      // reads the detourID from the injected detour-review message and reviews.
      nia: [
        {
          tool: (context) => {
            const text = context.request.messages
              .map((message) => String(message.content ?? ""))
              .join("\n");
            const match = text.match(/detour ([\w:-]+)\):/u);
            return {
              name: "detour_review",
              arguments: {
                detourID: match?.[1] ?? "",
                verdict: "approve",
                rationale: "the util package is a legitimate dependency",
              },
            };
          },
        },
        { text: "reviewed" },
      ],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (
      event.type === "approval.request" &&
      (event.scope === "work_contract" || event.scope === "detour")
    )
      client.respondApproval({ requestID: event.id, decision: "once" });
  });
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/e2e-detour.md",
    content: "# E2E detour\n",
    title: "E2E detour",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-detour.md",
    title: "E2E detour",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose then declare a detour");

  // The detour_declare wake drives Nia's review turn; wait for her verdict.
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "detour.reviewed" && event.verdict === "approve",
      ),
    { timeoutMs: 10_000 },
  );
  const detourID =
    events.find((event) => event.type === "detour.requested")?.detourID ?? "";
  const review = events.find(
    (event): event is Extract<RuntimeEvent, { type: "detour.reviewed" }> =>
      event.type === "detour.reviewed" &&
      event.detourID === detourID &&
      event.verdict === "approve",
  )!;
  expect(review).toMatchObject({
    planID,
    verdict: "approve",
    reviewedBy: "nia",
    rationale: "the util package is a legitimate dependency",
  });
  await client.dispose?.();
}, 30_000);

test("Phase 2 E2E: a rejected detour leaves the contract at its current version and records Nia unavailable", async () => {
  const root = await officialPluginWorkspace("detour-e2e-reject-gate");
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: SESSION,
    permissionMode: "ask",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "plan_propose",
            arguments: {
              planID,
              scope: ["packages/a"],
              verification: ["bun test packages/a"],
            },
          }),
        },
        {
          tool: () => ({
            name: "detour_declare",
            arguments: {
              planID,
              currentVersion: 1,
              reason: "the fix also needs the shared util package",
              scopeDelta: ["packages/b"],
            },
          }),
        },
        { text: "detour rejected" },
      ],
      navi: [{ text: "s" }],
      nia: [{ text: "s" }],
    }),
  });
  client.start((event) => {
    events.push(event);
    if (event.type === "approval.request") {
      // Accept the contract, but reject the detour gate.
      client.respondApproval({
        requestID: event.id,
        decision: event.scope === "detour" ? "reject" : "once",
        ...(event.scope === "detour" ? { feedback: "stay in scope" } : {}),
      });
    }
  });
  await client.sessionAttach!(SESSION);
  await client.planDocWrite!({
    path: "plans/e2e-detour.md",
    content: "# E2E detour\n",
    title: "E2E detour",
  });
  const marked = await client.planDocMark!({
    path: "plans/e2e-detour.md",
    title: "E2E detour",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("propose then declare a detour to reject");

  // The contract stays at v1 — a rejected detour does not absorb its deltas.
  const accepted = events.filter(
    (event) => event.type === "work_contract.accepted",
  );
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ planVersion: 1 });
  const contract = projectedWorkContracts(events).find(
    (c) => c.planID === planID,
  )!;
  expect(contract).toMatchObject({
    status: "current",
    version: 1,
    scope: ["packages/a"],
  });
  // The detour was requested; Nia did not weigh in before the user rejected,
  // so her opinion is recorded as unavailable.
  expect(events.some((event) => event.type === "detour.requested")).toBe(true);
  const review = events.find(
    (event): event is Extract<RuntimeEvent, { type: "detour.reviewed" }> =>
      event.type === "detour.reviewed",
  );
  expect(review).toMatchObject({ verdict: "unavailable", reviewedBy: "nia" });
  await client.dispose?.();
}, 30_000);
