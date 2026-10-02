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
 * Block ②'s faces: a growth trigger promoted to a proposal (the class
 * policy's routing), the promotion recorded as the audit fact, and read
 * back. The faces apply NOTHING — the destination's face does.
 */

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(events: RuntimeEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "promo-face-"));
  dirs.push(dir);
  const sessionID = "ses_promo" as SessionID;
  const session = { id: sessionID, events } as never;
  const exec = {
    session,
    factStateComplete: false,
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
      publishForSession: (_: unknown, event: RuntimeEvent) => {
        events.push(event);
        exec.factState = sessionFactStateFromEvents(events);
        return undefined;
      },
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

/** A journal whose completions repeat one gap (a curriculum trigger). */
function gapJournal(): RuntimeEvent[] {
  const gap = { type: "completion.recorded" } as unknown as RuntimeEvent;
  void gap;
  return [
    {
      id: "c1",
      type: "completion.recorded",
      taskID: "t1",
      objective: "ship the packer",
      changeSummary: "packer shipped",
      validations: [],
      knownGaps: ["no ripgrep tool"],
      recordedAt: new Date().toISOString(),
    } as RuntimeEvent,
    {
      id: "c2",
      type: "completion.recorded",
      taskID: "t2",
      objective: "ship the reader",
      changeSummary: "reader shipped",
      validations: [],
      knownGaps: ["no ripgrep tool"],
      recordedAt: new Date().toISOString(),
    } as RuntimeEvent,
  ];
}

test("a trigger promotes to a proposal routed by the class policy, recorded and read back", async () => {
  const events = gapJournal();
  const { surface, sessionID } = harness(events);
  // The trigger the journal carries (the curriculum's repeated gap).
  const triggers = await surface.growthTriggers!(sessionID);
  expect(triggers.map((entry) => entry.capability)).toContain(
    "no ripgrep tool",
  );

  const promoted = await surface.promoteGrowthTrigger!(
    { capability: "no ripgrep tool" },
    sessionID,
  );
  expect(promoted).toMatchObject({
    promoted: true,
    destination: "skill",
    approval: "auto",
  });
  // The fact is journaled and the reader answers it.
  const list = await surface.growthPromotions!(sessionID);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    destination: "skill",
    approval: "auto",
    trigger: { capability: "no ripgrep tool" },
  });
  // The repeat appends nothing (the id is rule:capability's hash).
  await surface.promoteGrowthTrigger!(
    { capability: "no ripgrep tool" },
    sessionID,
  );
  expect(await surface.growthPromotions!(sessionID)).toHaveLength(1);

  // The honest edges: no session / an unknown trigger.
  expect(
    await surface.promoteGrowthTrigger!({ capability: "zzz" }, sessionID),
  ).toEqual({
    promoted: false,
    reason: "unknown_trigger",
  });
}, 30_000);
