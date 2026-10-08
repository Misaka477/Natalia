import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * EI §3.5 correction action "暂停 plan": the main agent pauses/resumes a plan
 * through the chat dialogue. The status is a durable `plan.doc.status` fact, so
 * it survives replay and the plan panel reflects it.
 */
test("plan_pause sets a durable paused status and resumes (EI §3.5)", async () => {
  const root = await officialPluginWorkspace("plan-pause-e2e");
  const sessionID = "ses_plan_pause" as SessionID;
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "plan-pause",
      model: "plan-pause-model",
      async *stream(request: ProviderStreamRequest) {
        const results = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.filter(
          (message) =>
            message.role === "tool" &&
            String(message.toolCallID ?? "").startsWith("call_pause"),
        );
        const call = (paused: boolean) => ({
          type: "tool_call" as const,
          calls: [
            {
              id: "call_pause",
              name: "plan_pause",
              arguments: JSON.stringify({ planID, paused }),
            },
          ],
        });
        if (results.length === 0) {
          yield call(true);
          yield { type: "done" as const };
          return;
        }
        if (results.length === 1) {
          yield call(false);
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "plan paused then resumed" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(sessionID);
  await client.planDocWrite!({
    path: "plans/pause-me.md",
    content: "# Pause me\n\n- one step\n",
    title: "Pause me",
  });
  const marked = await client.planDocMark!({
    path: "plans/pause-me.md",
    title: "Pause me",
  });
  planID = marked.planID;
  await client.planDocActivate!(planID);
  await client.submitAndWait!("pause then resume the plan");

  // Both transitions are durable facts.
  const statuses = events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "plan.doc.status" }> =>
        event.type === "plan.doc.status",
    )
    .map((event) => event.status);
  expect(statuses).toContain("paused");
  // P0-3: the resume returns the plan's OWN status, which is `marked` here
  // (the plan was marked and never advanced). The old hardcoded
  // `executing` was the audit's finding — a round trip that rewrote the
  // caller's state.
  expect(statuses).toContain("marked");
  expect(statuses).not.toContain("executing");
  // The plan panel reads the final status.
  const list = await client.planDocList!();
  expect(list.find((plan) => plan.planID === planID)?.status).toBe("marked");
  await client.dispose?.();
}, 30_000);

test("a terminal plan refuses pause and resume (T-20)", async () => {
  const root = await officialPluginWorkspace("plan-pause-terminal");
  const sessionID = "ses_plan_pause_terminal" as SessionID;
  const events: RuntimeEvent[] = [];
  let planID = "";
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "plan-pause-terminal",
      model: "plan-pause-terminal-model",
      async *stream(request: ProviderStreamRequest) {
        const results = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages.filter(
          (message) =>
            message.role === "tool" &&
            String(message.toolCallID ?? "").startsWith("call_pause"),
        );
        const call = (paused: boolean) => ({
          type: "tool_call" as const,
          calls: [
            {
              id: "call_pause",
              name: "plan_pause",
              arguments: JSON.stringify({ planID, paused }),
            },
          ],
        });
        if (results.length === 0) {
          // First the PAUSE direction on the completed plan.
          yield call(true);
          yield { type: "done" as const };
          return;
        }
        if (results.length === 1) {
          // Then the resume direction that used to resurrect it.
          yield call(false);
          yield { type: "done" as const };
          return;
        }
        yield { type: "content" as const, text: "terminal plan held" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(sessionID);
  await client.planDocWrite!({
    path: "plans/finished.md",
    content: "# Finished plan\n\n- one step\n",
    title: "Finished plan",
  });
  const marked = await client.planDocMark!({
    path: "plans/finished.md",
    title: "Finished plan",
  });
  planID = marked.planID;
  // The plan completed: the audit passed, the lifecycle closed. (The durable
  // history in the smoke session's journal shows the same end state —
  // plan.doc.status "completed" — before the corrupted pause/resume writes.)
  await client.planDocUpdateStatus!({
    planID,
    status: "completed",
    sessionID,
  });

  await client.submitAndWait!("pause then resume the finished plan");

  // Both calls ran (the tool answered) and both answers REFUSED with the
  // terminal status named — the model is told why, not left to guess.
  const pauseUpdates = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update" &&
      event.name === "plan_pause" &&
      event.status === "succeeded",
  );
  expect(pauseUpdates).toHaveLength(2);
  for (const update of pauseUpdates) {
    const answer = JSON.parse(String(update.result ?? "{}")) as {
      ok: boolean;
      reason?: string;
    };
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain("terminal");
    expect(answer.reason).toContain("completed");
  }

  // The durable projection agrees: the only status fact is the completion
  // itself — no paused, no executing resurrection after it.
  const statuses = events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: "plan.doc.status" }> =>
        event.type === "plan.doc.status",
    )
    .map((event) => event.status);
  expect(statuses).toEqual(["completed"]);
  const list = await client.planDocList!();
  expect(list.find((plan) => plan.planID === planID)?.status).toBe("completed");
  await client.dispose?.();
}, 30_000);

test("a pause round trip returns the plan's own status, not executing (P0-3)", async () => {
  // The 2026-10-08 audit's P0-3: audit_gaps -> paused -> resume used to
  // land on `executing` (a hardcoded value), losing the caller's state.
  let planID = "";
  const root = await officialPluginWorkspace("plan-own-status");
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_plan_own_status" as SessionID,
    permissionMode: "auto",
    provider: {
      provider: "scripted-own-status",
      model: "scripted-own-status-model",
      async *stream() {
        yield { type: "content" as const, text: "paused" };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!("ses_plan_own_status" as SessionID);
    await client.planDocWrite!({
      path: "plans/own-status.md",
      content: "# Own status\n\n- one step\n",
      title: "Own status",
    });
    planID = (
      await client.planDocMark!({
        path: "plans/own-status.md",
        title: "Own status",
      })
    ).planID;
    // The plan's own state before the pause.
    await client.planDocUpdateStatus!({
      planID,
      status: "audit_gaps",
      sessionID: "ses_plan_own_status" as SessionID,
    });
    // Pause, then resume, through the same port the tool uses.
    const paused = await client.planDocPause!({
      planID,
      paused: true,
      sessionID: "ses_plan_own_status" as SessionID,
    });
    expect(paused).toMatchObject({
      updated: true,
      status: "paused",
      previousStatus: "audit_gaps",
    });
    const resumed = await client.planDocPause!({
      planID,
      paused: false,
      sessionID: "ses_plan_own_status" as SessionID,
    });
    expect(resumed).toMatchObject({ updated: true, status: "audit_gaps" });
    const list = await client.planDocList!();
    expect(list.find((plan) => plan.planID === planID)?.status).toBe(
      "audit_gaps",
    );
  } finally {
    await client.dispose?.();
  }
});
