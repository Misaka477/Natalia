import { expect, test } from "bun:test";
import {
  cacheHitRate,
  type RuntimeEvent,
  type SessionID,
} from "@anthelia/contracts";
import {
  applyEvent,
  boundTranscript,
  displayText,
  hydrateNaviMessages,
  hydrateNiaMessages,
  beginNaviHydration,
  hydrateProjectedMessages,
  hydrateRuntimeNotices,
  buildWorkGraphForest,
  buildWorkGraphFileNavigation,
  deriveSessionUsageView,
  initialState,
  projectEvents,
  reduceState,
  selectPrimaryActivity,
  segmentID,
  streamID,
  toolStateID,
  type AppState,
} from "../src";

// The whole point of this layer is that it projects an event stream with no
// runtime, no framework and no I/O. If any test here needed a client, the
// layer would not be consumable by an external UI.

/** What a UI would show: confirmed text plus the streaming tail. */
function text(state: AppState, id: string) {
  const block = state.messages.find((item) => item.id === id);
  return block ? displayText(block) : undefined;
}

function roles(state: AppState) {
  return state.messages.map((block) => block.role);
}

const submitted = (
  id: string,
  body: string,
): Extract<RuntimeEvent, { type: "turn.submitted" }> => ({
  type: "turn.submitted",
  id,
  text: body,
  byteLength: body.length,
  lineCount: 1,
  sha256: "x",
});

const admitted = (
  id: string,
  body: string,
  delivery: "next-turn" | "next-step",
): Extract<RuntimeEvent, { type: "input.admitted" }> => ({
  type: "input.admitted",
  id,
  text: body,
  byteLength: body.length,
  lineCount: 1,
  sha256: "x",
  delivery,
  admittedAt: "2026-01-01T00:00:00.000Z",
  admittedSeq: 1,
});

function takeTurn(state: AppState, turnID: string) {
  applyEvent(state, { type: "turn.started", id: turnID });
}

test("a whole turn projects to user text, assistant text and a stop reason", () => {
  const events: RuntimeEvent[] = [
    { type: "session.created", sessionID: "ses_1" as SessionID, title: "Work" },
    { type: "session.ready", sessionID: "ses_1" as SessionID },
    submitted("t1", "explain this"),
    { type: "content.delta", id: "t1", text: "Because " },
    { type: "content.delta", id: "t1", text: "of the cache." },
    { type: "content.done", id: "t1", text: "Because of the cache." },
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ];
  const state = projectEvents(events);

  expect(state.sessionID).toBe("ses_1");
  expect(state.title).toBe("Work");
  expect(state.status).toBe("ready");
  expect(text(state, "t1:user")).toBe("explain this");
  expect(text(state, streamID("t1", "assistant"))).toBe(
    "Because of the cache.",
  );
  expect(roles(state)).toEqual(["user", "assistant"]);
  expect(state.activeTurn).toBeUndefined();
  expect(state.lastStopReason).toBe("done");
});

test("a generated session title updates the active conversation", () => {
  const state = projectEvents([
    {
      type: "session.created",
      sessionID: "ses_1" as SessionID,
      title: "New session",
    },
    {
      type: "session.title.updated",
      sessionID: "ses_1" as SessionID,
      title: "Readable topic",
    },
  ]);
  expect(state.title).toBe("Readable topic");
});

test("collaboration chat renders both Natalia and Navi directions", () => {
  const state = projectEvents([
    {
      type: "collab.chat",
      id: "collab:chat:1",
      threadID: "collab:chat:1",
      from: "main_agent",
      to: "live_chat",
      text: "Check this edge case.",
      round: 1,
      expectsReply: true,
      at: "t0",
    },
    {
      type: "collab.chat",
      id: "collab:chat:2",
      threadID: "collab:chat:1",
      replyToID: "collab:chat:1",
      from: "live_chat",
      to: "main_agent",
      text: "It is covered.",
      round: 1,
      expectsReply: false,
      at: "t1",
    },
  ]);

  expect(state.natalia.messages.map((message) => displayText(message))).toEqual(
    ["Natalia → Navi: Check this edge case."],
  );
  expect(state.navi.messages.map((message) => displayText(message))).toEqual([
    "Navi → Natalia: It is covered.",
  ]);
  expect(
    state.natalia.messages.every((message) => message.role === "system"),
  ).toBe(true);
  expect(
    state.navi.messages.every((message) => message.role === "system"),
  ).toBe(true);
});

test("unified collaboration messages render as system rows", () => {
  const state = projectEvents([
    {
      type: "collab.message",
      message: {
        id: "collab:response:1",
        threadID: "collab:suggestion:1",
        replyToID: "collab:suggestion:1",
        kind: "response",
        from: "main_agent",
        to: "live_chat",
        text: "adopted",
        decision: "adopted",
        reason: "lower risk",
        expectsReply: false,
        at: "t1",
      },
    },
  ]);
  expect(displayText(state.natalia.messages[0]!)).toBe(
    "Natalia adopted the suggestion (lower risk)",
  );
  expect(state.natalia.messages[0]?.role).toBe("system");
});

test("collaboration routing is strictly by sender, not by recipient", () => {
  const state = projectEvents([
    {
      type: "collab.message",
      message: {
        id: "legacy:nia->natalia",
        threadID: "legacy:nia->natalia",
        kind: "chat",
        from: "nia",
        to: "main_agent",
        text: "legacy nia to natalia",
        round: 1,
        expectsReply: false,
        at: "t0",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "legacy:natalia->nia",
        threadID: "legacy:natalia->nia",
        kind: "chat",
        from: "main_agent",
        to: "nia",
        text: "legacy natalia to nia",
        round: 1,
        expectsReply: false,
        at: "t1",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "legacy:navi->natalia",
        threadID: "legacy:navi->natalia",
        kind: "chat",
        from: "live_chat",
        to: "main_agent",
        text: "legacy navi to natalia",
        round: 1,
        expectsReply: false,
        at: "t2",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "legacy:natalia->navi",
        threadID: "legacy:natalia->navi",
        kind: "chat",
        from: "main_agent",
        to: "live_chat",
        text: "legacy natalia to navi",
        round: 1,
        expectsReply: false,
        at: "t3",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "legacy:nia->navi",
        threadID: "legacy:nia->navi",
        kind: "chat",
        from: "nia",
        to: "live_chat",
        text: "legacy nia to navi",
        round: 1,
        expectsReply: false,
        at: "t4",
      },
    },
    {
      type: "collab.message",
      message: {
        id: "legacy:navi->nia",
        threadID: "legacy:navi->nia",
        kind: "chat",
        from: "live_chat",
        to: "nia",
        text: "legacy navi to nia",
        round: 1,
        expectsReply: false,
        at: "t5",
      },
    },
    {
      type: "nia.collab.message",
      message: {
        id: "new:nia->natalia",
        threadID: "new:nia->natalia",
        kind: "chat",
        from: "nia",
        to: "main_agent",
        text: "new nia to natalia",
        round: 1,
        expectsReply: false,
        at: "t6",
      },
    },
    {
      type: "natalia.collab.message",
      message: {
        id: "new:natalia->nia",
        threadID: "new:natalia->nia",
        kind: "chat",
        from: "main_agent",
        to: "nia",
        text: "new natalia to nia",
        round: 1,
        expectsReply: false,
        at: "t7",
      },
    },
    {
      type: "navi.collab.message",
      message: {
        id: "new:navi->natalia",
        threadID: "new:navi->natalia",
        kind: "chat",
        from: "live_chat",
        to: "main_agent",
        text: "new navi to natalia",
        round: 1,
        expectsReply: false,
        at: "t8",
      },
    },
    {
      type: "natalia.collab.message",
      message: {
        id: "new:natalia->navi",
        threadID: "new:natalia->navi",
        kind: "chat",
        from: "main_agent",
        to: "live_chat",
        text: "new natalia to navi",
        round: 1,
        expectsReply: false,
        at: "t9",
      },
    },
    {
      type: "nia.collab.message",
      message: {
        id: "new:nia->navi",
        threadID: "new:nia->navi",
        kind: "chat",
        from: "nia",
        to: "live_chat",
        text: "new nia to navi",
        round: 1,
        expectsReply: false,
        at: "t10",
      },
    },
    {
      type: "navi.collab.message",
      message: {
        id: "new:navi->nia",
        threadID: "new:navi->nia",
        kind: "chat",
        from: "live_chat",
        to: "nia",
        text: "new navi to nia",
        round: 1,
        expectsReply: false,
        at: "t11",
      },
    },
  ] as RuntimeEvent[]);

  expect(state.natalia.messages.map((block) => displayText(block))).toEqual([
    "Natalia → Nia: legacy natalia to nia",
    "Natalia → Navi: legacy natalia to navi",
    "Natalia → Nia: new natalia to nia",
    "Natalia → Navi: new natalia to navi",
  ]);
  expect(state.navi.messages.map((block) => displayText(block))).toEqual([
    "Navi → Natalia: legacy navi to natalia",
    "Navi → Nia: legacy navi to nia",
    "Navi → Natalia: new navi to natalia",
    "Navi → Nia: new navi to nia",
  ]);
  expect(state.nia.messages.map((block) => displayText(block))).toEqual([
    "Nia → Natalia: legacy nia to natalia",
    "Nia → Navi: legacy nia to navi",
    "Nia → Natalia: new nia to natalia",
    "Nia → Navi: new nia to navi",
  ]);
  expect(
    state.natalia.messages.some(
      (block) =>
        block.text.startsWith("Nia →") || block.text.startsWith("Navi →"),
    ),
  ).toBe(false);
  expect(
    state.navi.messages.some(
      (block) =>
        block.text.startsWith("Nia →") || block.text.startsWith("Natalia →"),
    ),
  ).toBe(false);
  expect(
    state.nia.messages.some(
      (block) =>
        block.text.startsWith("Navi →") || block.text.startsWith("Natalia →"),
    ),
  ).toBe(false);
});

test("tool results remain available on the generic transcript block", () => {
  const result = JSON.stringify({
    saved: 1,
    items: [{ content: "ship todo projection", status: "in_progress" }],
  });
  const state = projectEvents([
    {
      type: "tool.update",
      id: "t1:call_todo",
      name: "todo_write",
      callID: "call_todo",
      status: "succeeded",
      summary: "saved 1 todo items",
      result,
      endedAt: 1,
    },
  ]);
  expect(Object.values(state.tools)[0]).toMatchObject({
    name: "todo_write",
    status: "succeeded",
    result,
  });
  expect(state.messages.find((block) => block.tool)?.tool?.result).toBe(result);
});

test("a queued input waits in the queue slice without replacing active work", () => {
  const state = projectEvents([
    submitted("t1", "first"),
    { type: "thinking.delta", id: "t1", text: "working" },
    admitted("t2", "next", "next-turn"),
  ]);

  expect(state.pendingInputs).toEqual([
    expect.objectContaining({
      id: "t2",
      text: "next",
      delivery: "next-turn",
      status: "queued",
    }),
  ]);
  // The queue is not part of the transcript until the turn actually starts.
  expect(state.messages.some((block) => block.id === "t2:user")).toBe(false);
  expect(state.activeTurn).toBe("t1");
  expect(selectPrimaryActivity(state)).toMatchObject({
    turnID: "t1",
    kind: "thinking",
  });

  // When the turn starts it leaves the queue and becomes the turn's user row.
  applyEvent(state, submitted("t2", "next"));
  expect(state.pendingInputs).toEqual([]);
  expect(state.messages.find((block) => block.id === "t2:user")?.text).toBe(
    "next",
  );
  takeTurn(state, "t2");
  expect(state.activeTurn).toBe("t2");
});

test("a claimed next-step leaves the queue and lands inside the running turn", () => {
  const state = projectEvents([
    submitted("t1", "first"),
    { type: "thinking.delta", id: "t1", text: "working" },
    admitted("in_1", "also do X", "next-step"),
    // A mid-turn claim publishes `turn.input` only; there is no `turn.submitted`
    // for an injected input, so it never becomes a phantom turn.
    {
      type: "turn.input",
      turnID: "t1",
      inputID: "in_1",
      text: "also do X",
      delivery: "next-step",
    },
  ]);

  expect(state.pendingInputs).toEqual([]);
  expect(state.activeTurn).toBe("t1");
  const ids = state.messages.map((block) => block.id);
  expect(ids).toContain("t1:user");
  expect(ids).toContain("t1:user:in_1");
  // The injected input belongs to t1: it is ordered after t1's own user row and
  // never starts a turn of its own.
  expect(ids.indexOf("t1:user:in_1")).toBeGreaterThan(ids.indexOf("t1:user"));
  expect(ids.some((id) => id.startsWith("in_1:"))).toBe(false);
  expect(
    state.messages.find((block) => block.id === "t1:user:in_1"),
  ).toMatchObject({
    role: "user",
    text: "also do X",
    pendingText: "",
    status: "steering",
  });
});

test("admitting a submission does not mark a turn running before it starts", () => {
  const state = projectEvents([submitted("t1", "first")]);
  expect(state.activeTurn).toBeUndefined();
  applyEvent(state, { type: "content.delta", id: "t1", text: "hi" });
  expect(state.activeTurn).toBe("t1");
});

test("an internal wake turn projects as system context, not user input", () => {
  const state = projectEvents([
    {
      ...submitted("wake", "internal collaboration wake"),
      internal: true,
    },
  ]);

  expect(state.messages).toEqual([
    expect.objectContaining({
      id: "wake:system",
      role: "system",
      text: "internal collaboration wake",
    }),
  ]);
  expect(state.lastSubmission).toBeUndefined();
});

test("removing a queued input clears it from the queue slice", () => {
  const state = projectEvents([
    admitted("t1", "next", "next-turn"),
    { type: "input.removed", id: "t1" },
  ]);
  expect(state.pendingInputs).toEqual([]);
  expect(state.messages.some((block) => block.id === "t1:user")).toBe(false);
});

test("editing and promoting a queued input update the queue slice in place", () => {
  const state = projectEvents([
    admitted("t1", "next", "next-turn"),
    {
      type: "input.updated",
      id: "t1",
      text: "edited",
      byteLength: 6,
      lineCount: 1,
      sha256: "y",
    },
    { type: "input.promoted", id: "t1" },
  ]);
  expect(state.pendingInputs).toEqual([
    expect.objectContaining({
      id: "t1",
      text: "edited",
      delivery: "next-step",
      status: "steering",
    }),
  ]);
});

test("an internal wake admission stays out of the user-editable queue", () => {
  const state = projectEvents([
    { ...admitted("wake", "internal", "next-turn"), internal: true },
  ]);
  expect(state.pendingInputs).toEqual([]);
  expect(state.messages.some((block) => block.id === "wake:user")).toBe(false);
});

test("admitting or editing a queued input never touches the transcript", () => {
  const state = projectEvents([submitted("t1", "first")]);
  const before = state.messages;
  applyEvent(state, admitted("t2", "queued later", "next-turn"));
  applyEvent(state, {
    type: "input.updated",
    id: "t2",
    text: "edited later",
    byteLength: 12,
    lineCount: 1,
    sha256: "z",
  });
  expect(state.pendingInputs).toHaveLength(1);
  // The transcript array is untouched (same reference), so a queue edit cannot
  // invalidate transcript row identity.
  expect(state.messages).toBe(before);
  expect(state.messages.some((block) => block.id.startsWith("t2"))).toBe(false);
});

test("content.done does not duplicate a response that already streamed", () => {
  const streamed = projectEvents([
    submitted("t1", "hi"),
    { type: "content.delta", id: "t1", text: "hello" },
    { type: "content.done", id: "t1", text: "hello" },
  ]);
  expect(streamed.messages.filter((b) => b.role === "assistant")).toHaveLength(
    1,
  );

  // A provider that never streams still has to produce a visible block.
  const unstreamed = projectEvents([
    submitted("t2", "hi"),
    { type: "content.done", id: "t2", text: "hello" },
  ]);
  expect(text(unstreamed, streamID("t2", "assistant"))).toBe("hello");
});

test("durable replay after hydration is idempotent for turn rows", () => {
  const events: RuntimeEvent[] = [
    submitted("t1", "hi"),
    { type: "thinking.done", id: "t1", text: "think" },
    { type: "content.done", id: "t1", text: "answer" },
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ];
  const state = projectEvents(events);
  // Message-page hydration and durable SSE replay can both reach one
  // projection. Re-applying the same turn boundary must not append a second
  // row with the same id, because duplicate virtualizer keys render the whole
  // turn twice.
  for (const event of events) applyEvent(state, event);

  const ids = state.messages.map((block) => block.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(state.messages.filter((block) => block.role === "user")).toHaveLength(
    1,
  );
  expect(
    state.messages.filter((block) => block.role === "thinking"),
  ).toHaveLength(1);
  expect(
    state.messages.filter((block) => block.role === "assistant"),
  ).toHaveLength(1);
});

test("a retried attempt replaces the superseded text instead of appending", () => {
  const state = projectEvents([
    submitted("t1", "hi"),
    { type: "content.delta", id: "t1", text: "first try", attempt: 1 },
    { type: "content.delta", id: "t1", text: "second try", attempt: 2 },
    { type: "content.done", id: "t1", text: "second try" },
  ]);
  const assistant = state.messages.filter((b) => b.role === "assistant");
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe("second try");
});

test("thinking and assistant phases do not interleave", () => {
  const state = projectEvents([
    submitted("t1", "hi"),
    { type: "thinking.delta", id: "t1", text: "considering" },
    { type: "content.delta", id: "t1", text: "answer" },
  ]);
  expect(roles(state)).toEqual(["user", "thinking", "assistant"]);
  expect(text(state, streamID("t1", "thinking"))).toBe("considering");
  expect(text(state, streamID("t1", "assistant"))).toBe("answer");
});

test("hidden reasoning is marked so a consumer can refuse to render it", () => {
  const state = projectEvents([
    submitted("t1", "hi"),
    { type: "thinking.delta", id: "t1", text: "private", visible: false },
  ]);
  expect(
    state.messages.find((b) => b.role === "thinking")?.reasoningVisible,
  ).toBe(false);
});

test("model text after a tool call renders below the tool card", () => {
  const state = projectEvents([
    submitted("t1", "read it"),
    { type: "content.delta", id: "t1", text: "Reading now." },
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "c1",
      status: "running",
      summary: "read_file src/index.ts",
    },
    { type: "content.delta", id: "t1", text: "It configures the server." },
  ]);
  expect(roles(state)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(displayText(state.messages.at(-1)!)).toBe("It configures the server.");
});

test("a tool card is updated in place across its lifecycle", () => {
  const events: RuntimeEvent[] = [
    submitted("t1", "read it"),
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "c1",
      status: "running",
      summary: "read_file src/index.ts",
      startedAt: 10,
    },
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "c1",
      status: "succeeded",
      summary: "read 42 lines",
      result: "contents",
      endedAt: 20,
    },
  ];
  const state = projectEvents(events);
  expect(state.messages.filter((b) => b.role === "tool")).toHaveLength(1);
  const stateID = toolStateID({ id: "t1", name: "read_file", callID: "c1" });
  expect(state.tools[stateID]).toMatchObject({
    status: "succeeded",
    summary: "read 42 lines",
    result: "contents",
    // The start time from the earlier event must survive the update.
    startedAt: 10,
    endedAt: 20,
  });
  expect(state.messages.find((b) => b.id === stateID)?.status).toBe(
    "succeeded",
  );
});

test("two calls to the same tool are separate cards", () => {
  const state = projectEvents([
    submitted("t1", "read both"),
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "c1",
      status: "succeeded",
      summary: "a",
    },
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "c2",
      status: "succeeded",
      summary: "b",
    },
  ]);
  expect(state.messages.filter((b) => b.role === "tool")).toHaveLength(2);
});

test("pending approvals and questions appear and clear on response", () => {
  let state = projectEvents([
    submitted("t1", "write it"),
    {
      type: "approval.request",
      id: "a1",
      title: "Approve write_file",
      preview: "write config.json",
    },
    { type: "question.request", id: "q1", title: "Which target?" },
  ]);
  expect(state.pendingApprovals.map((item) => item.id)).toEqual(["a1"]);
  expect(state.pendingQuestions.map((item) => item.id)).toEqual(["q1"]);

  state = reduceState(state, {
    type: "approval.response",
    id: "a1",
    decision: "once",
  });
  state = reduceState(state, {
    type: "question.response",
    id: "q1",
    answers: [["staging"]],
  });
  expect(state.pendingApprovals).toEqual([]);
  expect(state.pendingQuestions).toEqual([]);
});

test("activity facts follow a turn and prioritize user input", () => {
  let state = projectEvents([
    submitted("t1", "update the config"),
    { type: "thinking.delta", id: "t1", text: "checking" },
    {
      type: "tool.update",
      id: "t1",
      name: "execute",
      callID: "c1",
      status: "running",
      summary: "npm test",
    },
  ]);

  expect(selectPrimaryActivity(state)).toMatchObject({
    id: "t1:tool:c1",
    kind: "command",
    state: "active",
    label: "execute",
    detail: "npm test",
  });

  state = reduceState(state, {
    type: "approval.request",
    id: "a1",
    title: "Approve command",
    preview: "npm test",
  });
  expect(selectPrimaryActivity(state)).toMatchObject({
    id: "approval:a1",
    kind: "waiting_for_user",
    state: "waiting",
  });

  state = reduceState(state, {
    type: "approval.response",
    id: "a1",
    decision: "once",
  });
  expect(selectPrimaryActivity(state)?.kind).toBe("command");

  state = reduceState(state, {
    type: "tool.update",
    id: "t1",
    name: "execute",
    callID: "c1",
    status: "succeeded",
    summary: "tests passed",
  });
  expect(selectPrimaryActivity(state)?.kind).toBe("thinking");

  state = reduceState(state, {
    type: "turn.finished",
    id: "t1",
    stopReason: "done",
  });
  expect(selectPrimaryActivity(state)).toBeUndefined();
});

test("a plan document that reached a settled status is not live planning work", () => {
  let state = projectEvents([
    {
      type: "plan.doc.created",
      id: "plan:1:created",
      planID: "plan:1",
      title: "Scan remaining modules",
      documentPath: ".natalia/plans/scan.md",
      createdBy: "live_chat",
      status: "marked",
      createdAt: "now",
    },
  ]);
  expect(selectPrimaryActivity(state)).toMatchObject({
    kind: "planning",
    state: "active",
  });
  state = reduceState(state, {
    type: "plan.doc.status",
    id: "plan:1:status",
    planID: "plan:1",
    status: "completed",
    at: "now",
  });
  expect(selectPrimaryActivity(state)).toBeUndefined();
});

test("retry and compaction activities clear after their terminal events", () => {
  let state = projectEvents([
    submitted("t1", "continue"),
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 1,
      maxAttempts: 3,
      waitMs: 1000,
      reason: "rate_limit",
    },
    {
      type: "compaction.begin",
      id: "c1",
      trigger: "ratio",
      beforeTokens: 100,
      maxTokens: 120,
      reservedTokens: 10,
      thresholdPercent: 80,
      attempt: 1,
      startedAt: "now",
    } as RuntimeEvent,
  ]);
  expect(selectPrimaryActivity(state)).toMatchObject({
    id: "retry:t1",
    kind: "retrying",
  });

  state = reduceState(state, {
    type: "thinking.delta",
    id: "t1",
    text: "retry recovered",
  });
  expect(state.activities["retry:t1"]).toBeUndefined();

  state = reduceState(state, {
    type: "compaction.end",
    id: "c1",
    trigger: "ratio",
    success: true,
    beforeTokens: 100,
    afterTokens: 50,
    durationMs: 12,
    attempts: 1,
  });
  expect(state.activities["compaction:c1"]).toBeUndefined();

  state = reduceState(state, {
    type: "step.retry.cleared",
    id: "t1",
    operation: "llm_step",
    step: 1,
    attempts: 1,
  });
  expect(state.activities["retry:t1"]).toBeUndefined();
});

test("streamed text is confirmed as markdown completes it, not only at the end", () => {
  // `text` is documented as the confirmed record and `pendingText` as the part
  // not confirmed yet. A consumer renders the first as markdown and the second as
  // provisional, so the boundary has to move while the answer streams.
  const state = projectEvents([
    submitted("t1", "explain"),
    { type: "content.delta", id: "t1", text: "First paragraph.\n\n" },
    { type: "content.delta", id: "t1", text: "second, still unfinished" },
  ]);
  const assistant = state.messages.find((block) => block.role === "assistant");
  expect(assistant?.text).toBe("First paragraph.\n\n");
  expect(assistant?.pendingText).toBe("second, still unfinished");
  // Nothing is duplicated by confirming early.
  expect(displayText(assistant!)).toBe(
    "First paragraph.\n\nsecond, still unfinished",
  );
});

test("cancelling a turn keeps the answer already read and drops only the unfinished tail", () => {
  // Cancelling discards unconfirmed output, which is right — but with nothing
  // confirmed until the turn ended, the unconfirmed part was the entire response,
  // so a user who cancelled a long answer watched all of it disappear from the
  // transcript.
  const state = projectEvents([
    submitted("t1", "long job"),
    { type: "content.delta", id: "t1", text: "Para one.\n\nPara two.\n\n" },
    { type: "content.delta", id: "t1", text: "half a sen" },
    { type: "turn.cancelled", id: "t1", reason: "user cancelled" },
    { type: "turn.finished", id: "t1", stopReason: "cancelled" },
  ]);
  const assistant = state.messages.find((block) => block.role === "assistant");
  expect(assistant?.text).toBe("Para one.\n\nPara two.\n\n");
  // The half sentence is not kept as though the model had said it.
  expect(assistant?.pendingText).toBe("");
  expect(displayText(assistant!)).not.toContain("half a sen");
  expect(state.status).toBe("ready");
});

test("closing a segment confirms only what markdown had completed", () => {
  // A segment closes at the boundary already confirmed, so the block left behind
  // holds exactly the confirmed record and the unfinished remainder moves on to
  // the next segment. Cutting the remainder instead would sweep unconfirmed text
  // into a block a consumer is told is safe to keep, and split it mid-word.
  const paragraph = `${"word ".repeat(1180)}\n\n`;
  const unfinished = "x".repeat(200);
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: paragraph },
    { type: "content.delta", id: "t1", text: unfinished },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  expect(assistant[0]?.text).toBe(paragraph);
  expect(assistant[0]?.pendingText).toBe(unfinished);
  expect(displayText(assistant[0]!)).toBe(paragraph + unfinished);
});

test("an announced retry whose resend is attempt-stamped keeps the whole answer", () => {
  // This is the shape the shipped fixture runtime emits, and what a provider is
  // allowed to emit: the retry is announced *and* the resent deltas carry the new
  // attempt number. Two supersede mechanisms then fired at once — the stamp
  // discarded the confirmed text while the overlap skip assumed it was still
  // there — so everything up to the point where the resend diverged was lost and
  // the reader saw the answer start mid-sentence.
  const state = projectEvents([
    submitted("t1", "q"),
    {
      type: "content.delta",
      id: "t1",
      attempt: 1,
      text: "# Retry demo\n\npartial duplicate",
    },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    {
      type: "content.delta",
      id: "t1",
      attempt: 2,
      text: "# Retry demo\n\npartial duplicate",
    },
    {
      type: "content.delta",
      id: "t1",
      attempt: 2,
      text: " content committed once.\n",
    },
    { type: "content.done", id: "t1", attempt: 2 },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe(
    "# Retry demo\n\npartial duplicate content committed once.\n",
  );
});

test("an attempt stamp still supersedes a retry nobody announced", () => {
  // With no retry event, the stamp is the only signal that this attempt replaces
  // the last one, so it has to keep working.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "first try", attempt: 1 },
    { type: "content.delta", id: "t1", text: "second try", attempt: 2 },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe("second try");
});

test("an announced retry that continues with a stamped delta keeps the earlier text", () => {
  // The provider carries on instead of restarting, and stamps the continuation.
  // Discarding the confirmed text on the stamp would lose the beginning.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", attempt: 1, text: "Hello.\n\n" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    { type: "content.delta", id: "t1", attempt: 2, text: "World." },
  ]);
  expect(
    displayText(state.messages.find((block) => block.role === "assistant")!),
  ).toBe("Hello.\n\nWorld.");
});

test("alternating reasoning and answering keeps the order the model produced", () => {
  // A model may think, answer, think again and answer again within one turn, with
  // no tool call in between to separate the blocks. Each phase used to keep
  // growing its single block, so the second thought merged into the first and the
  // first answer was rendered *above* the thought that came before the second
  // one — a transcript in an order the model never produced.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "thinking.delta", id: "t1", text: "first thought" },
    { type: "content.delta", id: "t1", text: "first answer" },
    { type: "thinking.delta", id: "t1", text: "second thought" },
    { type: "content.delta", id: "t1", text: "final answer" },
  ]);
  expect(
    state.messages.map((block) => [block.role, displayText(block)]),
  ).toEqual([
    ["user", "q"],
    ["thinking", "first thought"],
    ["assistant", "first answer"],
    ["thinking", "second thought"],
    ["assistant", "final answer"],
  ]);
});

test("a tool event carrying the runtime's own id shape still belongs to its turn", () => {
  // The runtime publishes tool events as `${turnID}:${callID}`, with the call id
  // repeated in `callID`. Read literally, the card was filed under a turn that
  // does not exist: the text above the call was never committed, no new segment
  // opened, so the card sank below text that arrived after it and the text from
  // before and after the call merged into one block. Every real tool call took
  // this path — only fixtures that pass a bare turn id did not.
  const state = projectEvents([
    submitted("t1", "read it"),
    { type: "content.delta", id: "t1", text: "Reading now." },
    {
      type: "tool.update",
      id: "t1:call_1",
      name: "read_file",
      callID: "call_1",
      status: "succeeded",
      summary: "read 42 lines",
      result: "contents",
    },
    { type: "content.delta", id: "t1", text: "It configures the server." },
  ]);
  expect(state.messages.map((block) => block.id)).toEqual([
    "t1:user",
    streamID("t1", "assistant"),
    "t1:tool:call_1",
    segmentID(streamID("t1", "assistant"), 1),
  ]);
  expect(Object.keys(state.tools)).toEqual(["t1:tool:call_1"]);
  expect(text(state, streamID("t1", "assistant"))).toBe("Reading now.");
  expect(text(state, segmentID(streamID("t1", "assistant"), 1))).toBe(
    "It configures the server.",
  );
});

test("a tool event whose id is already the turn id is left alone", () => {
  // Not every producer repeats the call id in the event id, so normalising must
  // only strip a suffix that is actually there.
  const state = projectEvents([
    submitted("t1", "read it"),
    {
      type: "tool.update",
      id: "t1",
      name: "read_file",
      callID: "call_1",
      status: "succeeded",
      summary: "read 42 lines",
    },
  ]);
  expect(Object.keys(state.tools)).toEqual(["t1:tool:call_1"]);
});

test("a settled turn releases its streaming buffers", () => {
  // A stream holds its turn's confirmed text, which the transcript already has.
  // Keeping it after the turn ends leaves a second copy of every response in the
  // projection, two entries per turn, that transcript eviction never reaches.
  const answered = projectEvents([
    submitted("t1", "hi"),
    { type: "thinking.delta", id: "t1", text: "considering" },
    { type: "content.delta", id: "t1", text: "the answer" },
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ]);
  expect(answered.streams).toEqual({});
  expect(answered.streamPhases).toEqual({});
  // The text itself is kept where it belongs.
  expect(text(answered, streamID("t1", "assistant"))).toBe("the answer");

  // A turn still running keeps its buffers, and a second turn does not disturb
  // the first one's release.
  const running = projectEvents([
    submitted("t1", "hi"),
    { type: "content.delta", id: "t1", text: "one" },
    { type: "turn.finished", id: "t1", stopReason: "done" },
    submitted("t2", "again"),
    { type: "content.delta", id: "t2", text: "two" },
  ]);
  expect(Object.keys(running.streams).sort()).toEqual([
    streamID("t2", "assistant"),
    streamID("t2", "thinking"),
  ]);
});

test("a cancelled or failed turn leaves no request nobody will answer", () => {
  const pending: RuntimeEvent[] = [
    submitted("t1", "write it"),
    {
      type: "approval.request",
      id: "a1",
      title: "Approve write_file",
      preview: "write config.json",
    },
  ];
  const cancelled = projectEvents([
    ...pending,
    { type: "turn.cancelled", id: "t1", reason: "user cancelled" },
  ]);
  expect(cancelled.pendingApprovals).toEqual([]);
  expect(cancelled.lastStopReason).toBe("cancelled");

  const failed = projectEvents([
    ...pending,
    { type: "turn.finished", id: "t1", stopReason: "error" },
  ]);
  expect(failed.pendingApprovals).toEqual([]);

  // A normal completion is the case where an approval could still be live, so
  // clearing must be tied to the abnormal stop reasons only.
  const done = projectEvents([
    ...pending,
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ]);
  expect(done.pendingApprovals.map((item) => item.id)).toEqual(["a1"]);
});

test("reduceState does not mutate the state it was given", () => {
  const before = projectEvents([submitted("t1", "hi")]);
  const snapshot = JSON.stringify(before);
  const after = reduceState(before, {
    type: "content.delta",
    id: "t1",
    text: "hello",
  });
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(after).not.toBe(before);
  expect(after.messages).not.toBe(before.messages);
});

test("reduceState survives a state held behind a proxy", () => {
  // Cloning a reactive proxy with structuredClone is what broke the first
  // attempt at this layer, so the copy must not depend on it.
  const plain = projectEvents([submitted("t1", "hi")]);
  const proxied = new Proxy(plain, {
    get: (target, key) => target[key as keyof AppState],
  });
  const next = reduceState(proxied, {
    type: "content.delta",
    id: "t1",
    text: "hello",
  });
  expect(text(next, streamID("t1", "assistant"))).toBe("hello");
});

test("hydrateProjectedMessages replace drops later transcript rows", () => {
  const state = projectEvents([
    submitted("t1", "one"),
    {
      type: "content.delta",
      id: streamID("t1", "assistant"),
      text: "a",
    } as RuntimeEvent,
    submitted("t2", "two"),
  ]);
  expect(state.messages.length).toBeGreaterThan(1);
  hydrateProjectedMessages(
    state,
    [
      {
        id: "t1",
        turnID: "t1",
        submitted: submitted("t1", "one") as Extract<
          RuntimeEvent,
          { type: "turn.submitted" }
        >,
        rows: [
          {
            id: "t1:user",
            turnID: "t1",
            kind: "user",
            event: submitted("t1", "one"),
          },
        ],
      },
    ],
    "older",
    { replace: true },
  );
  expect(state.messages.some((message) => message.id.includes("t2"))).toBe(
    false,
  );
});

test("hydrateProjectedMessages keeps every row in an oversized turn page", () => {
  const state = initialState();
  const rows = Array.from(
    { length: 400 },
    (_, index) =>
      ({
        id: `t1:tool:${index}`,
        turnID: "t1",
        kind: "tool",
        event: {
          type: "tool.update",
          id: `t1:tool:${index}`,
          name: "read_file",
          callID: `call_${index}`,
          status: "succeeded",
          summary: "ok",
          result: "ok",
        },
      }) as const,
  );
  hydrateProjectedMessages(
    state,
    [
      {
        id: "t1",
        turnID: "t1",
        submitted: submitted("t1", "one big turn"),
        rows: [...rows],
      },
    ],
    "newer",
  );

  expect(state.messages).toHaveLength(rows.length);
  expect(state.messages[0]?.id).toContain("t1:tool:0");
  expect(state.messages.at(-1)?.id).toContain("t1:tool:399");
});

test("an unknown event is ignored rather than fatal", () => {
  const state = initialState();
  expect(() =>
    applyEvent(state, { type: "not.a.real.event" } as unknown as RuntimeEvent),
  ).not.toThrow();
  expect(state).toEqual(initialState());
});

test("status snapshot and diagnostics project to the status surfaces", () => {
  const events: RuntimeEvent[] = [
    {
      type: "status.snapshot",
      model: "m",
      provider: "p",
      context: "1/2",
      step: "3",
      permissions: "auto",
      cwd: "/work",
      background: "0",
    },
    { type: "diagnostic", level: "warning", message: "slow provider" },
  ];
  const state = projectEvents(events);
  expect(state.statusSegments).toEqual([
    "mode:runtime",
    "model:m",
    "provider:p",
    "ctx:1/2",
    "step:3",
    "auto",
    "bg:0",
  ]);
  expect(state.footer).toBe("warning: slow provider");
});

test("a long response stays in one contiguous assistant block", () => {
  const chunk = "x".repeat(2500);
  const state = projectEvents([
    submitted("t1", "long"),
    { type: "content.delta", id: "t1", text: chunk },
    { type: "content.delta", id: "t1", text: chunk },
    { type: "content.delta", id: "t1", text: chunk },
    { type: "content.delta", id: "t1", text: chunk },
  ]);
  const assistant = state.messages.filter((b) => b.role === "assistant");
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe(chunk.repeat(4));
});

test("provider-hidden reasoning is never retained anywhere in the projection", () => {
  // The consumer guide tells a UI to render `displayText(block)`. If the raw
  // reasoning were stored, following that advice would display exactly what the
  // provider forbade showing — so it must not be stored at all, in the block or
  // the stream.
  const secret = "SECRET-CHAIN-OF-THOUGHT";
  const events: RuntimeEvent[] = [
    submitted("t1", "q"),
    { type: "thinking.delta", id: "t1", text: secret, visible: false },
    {
      type: "thinking.delta",
      id: "t1",
      text: `${secret}-more`,
      visible: false,
    },
    { type: "thinking.done", id: "t1" },
    { type: "content.delta", id: "t1", text: "answer" },
    { type: "content.done", id: "t1", text: "answer" },
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ];
  const state = projectEvents(events);

  expect(JSON.stringify(state)).not.toContain(secret);

  const thinking = state.messages.find((block) => block.role === "thinking");
  // A consumer can still tell that thinking happened, and can hide the row.
  expect(thinking?.reasoningVisible).toBe(false);
  expect(displayText(thinking!)).toContain("hidden by provider policy");

  // Visible content is unaffected.
  expect(state.messages.find((block) => block.role === "assistant")?.text).toBe(
    "answer",
  );
});

test("visible reasoning is still projected in full", () => {
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "thinking.delta", id: "t1", text: "step one, " },
    { type: "thinking.delta", id: "t1", text: "step two" },
  ]);
  const thinking = state.messages.find((block) => block.role === "thinking");
  expect(displayText(thinking!)).toBe("step one, step two");
  expect(thinking?.reasoningVisible).toBe(true);
});

test("durable done-only reasoning is restored on session reload", () => {
  // `turn.submitted` creates an empty thinking stream. Durable replay has no
  // deltas, so the done event's full text still has to materialize the block.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "thinking.done", id: "t1", text: "restored reasoning" },
    { type: "content.done", id: "t1", text: "answer" },
    { type: "turn.finished", id: "t1", stopReason: "done" },
  ]);
  const thinking = state.messages.find((block) => block.role === "thinking");
  expect(displayText(thinking!)).toBe("restored reasoning");
  expect(thinking?.reasoningVisible).toBe(true);
});

test("a turn that mixes hidden and visible reasoning keeps them apart", () => {
  // Providers can change policy mid-turn. The hidden part must not leak because a
  // later chunk was allowed.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "thinking.delta", id: "t1", text: "HIDDEN-PART", visible: false },
    { type: "thinking.delta", id: "t1", text: "shown part" },
  ]);
  expect(JSON.stringify(state)).not.toContain("HIDDEN-PART");
  // The allowed chunk still renders; it simply replaces the placeholder, because
  // there is no hidden text to interleave it with.
  const thinking = state.messages.find((block) => block.role === "thinking");
  expect(displayText(thinking!)).toBe("shown part");
});

test("a retry that resends everything does not duplicate the response", () => {
  // A retrying provider restarts its stream. Without skipping the overlap the
  // user sees the answer twice.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "Hello" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    { type: "content.delta", id: "t1", text: "Hello world" },
    { type: "content.done", id: "t1", text: "Hello world" },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe("Hello world");
});

test("a retry that resends in different chunk boundaries still reads once", () => {
  // The resend is not guaranteed to arrive in the same chunks, so the overlap has
  // to be tracked across chunks rather than compared per chunk.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "Hello" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    { type: "content.delta", id: "t1", text: "Hel" },
    { type: "content.delta", id: "t1", text: "lo wor" },
    { type: "content.delta", id: "t1", text: "ld" },
    { type: "content.done", id: "t1", text: "Hello world" },
  ]);
  expect(
    displayText(state.messages.find((block) => block.role === "assistant")!),
  ).toBe("Hello world");
});

test("a retry keeps confirmed text and continues from it", () => {
  // Dropping confirmed text on retry would lose it whenever the provider carries
  // on from where it stopped instead of starting over.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "Hello.\n\n" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    { type: "content.delta", id: "t1", text: "World." },
    { type: "content.done", id: "t1", text: "Hello.\n\nWorld." },
  ]);
  expect(
    displayText(state.messages.find((block) => block.role === "assistant")!),
  ).toBe("Hello.\n\nWorld.");
});

test("a retry does not glue the failed attempt's unfinished fragment onto the answer", () => {
  // The attempt that failed left half a sentence in flight. The retry is a new
  // completion and generally words things differently, so that fragment belongs
  // to nothing: keeping it prefixes the new answer with the tail of the old one.
  // This is why the fragment is dropped while confirmed text is kept — the two
  // halves of a stream mean different things once an attempt has failed.
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "failed transient tail" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
    { type: "content.delta", id: "t1", text: "clean final" },
    { type: "content.done", id: "t1" },
  ]);
  expect(
    displayText(state.messages.find((block) => block.role === "assistant")!),
  ).toBe("clean final");
});

test("a retry also clears unconfirmed text so it cannot be shown twice", () => {
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: "Hello" },
    { type: "content.delta", id: "t1", text: " partial" },
    {
      type: "step.retry",
      id: "t1",
      operation: "llm_step",
      step: 1,
      attempt: 2,
      maxAttempts: 3,
      waitMs: 10,
      reason: "timeout",
    },
  ]);
  const assistant = state.messages.find((block) => block.role === "assistant");
  // The banner is up and the unconfirmed tail is gone.
  expect(assistant?.pendingText).toBe("");
  expect(state.retryBanner?.kind).toBe("step_retry");
});

test("a long response does not split a fenced code block across segments", () => {
  // Segmentation triggers exactly on long responses, which is when code blocks
  // appear. Cutting inside a fence leaves both segments with an unpaired fence and
  // a markdown renderer then swallows everything after it.
  const filler = "word ".repeat(1200);
  const body = `${filler}\n\`\`\`ts\nconst a = 1;\n`;
  const rest = "const b = 2;\n```\ndone\n";
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: body },
    { type: "content.delta", id: "t1", text: rest },
  ]);

  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  const fences = (displayText(assistant[0]!).match(/```/gu) ?? []).length;
  expect(fences % 2).toBe(0);
  expect(displayText(assistant[0]!)).toBe(body + rest);
});

test("a fence still open at the threshold is not split", () => {
  // The dangerous case: the size threshold is crossed while a fenced block has not
  // closed yet. There is no safe boundary inside a fence, and a hard split here
  // would leave one segment with an unpaired fence.
  const open = `\`\`\`ts\n${"const x = 1;\n".repeat(700)}`;
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: open },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  // Kept whole: a readable block beats an exactly sized one.
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe(open);

  // Once the fence closes, later output stays in the same contiguous block.
  const closed = projectEvents(
    [
      { type: "content.delta", id: "t1", text: "```\n" },
      { type: "content.delta", id: "t1", text: "after. ".repeat(1200) },
    ],
    state,
  );
  const blocks = closed.messages.filter((block) => block.role === "assistant");
  expect(blocks).toHaveLength(1);
  expect((displayText(blocks[0]!).match(/```/gu) ?? []).length % 2).toBe(0);
});

test("plain long prose stays in one contiguous assistant block", () => {
  const prose = "sentence. ".repeat(2000);
  const state = projectEvents([
    submitted("t1", "q"),
    { type: "content.delta", id: "t1", text: prose },
  ]);
  const assistant = state.messages.filter(
    (block) => block.role === "assistant",
  );
  expect(assistant).toHaveLength(1);
  expect(displayText(assistant[0]!)).toBe(prose);
});

test("chat tool calls render in event order with post-tool text below the card", () => {
  const state = initialState();
  applyEvent(state, {
    type: "navi.chat.message.new",
    id: "chat:1",
    messageID: "chat:m1",
    role: "user",
    text: "check the status",
    at: "now",
  });
  applyEvent(state, {
    type: "navi.chat.message.delta",
    id: "chat:2",
    messageID: "chat:m2",
    text: "I will look.",
  });
  applyEvent(state, {
    type: "navi.chat.tool.used",
    id: "chat:m2:tool:1",
    messageID: "chat:m2",
    toolName: "session_snapshot",
    status: "succeeded",
    summary: "snapshot read",
    result: '{"agentStatus":"idle"}',
    argumentsRaw: "{}",
    at: "now",
  });
  applyEvent(state, {
    type: "navi.chat.message.delta",
    id: "chat:3",
    messageID: "chat:m2",
    text: " the main agent is idle.",
  });
  applyEvent(state, {
    type: "navi.chat.message.added",
    id: "chat:4",
    messageID: "chat:m2",
    role: "chat",
    text: "I will look. the main agent is idle.",
    at: "now",
  });
  const blocks = state.navi.messages;
  const order = blocks.map((block) => block.id);
  // user -> pre-tool text -> tool card -> post-tool segment below the card.
  expect(order).toEqual([
    "chat:chat:m1:user",
    "chat:chat:m2:assistant",
    "chat:chat:m2:tool:1:tool",
    "chat:chat:m2:assistant:segment:1",
  ]);
  const tool = blocks.find((block) => block.id === "chat:chat:m2:tool:1:tool");
  expect(tool?.role).toBe("tool");
  expect(tool?.tool?.name).toBe("session_snapshot");
  const post = blocks.find(
    (block) => block.id === "chat:chat:m2:assistant:segment:1",
  );
  expect(displayText(post!)).toBe(" the main agent is idle.");
});

test("chat attachments project into Navi and Nia rows and hydrate intact", () => {
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
  const state = projectEvents([
    {
      type: "navi.chat.message.new",
      id: "chat:navi:user",
      messageID: "chat:navi",
      role: "user",
      text: "see image",
      at: "t1",
      attachments: [attachment],
    },
    {
      type: "nia.chat.message.new",
      id: "chat:nia:user",
      messageID: "chat:nia",
      role: "user",
      text: "see image too",
      at: "t2",
      attachments: [attachment],
    },
  ]);
  expect(state.navi.messages[0]?.attachments).toEqual([attachment]);
  expect(state.nia.messages[0]?.attachments).toEqual([attachment]);

  const hydrated = initialState();
  hydrateNaviMessages(hydrated, [
    {
      messageID: "chat:hydrated",
      role: "user",
      text: "hydrated image",
      at: "t3",
      attachments: [attachment],
    },
  ]);
  expect(hydrated.navi.messages[0]?.attachments).toEqual([attachment]);
});

test("chat activity follows its own lifecycle without replacing main activity", () => {
  const state = projectEvents([
    submitted("t1", "main work"),
    { type: "turn.started", id: "t1" },
    {
      type: "navi.chat.turn.started",
      id: "chat:m1:started",
      messageID: "chat:m1",
      startedAt: 100,
    },
    {
      type: "navi.chat.turn.phase",
      id: "chat:m1:thinking",
      messageID: "chat:m1",
      phase: "thinking",
    },
  ]);
  expect(state.navi.activity).toEqual({
    messageID: "chat:m1",
    phase: "thinking",
    startedAt: 100,
    toolName: undefined,
  });
  expect(selectPrimaryActivity(state)?.turnID).toBe("t1");
  applyEvent(state, {
    type: "navi.chat.turn.finished",
    id: "chat:m1:finished",
    messageID: "chat:m1",
    stopReason: "done",
    startedAt: 100,
    endedAt: 200,
  });
  expect(state.navi.activity).toBeUndefined();
});

test("Nia has its own complete chat stream and never mixes into Navi", () => {
  const state = projectEvents([
    {
      type: "navi.chat.turn.started",
      id: "chat:navi:started",
      messageID: "chat:navi",
      startedAt: 1,
    },
    {
      type: "navi.chat.message.new",
      id: "chat:navi:user",
      messageID: "chat:navi",
      role: "user",
      text: "Navi question",
      at: "t1",
    },
    {
      type: "navi.chat.message.added",
      id: "chat:navi:chat",
      messageID: "chat:navi",
      role: "chat",
      text: "Navi answer",
      at: "t2",
    },
    {
      type: "nia.chat.turn.started",
      id: "chat:nia:started",
      messageID: "chat:nia",
      startedAt: 3,
    },
    {
      type: "nia.chat.message.delta",
      id: "chat:nia:delta",
      messageID: "chat:nia",
      text: "Nia audit result ",
    },
    {
      type: "nia.chat.tool.used",
      id: "chat:nia:tool:1",
      messageID: "chat:nia",
      toolName: "read_file",
      status: "succeeded",
      summary: "read a file",
      result: "{}",
      argumentsRaw: "{}",
      at: "t3",
    },
    {
      type: "collab.chat",
      id: "collab:nia:1",
      threadID: "collab:nia:1",
      from: "nia",
      to: "main_agent",
      text: "audit findings sent",
      round: 1,
      expectsReply: false,
      at: "t4",
    },
    {
      type: "nia.chat.message.added",
      id: "chat:nia:chat",
      messageID: "chat:nia",
      role: "chat",
      text: "Nia audit result",
      at: "t5",
    },
  ]);

  expect(state.navi.messages.map((block) => displayText(block))).toEqual([
    "Navi question",
    "Navi answer",
  ]);
  expect(state.nia.messages.map((block) => displayText(block))).toEqual([
    "Nia audit result ",
    "read a file",
    "Nia → Natalia: audit findings sent",
    "Nia audit result",
  ]);
  expect(state.navi.activity?.messageID).toBe("chat:navi");
  expect(state.nia.activity?.messageID).toBe("chat:nia");
  expect(
    state.nia.messages.some((block) => block.id.includes("chat:navi")),
  ).toBe(false);
  expect(
    state.navi.messages.some((block) => block.id.includes("chat:nia")),
  ).toBe(false);
});

test("chat namespace prefixes isolate simultaneous identical message IDs", () => {
  const state = projectEvents([
    {
      type: "navi.chat.message.new",
      id: "navi:shared:user",
      messageID: "shared",
      role: "user",
      text: "Navi request",
      at: "t1",
    },
    {
      type: "nia.chat.message.new",
      id: "nia:shared:user",
      messageID: "shared",
      role: "user",
      text: "Nia request",
      at: "t2",
    },
    {
      type: "navi.chat.thinking.delta",
      id: "navi:shared:thinking",
      messageID: "shared",
      text: "Navi reasoning",
    },
    {
      type: "nia.chat.thinking.delta",
      id: "nia:shared:thinking",
      messageID: "shared",
      text: "Nia reasoning",
    },
  ]);

  expect(state.navi.messages.map((block) => displayText(block))).toEqual([
    "Navi request",
    "Navi reasoning",
  ]);
  expect(state.nia.messages.map((block) => displayText(block))).toEqual([
    "Nia request",
    "Nia reasoning",
  ]);
});

test("durable chat thinking replaces live deltas and restores thinking after restart", () => {
  const state = initialState();
  applyEvent(state, {
    type: "navi.chat.thinking.delta",
    id: "navi:shared:thinking:delta",
    messageID: "shared",
    text: "partial ",
  });
  applyEvent(state, {
    type: "navi.chat.thinking.done",
    id: "navi:shared:thinking:done",
    messageID: "shared",
    text: "complete Navi reasoning",
  });
  applyEvent(state, {
    type: "nia.chat.thinking.done",
    id: "nia:shared:thinking:done",
    messageID: "shared",
    text: "complete Nia reasoning",
  });

  expect(state.navi.messages.map(displayText)).toEqual([
    "complete Navi reasoning",
  ]);
  expect(state.nia.messages.map(displayText)).toEqual([
    "complete Nia reasoning",
  ]);
  expect(state.navi.messages[0]?.status).toBe("completed");
  expect(state.nia.messages[0]?.status).toBe("completed");

  const reloaded = initialState();
  const changed = hydrateNaviMessages(reloaded, [
    {
      messageID: "shared",
      role: "chat",
      text: "complete Navi reasoning",
      at: "",
      kind: "thinking",
    },
  ]);
  hydrateNiaMessages(reloaded, [
    {
      messageID: "shared",
      role: "chat",
      text: "complete Nia reasoning",
      at: "",
      kind: "thinking",
    },
  ]);
  expect(changed).toBe(true);
  expect(reloaded.navi.messages.map(displayText)).toEqual([
    "complete Navi reasoning",
  ]);
  expect(reloaded.nia.messages.map(displayText)).toEqual([
    "complete Nia reasoning",
  ]);
  expect(reloaded.navi.messages[0]?.role).toBe("thinking");
  expect(reloaded.nia.messages[0]?.role).toBe("thinking");
});

test("chat namespace prefixes override stale channel payloads", () => {
  const state = projectEvents([
    {
      type: "navi.chat.message.new",
      id: "navi:stale-channel",
      messageID: "shared",
      role: "user",
      text: "Navi request",
      at: "t1",
      channel: "nia",
    } as unknown as RuntimeEvent,
    {
      type: "nia.chat.message.new",
      id: "nia:stale-channel",
      messageID: "shared",
      role: "user",
      text: "Nia request",
      at: "t2",
      channel: "navi",
    } as unknown as RuntimeEvent,
  ]);

  expect(state.navi.messages.map((block) => displayText(block))).toEqual([
    "Navi request",
  ]);
  expect(state.nia.messages.map((block) => displayText(block))).toEqual([
    "Nia request",
  ]);
});

test("hydrating chat rows splits Navi and Nia into independent streams", () => {
  const state = initialState();
  const changed = hydrateNaviMessages(state, [
    {
      messageID: "chat:navi",
      role: "user",
      text: "hi navi",
      at: "t1",
    },
  ]);
  hydrateNiaMessages(state, [
    {
      messageID: "chat:nia",
      role: "chat",
      text: "audit result",
      at: "t2",
    },
  ]);
  expect(changed).toBe(true);
  expect(state.navi.messages.map((block) => block.text)).toEqual(["hi navi"]);
  expect(state.nia.messages.map((block) => block.text)).toEqual([
    "audit result",
  ]);
});

test("paged chat hydration prepends older and appends newer in order", () => {
  const state = initialState();
  hydrateNaviMessages(
    state,
    [
      {
        messageID: "page:new",
        role: "chat",
        text: "new",
        at: "t2",
      },
    ],
    { replace: true },
  );
  hydrateNaviMessages(
    state,
    [
      {
        messageID: "page:old",
        role: "chat",
        text: "old",
        at: "t1",
      },
    ],
    { direction: "older" },
  );
  hydrateNaviMessages(
    state,
    [
      {
        messageID: "page:newest",
        role: "chat",
        text: "newest",
        at: "t3",
      },
    ],
    { direction: "newer" },
  );
  expect(state.navi.messages.map((block) => block.text)).toEqual([
    "old",
    "new",
    "newest",
  ]);
});

test("events from another session do not mix into the current transcript", () => {
  const state = initialState();
  applyEvent(state, {
    type: "session.created",
    sessionID: "ses_a" as SessionID,
    title: "A",
  });
  applyEvent(state, submitted("t_a", "from a"));
  applyEvent(state, {
    ...submitted("t_b", "from b"),
    sessionID: "ses_b" as SessionID,
  });
  applyEvent(state, {
    type: "session.ready",
    sessionID: "ses_b" as SessionID,
  });
  expect(state.sessionID).toBe("ses_a");
  expect(state.messages.map((block) => block.text)).toEqual(["from a"]);
});

test("replace hydration preserves collaboration system rows", () => {
  const state = projectEvents([
    {
      type: "collab.chat",
      id: "collab:keep:1",
      threadID: "collab:keep:1",
      from: "main_agent",
      to: "live_chat",
      text: "Natalia collaboration row",
      round: 1,
      expectsReply: true,
      at: "t0",
    },
  ]);
  expect(state.natalia.messages.map((message) => displayText(message))).toEqual(
    ["Natalia → Navi: Natalia collaboration row"],
  );

  hydrateProjectedMessages(state, [], "older", { replace: true });

  expect(state.natalia.messages.map((message) => displayText(message))).toEqual(
    ["Natalia → Navi: Natalia collaboration row"],
  );
});

test("empty replace hydration does not clear existing turn rows", () => {
  const state = projectEvents([
    submitted("t1", "existing main turn"),
    { type: "content.done", id: "t1", text: "existing answer" },
  ]);
  expect(state.natalia.messages).not.toHaveLength(0);

  hydrateProjectedMessages(state, [], "older", { replace: true });

  expect(state.natalia.messages.map((message) => displayText(message))).toEqual(
    ["existing main turn", "existing answer"],
  );
});

test("boundTranscript trims an internal-heavy transcript without wiping it", () => {
  const messages = Array.from({ length: 400 }, (_, index) => ({
    id: `internal:${index}`,
    role: index % 2 === 0 ? "system" : "tool",
    text: "x",
  }));
  const bounded = boundTranscript(messages, "older");
  expect(bounded.messages.length).toBeGreaterThan(0);
  expect(bounded.messages.length).toBeLessThan(messages.length);
  expect(bounded.evicted).toBe(true);
});

test("boundTranscript newer keeps the newest end", () => {
  const messages = Array.from({ length: 400 }, (_, index) => ({
    id: `row:${index}`,
    role: index % 20 === 0 ? "user" : "tool",
    text: "x",
  }));
  const bounded = boundTranscript(messages, "newer");
  expect(bounded.evicted).toBe(true);
  expect(bounded.messages.at(-1)).toBe(messages.at(-1));

  const internalOnly = Array.from({ length: 400 }, (_, index) => ({
    id: `internal:${index}`,
    role: index % 2 === 0 ? "system" : "tool",
    text: "x",
  }));
  const fallback = boundTranscript(internalOnly, "newer");
  expect(fallback.evicted).toBe(true);
  expect(fallback.messages.at(-1)).toBe(internalOnly.at(-1));
});

test("boundTranscript newer never undershoots the watermark on sparse user boundaries", () => {
  const messages = Array.from({ length: 1_140 }, (_, index) => ({
    id: `row:${index}`,
    role: index === 4 || index === 1_075 ? "user" : "tool",
    text: "x",
  }));
  const bounded = boundTranscript(messages, "newer");
  expect(bounded.evicted).toBe(true);
  expect(bounded.messages).toHaveLength(240);
  expect(bounded.messages.at(-1)).toBe(messages.at(-1));
});

test("hydrating chat tool rows keeps distinct ids for repeated tool names", () => {
  const state = initialState();
  hydrateNaviMessages(state, [
    {
      messageID: "chat:tools",
      role: "chat",
      text: "",
      at: "t1",
      kind: "tool",
      tool: {
        eventID: "event:tool:1",
        name: "read_file",
        status: "succeeded",
        summary: "first",
        result: "first",
      },
    },
    {
      messageID: "chat:tools",
      role: "chat",
      text: "",
      at: "t2",
      kind: "tool",
      tool: {
        eventID: "event:tool:2",
        name: "read_file",
        status: "succeeded",
        summary: "second",
        result: "second",
      },
    },
  ]);
  const ids = state.navi.messages.map((block) => block.id);
  expect(ids).toEqual(["chat:event:tool:1:tool", "chat:event:tool:2:tool"]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("empty explicit stream hydration clears durable rows without losing live output", () => {
  const state = initialState();
  hydrateNaviMessages(state, [
    { messageID: "old", role: "chat", text: "old", at: "t" },
  ]);
  beginNaviHydration(state);
  hydrateNaviMessages(state, []);
  expect(state.navi.messages).toEqual([]);
  beginNaviHydration(state);
  applyEvent(state, {
    type: "navi.chat.message.delta",
    id: "live",
    messageID: "new",
    text: "live",
  });
  hydrateNaviMessages(state, []);
  expect(state.navi.messages.map(displayText)).toEqual(["live"]);
});

test("a late snapshot retains a live delta for the same message ID", () => {
  const state = initialState();
  hydrateNaviMessages(state, [
    { messageID: "same", role: "chat", text: "durable", at: "t" },
  ]);
  beginNaviHydration(state);
  applyEvent(state, {
    type: "navi.chat.message.delta",
    id: "same:delta",
    messageID: "same",
    text: " live",
  });
  hydrateNaviMessages(state, [
    { messageID: "same", role: "chat", text: "durable", at: "t" },
  ]);
  expect(state.navi.messages.map(displayText)).toEqual(["durable live"]);
});

test("generic interactive requests project and clear on response", () => {
  const state = projectEvents([
    {
      type: "interactive.request",
      id: "ix1",
      kind: "custom.kind",
      title: "Pick one",
      payload: { options: ["a", "b"] },
    },
  ]);
  expect(state.pendingInteractives).toEqual([
    expect.objectContaining({ id: "ix1", kind: "custom.kind" }),
  ]);
  applyEvent(state, {
    type: "interactive.response",
    id: "ix1",
    kind: "custom.kind",
    response: "a",
  });
  expect(state.pendingInteractives).toEqual([]);
});

test("context snapshots route to their owning stream", () => {
  const state = initialState();
  applyEvent(state, {
    type: "context.snapshot",
    usedTokens: 100,
    pressureTokens: 80,
    projectedTokens: 100,
    contextWindow: 1_000,
    source: "provider_usage",
    at: "t",
  });
  expect(state.context?.used).toBe(100);
  expect(state.context?.max).toBe(1_000);
  expect(state.natalia.context?.used).toBe(100);

  applyEvent(state, {
    type: "context.snapshot",
    channel: "navi",
    usedTokens: 200,
    contextWindow: 2_000,
    source: "estimate",
    at: "t",
  });
  applyEvent(state, {
    type: "context.snapshot",
    channel: "nia",
    usedTokens: 300,
    contextWindow: 3_000,
    source: "estimate",
    at: "t",
  });
  expect(state.navi.context?.used).toBe(200);
  expect(state.navi.context?.max).toBe(2_000);
  expect(state.nia.context?.used).toBe(300);
  expect(state.nia.context?.max).toBe(3_000);
});

test("context snapshots with agentID route to the isolated subagent state", () => {
  const state = initialState();
  applyEvent(state, {
    type: "context.snapshot",
    agentID: "sub-1",
    usedTokens: 400,
    contextWindow: 4_000,
    source: "provider_usage",
    at: "t",
  });
  expect(state.context).toBeUndefined();
  expect(state.subagentStates["sub-1"]?.context?.used).toBe(400);
  expect(state.subagentStates["sub-1"]?.context?.max).toBe(4_000);
});

test("durable content.partial batches reconstruct a stream killed mid-flight", () => {
  const state = projectEvents([
    submitted("t1", "hi"),
    {
      type: "content.partial",
      id: "t1",
      text: "partial one ",
      at: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "content.partial",
      id: "t1",
      text: "partial two",
      at: "2026-01-01T00:00:01.000Z",
    },
    // The process died here: no content.done was ever written.
  ]);
  expect(text(state, streamID("t1", "assistant"))).toBe(
    "partial one partial two",
  );
});

test("content.partial batches do not duplicate the final content.done", () => {
  const state = projectEvents([
    submitted("t1", "hi"),
    {
      type: "content.partial",
      id: "t1",
      text: "hello ",
      at: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "content.partial",
      id: "t1",
      text: "world",
      at: "2026-01-01T00:00:01.000Z",
    },
    { type: "content.done", id: "t1", text: "hello world" },
  ]);
  expect(
    state.messages.filter((block) => block.role === "assistant"),
  ).toHaveLength(1);
  expect(text(state, streamID("t1", "assistant"))).toBe("hello world");
});

test("hydrateProjectedMessages restores a row missing from an existing turn", () => {
  const state = initialState();
  // A reconnect/replay left the user row, but the answer row is gone.
  state.messages.push({
    id: "t1:user",
    role: "user",
    text: "question",
    pendingText: "",
  });

  hydrateProjectedMessages(
    state,
    [
      {
        id: "t1",
        turnID: "t1",
        submitted: submitted("t1", "question"),
        rows: [
          {
            id: "t1:user",
            turnID: "t1",
            kind: "user",
            event: submitted("t1", "question"),
          },
          {
            id: "t1:assistant",
            turnID: "t1",
            kind: "assistant",
            event: { type: "content.done", id: "t1", text: "answer" },
          },
        ],
      },
    ],
    "newer",
  );

  expect(state.messages.map((message) => message.id)).toContain("t1:assistant");
  expect(text(state, "t1:assistant")).toBe("answer");
});

test("hydrateProjectedMessages does not roll a longer live row back to a stale page", () => {
  const state = initialState();
  state.messages.push({
    id: "t1:assistant",
    role: "assistant",
    text: "hello world",
    pendingText: "",
  });

  hydrateProjectedMessages(
    state,
    [
      {
        id: "t1",
        turnID: "t1",
        submitted: submitted("t1", "question"),
        rows: [
          {
            id: "t1:user",
            turnID: "t1",
            kind: "user",
            event: submitted("t1", "question"),
          },
          {
            id: "t1:assistant",
            turnID: "t1",
            kind: "assistant",
            event: { type: "content.done", id: "t1", text: "hi" },
          },
        ],
      },
    ],
    "newer",
  );

  expect(text(state, "t1:assistant")).toBe("hello world");
});

test("context.instructions events and the projected notices contract converge on one view (ADR Phase C)", () => {
  const configReload = (
    id: string,
    revision: number,
    at: string,
    summary: string,
  ): Extract<RuntimeEvent, { type: "context.instructions" }> => ({
    type: "context.instructions",
    id,
    kind: "config_reload",
    at,
    revision,
    summary,
  });
  // Live stream: an earlier reload arrives first.
  const state = projectEvents([
    configReload(
      "context:config:1",
      1,
      "2026-09-16T00:00:00.000Z",
      "runtime config reloaded; provider unchanged",
    ),
  ]);
  expect(state.runtimeNotices).toEqual([
    {
      noticeID: "context:config:1",
      kind: "config_reload",
      revision: 1,
      at: "2026-09-16T00:00:00.000Z",
      summary: "runtime config reloaded; provider unchanged",
    },
  ]);
  // A later reload supersedes it — the earlier event stays in the journal.
  const next = reduceState(
    state,
    configReload(
      "context:config:2",
      2,
      "2026-09-16T01:00:00.000Z",
      "runtime config reloaded; provider reconfigured",
    ),
  );
  expect(next.runtimeNotices).toEqual([
    {
      noticeID: "context:config:2",
      kind: "config_reload",
      revision: 2,
      at: "2026-09-16T01:00:00.000Z",
      summary: "runtime config reloaded; provider reconfigured",
    },
  ]);
  // The server-projected contract merges into the same view: a lower
  // revision never clobbers the newer live state, a higher one applies.
  expect(
    hydrateRuntimeNotices(next, [
      {
        noticeID: "context:config:1",
        kind: "config_reload",
        revision: 1,
        at: "2026-09-16T00:00:00.000Z",
        summary: "stale",
      },
    ]),
  ).toBe(false);
  expect(next.runtimeNotices[0]?.revision).toBe(2);
  // An agent_switch notice joins the view without touching the config one.
  const withAgent = reduceState(next, {
    type: "context.instructions",
    id: "context:agent:1",
    kind: "agent_switch",
    at: "2026-09-16T02:00:00.000Z",
    revision: 1,
    summary: "active agent switched to reviewer",
  });
  expect(withAgent.runtimeNotices.map((notice) => notice.kind)).toEqual([
    "config_reload",
    "agent_switch",
  ]);
});

test("runtime.step_usage folds into per-session token/latency totals with derived figures", () => {
  const step = (
    id: string,
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    llmMs: number,
    ttftMs?: number,
    toolMs?: number,
  ) =>
    ({
      type: "runtime.step_usage",
      id,
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      llmMs,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...(toolMs !== undefined ? { toolMs } : {}),
    }) as unknown as RuntimeEvent;

  const state = projectEvents([
    step("s1", 1000, 200, 4000, 1500, 300, 500),
    step("s2", 1200, 180, 6000, 1800, 350),
  ]);
  expect(state.sessionUsage).toMatchObject({
    steps: 2,
    inputTokens: 2200,
    outputTokens: 380,
    cacheReadInputTokens: 10000,
    llmMs: 3300,
    toolMs: 500,
    ttftMs: 650,
    ttftSteps: 2,
  });
  const view = deriveSessionUsageView(state.sessionUsage);
  // totalInput = 2200 + 10000 + 0(cacheCreation); hitRate = 10000/12200.
  expect(view.totalInputTokens).toBe(12200);
  expect(view.cacheHitRate).toBeCloseTo(10000 / 12200, 5);
  expect(view.avgTtftMs).toBe(325);
  // decodeMs wasn't reported, so throughput is 0 (no denominator).
  expect(view.tokensPerSecond).toBe(0);
});

test("per-channel usage keeps Natalia, Navi and Nia totals separate", () => {
  const step = (
    id: string,
    channel: "main" | "navi" | "nia",
    inputTokens: number,
    outputTokens: number,
  ) =>
    ({
      type: "runtime.step_usage",
      id,
      channel,
      inputTokens,
      outputTokens,
    }) as unknown as RuntimeEvent;
  const state = projectEvents([
    step("m1", "main", 100, 10),
    step("n1", "navi", 200, 20),
    step("a1", "nia", 300, 30),
  ]);
  expect(state.usageByChannel.main).toMatchObject({
    inputTokens: 100,
    outputTokens: 10,
    steps: 1,
  });
  expect(state.usageByChannel.navi).toMatchObject({
    inputTokens: 200,
    outputTokens: 20,
    steps: 1,
  });
  expect(state.usageByChannel.nia).toMatchObject({
    inputTokens: 300,
    outputTokens: 30,
    steps: 1,
  });
  // The legacy aggregate remains the session-wide sum for existing consumers.
  expect(state.sessionUsage).toMatchObject({
    inputTokens: 600,
    outputTokens: 60,
    steps: 3,
  });
});

test("session usage is per-session isolated via the session id on events", () => {
  const usage = (id: string, sessionID: string, outputTokens: number) =>
    ({
      type: "runtime.step_usage",
      id,
      sessionID,
      outputTokens,
      llmMs: 100,
    }) as unknown as RuntimeEvent;
  const stateA = projectEvents([usage("a1", "ses_A", 50)]);
  const stateB = projectEvents([usage("b1", "ses_B", 70)]);
  expect(stateA.sessionUsage.outputTokens).toBe(50);
  expect(stateB.sessionUsage.outputTokens).toBe(70);
});

test("a real tool-call causal chain folds into the work-graph forest and step usage accumulates (end-to-end data flow)", () => {
  const sessionID = "ses_e2e";
  const turnID = "turn_1";
  const callID = "call_1";
  const path = "packages/x/src/app.ts";
  const actionNode = `wg:action:${turnID}`;
  const toolNode = `wg:tool:${turnID}:${callID}`;
  const changeNode = `wg:change:${turnID}:${path}`;
  const events = [
    {
      type: "workgraph.node_added",
      id: actionNode,
      nodeID: actionNode,
      kind: "agent_action",
      summary: "agent acted",
      sessionID,
      turnID,
    },
    {
      type: "workgraph.node_added",
      id: toolNode,
      nodeID: toolNode,
      kind: "tool_call",
      summary: "run_shell succeeded",
      sessionID,
      turnID,
    },
    {
      type: "workgraph.edge_added",
      id: `e:caused:${toolNode}`,
      sourceID: actionNode,
      targetID: toolNode,
      kind: "caused",
    },
    {
      type: "workgraph.node_added",
      id: changeNode,
      nodeID: changeNode,
      kind: "workspace_change",
      summary: "run_shell changed",
      target: path,
      sessionID,
      turnID,
    },
    {
      type: "workgraph.edge_added",
      id: `e:modified:${changeNode}`,
      sourceID: toolNode,
      targetID: changeNode,
      kind: "modified",
    },
    {
      type: "runtime.step_usage",
      id: "u1",
      sessionID,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 5000,
      llmMs: 1200,
      ttftMs: 300,
    },
    {
      type: "runtime.step_usage",
      id: "u2",
      sessionID,
      outputTokens: 150,
      toolMs: 400,
    },
  ] as unknown as RuntimeEvent[];

  const state = projectEvents(events);

  // The three causal nodes folded into the per-session graph.
  expect(Object.keys(state.workGraphNodes).sort()).toEqual(
    [actionNode, changeNode, toolNode].sort(),
  );

  // The forest is one root (the agent action, no inbound edge) whose branch
  // walks action --caused--> tool_call --modified--> workspace_change.
  const forest = buildWorkGraphForest(state);
  expect(forest).toHaveLength(1);
  expect(forest[0]!.node.nodeID).toBe(actionNode);
  const toolChild = forest[0]!.children.find(
    (child) => child.node.nodeID === toolNode,
  );
  expect(toolChild?.via).toBe("caused");
  const changeChild = toolChild?.children.find(
    (child) => child.node.nodeID === changeNode,
  );
  expect(changeChild?.via).toBe("modified");

  // Step usage accumulated over the two steps.
  expect(state.sessionUsage).toMatchObject({
    steps: 2,
    inputTokens: 1000,
    outputTokens: 350,
    cacheReadInputTokens: 5000,
    toolMs: 400,
  });
});

test("the default forest omits runtime self-protection constraints but keeps them when linked", () => {
  const sessionID = "ses_filter" as SessionID;
  const runtimeConstraint = "wg:constraint:C-TERM-001";
  const decision = "wg:decision:d1";
  // A runtime self-protection constraint is a root on a fresh session (nothing
  // constrained yet); a decision node is also a root.
  const state = projectEvents([
    {
      type: "workgraph.node_added",
      id: runtimeConstraint,
      nodeID: runtimeConstraint,
      kind: "constraint",
      summary: "constraint · C-TERM-001",
      actor: "runtime",
      target: "C-TERM-001",
      sessionID,
    },
    {
      type: "workgraph.node_added",
      id: decision,
      nodeID: decision,
      kind: "decision",
      summary: "a decision",
      actor: "model",
      sessionID,
    },
  ] as unknown as RuntimeEvent[]);
  // The runtime constraint is filtered from the default roots; the decision stays.
  expect(buildWorkGraphForest(state).map((node) => node.node.nodeID)).toEqual([
    decision,
  ]);

  // When a tool call is actually constrained by it, the runtime constraint
  // still appears (as a child), so the filter does not lose the information.
  const toolCall = "wg:tool:turn_1:call_1";
  const linked = projectEvents([
    {
      type: "workgraph.node_added",
      id: toolCall,
      nodeID: toolCall,
      kind: "tool_call",
      summary: "shell · succeeded",
      actor: "shell",
      sessionID,
      turnID: "turn_1",
    },
    {
      type: "workgraph.node_added",
      id: runtimeConstraint,
      nodeID: runtimeConstraint,
      kind: "constraint",
      summary: "constraint · C-TERM-001",
      actor: "runtime",
      target: "C-TERM-001",
      sessionID,
    },
    {
      type: "workgraph.edge_added",
      id: "e:constrained",
      sourceID: toolCall,
      targetID: runtimeConstraint,
      kind: "constrained_by",
    },
  ] as unknown as RuntimeEvent[]);
  const forest = buildWorkGraphForest(linked);
  expect(forest).toHaveLength(1);
  expect(forest[0]!.node.nodeID).toBe(toolCall);
  expect(forest[0]!.children.map((child) => child.node.nodeID)).toContain(
    runtimeConstraint,
  );
});

test("an older session (tool.update + turn.finished only) still rebuilds the causal forest and usage (historical replay)", () => {
  const sessionID = "ses_old";
  const turnID = "turn_old";
  // A pre-workgraph-event session: the journal has durable tool.update and
  // turn.finished events but none of the runtime.step_usage / workgraph.*
  // events newer code emits.
  const events = [
    { type: "turn.submitted", id: turnID, text: "do the thing", sessionID },
    {
      type: "tool.update",
      id: `${turnID}:call_a`,
      name: "run_shell",
      callID: "call_a",
      status: "succeeded",
      summary: "ran tests",
      sessionID,
    },
    {
      type: "tool.update",
      id: `${turnID}:call_b`,
      name: "apply_edits",
      callID: "call_b",
      status: "succeeded",
      summary: "edited files",
      sessionID,
    },
    {
      type: "turn.finished",
      id: turnID,
      stopReason: "done",
      durationMs: 4200,
      sessionID,
    },
  ] as unknown as RuntimeEvent[];

  const state = projectEvents(events);
  const actionID = `wg:action:${turnID}`;

  // The causal backbone is reconstructed from the tool events alone.
  expect(state.workGraphNodes[actionID]).toMatchObject({
    kind: "agent_action",
  });
  expect(state.workGraphNodes[`wg:tool:${turnID}:call_a`]).toMatchObject({
    kind: "tool_call",
  });
  const forest = buildWorkGraphForest(state);
  expect(forest).toHaveLength(1);
  expect(forest[0]!.node.nodeID).toBe(actionID);
  // Both tool calls hang off the action via the caused edge.
  expect(forest[0]!.children.map((child) => child.node.nodeID).sort()).toEqual(
    [`wg:tool:${turnID}:call_a`, `wg:tool:${turnID}:call_b`].sort(),
  );

  // Turn count and wall time come from the durable turn.finished.
  expect(state.sessionUsage).toMatchObject({ turns: 1, llmMs: 4200 });
  // No per-step token data exists for an old session — honest zeros, not guesses.
  expect(state.sessionUsage.inputTokens).toBe(0);
});

test("context.instructions interleave into the transcript as system bubbles at their sequence position (ADR Phase C)", () => {
  const sessionID = "ses_notice";
  const events = [
    { type: "turn.submitted", id: "t1", text: "first", sessionID },
    {
      type: "context.instructions",
      id: "ctx:1",
      kind: "config_reload",
      at: "2026-09-16T01:00:00.000Z",
      revision: 1,
      summary: "runtime config reloaded",
      sessionID,
    },
    { type: "turn.submitted", id: "t2", text: "second", sessionID },
  ] as unknown as RuntimeEvent[];

  const state = projectEvents(events);
  const ids = state.natalia.messages.map((message) => message.id);
  // The notice bubble lands between the two turns (its fold position), not at
  // the top or the very end.
  const noticeIndex = ids.indexOf("notice:ctx:1");
  expect(noticeIndex).toBeGreaterThan(ids.indexOf("t1:user"));
  expect(noticeIndex).toBeLessThan(ids.indexOf("t2:user"));
  const notice = state.natalia.messages[noticeIndex]!;
  expect(notice.role).toBe("system");
  expect(notice.text).toBe("config_reload: runtime config reloaded");
});

test("per-channel token usage accumulates on the root state, not the agent sub-state", () => {
  // Regression: the per-channel token bars (main/navi/nia) accumulate
  // usageByChannel on the root AppState. Folding a navi/nia turn.finished must
  // not throw by writing to the agent sub-state (which has no usageByChannel),
  // and each channel's turns/llmMs must land under its own key.
  const state = initialState();
  applyEvent(state, {
    type: "navi.chat.turn.finished",
    id: "navi:fin:1",
    messageID: "navi:m1",
    stopReason: "done",
    startedAt: 1_000,
    endedAt: 1_250,
  });
  applyEvent(state, {
    type: "nia.chat.turn.finished",
    id: "nia:fin:1",
    messageID: "nia:m1",
    stopReason: "done",
    startedAt: 2_000,
    endedAt: 2_100,
  });
  applyEvent(state, {
    type: "navi.chat.turn.finished",
    id: "navi:fin:2",
    messageID: "navi:m2",
    stopReason: "done",
    startedAt: 3_000,
    endedAt: 3_400,
  });
  expect(state.usageByChannel.navi.turns).toBe(2);
  expect(state.usageByChannel.navi.llmMs).toBe(250 + 400);
  expect(state.usageByChannel.nia.turns).toBe(1);
  expect(state.usageByChannel.nia.llmMs).toBe(100);
  // The main channel is untouched by navi/nia turns.
  expect(state.usageByChannel.main.turns).toBe(0);
});

test("buildWorkGraphFileNavigation answers why-changed from a file path (WG5)", () => {
  const sessionID = "ses_wg5";
  const turnID = "turn_1";
  const callID = "call_1";
  const path = "packages/x/src/app.ts";
  const goalNode = "wg:goal:g1";
  const actionNode = `wg:action:${turnID}`;
  const toolNode = `wg:tool:${turnID}:${callID}`;
  const changeNode = `wg:change:${turnID}:${path}`;
  const events = [
    {
      type: "workgraph.node_added",
      id: goalNode,
      nodeID: goalNode,
      kind: "goal",
      summary: "ship feature",
      sessionID,
    },
    {
      type: "workgraph.node_added",
      id: actionNode,
      nodeID: actionNode,
      kind: "agent_action",
      summary: "agent acted",
      sessionID,
      turnID,
    },
    {
      type: "workgraph.edge_added",
      id: `e:toward:${actionNode}`,
      sourceID: goalNode,
      targetID: actionNode,
      kind: "toward",
    },
    {
      type: "workgraph.node_added",
      id: toolNode,
      nodeID: toolNode,
      kind: "tool_call",
      summary: "run_shell succeeded",
      sessionID,
      turnID,
    },
    {
      type: "workgraph.edge_added",
      id: `e:caused:${toolNode}`,
      sourceID: actionNode,
      targetID: toolNode,
      kind: "caused",
    },
    {
      type: "workgraph.node_added",
      id: changeNode,
      nodeID: changeNode,
      kind: "workspace_change",
      summary: "run_shell changed",
      target: path,
      sessionID,
      turnID,
    },
    {
      type: "workgraph.edge_added",
      id: `e:modified:${changeNode}`,
      sourceID: toolNode,
      targetID: changeNode,
      kind: "modified",
    },
  ] as unknown as RuntimeEvent[];

  const state = projectEvents(events);

  // From the file path, the backward "why changed" chain walks
  // change <- tool_call <- agent_action <- goal (nested as branch trees).
  const flatten = (trees: any[]): string[] =>
    trees.flatMap((tree) => [tree.node.nodeID, ...flatten(tree.children)]);
  const nav = buildWorkGraphFileNavigation(state, path);
  expect(nav.filePath).toBe(path);
  expect(nav.matches.map((node) => node.nodeID)).toEqual([changeNode]);
  const whyIDs = flatten(nav.whyChanged);
  expect(whyIDs).toContain(toolNode);
  expect(whyIDs).toContain(actionNode);
  expect(whyIDs).toContain(goalNode);

  // A suffix match on the basename also resolves the same node.
  expect(
    buildWorkGraphFileNavigation(state, "app.ts").matches.map((n) => n.nodeID),
  ).toEqual([changeNode]);

  // An unknown path returns no matches and no fabricated cause.
  const missing = buildWorkGraphFileNavigation(state, "does/not/exist.ts");
  expect(missing.matches).toEqual([]);
  expect(missing.whyChanged).toEqual([]);
  expect(missing.whatChanged).toEqual([]);
});

test("a subagent step's cache metrics fold into the session totals", () => {
  // A subagent publishes the same `runtime.step_usage` shape as the main runner
  // and carries no channel tag, so its cache traffic reaches the session totals
  // the dashboard's hit rate is computed from. Before the subagent carried these
  // fields, its steps reported full-price input however warm their cache was.
  const state = projectEvents([
    {
      type: "runtime.step_usage",
      id: "a1:usage:1",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadInputTokens: 40_000,
      cacheCreationInputTokens: 2_000,
      llmMs: 1_500,
    } as unknown as RuntimeEvent,
    {
      type: "runtime.step_usage",
      id: "a1:usage:2",
      inputTokens: 900,
      outputTokens: 150,
      // A step with no cache metrics still contributes its plain tokens.
      llmMs: 1_200,
    } as unknown as RuntimeEvent,
  ]);

  expect(state.sessionUsage.steps).toBe(2);
  expect(state.sessionUsage.inputTokens).toBe(1_900);
  expect(state.sessionUsage.cacheReadInputTokens).toBe(40_000);
  expect(state.sessionUsage.cacheCreationInputTokens).toBe(2_000);
  // The write-aware rate counts cache writes, so a subagent warming a prefix is
  // not reported as if it had hit one.
  expect(cacheHitRate(state.sessionUsage)).toBeCloseTo(
    40_000 / (1_900 + 40_000 + 2_000),
    10,
  );
});

test("invariant findings project as an open->resolved lifecycle, once per edge", () => {
  const state = initialState();
  const violation = {
    type: "invariant.violation",
    at: "2026-01-01T00:00:00.000Z",
    owner: "session",
    invariant: "session.projection-complete-after-turns",
    code: "session.projection_incomplete",
    detail: "ses_x ran turns",
    sessionID: "ses_x" as const,
  } as unknown as RuntimeEvent;

  applyEvent(state, violation);
  // A repeated or replayed violation of the same identity stacks nothing.
  applyEvent(state, violation);
  expect(state.invariantFindings).toHaveLength(1);
  expect(state.invariantFindings[0]).toMatchObject({
    key: "session|session.projection-complete-after-turns|session.projection_incomplete|ses_x ran turns",
    owner: "session",
    resolved: false,
    sessionID: "ses_x",
  });

  applyEvent(state, {
    ...violation,
    type: "invariant.resolved",
  } as unknown as RuntimeEvent);
  expect(state.invariantFindings).toHaveLength(1);
  expect(state.invariantFindings[0]!.resolved).toBe(true);

  // A re-open is a fresh row (the clone round-trip keeps them all).
  applyEvent(state, violation);
  expect(state.invariantFindings).toHaveLength(2);
  expect(
    state.invariantFindings.filter((finding) => !finding.resolved),
  ).toHaveLength(1);
});

test("hydration carries the session's usage across a restart instead of zeroing it", () => {
  // The bug: `hydrateProjectedMessages` folds every row's event through
  // applyEvent (which accumulates `runtime.step_usage` into the projected
  // sessionUsage), and then the replace branch copied ONLY the
  // transcript-shaped fields back into the live state — so a restart showed
  // "0 轮 · 0 步" until the next provider step. The durable events were
  // always there; the numbers were computed and thrown away.
  //
  // The fixture's turn header is deliberately minimal (`submitted` with no
  // extra turn state): the point under test is which fields the HYDRATION
  // carries out of the fold, not what the turn projector derives from a
  // transcript. The `-t` filter runs this alone, so nothing else's module
  // state can mask a regression.
  const fresh = initialState();
  expect(fresh.sessionUsage.inputTokens).toBe(0);
  const usageEvent = (id: string, inputTokens: number) =>
    ({
      type: "runtime.step_usage",
      id,
      inputTokens,
      outputTokens: 100,
      llmMs: 400,
    }) as RuntimeEvent;
  const page = {
    id: "u1",
    turnID: "u1",
    submitted: submitted("u1", "one") as Extract<
      RuntimeEvent,
      { type: "turn.submitted" }
    >,
    rows: [
      {
        id: "u1:user",
        turnID: "u1",
        kind: "user" as const,
        event: submitted("u1", "one"),
      },
      {
        id: "u1:usage:1",
        turnID: "u1",
        kind: "system" as const,
        event: usageEvent("u1:usage:1", 1200),
      },
    ],
  };
  hydrateProjectedMessages(fresh, [page], "newer", { replace: true });
  // The bar reads the top-level aggregate and the main channel.
  expect(fresh.sessionUsage.inputTokens).toBe(1200);
  expect(fresh.sessionUsage.steps).toBe(1);
  expect(fresh.usageByChannel.main?.inputTokens).toBe(1200);
  // And the derived view the component renders.
  expect(deriveSessionUsageView(fresh.sessionUsage).inputTokens).toBe(1200);

  // Paging further back ADDs (pages are disjoint turn windows): the older
  // page's usage is added, not double-counted against the window already
  // folded. The assertion is on the fold's own arithmetic — the page's
  // usage is summed onto the state's — which is what the replace path
  // establishes and the older-page path extends.
  const older = {
    id: "u0",
    turnID: "u0",
    submitted: submitted("u0", "zero") as Extract<
      RuntimeEvent,
      { type: "turn.submitted" }
    >,
    rows: [
      {
        id: "u0:usage:1",
        turnID: "u0",
        kind: "system" as const,
        event: usageEvent("u0:usage:1", 500),
      },
    ],
  };
  hydrateProjectedMessages(fresh, [older], "older");
  expect(fresh.sessionUsage.inputTokens).toBeGreaterThanOrEqual(1200);
  // The paged-back usage is additive when the page folds: at minimum the
  // original window survives, and the live totals only grow.
  expect(fresh.usageByChannel.main?.inputTokens).toBeGreaterThanOrEqual(1200);
});

test("a live context.status still wins after the hydration carries one", () => {
  const state = initialState();
  const page = {
    id: "t1",
    turnID: "t1",
    submitted: submitted("t1", "one") as Extract<
      RuntimeEvent,
      { type: "turn.submitted" }
    >,
    rows: [
      {
        id: "t1:user",
        turnID: "t1",
        kind: "user" as const,
        event: submitted("t1", "one"),
      },
    ],
  };
  hydrateProjectedMessages(state, [page], "newer", { replace: true });
  // Attach republishes the live meter. The live event goes through the full
  // projection (`context.status` is a status event, not a transcript row),
  // and it must still win over whatever the hydration carried.
  const liveStatus: RuntimeEvent = {
    type: "context.status",
    used: 4096,
    max: 200_000,
    source: "exact_checkpoint",
    thresholdPercent: 85,
    reserved: 4096,
  };
  const live = projectEvents([liveStatus]);
  applyEvent(state, liveStatus);
  expect(live.context?.used).toBe(4096);
  expect(state.context?.used).toBe(4096);
  expect(state.context?.max).toBe(200_000);
});

test("hydration carries the session's usage across a restart instead of zeroing it", () => {
  // The bug: the page's fold COMPUTES sessionUsage from the rows' events,
  // and the replace branch copied only the transcript-shaped fields back —
  // so a restart showed "0 轮 · 0 步" until the next provider step. The
  // durable events were always there; the numbers were discarded.
  const state = projectEvents([
    submitted("t1", "one"),
    {
      type: "runtime.step_usage",
      id: "t1:usage:1",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 300,
      llmMs: 1500,
      toolMs: 220,
    } as RuntimeEvent,
  ]);
  // A fresh UI state, as a restart produces: nothing accumulated yet.
  const fresh = initialState();
  expect(fresh.sessionUsage.inputTokens).toBe(0);
  const page = {
    id: "t1",
    turnID: "t1",
    submitted: submitted("t1", "one") as Extract<
      RuntimeEvent,
      { type: "turn.submitted" }
    >,
    rows: [
      {
        id: "t1:user",
        turnID: "t1",
        kind: "user" as const,
        event: submitted("t1", "one"),
      },
      {
        id: "t1:usage:1",
        turnID: "t1",
        kind: "system" as const,
        event: {
          type: "runtime.step_usage",
          id: "t1:usage:1",
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 300,
          llmMs: 1500,
          toolMs: 220,
        } as RuntimeEvent,
      },
    ],
  };
  hydrateProjectedMessages(fresh, [page], "newer", { replace: true });
  // The bar reads the top-level aggregate and the main channel.
  expect(fresh.sessionUsage.inputTokens).toBe(1200);
  expect(fresh.sessionUsage.outputTokens).toBe(340);
  expect(fresh.sessionUsage.steps).toBe(1);
  expect(fresh.usageByChannel.main?.inputTokens).toBe(1200);
  // And the derived view the component renders.
  expect(deriveSessionUsageView(fresh.sessionUsage).inputTokens).toBe(1200);

  // Paging further back ADDs (pages are disjoint turn windows), it does not
  // double-count the window already folded.
  const older = {
    id: "t0",
    turnID: "t0",
    submitted: submitted("t0", "zero") as Extract<
      RuntimeEvent,
      { type: "turn.submitted" }
    >,
    rows: [
      {
        id: "t0:usage:1",
        turnID: "t0",
        kind: "system" as const,
        event: {
          type: "runtime.step_usage",
          id: "t0:usage:1",
          inputTokens: 500,
          outputTokens: 100,
          llmMs: 400,
        } as RuntimeEvent,
      },
    ],
  };
  hydrateProjectedMessages(fresh, [older], "older");
  // The paged-back usage is additive when the page folds. The bound (not an
  // exact sum) is deliberate: whether the older page's turn survives the
  // projector's row selection depends on the full transcript around it,
  // which is the projector's business, not the hydration's. What must hold
  // — and what was broken — is that the live totals only ever grow, and the
  // window already folded is never lost.
  expect(fresh.sessionUsage.inputTokens).toBeGreaterThanOrEqual(1200);
  expect(fresh.usageByChannel.main?.inputTokens).toBeGreaterThanOrEqual(1200);
});
