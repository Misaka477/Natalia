import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  admitInput,
  appendSessionEvent,
  PROJECTION_STATE_VERSION,
  createSessionRecord,
  deserializeProjectionState,
  latestSessionSnapshot,
  modelVisibleEvents,
  projectedCanonicalTools,
  projectedCapabilities,
  projectedDriftFindings,
  projectedConstitutionRules,
  projectedChatMessages,
  projectedNiaChatMessages,
  projectedNaviChatMessages,
  projectedDecisionRecords,
  projectedEvidenceRecords,
  projectedMailboxMessages,
  projectedCollabMessages,
  projectedPlanDocs,
  projectedWorkGraphNodes,
  projectedWorkGraphEdges,
  projectSessionMessages,
  projectSession,
  foldProjection,
  settleInterruptedTurns,
  selectedAgentFromEvents,
  selectedModelFromEvents,
  settlementRecordsFromEvents,
} from "../src";
import { JsonSessionStore } from "../src";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("session projector separates completed, active, and unpromoted durable input", () => {
  const session = createSessionRecord("ses_projector", "Projector");
  admitInput(session, { id: "turn_done", text: "done", delivery: "next-step" });
  admitInput(session, {
    id: "turn_queue",
    text: "queue",
    delivery: "next-turn",
  });
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_done",
    text: "done",
    byteLength: 4,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "tool.update",
    id: "turn_interrupted:call_1",
    name: "read_file",
    callID: "call_1",
    status: "succeeded",
    summary: "read",
    result: "orphaned output",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_done",
    stopReason: "done",
  });
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_interrupted",
    text: "interrupted",
    byteLength: 11,
    lineCount: 1,
    sha256: "test",
  });

  const projection = projectSession(session);
  expect(projection.completedTurnIDs).toEqual(["turn_done"]);
  expect(projection.activeTurnIDs).toEqual(["turn_interrupted"]);
  expect(projection.pendingInputs.map((input) => input.id)).toEqual([
    "turn_done",
    "turn_queue",
  ]);
  expect(projection.replayableEvents).toHaveLength(2);
  expect(
    projection.replayableEvents.some(
      (event) =>
        event.type === "turn.submitted" && event.id === "turn_interrupted",
    ),
  ).toBe(false);
  expect(
    projection.replayableEvents.some(
      (event) =>
        event.type === "tool.update" && event.id === "turn_interrupted:call_1",
    ),
  ).toBe(false);
});

test("projects the last durable model and variant selection", () => {
  const events = [
    { type: "model.selection", modelID: "alpha", variant: "fast" },
    { type: "model.selection", modelID: "beta", variant: "careful" },
  ] as const;
  expect(selectedModelFromEvents([...events])).toEqual({
    modelID: "beta",
    variant: "careful",
  });
});

test("session projector replays only committed agent selection", () => {
  const events = [
    { type: "agent.selection" as const, name: "first", pending: false },
    { type: "agent.selection" as const, name: "second", pending: true },
    { type: "agent.selection" as const, name: "third", pending: false },
  ];
  expect(selectedAgentFromEvents(events)).toBe("third");
});

test("interrupted turns reject only their unresolved interactive requests", () => {
  const session = createSessionRecord("ses_interrupted", "Interrupted");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_crashed",
    text: "write",
    byteLength: 5,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "approval.request",
    id: "turn_crashed:write",
    title: "Write",
    preview: "file",
  });
  appendSessionEvent(session, {
    type: "question.request",
    id: "turn_crashed:write:question",
    title: "Confirm",
  });
  appendSessionEvent(session, {
    type: "approval.request",
    id: "independent_approval",
    title: "Independent",
    preview: "safe",
  });

  expect(settleInterruptedTurns(session)).toEqual([
    {
      type: "approval.response",
      id: "turn_crashed:write",
      decision: "reject",
      feedback: "interrupted turn cannot continue after runtime restart",
    },
    {
      type: "question.response",
      id: "turn_crashed:write:question",
      answers: [],
      rejected: true,
    },
    { type: "turn.finished", id: "turn_crashed", stopReason: "error" },
  ]);
  expect(projectSession(session).activeTurnIDs).toEqual([]);
});

test("model-visible selection starts after the latest durable context epoch", () => {
  const events = [
    {
      type: "turn.submitted" as const,
      id: "old",
      text: "old",
      byteLength: 3,
      lineCount: 1,
      sha256: "x",
    },
    {
      type: "context.checkpoint" as const,
      id: "epoch",
      snapshot: {
        entries: [],
        resources: [],
        journalOffset: 1,
        step: 1,
        tokenEstimate: 1,
        compactionGeneration: 0,
      },
    },
    {
      type: "turn.submitted" as const,
      id: "new",
      text: "new",
      byteLength: 3,
      lineCount: 1,
      sha256: "x",
    },
  ];
  expect(
    modelVisibleEvents(events).map((event) =>
      event.type === "turn.submitted" ? event.id : event.type,
    ),
  ).toEqual(["new"]);
});

test("session fork truncates at a durable submitted-turn boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-session-fork-"));
  try {
    const store = new JsonSessionStore(root);
    const session = createSessionRecord("ses_parent", "Parent");
    for (const id of ["turn_one", "turn_two"])
      appendSessionEvent(session, {
        type: "turn.submitted",
        id,
        text: id,
        byteLength: id.length,
        lineCount: 1,
        sha256: "test",
      });
    appendSessionEvent(session, {
      type: "content.done",
      id: "turn_one",
      text: "first result",
    });
    await store.save(session);

    const fork = await store.fork("ses_parent", "turn_two", "ses_fork");
    expect(fork.id).toBe("ses_fork");
    expect(fork.title).toBe("Parent (fork)");
    expect(
      fork.events.map((event) =>
        event.type === "turn.submitted" ? event.id : event.type,
      ),
    ).toEqual(["turn_one"]);
    expect(
      fork.events.some((event) => "id" in event && event.id === "turn_two"),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects ordered turn messages without splitting durable rows", () => {
  const session = createSessionRecord("ses_messages", "Messages");
  for (const id of ["turn_one", "turn_two", "turn_three"]) {
    appendSessionEvent(session, {
      type: "turn.submitted",
      id,
      text: id,
      byteLength: id.length,
      lineCount: 1,
      sha256: "test",
    });
    appendSessionEvent(session, {
      type: "content.done",
      id,
      text: `${id} response`,
    });
    appendSessionEvent(session, {
      type: "tool.update",
      id: `${id}:tool:read`,
      name: "read_file",
      status: "succeeded",
      summary: "read",
      result: "content",
    });
    appendSessionEvent(session, {
      type: "turn.finished",
      id,
      stopReason: "done",
    });
  }

  const first = projectSessionMessages(session, { order: "asc", limit: 2 });
  expect(first.data.map((message) => message.id)).toEqual([
    "turn_one",
    "turn_two",
  ]);
  expect(first.data[0]?.rows.map((row) => row.kind)).toEqual([
    "user",
    "assistant",
    "tool",
    "system",
  ]);
  expect(first.data[0]?.stopReason).toBe("done");
  expect(first.cursor.next).toEqual(expect.any(String));

  const next = projectSessionMessages(session, {
    cursor: first.cursor.next,
  });
  expect(next.data.map((message) => message.id)).toEqual(["turn_three"]);
  expect(next.cursor.previous).toEqual(expect.any(String));

  const previous = projectSessionMessages(session, {
    cursor: next.cursor.previous,
    limit: 2,
  });
  expect(previous.data.map((message) => message.id)).toEqual([
    "turn_one",
    "turn_two",
  ]);
});

test("projected turn inputs attach to the running turn as user rows", () => {
  const session = createSessionRecord("ses_turn_input", "Turn input");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_live",
    text: "start",
    byteLength: 5,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "turn.input",
    turnID: "turn_live",
    inputID: "input_1",
    text: "also do X",
    delivery: "next-step",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_live",
    text: "done",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_live",
    stopReason: "done",
  });

  const projected = projectSessionMessages(session, { order: "asc" });
  expect(projected.data.map((message) => message.id)).toEqual(["turn_live"]);
  expect(projected.data[0]!.rows.map((row) => row.id)).toEqual([
    "turn_live:turn.submitted",
    "turn_live:user:input_1",
    "turn_live:content.done",
    "turn_live:turn.finished",
  ]);
  expect(projected.data[0]!.rows.map((row) => row.kind)).toEqual([
    "user",
    "user",
    "assistant",
    "system",
  ]);
});

test("projected row ids stay unique across repeated events in one turn", () => {
  const session = createSessionRecord("ses_message_row_ids", "Row ids");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_rows",
    text: "hello",
    byteLength: 5,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "thinking.done",
    id: "turn_rows",
    text: "first thought",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_rows",
    text: "first answer",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_rows",
    text: "",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_rows",
    stopReason: "done",
  });

  const rows = projectSessionMessages(session, { order: "asc" }).data[0]!.rows;
  const ids = rows.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("message projection rejects malformed or stale opaque cursors", () => {
  const session = createSessionRecord("ses_message_cursor", "Messages");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_one",
    text: "one",
    byteLength: 3,
    lineCount: 1,
    sha256: "test",
  });
  expect(() => projectSessionMessages(session, { cursor: "invalid" })).toThrow(
    "invalid message cursor",
  );
  expect(() =>
    projectSessionMessages(session, {
      cursor: Buffer.from(
        JSON.stringify({
          version: 1,
          order: "asc",
          direction: "next",
          anchor: "missing",
        }),
      ).toString("base64url"),
    }),
  ).toThrow("message cursor anchor is no longer available");
});

test("message projection keeps large histories within a bounded local budget", () => {
  const session = createSessionRecord(
    "ses_large_projection",
    "Large projection",
  );
  for (let index = 0; index < 1_000; index++) {
    const id = `turn_${index}`;
    appendSessionEvent(session, {
      type: "turn.submitted",
      id,
      text: `prompt ${index}`,
      byteLength: 8,
      lineCount: 1,
      sha256: "fixture",
    });
    appendSessionEvent(session, {
      type: "content.done",
      id,
      text: `response ${index}`,
    });
    appendSessionEvent(session, {
      type: "turn.finished",
      id,
      stopReason: "done",
    });
  }
  const start = performance.now();
  const page = projectSessionMessages(session, { limit: 100 });
  expect(page.data).toHaveLength(100);
  expect(performance.now() - start).toBeLessThan(100);
});

test("projectedConstitutionRules collects rules and applies updates", () => {
  const session = createSessionRecord("ses_constitution", "Constitution");
  appendSessionEvent(session, {
    type: "constitution.rule_added",
    id: "evt_1",
    ruleID: "C-001",
    statement: "Never commit without approval",
    scope: "project",
    priority: "critical",
    source: "user",
    enforcement: "approval",
    overridePolicy: "forbidden",
  });
  appendSessionEvent(session, {
    type: "constitution.rule_added",
    id: "evt_2",
    ruleID: "C-002",
    statement: "Use TypeScript only",
    scope: "project",
    priority: "high",
    source: "master_plan",
    enforcement: "deny",
    overridePolicy: "forbidden",
  });
  const rules = projectedConstitutionRules(session.events);
  expect(rules).toHaveLength(2);
  expect(rules[0]?.ruleID).toBe("C-001");
  expect(rules[0]?.priority).toBe("critical");
  expect(rules[1]?.ruleID).toBe("C-002");
});

test("projectedDecisionRecords collects decision records", () => {
  const session = createSessionRecord("ses_decisions", "Decisions");
  appendSessionEvent(session, {
    type: "decision.recorded",
    id: "evt_1",
    decision: "Use TypeScript/Bun runtime only",
    rationale: ["Go fallback was removed", "TypeScript provides better DX"],
    status: "accepted",
    linkedPlans: ["natalia-engineering-intelligence-mainline"],
    linkedConstraints: ["C-002"],
  });
  const records = projectedDecisionRecords(session.events);
  expect(records).toHaveLength(1);
  expect(records[0]?.decision).toContain("TypeScript/Bun");
  expect(records[0]?.status).toBe("accepted");
});

test("projectedMailboxMessages tracks the full mailbox lifecycle", () => {
  const session = createSessionRecord("ses_mailbox", "Mailbox");
  appendSessionEvent(session, {
    type: "mailbox.queued",
    id: "mailbox:1:queued",
    messageID: "mailbox:1",
    source: "user_via_live_chat",
    priority: "high",
    intent: "reprioritize",
    text: "focus on docs",
    safeSummary: "reprioritize to docs",
    deliveryPolicy: "next_safe_boundary",
    createdAt: "t0",
  });
  expect(projectedMailboxMessages(session.events)[0]?.status).toBe("queued");

  appendSessionEvent(session, {
    type: "mailbox.deferred",
    id: "mailbox:1:deferred",
    messageID: "mailbox:1",
    reason: "unsafe boundary",
    deferredAt: "t1",
  });
  expect(projectedMailboxMessages(session.events)[0]?.status).toBe("deferred");
  expect(projectedMailboxMessages(session.events)[0]?.reason).toBe(
    "unsafe boundary",
  );

  appendSessionEvent(session, {
    type: "mailbox.superseded",
    id: "mailbox:1:superseded",
    messageID: "mailbox:1",
    reason: "newer instruction",
    supersededAt: "t2",
  });
  expect(projectedMailboxMessages(session.events)[0]?.status).toBe(
    "superseded",
  );

  // A transition for an unknown message is ignored.
  appendSessionEvent(session, {
    type: "mailbox.acknowledged",
    id: "mailbox:2:ack",
    messageID: "mailbox:2",
    acknowledgedAt: "t3",
  });
  expect(projectedMailboxMessages(session.events)).toHaveLength(1);
});

test("projectedMailboxMessages replays to the same status from replay", () => {
  const session = createSessionRecord("ses_mailbox_replay", "Mailbox");
  appendSessionEvent(session, {
    type: "mailbox.queued",
    id: "mailbox:3:queued",
    messageID: "mailbox:3",
    source: "system",
    priority: "normal",
    intent: "constraint",
    text: "never commit",
    safeSummary: "a constraint",
    deliveryPolicy: "before_next_tool",
    createdAt: "t0",
  });
  appendSessionEvent(session, {
    type: "mailbox.delivered",
    id: "mailbox:3:delivered",
    messageID: "mailbox:3",
    deliveredAt: "t1",
  });
  appendSessionEvent(session, {
    type: "mailbox.acknowledged",
    id: "mailbox:3:ack",
    messageID: "mailbox:3",
    acknowledgedAt: "t2",
  });
  // Replaying the same journal produces the same projected state.
  const projected = projectedMailboxMessages(session.events);
  expect(projected[0]).toMatchObject({
    messageID: "mailbox:3",
    intent: "constraint",
    status: "acknowledged",
  });
});

test("projectedCollabMessages tracks required replies and closed chat threads", () => {
  const session = createSessionRecord("ses_collab_chat", "Collaboration chat");
  appendSessionEvent(session, {
    type: "collab.chat",
    id: "collab:chat:1",
    threadID: "collab:chat:1",
    from: "main_agent",
    to: "live_chat",
    text: "Can you sanity-check this?",
    round: 1,
    expectsReply: true,
    at: "t0",
  });
  appendSessionEvent(session, {
    type: "collab.chat",
    id: "collab:chat:2",
    threadID: "collab:chat:1",
    replyToID: "collab:chat:1",
    from: "live_chat",
    to: "main_agent",
    text: "Yes. One more detail?",
    round: 2,
    expectsReply: true,
    at: "t1",
  });
  appendSessionEvent(session, {
    type: "collab.chat",
    id: "collab:chat:3",
    threadID: "collab:chat:1",
    replyToID: "collab:chat:2",
    from: "main_agent",
    to: "live_chat",
    text: "No, that closes it.",
    round: 2,
    expectsReply: false,
    at: "t2",
  });

  expect(projectedCollabMessages(session.events)).toEqual([
    expect.objectContaining({
      id: "collab:chat:1",
      kind: "chat",
      status: "replied",
      threadID: "collab:chat:1",
      round: 1,
      expectsReply: true,
    }),
    expect.objectContaining({
      id: "collab:chat:2",
      status: "replied",
      replyToID: "collab:chat:1",
      round: 2,
    }),
    expect.objectContaining({
      id: "collab:chat:3",
      status: "informational",
      replyToID: "collab:chat:2",
      expectsReply: false,
    }),
  ]);
});

test("projectedCollabMessages normalizes mixed and out-of-order replies", () => {
  const events: RuntimeEvent[] = [
    {
      type: "collab.answer",
      id: "answer:1",
      questionID: "question:1",
      from: "live_chat",
      to: "main_agent",
      answer: "yes",
      at: "t1",
    },
    {
      type: "collab.question",
      id: "question:1",
      from: "main_agent",
      to: "live_chat",
      question: "safe?",
      at: "t0",
    },
    {
      type: "collab.message",
      message: {
        id: "suggestion:1",
        threadID: "suggestion:1",
        kind: "suggestion",
        from: "live_chat",
        to: "main_agent",
        text: "use echo",
        priority: "normal",
        expectsReply: true,
        at: "t2",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "response:1",
        threadID: "suggestion:1",
        replyToID: "suggestion:1",
        kind: "response",
        from: "main_agent",
        to: "live_chat",
        text: "adopted",
        decision: "adopted",
        expectsReply: false,
        at: "t3",
      },
    },
  ];

  expect(projectedCollabMessages(events)).toEqual([
    expect.objectContaining({
      id: "answer:1",
      kind: "answer",
      threadID: "question:1",
      replyToID: "question:1",
      status: "informational",
    }),
    expect.objectContaining({ id: "question:1", status: "replied" }),
    expect.objectContaining({ id: "suggestion:1", status: "replied" }),
    expect.objectContaining({
      id: "response:1",
      kind: "response",
      decision: "adopted",
      status: "informational",
    }),
  ]);
});

test("projectedCollabMessages normalizes namespaced collab events", () => {
  const events: RuntimeEvent[] = [
    {
      type: "natalia.collab.message",
      message: {
        id: "ns:1",
        threadID: "ns:1",
        kind: "chat",
        from: "main_agent",
        to: "live_chat",
        text: "from Natalia",
        round: 1,
        expectsReply: true,
        at: "t0",
      },
    },
    {
      type: "navi.collab.message",
      message: {
        id: "ns:2",
        threadID: "ns:1",
        replyToID: "ns:1",
        kind: "chat",
        from: "live_chat",
        to: "main_agent",
        text: "from Navi",
        round: 2,
        expectsReply: false,
        at: "t1",
      },
    },
    {
      type: "nia.collab.message",
      message: {
        id: "ns:3",
        threadID: "ns:3",
        kind: "chat",
        from: "nia",
        to: "main_agent",
        text: "from Nia",
        round: 1,
        expectsReply: false,
        at: "t2",
      },
    },
  ];

  expect(projectedCollabMessages(events)).toEqual([
    expect.objectContaining({ id: "ns:1", status: "replied" }),
    expect.objectContaining({ id: "ns:2", status: "informational" }),
    expect.objectContaining({
      id: "ns:3",
      from: "nia",
      status: "informational",
    }),
  ]);
});

test("projectedPlanDocs tracks mark, status and deletion", () => {
  const session = createSessionRecord("ses_plan_docs", "Plan docs");
  appendSessionEvent(session, {
    type: "plan.doc.created",
    id: "plan:1:created:0",
    planID: "plan:1",
    title: "Bun-native HTTP plan",
    documentPath: ".natalia/plans/plan_1.md",
    createdBy: "live_chat",
    status: "marked",
    createdAt: "t0",
  });
  expect(projectedPlanDocs(session.events)[0]).toMatchObject({
    planID: "plan:1",
    documentPath: ".natalia/plans/plan_1.md",
    status: "marked",
  });

  appendSessionEvent(session, {
    type: "plan.doc.marked",
    id: "plan:1:marked:1",
    planID: "plan:1",
    markedAt: "t1",
  });
  appendSessionEvent(session, {
    type: "plan.doc.status",
    id: "plan:1:status:2",
    planID: "plan:1",
    status: "executing",
    at: "t2",
  });
  const projected = projectedPlanDocs(session.events)[0];
  expect(projected?.markedAt).toBe("t1");
  expect(projected?.status).toBe("executing");

  appendSessionEvent(session, {
    type: "plan.doc.deleted",
    id: "plan:1:deleted:3",
    planID: "plan:1",
    deletedAt: "t3",
  });
  expect(projectedPlanDocs(session.events)).toEqual([]);
});

test("projectedPlanDocs ignores status events for a plan that was never created", () => {
  const session = createSessionRecord("ses_plan_docs_unknown", "Plan docs");
  appendSessionEvent(session, {
    type: "plan.doc.status",
    id: "plan:9:status:0",
    planID: "plan:9",
    status: "executing",
    at: "t0",
  });
  expect(projectedPlanDocs(session.events)).toEqual([]);
});

test("projectedEvidenceRecords collects evidence records", () => {
  const session = createSessionRecord("ses_evidence", "Evidence");
  appendSessionEvent(session, {
    type: "evidence.recorded",
    id: "evt_1",
    taskID: "T-001",
    objective: "Add completion evidence schema",
    status: "validated",
    knownGaps: ["Needs full integration test"],
  });
  const records = projectedEvidenceRecords(session.events);
  expect(records).toHaveLength(1);
  expect(records[0]?.taskID).toBe("T-001");
  expect(records[0]?.status).toBe("validated");
});

test("projectedWorkGraphNodes and Edges collect graph nodes", () => {
  const session = createSessionRecord("ses_wg", "WorkGraph");
  appendSessionEvent(session, {
    type: "workgraph.node_added",
    id: "evt_1",
    nodeID: "G-001",
    kind: "goal",
    summary: "Fix empty provider response",
    sessionID: "ses_wg",
  });
  appendSessionEvent(session, {
    type: "workgraph.node_added",
    id: "evt_2",
    nodeID: "A-001",
    kind: "agent_action",
    summary: "edit-parser-fallback",
  });
  appendSessionEvent(session, {
    type: "workgraph.edge_added",
    id: "evt_3",
    sourceID: "A-001",
    targetID: "G-001",
    kind: "requested_by",
  });
  const nodes = projectedWorkGraphNodes(session.events);
  const edges = projectedWorkGraphEdges(session.events);
  expect(nodes).toHaveLength(2);
  expect(edges).toHaveLength(1);
  expect(nodes[0]?.kind).toBe("goal");
  expect(edges[0]?.kind).toBe("requested_by");
});

test("projectedCapabilities tracks loaded/unloaded capabilities", () => {
  const session = createSessionRecord("ses_cap", "Capabilities");
  appendSessionEvent(session, {
    type: "capability.loaded",
    id: "evt_1",
    apiVersion: 1,
    name: "Test Capability",
    version: "1.0.0",
    scope: "session",
    grants: ["tools"],
  });
  const caps = projectedCapabilities(session.events);
  expect(caps).toHaveLength(1);
  expect(caps[0]?.name).toBe("Test Capability");
  expect(caps[0]?.manifest.scope).toBe("session");
  expect(caps[0]?.manifest.apiVersion).toBe(1);
  expect(caps[0]?.manifest.version).toBe("1.0.0");
  expect(caps[0]?.manifest.grants).toEqual(["tools"]);

  appendSessionEvent(session, {
    type: "capability.unloaded",
    id: "evt_1",
    name: "Test Capability",
  });
  expect(projectedCapabilities(session.events)).toEqual([]);
});

test("projectedCapabilities keeps a removal out of the projection", () => {
  // A capability going away is not a capability being present. The projection
  // reads `loaded` only, so a removal contributes nothing.
  const session = createSessionRecord("ses_cap_unloaded", "Capabilities");
  appendSessionEvent(session, {
    type: "capability.unloaded",
    id: "evt_1",
    name: "Removed Capability",
  });
  expect(projectedCapabilities(session.events)).toEqual([]);
});

test("projectedCanonicalTools registers and unregisters tools", () => {
  const session = createSessionRecord("ses_treg", "ToolReg");
  appendSessionEvent(session, {
    type: "tool.registered",
    id: "evt_1",
    name: "read_file",
    owner: "natalia",
    scope: "session",
    recovery: "retry",
    precedence: 0,
    requiresApproval: false,
  });
  const tools = projectedCanonicalTools(session.events);
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toBe("read_file");
  expect(tools[0]?.owner).toBe("natalia");
});

test("projectedDriftFindings tracks findings and status updates", () => {
  const session = createSessionRecord("ses_drift", "Drift");
  appendSessionEvent(session, {
    type: "drift.finding_opened",
    id: "evt_1",
    findingID: "DF-001",
    severity: "warning",
    confidence: 0.75,
    originalObjective: "Fix parser",
    currentActivity: "Auth config",
    evidence: ["12 actions without parser files"],
    applicableConstraints: [],
    contractVersion: 2,
  });
  const opened = projectedDriftFindings(session.events);
  expect(opened).toHaveLength(1);
  expect(opened[0]?.severity).toBe("warning");
  expect(opened[0]?.originalObjective).toBe("Fix parser");
  // A finding starts open, and the status is owned by the projection rather
  // than by the opening event.
  expect(opened[0]?.status).toBe("open");
  expect(opened[0]?.rationale).toBeUndefined();

  appendSessionEvent(session, {
    type: "drift.finding_updated",
    id: "evt_2",
    findingID: "DF-001",
    status: "explained",
    rationale: "Auth config is a prerequisite of the parser fix",
  });
  const explained = projectedDriftFindings(session.events);
  expect(explained).toHaveLength(1);
  expect(explained[0]?.status).toBe("explained");
  expect(explained[0]?.rationale).toBe(
    "Auth config is a prerequisite of the parser fix",
  );
  // The opening facts survive the update.
  expect(explained[0]?.originalObjective).toBe("Fix parser");
  expect(explained[0]?.evidence).toEqual(["12 actions without parser files"]);

  appendSessionEvent(session, {
    type: "drift.finding_updated",
    id: "evt_3",
    findingID: "DF-001",
    status: "corrected",
  });
  const corrected = projectedDriftFindings(session.events);
  expect(corrected[0]?.status).toBe("corrected");
  // The latest update wins, and it does not clear an earlier rationale.
  expect(corrected[0]?.rationale).toBe(
    "Auth config is a prerequisite of the parser fix",
  );
});

test("projectedDriftFindings ignores an update for a finding that was never opened", () => {
  const session = createSessionRecord("ses_drift_orphan", "Drift");
  appendSessionEvent(session, {
    type: "drift.finding_updated",
    id: "evt_1",
    findingID: "DF-404",
    status: "dismissed",
  });
  // An update carries no objective or evidence, so no finding can be
  // reconstructed from it.
  expect(projectedDriftFindings(session.events)).toEqual([]);
});

test("latestSessionSnapshot returns the most recent snapshot", () => {
  const session = createSessionRecord("ses_snap", "Snapshot");
  appendSessionEvent(session, {
    type: "session.snapshot",
    id: "evt_1",
    agentStatus: "running",
    currentStep: "fix parser",
    changedFiles: 3,
    unvalidatedChanges: 1,
    hasPTY: true,
    hasSandbox: false,
  });
  const snap = latestSessionSnapshot(session.events);
  expect(snap?.agentStatus).toBe("running");
  expect(snap?.currentStep).toBe("fix parser");
  expect(snap?.hasPTY).toBe(true);
});

test("the Navi conversation projects messages and honours rollback boundaries", () => {
  const session = createSessionRecord("ses_chat", "Chat");
  appendSessionEvent(session, {
    type: "navi.chat.message.added",
    id: "chat:1",
    messageID: "chat:m1",
    role: "user",
    text: "what is the agent doing",
    at: "2026-08-14T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "navi.chat.message.added",
    id: "chat:2",
    messageID: "chat:m2",
    role: "chat",
    text: "it is running step 2 of the plan",
    at: "2026-08-14T00:00:01.000Z",
  });
  appendSessionEvent(session, {
    type: "navi.chat.message.added",
    id: "chat:3",
    messageID: "chat:m3",
    role: "user",
    text: "stop and re-plan",
    at: "2026-08-14T00:00:02.000Z",
  });
  const history = projectedChatMessages(session.events);
  expect(history.map((message) => message.messageID)).toEqual([
    "chat:m1",
    "chat:m2",
    "chat:m3",
  ]);
  expect(history[1]).toMatchObject({
    role: "chat",
    text: "it is running step 2 of the plan",
  });

  appendSessionEvent(session, {
    type: "navi.chat.rollback",
    id: "chat:r1",
    toMessageID: "chat:m2",
    removed: 1,
    at: "2026-08-14T00:00:03.000Z",
  });
  const after = projectedChatMessages(session.events);
  expect(after.map((message) => message.messageID)).toEqual([
    "chat:m1",
    "chat:m2",
  ]);
});

test("namespaced chat tool projections keep durable event ids", () => {
  const events: RuntimeEvent[] = [
    {
      type: "navi.chat.tool.used",
      id: "chat:tool:1",
      messageID: "chat:m1",
      toolName: "read_file",
      status: "succeeded",
      summary: "first",
      at: "t1",
    },
    {
      type: "navi.chat.tool.used",
      id: "chat:tool:2",
      messageID: "chat:m1",
      toolName: "read_file",
      status: "succeeded",
      summary: "second",
      at: "t2",
    },
  ];
  expect(
    projectedNaviChatMessages(events).map((row) => row.tool?.eventID),
  ).toEqual(["chat:tool:1", "chat:tool:2"]);
});

test("chat replay preserves user attachment metadata", () => {
  const session = createSessionRecord("ses_chat_attachment", "Chat attachment");
  const attachment = {
    id: "att_image",
    path: ".natalia/attachments/att_image.png",
    filename: "image.png",
    mediaType: "image/png" as const,
    byteLength: 24,
    sha256: "image-hash",
    width: 1,
    height: 1,
  };
  appendSessionEvent(session, {
    type: "navi.chat.message.new",
    id: "navi:attachment:user",
    messageID: "attachment-user",
    role: "user",
    text: "see image",
    at: "2026-08-14T00:00:00.000Z",
    attachments: [attachment],
  });
  expect(projectedNaviChatMessages(session.events)[0]?.attachments).toEqual([
    attachment,
  ]);
});

test("chat replay keeps identical Navi and Nia message IDs and thinking isolated", () => {
  const session = createSessionRecord("ses_chat_namespaces", "Chat namespaces");
  appendSessionEvent(session, {
    type: "navi.chat.message.new",
    id: "navi:shared:user",
    messageID: "shared",
    role: "user",
    text: "Navi question",
    at: "2026-08-14T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "nia.chat.message.new",
    id: "nia:shared:user",
    messageID: "shared",
    role: "user",
    text: "Nia question",
    at: "2026-08-14T00:00:01.000Z",
  });
  appendSessionEvent(session, {
    type: "navi.chat.thinking.delta",
    id: "navi:shared:thinking:1",
    messageID: "shared",
    text: "Navi thinks. ",
  });
  appendSessionEvent(session, {
    type: "nia.chat.thinking.delta",
    id: "nia:shared:thinking:1",
    messageID: "shared",
    text: "Nia thinks. ",
  });
  appendSessionEvent(session, {
    type: "navi.chat.thinking.delta",
    id: "navi:shared:thinking:2",
    messageID: "shared",
    text: "Still Navi.",
  });
  appendSessionEvent(session, {
    type: "nia.chat.message.added",
    id: "nia:shared:chat",
    messageID: "shared",
    role: "chat",
    text: "Nia answer",
    at: "2026-08-14T00:00:02.000Z",
  });

  expect(projectedChatMessages(session.events)).toEqual([
    {
      messageID: "shared",
      role: "user",
      text: "Navi question",
      at: "2026-08-14T00:00:00.000Z",
      kind: "message",
    },
    {
      messageID: "shared",
      role: "user",
      text: "Nia question",
      at: "2026-08-14T00:00:01.000Z",
      kind: "message",
    },
    {
      messageID: "shared",
      role: "chat",
      text: "Navi thinks. Still Navi.",
      at: "",
      kind: "thinking",
    },
    {
      messageID: "shared",
      role: "chat",
      text: "Nia thinks. ",
      at: "",
      kind: "thinking",
    },
    {
      messageID: "shared",
      role: "chat",
      text: "Nia answer",
      at: "2026-08-14T00:00:02.000Z",
      kind: "message",
    },
  ]);
});

test("projected Nia/Navi chat streams include collaboration rows by sender", () => {
  const events: RuntimeEvent[] = [
    {
      type: "nia.collab.message",
      message: {
        id: "collab:nia:1",
        threadID: "collab:nia:1",
        kind: "chat",
        from: "nia",
        to: "main_agent",
        text: "Nia audit result",
        round: 1,
        expectsReply: false,
        at: "t1",
      },
    },
    {
      type: "natalia.collab.message",
      message: {
        id: "collab:natalia:1",
        threadID: "collab:natalia:1",
        kind: "chat",
        from: "main_agent",
        to: "nia",
        text: "Natalia reply",
        round: 1,
        expectsReply: false,
        at: "t2",
      },
    },
  ];

  expect(projectedNiaChatMessages(events)).toEqual([
    expect.objectContaining({
      messageID: "collab:nia:1",
      role: "system",
      kind: "collab",
      text: "Nia → Natalia: Nia audit result",
    }),
  ]);
  expect(projectedNaviChatMessages(events)).toEqual([]);
});

test("durable chat thinking replaces live deltas and restores done-only streams", () => {
  const events: RuntimeEvent[] = [
    {
      type: "navi.chat.thinking.delta",
      id: "navi:shared:thinking:delta",
      messageID: "shared",
      text: "partial ",
    },
    {
      type: "navi.chat.thinking.done",
      id: "navi:shared:thinking:done",
      messageID: "shared",
      text: "complete Navi reasoning",
    },
    {
      type: "nia.chat.thinking.done",
      id: "nia:shared:thinking:done",
      messageID: "shared",
      text: "complete Nia reasoning",
    },
  ];

  expect(projectedChatMessages(events)).toEqual([
    {
      messageID: "shared",
      role: "chat",
      text: "complete Navi reasoning",
      at: "",
      kind: "thinking",
    },
    {
      messageID: "shared",
      role: "chat",
      text: "complete Nia reasoning",
      at: "",
      kind: "thinking",
    },
  ]);
});

test("namespaced chat replay ignores stale channel payloads", () => {
  const events = [
    {
      type: "navi.chat.message.new",
      id: "navi:stale-channel",
      messageID: "shared",
      role: "user",
      text: "Navi remains Navi",
      at: "t1",
      channel: "nia",
    } as unknown as RuntimeEvent,
    {
      type: "nia.chat.thinking.delta",
      id: "nia:stale-channel",
      messageID: "shared",
      text: "Nia remains Nia",
      channel: "navi",
    } as unknown as RuntimeEvent,
  ];

  expect(projectedChatMessages(events)).toEqual([
    {
      messageID: "shared",
      role: "user",
      text: "Navi remains Navi",
      at: "t1",
      kind: "message",
    },
    {
      messageID: "shared",
      role: "chat",
      text: "Nia remains Nia",
      at: "",
      kind: "thinking",
    },
  ]);
});

test("legacy persisted chat records retain isolated channel histories", () => {
  const events: RuntimeEvent[] = [
    {
      type: "chat.message.added",
      id: "legacy:navi:user",
      messageID: "shared",
      role: "user",
      text: "Legacy Navi",
      at: "t1",
      channel: "navi",
    },
    {
      type: "chat.message.added",
      id: "legacy:nia:user",
      messageID: "shared",
      role: "user",
      text: "Legacy Nia",
      at: "t2",
      channel: "nia",
    },
    {
      type: "chat.message.added",
      id: "legacy:navi:later",
      messageID: "navi-later",
      role: "chat",
      text: "Legacy Navi later",
      at: "t3",
      channel: "navi",
    },
    {
      type: "chat.message.added",
      id: "legacy:nia:later",
      messageID: "nia-later",
      role: "chat",
      text: "Legacy Nia later",
      at: "t4",
      channel: "nia",
    },
    {
      type: "chat.rollback",
      id: "legacy:nia:rollback",
      toMessageID: "shared",
      removed: 0,
      at: "t5",
      channel: "nia",
    },
  ];

  expect(projectedChatMessages(events)).toEqual([
    {
      messageID: "shared",
      role: "user",
      text: "Legacy Navi",
      at: "t1",
      kind: "message",
    },
    {
      messageID: "shared",
      role: "user",
      text: "Legacy Nia",
      at: "t2",
      kind: "message",
    },
    {
      messageID: "navi-later",
      role: "chat",
      text: "Legacy Navi later",
      at: "t3",
      kind: "message",
    },
  ]);
});

test("projected messages include collaboration rows in event order", () => {
  const session = createSessionRecord("ses_collab_projection", "Collab");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_collab_1",
    text: "ask navi",
    byteLength: 8,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "natalia.collab.message",
    message: {
      id: "collab:chat:abc:1",
      threadID: "collab:chat:abc:1",
      kind: "chat",
      from: "main_agent",
      to: "live_chat",
      text: "please review this",
      expectsReply: false,
      round: 1,
      at: "2026-01-01T00:00:00.000Z",
    },
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_collab_1",
    stopReason: "done",
  });

  const page = projectSessionMessages(session, { order: "asc" });
  const rows = page.data.flatMap((message) => message.rows);
  const collab = rows.find(
    (row) => row.event.type === "natalia.collab.message",
  );
  expect(collab).toBeDefined();
  expect(collab?.turnID).toBe("turn_collab_1");
  expect(collab?.kind).toBe("system");
});

test("message projection keeps durable content.partial rows for a killed stream", () => {
  const session = createSessionRecord("ses_partial_rows", "Partial rows");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_partial",
    text: "start",
    byteLength: 5,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial",
    text: "par",
    at: "2026-01-01T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial",
    text: "tial",
    at: "2026-01-01T00:00:01.000Z",
  });
  // Killed mid-stream: there is no content.done.
  const projected = projectSessionMessages(session, { order: "asc" });
  expect(projected.data.map((message) => message.id)).toEqual(["turn_partial"]);
  const rows = projected.data[0]!.rows;
  expect(rows.filter((row) => row.kind === "assistant")).toHaveLength(2);
  expect(rows.map((row) => row.event.type)).toEqual([
    "turn.submitted",
    "content.partial",
    "content.partial",
  ]);
});

test("static history restores thinking before its answer partials", () => {
  const session = createSessionRecord("ses_partial_order", "Partial order");
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_partial_order",
    text: "go",
    byteLength: 2,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial_order",
    text: "hello ",
    at: "2026-01-01T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial_order",
    text: "world",
    at: "2026-01-01T00:00:01.000Z",
  });
  appendSessionEvent(session, {
    type: "thinking.done",
    id: "turn_partial_order",
    text: "thought",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_partial_order",
    text: "hello world",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_partial_order",
    stopReason: "done",
  });
  const rows = projectSessionMessages(session, { order: "asc" }).data[0]!.rows;
  expect(rows.map((row) => row.event.type)).toEqual([
    "turn.submitted",
    "thinking.done",
    "content.partial",
    "content.partial",
    "content.done",
    "turn.finished",
  ]);
});

test("alternating reasoning and answering keeps the order the model produced", () => {
  const session = createSessionRecord(
    "ses_partial_alternating",
    "Partial alternating",
  );
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_partial_alternating",
    text: "go",
    byteLength: 2,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "thinking.done",
    id: "turn_partial_alternating",
    text: "first thought",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial_alternating",
    text: "first answer",
    at: "2026-01-01T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_partial_alternating",
    text: "first answer",
  });
  appendSessionEvent(session, {
    type: "thinking.done",
    id: "turn_partial_alternating",
    text: "second thought",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial_alternating",
    text: "second answer",
    at: "2026-01-01T00:00:01.000Z",
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_partial_alternating",
    text: "second answer",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_partial_alternating",
    stopReason: "done",
  });
  const rows = projectSessionMessages(session, { order: "asc" }).data[0]!.rows;
  expect(rows.map((row) => row.event.type)).toEqual([
    "turn.submitted",
    "thinking.done",
    "content.partial",
    "content.done",
    "thinking.done",
    "content.partial",
    "content.done",
    "turn.finished",
  ]);
});

test("attempt-stamped thinking.done is not treated as historical late settlement", () => {
  const session = createSessionRecord(
    "ses_partial_attempt_order",
    "Partial attempt order",
  );
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_partial_attempt_order",
    text: "go",
    byteLength: 2,
    lineCount: 1,
    sha256: "test",
  });
  appendSessionEvent(session, {
    type: "content.partial",
    id: "turn_partial_attempt_order",
    text: "answer",
    at: "2026-01-01T00:00:00.000Z",
  });
  appendSessionEvent(session, {
    type: "thinking.done",
    id: "turn_partial_attempt_order",
    text: "answer came first",
    attempt: 1,
  });
  appendSessionEvent(session, {
    type: "content.done",
    id: "turn_partial_attempt_order",
    text: "answer",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_partial_attempt_order",
    stopReason: "done",
  });
  const rows = projectSessionMessages(session, { order: "asc" }).data[0]!.rows;
  expect(rows.map((row) => row.event.type)).toEqual([
    "turn.submitted",
    "content.partial",
    "thinking.done",
    "content.done",
    "turn.finished",
  ]);
});

test("foldable projection unit reproduces projectSession for a mixed log", () => {
  const session = createSessionRecord("ses_projection_unit", "Projection Unit");
  // Completed turn with scalar selections and a tool call.
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_a",
    text: "a",
    byteLength: 1,
    lineCount: 1,
    sha256: "x",
  });
  appendSessionEvent(session, {
    type: "agent.selection",
    name: "reviewer",
    pending: false,
  });
  appendSessionEvent(session, {
    type: "model.selection",
    modelID: "alpha",
    variant: "fast",
  });
  appendSessionEvent(session, {
    type: "model.reasoning.set",
    reasoningEffort: "high",
  });
  appendSessionEvent(session, {
    type: "session.permission.mode",
    mode: "auto",
    profile: "default",
  });
  appendSessionEvent(session, {
    type: "tool.update",
    id: "turn_a:call_1",
    name: "read_file",
    callID: "call_1",
    status: "succeeded",
    summary: "read",
    result: "ok",
  });
  appendSessionEvent(session, {
    type: "turn.finished",
    id: "turn_a",
    stopReason: "done",
  });
  // Interrupted turn (submitted, never finished) with its own tool output.
  appendSessionEvent(session, {
    type: "turn.submitted",
    id: "turn_b",
    text: "b",
    byteLength: 1,
    lineCount: 1,
    sha256: "y",
  });
  appendSessionEvent(session, {
    type: "tool.update",
    id: "turn_b:call_2",
    name: "read_file",
    callID: "call_2",
    status: "succeeded",
    summary: "read",
    result: "orphaned",
  });
  // A later model selection that survives (not part of the interrupted turn).
  appendSessionEvent(session, {
    type: "model.selection",
    modelID: "beta",
    variant: "careful",
  });
  // A pending input that must appear in the projection.
  admitInput(session, {
    id: "input_pending",
    text: "queued",
    delivery: "next-turn",
  });

  const full = projectSession(session);
  const folded = foldProjection(session.events, session.inbox ?? []);
  expect(folded).toEqual(full);
  expect(folded.activeTurnIDs).toEqual(["turn_b"]);
  expect(folded.completedTurnIDs).toEqual(["turn_a"]);
  expect(folded.selectedModel).toEqual({ modelID: "beta", variant: "careful" });
  expect(folded.pendingInputs.map((input) => input.id)).toEqual([
    "input_pending",
  ]);
});

test("deserializeProjectionState round-trips a serialized state", () => {
  const state = {
    version: 1,
    events: [],
    activeTurnIDs: new Set(["turn_1"]),
    completedTurnIDs: new Set<string>(),
  };
  const restored = deserializeProjectionState(
    JSON.stringify({
      version: PROJECTION_STATE_VERSION,
      events: [],
      activeTurnIDs: ["turn_1"],
      completedTurnIDs: [],
    }),
  );
  expect(restored?.activeTurnIDs).toEqual(new Set(["turn_1"]));
  expect(restored?.completedTurnIDs).toEqual(new Set());
  // a stale fold version is discarded, never mis-replayed
  const stale = deserializeProjectionState(
    JSON.stringify({
      version: PROJECTION_STATE_VERSION - 1,
      events: [],
      activeTurnIDs: ["turn_1"],
      completedTurnIDs: [],
    }),
  );
  expect(stale).toBeUndefined();
  // absent set fields are tolerated (default empty)
  const partial = deserializeProjectionState(
    JSON.stringify({ version: PROJECTION_STATE_VERSION, events: [] }),
  );
  expect(partial?.activeTurnIDs).toEqual(new Set());
});

test("deserializeProjectionState fails soft on a non-array set field instead of throwing", () => {
  // A same-version, valid-JSON payload whose activeTurnIDs is not an array must
  // be discarded (recovery falls back to a full projection), never crash on
  // `new Set(nonIterable)`.
  for (const bad of [5, { a: 1 }, true]) {
    const json = JSON.stringify({ version: 1, events: [], activeTurnIDs: bad });
    expect(deserializeProjectionState(json)).toBeUndefined();
  }
  const badCompleted = JSON.stringify({
    version: 1,
    events: [],
    completedTurnIDs: "nope",
  });
  expect(deserializeProjectionState(badCompleted)).toBeUndefined();
});

test("settlement notices fold into the projection's record list", () => {
  const events = [
    {
      type: "settlement.notice",
      id: "settlement:terminal-settled:term_a:1",
      subject: "term_a",
      reason: "settled",
      summary: "screen settled",
      sourceKind: "terminal-settled",
      at: "2026-09-25T00:00:00.000Z",
    },
    {
      type: "settlement.notice",
      id: "settlement:process-exited:proc_b:2",
      subject: "proc_b",
      reason: "exited",
      summary: "exited 0",
      detail: "exitCode 0",
      sourceKind: "process-exited",
      at: "2026-09-25T00:00:09.000Z",
    },
  ] as unknown as RuntimeEvent[];
  const records = settlementRecordsFromEvents(events);
  // Oldest first, and the record is the index (summary/detail stay on
  // the event) — replay sees exactly what the model was told.
  expect(records).toEqual([
    {
      subject: "term_a",
      reason: "settled",
      sourceKind: "terminal-settled",
      at: "2026-09-25T00:00:00.000Z",
    },
    {
      subject: "proc_b",
      reason: "exited",
      sourceKind: "process-exited",
      at: "2026-09-25T00:00:09.000Z",
    },
  ]);
});

test("a journal without notices folds to an empty list", () => {
  expect(settlementRecordsFromEvents([])).toEqual([]);
  expect(
    settlementRecordsFromEvents([
      { type: "turn.started", id: "t1" } as unknown as RuntimeEvent,
    ]),
  ).toEqual([]);
});
