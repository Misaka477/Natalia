import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  applyEvent,
  boundTranscript,
  hydrateSubagentHistory,
  initialState,
  projectEvents,
  selectUnattributedWorkGraphNodes,
  selectWorkGraphNeighborhood,
  terminalTimelineLimit,
  terminalTranscriptChars,
  transcriptLimit,
  transcriptWatermark,
  type AppState,
} from "../src";

// These cover the surfaces beyond the conversation core, so a UI can render
// terminals, sandboxes, checkpoints, subagents and status without reading raw
// events. Each assertion is about a fact the runtime produced, never about how a
// particular UI chooses to draw it.

const terminalUpdate = (
  id: string,
  overrides: Record<string, unknown> = {},
): RuntimeEvent =>
  ({
    type: "terminal.update",
    id,
    command: "bash",
    cwd: "/work",
    status: "running",
    attached: true,
    rows: 24,
    cols: 80,
    activity: "running",
    tail: "",
    transcript: "",
    target: { kind: "host", cwd: "/work" },
    ...overrides,
  }) as RuntimeEvent;

test("the latest terminal state is kept per pane", () => {
  const state = projectEvents([
    terminalUpdate("t_a"),
    terminalUpdate("t_b", { command: "vim" }),
    terminalUpdate("t_a", { status: "exited", activity: "waiting" }),
  ]);
  expect(Object.keys(state.terminals).sort()).toEqual(["t_a", "t_b"]);
  expect(state.terminals.t_a).toMatchObject({ status: "exited" });
  expect(state.terminals.t_b).toMatchObject({ command: "vim" });
});

test("terminal timeline is per pane and bounded", () => {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < terminalTimelineLimit + 40; index += 1)
    events.push({
      type: "terminal.timeline",
      id: "t_a",
      actor: "model",
      action: "created",
      status: "executed",
      summary: `entry ${index}`,
      at: new Date(index).toISOString(),
    } as RuntimeEvent);
  const state = projectEvents(events);
  // A projection that grows without limit is a leak in every consumer.
  expect(state.terminalTimeline.t_a).toHaveLength(terminalTimelineLimit);
  expect(state.terminalTimeline.t_a?.at(-1)).toMatchObject({
    summary: `entry ${terminalTimelineLimit + 39}`,
  });
});

test("terminal approvals are keyed by approval, not by pane", () => {
  const state = projectEvents([
    {
      type: "terminal.approval",
      id: "t_a",
      approvalID: "ap_1",
      state: "awaiting",
      action: "write",
      reason: "risky",
      target: { kind: "host", cwd: "/work" },
    } as RuntimeEvent,
    {
      type: "terminal.approval",
      id: "t_a",
      approvalID: "ap_2",
      state: "approved",
      action: "write",
      reason: "second",
      target: { kind: "host", cwd: "/work" },
    } as RuntimeEvent,
  ]);
  // One pane can accumulate several approvals; a UI must resolve the right one.
  expect(Object.keys(state.terminalApprovals).sort()).toEqual(["ap_1", "ap_2"]);
  expect(state.terminalApprovals.ap_1).toMatchObject({ state: "awaiting" });
});

test("sandbox state and diffs project separately", () => {
  const state = projectEvents([
    {
      type: "sandbox.update",
      id: "box",
      status: "created",
      root: "/work/.natalia/sandboxes/box",
      isolationLevel: "workspace",
      changedFiles: 2,
      runningResources: 0,
      target: {
        kind: "sandbox",
        sandboxID: "box",
        root: "/work/.natalia/sandboxes/box",
        isolationLevel: "workspace",
      },
      resourcePolicy: "sandbox_manifest",
    } as RuntimeEvent,
    {
      type: "sandbox.diff",
      id: "box",
      changes: [{ kind: "add", path: "a.txt" }],
    } as RuntimeEvent,
  ]);
  expect(state.sandboxes.box).toMatchObject({ changedFiles: 2 });
  expect(state.sandboxDiffs.box?.changes).toHaveLength(1);
});

test("a sandbox audit that requires approval is visible in the transcript", () => {
  const state = projectEvents([
    {
      type: "sandbox.audit",
      id: "box",
      action: "merge",
      target: {
        kind: "sandbox",
        sandboxID: "box",
        root: "/work/.natalia/sandboxes/box",
        isolationLevel: "workspace",
      },
      approvalRequired: true,
      checkpointPolicy: "sandbox_manifest",
      message: "merge needs approval",
    } as RuntimeEvent,
  ]);
  const block = state.messages.find((item) => item.role === "system");
  expect(block?.text).toBe("merge needs approval");
  expect(block?.status).toBe("approval_required");
});

test("subagents keep a current state and full stable history", () => {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < 110; index += 1)
    events.push({
      type: "subagent.update",
      id: "child",
      status: index === 109 ? "completed" : "running",
      attached: false,
      event: "status",
      continuation: index,
    } as RuntimeEvent);
  const state = projectEvents(events);
  expect(state.subagents.child).toMatchObject({ status: "completed" });
  expect(state.subagentHistory.child).toHaveLength(110);
});

test("subagent history pagination prepends older and appends newer", () => {
  const state = initialState();
  const event = (
    continuation: number,
  ): Extract<RuntimeEvent, { type: "subagent.update" }> => ({
    type: "subagent.update",
    id: "child",
    status: "running",
    attached: false,
    event: "status",
    continuation,
  });
  hydrateSubagentHistory(state, [event(1), event(2)], {
    replace: true,
    subagentID: "child",
  });
  hydrateSubagentHistory(state, [event(0)], {
    direction: "older",
    subagentID: "child",
  });
  expect(state.subagentHistory.child?.map((row) => row.continuation)).toEqual([
    0, 1, 2,
  ]);
  hydrateSubagentHistory(state, [event(3)], {
    direction: "newer",
    subagentID: "child",
  });
  expect(state.subagentHistory.child?.map((row) => row.continuation)).toEqual([
    0, 1, 2, 3,
  ]);
});

test("checkpoints accumulate and rollback tracks one operation", () => {
  let state = projectEvents([
    {
      type: "checkpoint.created",
      id: "cp_1",
      reason: "turn_begin",
      sequence: 1,
      complete: true,
      files: 3,
      changes: 1,
      contextJournalOffset: 0,
      step: 1,
      tokenEstimate: 10,
      diskUsageBytes: 100,
    } as RuntimeEvent,
  ]);
  expect(state.checkpoints).toHaveLength(1);

  state = projectEvents(
    [
      {
        type: "rollback.begin",
        checkpointID: "cp_1",
        safetyCheckpointID: "cp_safety",
      } as RuntimeEvent,
    ],
    state,
  );
  expect(state.rollback).toMatchObject({ state: "running" });

  state = projectEvents(
    [
      {
        type: "rollback.end",
        checkpointID: "cp_1",
        safetyCheckpointID: "cp_safety",
        restoredFiles: 3,
        deletedFiles: 1,
        contextJournalOffset: 0,
        step: 1,
      } as RuntimeEvent,
    ],
    state,
  );
  expect(state.rollback).toMatchObject({
    state: "completed",
    restoredFiles: 3,
    deletedFiles: 1,
  });
});

test("an incomplete checkpoint is reported, not silently dropped", () => {
  // Rollback safety depends on knowing a checkpoint did not finish.
  const state = projectEvents([
    {
      type: "checkpoint.failed",
      reason: "disk_full",
      message: "no space",
      incomplete: true,
    } as RuntimeEvent,
  ]);
  expect(
    state.messages.some((block) => block.text.includes("incomplete")),
  ).toBe(true);
});

test("a failed rollback records whether it recovered", () => {
  const state = projectEvents([
    {
      type: "rollback.failed",
      checkpointID: "cp_1",
      message: "conflict",
      recovered: false,
    } as RuntimeEvent,
  ]);
  expect(state.rollback).toMatchObject({ state: "failed", recovered: false });
});

test("mcp, plugin and capability states project by identity", () => {
  const state = projectEvents([
    {
      type: "mcp.status",
      server: "docs",
      status: "connected",
      tools: 4,
    } as RuntimeEvent,
    { type: "plugin.update", id: "p1", status: "loaded" } as RuntimeEvent,
    {
      type: "capability.loaded",
      id: "cap:natalia-terminal",
      apiVersion: 1,
      name: "Terminal",
      version: "1.0.0",
      scope: "session",
      grants: ["tools"],
    } as RuntimeEvent,
  ]);
  expect(state.mcp.docs).toMatchObject({ tools: 4 });
  expect(state.plugins.p1).toMatchObject({ status: "loaded" });
  expect(state.capabilities["cap:natalia-terminal"]).toMatchObject({
    name: "Terminal",
  });
});

test("an unloaded capability is removed rather than left as loaded", () => {
  const loaded: RuntimeEvent = {
    type: "capability.loaded",
    id: "cap:x",
    apiVersion: 1,
    name: "X",
    version: "1.0.0",
    scope: "session",
    grants: ["tools"],
  } as RuntimeEvent;
  const state = projectEvents([
    loaded,
    { type: "capability.unloaded", id: "cap:x" } as RuntimeEvent,
  ]);
  expect(state.capabilities).toEqual({});
});

test("context status and compaction banner follow the runtime", () => {
  let state = projectEvents([
    {
      type: "context.status",
      used: 100,
      max: 200,
      source: "exact_checkpoint",
      thresholdPercent: 80,
      reserved: 20,
    } as RuntimeEvent,
    {
      type: "compaction.begin",
      id: "c1",
      trigger: "manual",
      beforeTokens: 100,
      maxTokens: 200,
      thresholdPercent: 80,
      reservedTokens: 20,
      attempt: 1,
      startedAt: "now",
    } as RuntimeEvent,
  ]);
  expect(state.context).toMatchObject({ used: 100, max: 200 });
  expect(state.compactionBanner?.kind).toBe("compacting");

  state = projectEvents(
    [
      {
        type: "compaction.end",
        id: "c1",
        trigger: "manual",
        success: true,
        beforeTokens: 100,
        afterTokens: 40,
        durationMs: 30,
        attempts: 1,
      } as RuntimeEvent,
    ],
    state,
  );
  // The banner clears, but the outcome stays in the transcript because
  // compaction changed what the model can still see.
  expect(state.compactionBanner).toBeUndefined();
  expect(
    state.messages.some((block) => block.text.includes("100 -> 40 tokens")),
  ).toBe(true);
});

test("retry banner appears and clears, exhaustion is recorded", () => {
  let state = projectEvents([
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 300,
      reason: "timeout",
    } as RuntimeEvent,
  ]);
  expect(state.retryBanner?.text).toContain("attempt 2/3");

  state = projectEvents(
    [
      {
        type: "step.retry.cleared",
        id: "t1",
        operation: "llm_step",
        step: 1,
        attempts: 2,
      } as RuntimeEvent,
    ],
    state,
  );
  expect(state.retryBanner).toBeUndefined();

  const exhausted = projectEvents([
    {
      type: "step.retry.exhausted",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempts: 3,
      maxAttempts: 3,
      reason: "timeout",
      message: "gave up after 3 attempts",
      retryable: false,
    } as RuntimeEvent,
  ]);
  expect(exhausted.retryBanner).toBeUndefined();
  expect(
    exhausted.messages.some((block) => block.status === "retry_exhausted"),
  ).toBe(true);
  expect(exhausted.footer).toContain("not retryable");
});

test("pause and resume are reflected and cleared by a terminal turn", () => {
  let state = projectEvents([
    { type: "turn.paused", id: "t1", reason: "user pause" } as RuntimeEvent,
  ]);
  expect(state.paused).toBe(true);

  state = projectEvents(
    [{ type: "turn.resumed", id: "t1" } as RuntimeEvent],
    state,
  );
  expect(state.paused).toBe(false);

  // A turn that ends while paused must not leave the UI showing "paused".
  const stuck = projectEvents([
    { type: "turn.paused", id: "t1", reason: "user pause" } as RuntimeEvent,
    { type: "turn.finished", id: "t1", stopReason: "done" } as RuntimeEvent,
  ]);
  expect(stuck.paused).toBe(false);
});

test("policy decisions are retained so a UI can explain a refusal", () => {
  const state = projectEvents([
    {
      type: "policy.decision",
      turnID: "t1",
      toolName: "write_file",
      decision: "deny",
      reason: "protected path",
    } as RuntimeEvent,
  ]);
  expect(state.policyDecisions).toHaveLength(1);
  expect(state.policyDecisions[0]).toMatchObject({
    decision: "deny",
    reason: "protected path",
  });
});

test("agent and model selections project", () => {
  const state = projectEvents([
    { type: "agent.selection", name: "review", pending: true } as RuntimeEvent,
    {
      type: "model.selection",
      modelID: "m1",
      variant: "high",
    } as RuntimeEvent,
  ]);
  expect(state.agentSelection).toEqual({ name: "review", pending: true });
  expect(state.modelSelection).toEqual({ modelID: "m1", variant: "high" });
});

test("plugin projection contributions project and clear", () => {
  const contributed = projectEvents([
    {
      type: "projections.updated",
      contributions: [
        {
          name: "demo.card",
          title: "Demo card",
          placement: "sidebar",
          text: "hello",
        },
      ],
    } as RuntimeEvent,
  ]);
  expect(contributed.pluginProjections).toEqual([
    {
      name: "demo.card",
      title: "Demo card",
      placement: "sidebar",
      text: "hello",
    },
  ]);
  const cleared = projectEvents(
    [
      {
        type: "projections.updated",
        contributions: [],
      } as RuntimeEvent,
    ],
    contributed,
  );
  expect(cleared.pluginProjections).toEqual([]);
});

test("evidence.recorded projects a message carrying its task", () => {
  const state = projectEvents([
    {
      type: "evidence.recorded",
      id: "evidence:1",
      taskID: "task_build",
      objective: "verify the build",
      status: "promoted",
    } as RuntimeEvent,
  ]);
  expect(state.messages[0]).toMatchObject({
    id: "evidence:1",
    taskID: "task_build",
  });
});

test("streamed tool arguments are reassembled in generic tool state", () => {
  const args = JSON.stringify({ items: [{ content: "x", status: "pending" }] });
  const half = Math.floor(args.length / 2);
  const state = projectEvents([
    {
      type: "turn.submitted",
      id: "t1",
      text: "plan",
      byteLength: 4,
      lineCount: 1,
      sha256: "x",
    },
    {
      type: "tool.update",
      id: "t1",
      name: "todo_write",
      callID: "c1",
      status: "running",
      summary: "…",
      argumentsDelta: args.slice(0, half),
    },
    {
      type: "tool.update",
      id: "t1",
      name: "todo_write",
      callID: "c1",
      status: "succeeded",
      summary: "1 todo",
      argumentsDelta: args.slice(half),
    },
  ]);
  // A half-received argument string must not be parsed or discarded.
  const tool = Object.values(state.tools)[0];
  expect(tool?.argumentsRaw).toBe(args);
  expect(tool?.status).toBe("succeeded");
});

test("session intelligence snapshot projects", () => {
  const state = projectEvents([
    {
      type: "session.snapshot",
      id: "s1",
      agentStatus: "working",
      changedFiles: 3,
      unvalidatedChanges: 1,
      hasPTY: true,
      hasSandbox: false,
    } as RuntimeEvent,
  ]);
  expect(state.intelligence).toMatchObject({
    agentStatus: "working",
    changedFiles: 3,
  });
});

test("Work Graph events project into stable node and edge indexes", () => {
  const state = projectEvents([
    {
      type: "workgraph.node_added",
      id: "wg:action:t1",
      nodeID: "wg:action:t1",
      kind: "agent_action",
      summary: "turn",
      sessionID: "ses_1",
      turnID: "t1",
      episodeID: "epi_1",
    },
    {
      type: "workgraph.node_added",
      id: "wg:tool:t1:c1",
      nodeID: "wg:tool:t1:c1",
      kind: "tool_call",
      summary: "read_file · succeeded",
      actor: "read_file",
      sessionID: "ses_1",
      turnID: "t1",
      episodeID: "epi_1",
    },
    {
      type: "workgraph.edge_added",
      id: "wg:edge:t1:c1",
      sourceID: "wg:action:t1",
      targetID: "wg:tool:t1:c1",
      kind: "caused",
      episodeID: "epi_1",
    },
  ] as RuntimeEvent[]);

  expect(Object.keys(state.workGraphNodes).sort()).toEqual([
    "wg:action:t1",
    "wg:tool:t1:c1",
  ]);
  expect(state.workGraphNodes["wg:tool:t1:c1"]).toMatchObject({
    kind: "tool_call",
    episodeID: "epi_1",
  });
  expect(state.workGraphEdges["wg:edge:t1:c1"]).toMatchObject({
    kind: "caused",
    episodeID: "epi_1",
  });
});

test("constitution, plans, mailbox and evidence project as host-agnostic facts", () => {
  const state = projectEvents([
    {
      type: "constitution.rule_added",
      id: "constitution:c-rel-001",
      ruleID: "C-REL-001",
      statement: "默认不 commit/push",
      scope: "release",
      priority: "critical",
      source: "policy",
      enforcement: "deny",
      overridePolicy: "user_scoped",
    },
    {
      type: "constitution.check",
      id: "check:1",
      ruleID: "C-REL-001",
      statement: "默认不 commit/push",
      priority: "critical",
      enforcement: "deny",
      action: "run_shell",
      resource: "global",
      conflict: true,
    },
    {
      type: "decision.recorded",
      id: "decision:1",
      decision: "ship from a sandbox",
      status: "accepted",
    },
    {
      type: "evidence.recorded",
      id: "evidence:1",
      taskID: "task_build",
      objective: "verify the build",
      status: "promoted",
    },
    {
      type: "completion.recorded",
      id: "completion:1",
      taskID: "task_build",
      objective: "verify the build",
      changeSummary: "1 files promoted from sandbox box",
      validations: [],
      recordedAt: "2026-08-26T00:00:00.000Z",
    },
    {
      type: "mailbox.queued",
      id: "mbq:1",
      messageID: "mb:1",
      source: "user_via_live_chat",
      priority: "normal",
      intent: "constraint",
      text: "keep it small",
      safeSummary: "keep it small",
      deliveryPolicy: "next_safe_boundary",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    {
      type: "mailbox.acknowledged",
      id: "mba:1",
      messageID: "mb:1",
      acknowledgedAt: "2026-08-26T00:00:01.000Z",
    },
    {
      type: "plan.doc.created",
      id: "plan:1:created",
      planID: "plan:1",
      title: "Build plan",
      documentPath: ".natalia/plans/build-plan.md",
      createdBy: "main_agent",
      status: "marked",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    {
      type: "plan.doc.status",
      id: "plan:1:status",
      planID: "plan:1",
      status: "executing",
      at: "2026-08-26T00:00:02.000Z",
    },
  ] as RuntimeEvent[]);
  expect(state.constitutionRules["C-REL-001"]?.enforcement).toBe("deny");
  expect(state.constitutionConflicts).toHaveLength(1);
  expect(state.decisions[0]?.decision).toBe("ship from a sandbox");
  expect(state.evidence[0]?.taskID).toBe("task_build");
  expect(state.completions[0]?.id).toBe("completion:1");
  expect(state.mailbox["mb:1"]?.status).toBe("acknowledged");
  expect(state.plans["plan:1"]).toMatchObject({
    status: "executing",
    documentPath: ".natalia/plans/build-plan.md",
  });
});

test("work graph neighbourhood and unattributed changes are selectable", () => {
  const state = projectEvents([
    {
      type: "workgraph.node_added",
      id: "wg:action:t1",
      nodeID: "wg:action:t1",
      kind: "agent_action",
      summary: "turn",
    },
    {
      type: "workgraph.node_added",
      id: "wg:tool:t1:c1",
      nodeID: "wg:tool:t1:c1",
      kind: "tool_call",
      summary: "write · succeeded",
    },
    {
      type: "workgraph.node_added",
      id: "wg:change:orphan",
      nodeID: "wg:change:orphan",
      kind: "workspace_change",
      summary: "external.txt",
      target: "external.txt",
    },
    {
      type: "workgraph.edge_added",
      id: "wg:edge:t1:c1",
      sourceID: "wg:action:t1",
      targetID: "wg:tool:t1:c1",
      kind: "caused",
    },
  ] as RuntimeEvent[]);
  const slice = selectWorkGraphNeighborhood(state, "wg:action:t1", 1);
  expect(slice.nodes.map((node) => node.nodeID).sort()).toEqual([
    "wg:action:t1",
    "wg:tool:t1:c1",
  ]);
  expect(slice.edges).toHaveLength(1);
  expect(
    selectUnattributedWorkGraphNodes(state).map((node) => node.nodeID),
  ).toEqual(["wg:change:orphan"]);
  expect(slice.unattributed.map((node) => node.nodeID)).toEqual([
    "wg:change:orphan",
  ]);
});

test("UI-only events are ignored, because they are not runtime facts", () => {
  // Dialog stacks and pane focus belong to whichever UI renders them. Projecting
  // them here would create UI-only durable truth in a shared layer.
  const state = initialState();
  const before = JSON.stringify(state);
  for (const event of [
    { type: "dialog.open", id: "d1" },
    { type: "dialog.close", id: "d1" },
    { type: "terminal.pane.select", id: "t_a" },
  ] as RuntimeEvent[])
    applyEvent(state, event);
  expect(JSON.stringify(state)).toBe(before);
});

test("reduceState does not mutate the resource slices it copies", () => {
  const before = projectEvents([terminalUpdate("t_a")]);
  const snapshot = JSON.stringify(before);
  const after = projectEvents([terminalUpdate("t_b")], before);
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(after.terminals).not.toBe(before.terminals);
  expect(Object.keys(after.terminals).sort()).toEqual(["t_a", "t_b"]);
});

test("initialState has every slice a consumer will read", () => {
  // A consumer indexing into an undefined slice is a crash, so the shape must be
  // complete from the start rather than appearing with the first event.
  const state: AppState = initialState();
  expect(state.terminals).toEqual({});
  expect(state.terminalTimeline).toEqual({});
  expect(state.terminalApprovals).toEqual({});
  expect(state.sandboxes).toEqual({});
  expect(state.sandboxDiffs).toEqual({});
  expect(state.subagents).toEqual({});
  expect(state.subagentHistory).toEqual({});
  expect(state.mcp).toEqual({});
  expect(state.plugins).toEqual({});
  expect(state.capabilities).toEqual({});
  expect(state.checkpoints).toEqual([]);
  expect(state.policyDecisions).toEqual([]);
  expect(state.workGraphNodes).toEqual({});
  expect(state.workGraphEdges).toEqual({});
  expect(state.paused).toBe(false);
  expect(state.rollback).toBeUndefined();
  expect(state.context).toBeUndefined();
});

test("a terminal transcript is bounded and says what was dropped", () => {
  // A pane's scrollback grows for the life of the session. Keeping it whole would
  // grow the projection without limit in every consumer that holds it.
  const long = "x".repeat(terminalTranscriptChars + 5_000);
  const state = projectEvents([terminalUpdate("t_a", { transcript: long })]);
  const stored = state.terminals.t_a?.transcript ?? "";

  expect(stored.length).toBeLessThan(long.length);
  // A consumer must not render a truncated scrollback as though it were complete.
  expect(stored).toContain("earlier chars omitted");
  expect(stored).toContain("5000");
  // The visible part is the most recent output, which is what a pane shows.
  expect(stored.endsWith("x".repeat(100))).toBe(true);
});

test("a short transcript is kept exactly as published", () => {
  const state = projectEvents([
    terminalUpdate("t_a", { transcript: "short output" }),
  ]);
  expect(state.terminals.t_a?.transcript).toBe("short output");
});

test("a republished terminal update that changes nothing is dropped", () => {
  // Panes republish on every keystroke; an identical update must not churn the
  // projection and force consumers to re-render.
  const state = projectEvents([terminalUpdate("t_a", { tail: "$ ls" })]);
  const before = state.terminals;

  applyEvent(state, terminalUpdate("t_a", { tail: "$ ls" }));
  // Same identity: the no-op update did not rebuild the record.
  expect(state.terminals).toBe(before);

  applyEvent(state, terminalUpdate("t_a", { tail: "$ ls -l" }));
  expect(state.terminals).not.toBe(before);
  expect(state.terminals.t_a?.tail).toBe("$ ls -l");
});

test("a terminal update that only hands input to a viewer is kept", () => {
  // Who holds the keyboard is rendered ("user control (…)" in the TUI's pane), so
  // dropping this update would tell the reader the model is typing while a person
  // actually is. Nothing else about the pane changes on a takeover.
  const state = projectEvents([
    terminalUpdate("t_a", {
      ownership: "model",
      inputOwner: { type: "model" },
      geometryOwner: { type: "model" },
      viewers: [
        {
          id: "v1",
          kind: "embedded",
          connectedAt: "2026-08-09T00:00:00.000Z",
          lastSeenAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    }),
  ]);
  const before = state.terminals.t_a;

  applyEvent(
    state,
    terminalUpdate("t_a", {
      ownership: "model",
      inputOwner: { type: "viewer", viewerID: "v1" },
      geometryOwner: { type: "model" },
      viewers: [
        {
          id: "v1",
          kind: "embedded",
          connectedAt: "2026-08-09T00:00:00.000Z",
          lastSeenAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    }),
  );
  expect(state.terminals.t_a).not.toBe(before);
  expect(state.terminals.t_a?.inputOwner).toEqual({
    type: "viewer",
    viewerID: "v1",
  });
});

test("a terminal update that only changes the viewer list is kept", () => {
  const viewer = (id: string) => ({
    id,
    kind: "external" as const,
    connectedAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
  });
  const state = projectEvents([
    terminalUpdate("t_a", { viewers: [viewer("v1")] }),
  ]);
  const before = state.terminals.t_a;

  applyEvent(
    state,
    terminalUpdate("t_a", { viewers: [viewer("v1"), viewer("v2")] }),
  );
  expect(state.terminals.t_a).not.toBe(before);
  expect(state.terminals.t_a?.viewers).toHaveLength(2);

  // Structural, not by identity: an equal list republished is still a no-op.
  const kept = state.terminals.t_a;
  applyEvent(
    state,
    terminalUpdate("t_a", { viewers: [viewer("v1"), viewer("v2")] }),
  );
  expect(state.terminals.t_a).toBe(kept);
});

test("a terminal update that only changes the pending approval is kept", () => {
  const state = projectEvents([terminalUpdate("t_a")]);
  const before = state.terminals.t_a;
  applyEvent(state, terminalUpdate("t_a", { approvalID: "apr_1" }));
  expect(state.terminals.t_a).not.toBe(before);
  expect(state.terminals.t_a?.approvalID).toBe("apr_1");
});

test("transcript eviction cuts on a user turn boundary, not at the watermark", () => {
  // Turns are 7 rows long so the naive cutoff (exactly `excess` rows) lands on an
  // assistant row. A cut there would leave a reply with no prompt above it, which
  // reads as the assistant answering nothing. The layout is chosen so a correct
  // implementation and a naive one give different answers.
  const period = 7;
  const messages = Array.from({ length: transcriptLimit + 40 }, (_, index) => ({
    id: `m${index}`,
    role: index % period === 0 ? ("user" as const) : ("assistant" as const),
    text: "x",
    pendingText: "",
  }));
  const naiveKept = transcriptWatermark;
  expect(messages[naiveKept]?.role).toBe("assistant");

  const older = boundTranscript(messages, "older");
  expect(older.evicted).toBe(true);
  // The row just past the kept slice begins a turn, so nothing was cut mid-turn.
  expect(messages[older.messages.length]?.role).toBe("user");
  expect(older.messages.length).not.toBe(naiveKept);

  const newer = boundTranscript(messages, "newer");
  expect(newer.evicted).toBe(true);
  expect(newer.messages[0]?.role).toBe("user");
  expect(newer.messages.length).not.toBe(naiveKept);
});

test("a transcript under the limit is returned untouched", () => {
  const messages = [
    { id: "a", role: "user" as const, text: "q", pendingText: "" },
  ];
  const result = boundTranscript(messages, "older");
  expect(result.evicted).toBe(false);
  expect(result.messages).toBe(messages);
});

test("replaying a terminal timeline entry does not duplicate it", () => {
  // A reconnecting consumer replays durable history, so it receives entries it may
  // already hold. Counting those twice would make the timeline grow on every
  // reconnect and show each action repeatedly.
  const entry = {
    type: "terminal.timeline",
    id: "t_a",
    actor: "model",
    action: "created",
    status: "executed",
    summary: "started bash",
    at: "2026-08-09T00:00:00.000Z",
  } as RuntimeEvent;

  const state = projectEvents([entry, entry, entry]);
  expect(state.terminalTimeline.t_a).toHaveLength(1);

  // A genuinely later entry still appends, so dedupe is not swallowing history.
  const later = projectEvents(
    [{ ...entry, at: "2026-08-09T00:00:01.000Z" } as RuntimeEvent],
    state,
  );
  expect(later.terminalTimeline.t_a).toHaveLength(2);

  // Same instant but a different outcome is a different fact.
  const other = projectEvents(
    [{ ...entry, status: "denied" } as RuntimeEvent],
    state,
  );
  expect(other.terminalTimeline.t_a).toHaveLength(2);
});
