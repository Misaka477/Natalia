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
 * G-d's face over a real journal: the human's corrections across the
 * three safe sources, clustered into the suggestion. The face reads the
 * completed fact state like the rest of the EI surfaces.
 */

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(events: RuntimeEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "corr-face-"));
  dirs.push(dir);
  const sessionID = "ses_corr" as SessionID;
  const exec = {
    session: { id: sessionID, events } as never,
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

test("the face clusters the journal's repeated corrections into a suggestion", async () => {
  const events: RuntimeEvent[] = [
    {
      type: "mailbox.queued",
      id: "m1",
      messageID: "msg1",
      source: "user_via_live_chat",
      priority: "normal",
      intent: "constraint",
      text: "Always Ask Before Deleting!",
      safeSummary: "Always Ask Before Deleting!",
      deliveryPolicy: "next_safe_boundary",
      createdAt: "2026-09-24T10:00:00.000Z",
    } as unknown as RuntimeEvent,
    {
      type: "completion.human_validation",
      id: "v1",
      taskID: "t1",
      validation: "always ask before deleting",
      recordedAt: "2026-09-24T11:00:00.000Z",
    } as RuntimeEvent,
  ];
  const { surface, sessionID } = harness(events);
  const report = await surface.correctionPatterns!(sessionID);
  expect(report.suggestions).toHaveLength(1);
  expect(report.suggestions[0]).toMatchObject({
    capability: "always ask before deleting",
    destination: "rule",
    sources: ["mailbox", "human_validation"],
  });
  // The suggestion applies nothing: growth 默认不自授权 — the answer IS
  // the read, and the destination's class is the constitution's table.
  expect(report.considered).toEqual({ corrections: 2 });
});
