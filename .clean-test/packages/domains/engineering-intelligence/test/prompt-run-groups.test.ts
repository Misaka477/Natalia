import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  JsonSessionStore,
  sessionFactStateFromEvents,
} from "@anthelia/session";
import { createTestContext } from "@anthelia/runtime-services";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import { createIntelligenceSurface } from "../src/intelligence";

/**
 * Discovery G-b's face: the same prompt's success/cost distribution,
 * scored from the journal — the fork/duplicate turns a prompt replayed
 * through are turns sharing a promptKey, so the distribution is a fold
 * of what already happened (no fork needed to READ it). Defensive: the
 * legacy-event fields stay undefined when absent.
 */

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(events: RuntimeEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "prompt-runs-"));
  dirs.push(dir);
  const sessionID = "ses_runs" as SessionID;
  const store = new JsonSessionStore(dir);
  const session = { id: sessionID, events } as never;
  const exec = {
    session,
    factStateComplete: true,
    factState: sessionFactStateFromEvents(events),
  } as unknown as SessionExecutionState;
  const ctx = {
    ports: {
      getReady: async () => undefined,
      getSessionID: () => sessionID,
      getExecutionBySession: () => new Map([[sessionID, exec]]) as never,
      getActiveExec: () => exec,
      getSessionPersistenceForSession: () => Promise.resolve(undefined),
      planDocRuntime: {
        planDocActive: async () => undefined,
        planDocRead: async () => ({ content: "" }),
      },
      publishForSession: () => undefined,
      nextCompletionSequence: () => 1,
    },
    state: {
      pluginStoreRoot: dir,
      serviceDirectory: createTestContext([
        sessionStoreController.mock({
          history: (_id: `ses_${string}`, fallback: RuntimeEvent[]) =>
            Promise.resolve({
              events: fallback.map((event, seq) => ({ seq, event })),
              hasMore: false,
            }),
          flush: () => Promise.resolve(),
        } as unknown as Parameters<typeof sessionStoreController.mock>[0]),
      ]),
    },
  } as unknown as RuntimeContext;
  return { surface: createIntelligenceSurface(ctx, {}), sessionID };
}

function turn(
  turnID: string,
  promptKey: string,
  success: boolean,
  at: string,
): RuntimeEvent[] {
  // The journal's real turn shape: an admission carrying the prompt key
  // (`sha256` — P0's prompt key), the turn's start, its step usage, and
  // the finish that decides success.
  return [
    {
      type: "turn.submitted",
      id: `sub_${turnID}`,
      at,
      text: `do ${promptKey}`,
      sha256: promptKey,
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
    {
      type: "turn.started",
      id: turnID,
      at,
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
    {
      type: "runtime.step_usage",
      id: `step_${turnID}`,
      at,
      inputTokens: 100,
      outputTokens: 50,
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
    {
      type: "turn.finished",
      id: turnID,
      at,
      stopReason: success ? "done" : "error",
      durationMs: 1200,
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
  ];
}

test("a run with no finish keeps success undefined rather than zero-invented", async () => {
  // An interrupted turn (killed mid-flight): the scorer's defensive shape
  // — missing numbers stay undefined, never invented as 0.
  const events = [
    {
      type: "turn.submitted",
      id: "sub_t9",
      at: "2026-09-24T14:00:00.000Z",
      text: "do key_c",
      sha256: "key_c",
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
    {
      type: "turn.started",
      id: "t9",
      at: "2026-09-24T14:00:00.000Z",
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
    {
      type: "runtime.step_usage",
      id: "step_t9",
      at: "2026-09-24T14:00:01.000Z",
      inputTokens: 40,
      sessionID: "ses_runs",
    } as unknown as RuntimeEvent,
  ];
  const { surface, sessionID } = harness(events);
  const groups = await surface.promptRunGroups!(sessionID);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    promptKey: "key_c",
    runs: 1,
    successes: 0,
  });
  // 1 run, 0 successes, 0% — the honest zero the study's distribution
  // needs, without pretending a failed finish happened.
  expect(groups[0]!.successRate).toBe(0);
  expect(groups[0]!.avgInputTokens).toBe(40);
});

test("the same prompt replayed through forks answers one distribution", async () => {
  const events = [
    ...turn("t1", "key_a", true, "2026-09-24T10:00:00.000Z"),
    ...turn("t2", "key_a", false, "2026-09-24T11:00:00.000Z"),
    ...turn("t3", "key_a", true, "2026-09-24T12:00:00.000Z"),
    ...turn("t4", "key_b", true, "2026-09-24T13:00:00.000Z"),
  ];
  const { surface, sessionID } = harness(events);
  const groups = await surface.promptRunGroups!(sessionID);
  const keyA = groups.find((entry) => entry.promptKey === "key_a");
  expect(keyA).toMatchObject({
    runs: 3,
    successes: 2,
    successRate: 67,
    avgInputTokens: 100,
    avgOutputTokens: 50,
    retries: 0,
  });
  expect(groups).toHaveLength(2);
  const keyB = groups.find((entry) => entry.promptKey === "key_b");
  expect(keyB).toMatchObject({ runs: 1, successes: 1, successRate: 100 });
});
