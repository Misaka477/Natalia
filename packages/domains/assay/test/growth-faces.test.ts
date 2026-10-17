import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { sessionFactStateFromEvents } from "@anthelia/session";
import { JsonSessionStore } from "@anthelia/session";
import { createTestContext } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import { sessionStoreController } from "@anthelia/session-store";
import { createIntelligenceSurface } from "../src/intelligence";

/**
 * G-a block 2's faces: `growthPropose` derives the curriculum from the
 * journal (completion known-gaps + unbacked plan tasks), records the
 * `growth.proposed` FACT, and answers it; `growthProposals` reads the
 * journaled proposals. The id is the content's hash, so a repeat
 * derivation appends nothing — and the empty session journals nothing.
 */

const dirs: string[] = [];
afterAllCleanup();

function afterAllCleanup() {
  process.on("exit", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

test("growthPropose records the proposal once and reads it back; the repeat appends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "growth-faces-"));
  dirs.push(dir);
  const sessionID = "ses_growth" as SessionID;
  const store = new JsonSessionStore(dir);
  const session = await store.loadOrCreate(sessionID, "growth");
  // The real runtime keeps one exec per session; the test's registry
  // mirrors it so the empty session reads its own (not the active one's).
  const execs = new Map<string, unknown>();
  // Two completions sharing one gap (a pattern) and a one-off (an anecdote).
  const events: RuntimeEvent[] = [
    {
      type: "completion.recorded",
      id: "c1",
      taskID: "t1",
      objective: "ship the packer",
      changeSummary: "packer shipped",
      validations: [],
      knownGaps: ["no ripgrep tool"],
      recordedAt: new Date().toISOString(),
    },
    {
      type: "completion.recorded",
      id: "c2",
      taskID: "t2",
      objective: "ship the reader",
      changeSummary: "reader shipped",
      validations: [],
      knownGaps: ["no ripgrep tool"],
      recordedAt: new Date().toISOString(),
    },
    {
      type: "completion.recorded",
      id: "c3",
      taskID: "t3",
      objective: "ship the misc",
      changeSummary: "misc shipped",
      validations: [],
      knownGaps: ["a one-off hiccup"],
      recordedAt: new Date().toISOString(),
    },
  ];
  for (const event of events) session.events.push(event);
  await store.save(session);

  // The hot fact state holds the WHOLE session fact (growth proposals
  // ride its intelligence slice, like completions).
  const exec = {
    session,
    factStateComplete: false,
    factState: sessionFactStateFromEvents(session.events),
  };
  execs.set(sessionID, exec);
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        sessionStoreController.mock({
          history: (id: `ses_${string}`, fallback: RuntimeEvent[]) =>
            Promise.resolve({
              events: fallback.map((event, seq) => ({ seq, event })),
              hasMore: false,
            }),
          flush: () => Promise.resolve(),
        } as unknown as Parameters<typeof sessionStoreController.mock>[0]),
      ]),
      sessionStore: store,
    },
    ports: {
      getReady: async () => {},
      getSessionID: () => sessionID,
      getExecutionBySession: () => execs as never,
      ensureExecution: async () => exec,
      getActiveExec: () => exec,
      publishForSession: (_: unknown, event: RuntimeEvent) => {
        // The real publish appends the journal AND folds the hot fact
        // state (`feedSessionFactState`) — the stub does both, or the
        // reader's hot-slice read sees a stale state.
        events.push(event);
        session.events.push(event);
        exec.factState = sessionFactStateFromEvents(session.events);
        exec.factStateComplete = true;
        return Promise.resolve();
      },
      getSessionPersistenceForSession: () => Promise.resolve(undefined),
      // No active plan: the unbacked-task lane of the curriculum reads
      // empty (the completion-gaps lane is what this test exercises).
      planDocRuntime: {
        planDocActive: async () => undefined,
        planDocRead: async () => ({ content: "" }),
      },
      nextCompletionSequence: () => 1,
    },
  } as unknown as RuntimeContext;
  const surface = createIntelligenceSurface(ctx, {});

  const proposed = await surface.growthPropose!(undefined, sessionID);
  expect(proposed.suggestions).toHaveLength(1);
  expect(proposed.suggestions[0]).toMatchObject({
    capability: "no ripgrep tool",
    observations: 2,
  });
  expect(proposed.proposalID).toMatch(/^growth:/u);

  // The fact is journaled, and the reader answers it.
  const list = await surface.growthProposals!(sessionID);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    proposalID: proposed.proposalID,
    considered: { tasks: 3, gaps: 3 },
  });

  // The repeat: the id is the content's hash — nothing appended.
  await surface.growthPropose!(undefined, sessionID);
  expect(await surface.growthProposals!(sessionID)).toHaveLength(1);

  // An empty journal: the answer's shape is kept, nothing journaled.
  const other = "ses_growth_empty" as SessionID;
  const emptySession = await store.loadOrCreate(other, "empty");
  execs.set(other, {
    session: emptySession,
    factStateComplete: false,
    factState: sessionFactStateFromEvents(emptySession.events),
  });
  const emptyProposal = await surface.growthPropose!(undefined, other);
  expect(emptyProposal).toMatchObject({
    proposalID: "growth:none",
    suggestions: [],
  });
});
