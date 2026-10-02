import { expect, test } from "bun:test";
import type {
  ApprovalResponse,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type { ProviderToolCall } from "@anthelia/runtime";
import type { RuntimeTool } from "@anthelia/tools";
import { createInteractiveWaiter } from "../src/interactive-waiter";
import { createWorkLedgerController } from "@natalia/work-ledger";

const tool = (name: string): RuntimeTool => ({
  name,
  description: name,
  requiresApproval: true,
  parameters: { type: "object", properties: {} },
  async execute() {
    return "ok";
  },
});

const call = (id: string, name: string, args = {}): ProviderToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

function harness(initialSession = "ses_a" as SessionID) {
  let session = initialSession;
  const events: RuntimeEvent[] = [];
  let decision: ApprovalResponse["decision"] = "session";
  let waiter: ReturnType<typeof createInteractiveWaiter>;
  waiter = createInteractiveWaiter({
    publish: (event) => events.push(event),
    publishForSession: (_session, event) => {
      events.push(event);
      if (event.type === "approval.request")
        waiter.respondApproval({ requestID: event.id, decision });
    },
    sessionID: () => session,
    sessionIDForTurn: () => session,
    permissionMode: () => "ask",
    abortSignal: () => undefined,
    activeTurnID: () => undefined,
    isPending: () => false,
    workLedger: () =>
      createWorkLedgerController({ openFindingIDs: () => new Set() }),
  });
  return {
    waiter,
    events,
    setSession(value: SessionID) {
      session = value;
    },
    setDecision(value: ApprovalResponse["decision"]) {
      decision = value;
    },
    approvalCount() {
      return events.filter((event) => event.type === "approval.request").length;
    },
  };
}

test("session approval grants two distinct tools in one family only", async () => {
  const h = harness();
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
  );
  await h.waiter.requireApproval(
    "b",
    tool("edit_file"),
    call("b", "edit_file"),
    "turn_b",
  );
  expect(h.approvalCount()).toBe(1);

  h.setDecision("reject");
  await h.waiter.requireApproval(
    "c",
    tool("run_shell"),
    call("c", "run_shell"),
    "turn_c",
  );
  expect(h.approvalCount()).toBe(2);
  const approval = h.events.find(
    (event): event is Extract<RuntimeEvent, { type: "approval.request" }> =>
      event.type === "approval.request",
  );
  expect(approval?.permissionFamily?.id).toBe("filesystem-write");
  expect(approval?.permissionFamily?.label).toBe("Filesystem writes");
  expect(typeof approval?.permissionFamily?.scope).toBe("string");
});

test("session grants are isolated by session and runtime instance", async () => {
  const h = harness();
  await h.waiter.requireApproval(
    "a",
    tool("write_file"),
    call("a", "write_file"),
    "turn_a",
  );
  h.setSession("ses_b" as SessionID);
  await h.waiter.requireApproval(
    "b",
    tool("edit_file"),
    call("b", "edit_file"),
    "turn_b",
  );
  expect(h.approvalCount()).toBe(2);

  const restarted = harness("ses_a" as SessionID);
  await restarted.waiter.requireApproval(
    "restart",
    tool("edit_file"),
    call("restart", "edit_file"),
    "turn_restart",
  );
  expect(restarted.approvalCount()).toBe(1);
});

test("terminal family spans IDs and risk levels and can be revoked", async () => {
  const h = harness();
  await h.waiter.requireApproval(
    "low",
    tool("interactive_terminal_write"),
    call("low", "interactive_terminal_write", { id: "tty_1", input: "ls" }),
    "turn_low",
  );
  await h.waiter.requireApproval(
    "high",
    tool("interactive_terminal_keys"),
    call("high", "interactive_terminal_keys", {
      id: "tty_2",
      key: "Control-C",
    }),
    "turn_high",
  );
  expect(h.approvalCount()).toBe(1);

  expect(h.waiter.revokeTerminalApprovalScope("tty_1").revoked).toBe(true);
  await h.waiter.requireApproval(
    "again",
    tool("interactive_terminal_send_line"),
    call("again", "interactive_terminal_send_line", {
      id: "tty_3",
      text: "pwd",
    }),
    "turn_again",
  );
  expect(h.approvalCount()).toBe(2);
});

test("allow-session plan acceptance skips later plan prompts", async () => {
  const h = harness();
  expect(
    await h.waiter.requirePlanAcceptance({
      approvalID: "plan-a",
      planID: "plan_1",
      title: "Accept Navi's plan",
      detail: "details",
    }),
  ).toMatchObject({ decision: "session" });
  expect(
    await h.waiter.requirePlanAcceptance({
      approvalID: "plan-b",
      planID: "plan_2",
      title: "Accept Navi's plan",
      detail: "details",
    }),
  ).toMatchObject({ decision: "session" });
  expect(h.approvalCount()).toBe(1);
});

test("plan acceptance never grants a tool family", async () => {
  const h = harness();
  await h.waiter.requirePlanAcceptance({
    approvalID: "plan",
    planID: "plan_1",
    title: "Accept",
    detail: "details",
  });
  await h.waiter.requireApproval(
    "shell",
    tool("run_shell"),
    call("shell", "run_shell"),
    "turn_shell",
  );
  expect(h.approvalCount()).toBe(2);
});

test("responding to an approval does not write runtime state to stderr", async () => {
  const originalError = console.error;
  const writes: unknown[][] = [];
  console.error = (...args: unknown[]) => writes.push(args);
  try {
    const h = harness();
    await h.waiter.requireApproval(
      "shell",
      tool("run_shell"),
      call("shell", "run_shell"),
      "turn_shell",
    );
    expect(writes).toEqual([]);
  } finally {
    console.error = originalError;
  }
});
