import { expect, test } from "bun:test";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import {
  applySandboxRungGrant,
  rungFromApprovalID,
  rungGrantFromResponse,
  rungLabel,
  sandboxEscalationID,
} from "../src/runtime/sandbox-rung";

/**
 * 洞 2's four-rung ladder: the human widening the session's rung
 * mid-session, the policy home reading it, and the model being told.
 */

test("the escalation id carries the rung it asked for, and only that", () => {
  // The id is the runtime's own matching handle (the dialog shows the title
  // and preview, never the id), so it is the wire between the request and
  // the response's grant — no second table that could disagree.
  expect(sandboxEscalationID("run_shell", "danger-full-access")).toBe(
    "run_shell:sandbox:danger-full-access",
  );
  expect(rungFromApprovalID("run_shell:sandbox:danger-full-access")).toBe(
    "danger-full-access",
  );
  expect(rungFromApprovalID("run_shell:sandbox:workspace-write")).toBe(
    "workspace-write",
  );
  // A plain tool approval, a question, an interactive request: not a rung.
  expect(rungFromApprovalID("run_shell:approval")).toBeUndefined();
  expect(rungFromApprovalID("run_shell:question")).toBeUndefined();
  // And a forged rung is not one either.
  expect(rungFromApprovalID("run_shell:sandbox:everything")).toBeUndefined();
});

test("only a session-scoped grant on a rung escalation moves the ladder", () => {
  const id = sandboxEscalationID("run_shell", "danger-full-access");
  // once/project are not the session switch (a per-call grant is bounded by
  // its call's own events; the project grant is the standing-grant channel).
  expect(
    rungGrantFromResponse({ requestID: id, decision: "once" }),
  ).toBeUndefined();
  expect(
    rungGrantFromResponse({ requestID: id, decision: "project" }),
  ).toBeUndefined();
  expect(rungGrantFromResponse({ requestID: id, decision: "session" })).toBe(
    "danger-full-access",
  );
  // A session grant on a NON-rung approval is the prompt floor's business,
  // not the ladder's.
  expect(
    rungGrantFromResponse({
      requestID: "run_shell:approval",
      decision: "session",
    }),
  ).toBeUndefined();
});

/** A minimal ctx/exec pair that records the notice the switch publishes. */
function harness(over?: Partial<SessionExecutionState>) {
  const published: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const exec = {
    session: { id: "ses_rung", events },
    ...over,
  } as unknown as SessionExecutionState;
  const ctx = {
    ports: {
      getExecutionBySession: () =>
        new Map([["ses_rung" as const, exec]] as const),
      publishForSession: (_exec: unknown, event: Record<string, unknown>) => {
        published.push(event);
        events.push(event);
      },
    },
  } as unknown as RuntimeContext;
  return { ctx, exec, published, events };
}

test("a session grant moves the rung, tells the model, and is idempotent", () => {
  const { ctx, exec, published } = harness();
  const applied = applySandboxRungGrant(
    ctx,
    "ses_rung" as const,
    "danger-full-access",
  );
  // The state the policy home reads as the session override.
  expect(exec.sandboxModeOverride).toBe("danger-full-access");
  expect(applied).toEqual({ from: undefined, to: "danger-full-access" });
  // The notice: the durable latest-win channel, with the rung named in the
  // human's vocabulary rather than the mode string.
  expect(published).toHaveLength(1);
  const notice = published[0]!;
  expect(notice.type).toBe("context.instructions");
  expect(notice.kind).toBe("sandbox_rung");
  expect(notice.summary).toContain("4 full");
  expect(notice.detail).toEqual([
    "rung danger-full-access: writes anywhere are automatic, with no confinement and no prompt",
    "the change is scoped to this session; a new session starts at the deployment's rung",
  ]);
  // Switching to the rung you are already on is not news.
  expect(
    applySandboxRungGrant(ctx, "ses_rung" as const, "danger-full-access"),
  ).toBeUndefined();
  expect(published).toHaveLength(1);
});

test("the ladder moves in both directions, and a later switch supersedes", () => {
  const { ctx, exec, published } = harness({
    sandboxModeOverride: "danger-full-access",
  });
  const applied = applySandboxRungGrant(ctx, "ses_rung" as const, "read-only");
  expect(applied).toEqual({ from: "danger-full-access", to: "read-only" });
  expect(exec.sandboxModeOverride).toBe("read-only");
  expect(published[0]!.summary).toContain("1 read-only");
  expect(published[0]!.summary).toContain("was 4 full");
});

test("a grant for a session that is not live is dropped, not crashed on", () => {
  const { ctx, published } = harness();
  expect(
    applySandboxRungGrant(ctx, "ses_ghost" as const, "danger-full-access"),
  ).toBeUndefined();
  expect(published).toHaveLength(0);
});

test("the rung labels are the human's ladder numbers", () => {
  expect(rungLabel("read-only")).toBe("1 read-only");
  expect(rungLabel("workspace-write")).toBe("3 workspace-write");
  expect(rungLabel("danger-full-access")).toBe("4 full");
});
