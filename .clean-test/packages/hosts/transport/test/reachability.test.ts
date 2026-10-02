import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import {
  REQUIRED_RUNTIME_MEMBERS,
  RUNTIME_CAPABILITY_GROUPS,
  describeRuntimeCapabilities,
} from "@anthelia/contracts";
import type { RuntimeClient } from "@anthelia/contracts";
import {
  RPC_INTENTIONALLY_LOCAL,
  RPC_ROUTE_MEMBERS,
  RPC_ROUTED_MEMBERS,
  handleRPCMessage,
} from "../src/rpc";
import { WORKER_ROUTE_MEMBERS } from "@natalia/client";

/**
 * P0-B: reachability is computed from the route table, not from a second list.
 * These tests pin three things:
 *
 *   - the route tables are the dispatch code itself (a scan of this file makes
 *     a table row without a dispatch block, or a block without a row, fail);
 *   - the remote availability report says "implemented but this channel does
 *     not route it" for the members P0-C must add routes for, while the
 *     in-process report is unchanged;
 *   - the implemented-unreachable set is exactly the P0-C work list — a new
 *     member that is implemented but unrouted changes this list and appears in
 *     the report without anyone maintaining a checklist.
 */

/**
 * A runtime implementing every member — the most complete runtime there can
 * be, which is exactly what the in-process report test needs: nothing must be
 * reported missing because the test double was too small.
 */
function completeStubClient(): RuntimeClient {
  const members = [
    ...REQUIRED_RUNTIME_MEMBERS,
    ...Object.values(RUNTIME_CAPABILITY_GROUPS).flat(),
  ];
  const client: Record<string, unknown> = {};
  for (const member of members) client[member] = () => undefined;
  client.start = () => undefined;
  client.cancel = () => undefined;
  client.snapshot = () => ({
    type: "diagnostic",
    level: "info",
    message: "stub",
  });
  client.diagnostic = () => undefined;
  client.lastSubmission = () => undefined;
  client.respondApproval = () => ({ accepted: true });
  client.respondQuestion = () => ({ accepted: true });
  return client as unknown as RuntimeClient;
}

const ROUTE_TABLE_SOURCE = readFileSync(
  new URL("../src/rpc.ts", import.meta.url),
  "utf8",
);

test("the RPC route table is the dispatch code, not a second list", () => {
  // Every method the table names must appear in the dispatch, and every
  // dispatch block must be in the table. A route added to the code without a
  // table row would silently not be reported as reachable; a table row without
  // code would claim reachability for a method that answers `-32601`.
  const dispatchMethods = new Set(
    [
      ...ROUTE_TABLE_SOURCE.matchAll(/(?:body|request)\.method === "([^"]+)"/g),
    ].map((match) => match[1]!),
  );
  // The navi/nia chat surfaces dispatch dynamically: `body.method.startsWith(
  // "navi.chat.")` then a `switch (operation)`. Recognize each operation as
  // navi.chat.<op> / nia.chat.<op> so the dynamic dispatch counts as covering
  // the table rows.
  const chatSwitch = ROUTE_TABLE_SOURCE.match(
    /switch \(operation\) \{([\s\S]*?)\n      \}/u,
  );
  if (chatSwitch)
    for (const op of chatSwitch[1]!.matchAll(/case "([^"]+)":/gu))
      for (const stream of ["navi", "nia"])
        dispatchMethods.add(`${stream}.chat.${op[1]}`);
  for (const method of Object.keys(RPC_ROUTE_MEMBERS))
    expect(
      dispatchMethods,
      `table row without dispatch block: ${method}`,
    ).toContain(method);
  for (const method of dispatchMethods)
    expect(
      Object.keys(RPC_ROUTE_MEMBERS),
      `dispatch block without table row: ${method}`,
    ).toContain(method);

  // Every routed member is a real member of the contract.
  for (const member of Object.values(RPC_ROUTE_MEMBERS)) {
    if (member === null) continue;
    expect(
      [
        ...REQUIRED_RUNTIME_MEMBERS,
        ...Object.values(RUNTIME_CAPABILITY_GROUPS).flat(),
      ],
      `route table names unknown member: ${member}`,
    ).toContain(member);
  }
});

test("the worker route table matches the worker dispatch", () => {
  const workerSource = readFileSync(
    new URL("../../../framework/client/src/worker.ts", import.meta.url),
    "utf8",
  );
  const workerMethods = new Set(
    [...workerSource.matchAll(/request\.method === "([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  );
  for (const method of Object.keys(WORKER_ROUTE_MEMBERS))
    expect(
      workerMethods,
      `worker table row without handler: ${method}`,
    ).toContain(method);
  for (const method of workerMethods)
    expect(
      Object.keys(WORKER_ROUTE_MEMBERS),
      `worker handler without route declaration: ${method}`,
    ).toContain(method);
});

test("the remote report says implemented-but-unrouted for the P0-C work list", async () => {
  // The real runtime implements everything; the RPC channel routes a subset.
  // That is the exact shape of the production fact this report must tell.
  const client = completeStubClient();
  const response = await handleRPCMessage(
    { jsonrpc: "2.0", id: 1, method: "runtime.availability" },
    client,
  );
  const report = response.result as Awaited<
    ReturnType<typeof describeRuntimeCapabilities>
  >;

  // The channel dimension exists and names the RPC channel.
  expect(report.channel?.name).toBe("rpc");

  const byMember = new Map(
    report.channel!.groups.flatMap((group) =>
      group.members.map((member) => [member.member, member.state] as const),
    ),
  );

  // P0-C closed the gap: every member the runtime implements is routed now,
  // including native terminal, the intelligence queries, capabilities,
  // submitInput and sessionSnapshot.
  for (const member of [
    "nativeTerminalList",
    "nativeTerminalRead",
    "nativeTerminalOpenHub",
    "nativeTerminalRevokeApprovalScope",
    "nativeTerminalReleaseHumanControl",
    "nativeTerminalBeginSecureInput",
    "nativeTerminalEndSecureInput",
    "nativeTerminalStop",
    "constitutionRules",
    "constitutionOverrides",
    "decisionRecords",
    "recordDecision",
    "evidenceRecords",
    "recordValidation",
    "completions",
    "recordCompletion",
    "driftFindings",
    "evaluateDrift",
    "acknowledgeDriftFinding",
    "confirmedWorkspaceChanges",
    "registeredTools",
    "projectionContributions",
    "requestOverride",
    "approveOverride",
    "mailboxList",
    "mailboxSend",
    "mailboxDeliver",
    "mailboxAcknowledge",
    "mailboxDefer",
    "mailboxSupersede",
    "planDocList",
    "planDocRead",
    "planDocWrite",
    "planDocMark",
    "planDocDelete",
    "planDocStatus",
    "capabilities",
    "submitInput",
    "sessionSnapshot",
    "settingsGet",
    "settingsSet",
  ])
    expect(
      byMember.get(member),
      `${member} should be implemented and reachable after P0-C`,
    ).toBe("implemented_reachable");

  // The only implemented-but-unreachable members are the whitelist, each with
  // its own reason — the P0-C invariant: no unexplained unreachable members.
  // `start`, `lastSubmission` and `diagnostic` are required members, so they
  // live in `requiredMembers` rather than a capability group.
  const allChannelMembers = [
    ...report.channel!.groups.flatMap((group) => group.members),
    ...report.channel!.requiredMembers,
  ];
  for (const [member, reason] of Object.entries(RPC_INTENTIONALLY_LOCAL)) {
    expect(
      allChannelMembers.find((entry) => entry.member === member)?.state,
      `${member} must stay intentionally local`,
    ).toBe("implemented_unreachable");
    expect(
      allChannelMembers.find((entry) => entry.member === member)!.reason,
    ).toContain("intentionally local");
    expect(reason.length).toBeGreaterThan(0);
  }
  expect(
    allChannelMembers.find((entry) => entry.member === "start")!.state,
  ).toBe("implemented_unreachable");

  // Group conclusions follow: a group is reachable only when every member is.
  const native = report.channel!.groups.find(
    (group) => group.name === "nativeTerminal",
  )!;
  expect(native.reachable).toBe(true);
  const lifecycle = report.channel!.groups.find(
    (group) => group.name === "lifecycle",
  )!;
  expect(lifecycle.reachable).toBe(false);
  expect(lifecycle.partial).toBe(true);
});

test("the in-process report is unchanged by the channel dimension", () => {
  // Asking "what does this runtime implement" must not start claiming
  // unreachable: a runtime with all 15 groups implemented answers 15/15 both
  // with and without the channel parameter.
  const client = completeStubClient();
  const plain = describeRuntimeCapabilities(client);
  expect(plain.channel).toBeUndefined();
  expect(plain.groups.filter((group) => group.available)).toHaveLength(
    Object.keys(RUNTIME_CAPABILITY_GROUPS).length,
  );
  const withChannel = describeRuntimeCapabilities(client, {
    name: "rpc",
    routedMembers: new Set(),
  });
  expect(withChannel.groups.filter((group) => group.available)).toHaveLength(
    Object.keys(RUNTIME_CAPABILITY_GROUPS).length,
  );
});

test("the implemented-unreachable set is exactly the P0-C input, and is reported, not maintained", () => {
  // The audit itself: which members are implemented on the real runtime but
  // have no route? This is the work list P0-C consumes. It is computed here
  // from the two facts (the stub implements everything; the route table says
  // what is routed), so nothing drifts.
  const allMembers = [
    ...REQUIRED_RUNTIME_MEMBERS,
    ...Object.values(RUNTIME_CAPABILITY_GROUPS).flat(),
  ];
  const routed = new Set(
    (Object.values(RPC_ROUTE_MEMBERS) as Array<string | null>).filter(
      (member): member is string => typeof member === "string",
    ),
  );
  const unreachable = (allMembers as string[])
    .filter((member) => !routed.has(member))
    .sort();
  // P0-C: every implemented member has a route except the whitelist. The
  // diff-set is now exactly the whitelist — anything else appearing here is a
  // regression (a member implemented but forgotten) and fails this test.
  expect(unreachable).toEqual(Object.keys(RPC_INTENTIONALLY_LOCAL).sort());
});

test("the worker channel reports its own gaps instead of hiding them", async () => {
  const { handleWorkerRequest } = await import("@natalia/client");
  const client = completeStubClient();
  // The worker host answers availability through its own route table.
  const report = (await (
    handleWorkerRequest as unknown as (
      client: RuntimeClient,
      request: { method: string; value?: unknown },
    ) => Promise<unknown>
  )(client, {
    method: "runtime.availability",
  })) as Awaited<ReturnType<typeof describeRuntimeCapabilities>>;

  expect(report.channel?.name).toBe("worker");
  const byMember = new Map(
    report.channel!.groups.flatMap((group) =>
      group.members.map((member) => [member.member, member.state] as const),
    ),
  );
  // P0-C aligned the worker channel: checkpoint and the secure-input control
  // are routed now. The intelligence surface (constitution, mailbox, plan,
  // drift, completions, snapshot, evidence/decision reads) joined it in the
  // view-dock round (§56.50). The channel's remaining gap (work graph) is
  // still reported — that is the point, no silence.
  expect(byMember.get("nativeTerminalBeginSecureInput")).toBe(
    "implemented_reachable",
  );
  expect(byMember.get("checkpointList")).toBe("implemented_reachable");
  expect(byMember.get("checkpointRollback")).toBe("implemented_reachable");
  expect(byMember.get("mcpCatalog")).toBe("implemented_reachable");
  expect(byMember.get("getMcpPrompt")).toBe("implemented_reachable");
  expect(byMember.get("readMcpResource")).toBe("implemented_reachable");
  expect(byMember.get("sessionFork")).toBe("implemented_reachable");
  expect(byMember.get("sandboxList")).toBe("implemented_reachable");
  expect(byMember.get("selectAgent")).toBe("implemented_reachable");
  expect(byMember.get("constitutionRules")).toBe("implemented_reachable");
  expect(byMember.get("constitutionOverrides")).toBe("implemented_reachable");
  expect(byMember.get("mailboxSend")).toBe("implemented_reachable");
  expect(byMember.get("planDocList")).toBe("implemented_reachable");
  expect(byMember.get("sessionSnapshot")).toBe("implemented_reachable");
  expect(byMember.get("workGraphNodes")).toBe("implemented_unreachable");
});

test("a member the runtime lacks is not_implemented, with its own reason", async () => {
  // The channel report must not blur "this runtime cannot" into "this channel
  // cannot": a runtime missing `checkpointList` entirely is a different fact
  // from one that implements it while the channel fails to route it.
  const client = completeStubClient();
  delete (client as unknown as Record<string, unknown>).checkpointList;
  const report = describeRuntimeCapabilities(client, {
    name: "rpc",
    routedMembers: RPC_ROUTED_MEMBERS,
  });
  const checkpointGroup = report.channel!.groups.find(
    (group) => group.name === "checkpoint",
  )!;
  const member = checkpointGroup.members.find(
    (entry) => entry.member === "checkpointList",
  )!;
  expect(member.state).toBe("not_implemented");
  expect(member.reason).toBe("this runtime does not implement it");
});
