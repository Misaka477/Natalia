/**
 * The audit trigger law: WHO may start a Nia audit, and who may not.
 *
 * Both halves are here because both were broken and both were reported from
 * use in the same breath ("如果没有计划就肯定不去唤醒 nia 审计… 重启的时候就不能
 * 去自动审计").
 *
 * 1. NO PLAN, NO AUDIT. `requestAuditAfterCompletion` refuses when the
 *    completion's task has no registered plan document, and it says why. An
 *    audit is a review of a plan's claim; without the plan there is nothing to
 *    review, and waking another agent to say so is worse than silence.
 *
 * 2. A RESTART NEVER STARTS AN AUDIT. The old finalize scan re-woke Nia for
 *    every `audit.requested` whose plan had not reached a verdict. It could not
 *    tell "interrupted by this restart" from "failed / never going to close"
 *    (both leave the journal looking identical), and its dedup key lived in a
 *    process-level set — so a plan stuck on `awaiting_audit` started an audit
 *    on EVERY boot, forever. The scan is deleted; a restart now starts nothing.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { createTestContext } from "@anthelia/runtime-services";
import { workLedgerController } from "@natalia/work-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { requestAuditAfterCompletion } from "@natalia/assay";

function completion(
  taskID: string,
  at = "2026-10-10T00:00:00.000Z",
): Extract<RuntimeEvent, { type: "completion.recorded" }> {
  return {
    type: "completion.recorded",
    id: `completion:${taskID}:1`,
    taskID,
    objective: "ship",
    changeSummary: "did the thing",
    validations: [],
    recordedAt: at,
  };
}

/**
 * A context with no session store (so the audit scan falls back to the resident
 * log), no work-ledger unless one is passed, and a recording `requestNiaWake`.
 */
function harness(options: {
  plans?: Array<{ planID: string; title: string }>;
}) {
  const wakes: Array<{ intent: string | undefined }> = [];
  const published: RuntimeEvent[] = [];
  const exec = {
    session: { id: "ses_audit_law", events: [] },
    context: { add: () => undefined },
  } as unknown as SessionExecutionState;

  const ledger = {
    buildAuditRequested: (input: { id: string; planID: string }) => ({
      type: "audit.requested" as const,
      id: input.id,
      planID: input.planID,
      planVersion: 1,
      triggerEventID: "completion:1",
      round: 1,
      scope: "completion_recorded" as const,
      at: "2026-10-10T00:00:00.000Z",
    }),
  } as unknown as WorkLedgerController;

  const ctx = {
    state: {
      serviceDirectory: createTestContext([workLedgerController.mock(ledger)]),
    },
    ports: {
      getExecutionBySession: () => new Map([["ses_audit_law", exec]]),
      getActiveExec: () => exec,
      publishForSession: (_exec: unknown, event: RuntimeEvent) => {
        published.push(event);
      },
      nextPlanSequence: () => 1,
      requestNiaWake: (_exec: unknown, intent?: string) => {
        wakes.push({ intent });
      },
      planDocRuntime: {
        planDocList: async () => options.plans,
        planDocUpdateStatus: async () => undefined,
      },
    },
  } as unknown as RuntimeContext;

  return { ctx, exec, wakes, published };
}

test("a completion with NO registered plan does not wake Nia, and says why", async () => {
  const { ctx, exec, wakes } = harness({ plans: [] });
  const result = await requestAuditAfterCompletion(
    ctx,
    exec,
    completion("task_1"),
  );
  expect(result.requested).toBe(false);
  expect(result.reason).toContain("no registered plan for task_1");
  // The whole point: no reviewer is woken for a claim that has no plan to
  // review.
  expect(wakes).toEqual([]);
});

test("a plan list that is entirely absent is the same answer as an empty one", async () => {
  const { ctx, exec, wakes } = harness({});
  const result = await requestAuditAfterCompletion(
    ctx,
    exec,
    completion("task_1"),
  );
  expect(result.requested).toBe(false);
  expect(wakes).toEqual([]);
});

test("a completion over a REGISTERED plan does wake her, once, as an audit", async () => {
  const { ctx, exec, wakes, published } = harness({
    plans: [{ planID: "task_1", title: "Ship it" }],
  });
  const result = await requestAuditAfterCompletion(
    ctx,
    exec,
    completion("task_1"),
  );
  expect(result.requested).toBe(true);
  // The durable request is written BEFORE the wake, so a restart/dedup has a
  // journal shadow to read even if the process dies in between.
  expect(
    published.filter((event) => event.type === "audit.requested"),
  ).toHaveLength(1);
  expect(wakes).toEqual([{ intent: undefined }]);
});

const finalizeSource = readFileSync(
  join(import.meta.dir, "..", "src", "runtime", "initialize", "finalize.ts"),
  "utf8",
);

test("a restart starts no audit: finalize never wakes Nia", () => {
  // Not "wakes her less often" — it does not call the door at all. A source pin
  // because the property IS the absence of this call in this file, and a
  // behavioural version would need a whole runtime to prove a negative.
  expect(finalizeSource).not.toMatch(/requestNiaWake/u);
  // And the unclosed-audit scan that fed it is gone, so it cannot come back
  // through a renamed helper.
  expect(finalizeSource).not.toMatch(/unclosedAuditPlanIDs/u);
  expect(finalizeSource).not.toMatch(/reWokenAuditsThisProcess/u);
});
