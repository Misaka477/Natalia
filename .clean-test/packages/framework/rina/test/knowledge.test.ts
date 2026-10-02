import { expect, test } from "bun:test";
import {
  GLOBAL_MEMORY_SCOPE,
  recallKnowledge,
  recallMemoryLanes,
  workspaceMemoryScope,
} from "../src/knowledge";

/**
 * Phase 7 rule 3 as a contract: the consultation order State → Workspace
 * Memory → Global Memory → ContextVault IS the answer's section order,
 * silent lanes drop without reordering, and the memory lanes never cross
 * their scopes.
 */

test("the priority order survives; silent lanes drop", () => {
  const answer = recallKnowledge({
    state: { available: true, state: { goal: "ship the engine" } },
    workspaceMemories: [{ id: "m1" } as never],
    globalMemories: [{ id: "g1" } as never],
    vaultHits: [{ id: "v1" } as never],
  });
  expect(answer.sections.map((section) => section.source)).toEqual([
    "state",
    "workspace_memory",
    "global_memory",
    "vault",
  ]);
  expect(answer.sources).toBe(4);
  // Only the middle two have anything: the order of the rest is unchanged.
  const partial = recallKnowledge({
    globalMemories: [{ id: "g1" } as never],
    vaultHits: [{ id: "v1" } as never],
  });
  expect(partial.sections.map((section) => section.source)).toEqual([
    "global_memory",
    "vault",
  ]);
  expect(partial.sources).toBe(2);
});

test("an unavailable state lane stays silent (a reason is not a fact)", () => {
  const answer = recallKnowledge({
    state: { available: false, reason: "no fact-state reader" },
    workspaceMemories: [{ id: "m1" } as never],
  });
  expect(answer.sections.map((section) => section.source)).toEqual([
    "workspace_memory",
  ]);
});

test("the memory lanes fetch their own scopes and nothing else", () => {
  // A stub service: the recall's args are the contract (the face never
  // asks for inactive knowledge, and never crosses scopes).
  const asked: Array<Record<string, unknown>> = [];
  const stub = {
    recall: (input?: Record<string, unknown>) => {
      asked.push(input ?? {});
      return input?.scope === workspaceMemoryScope("w1")
        ? ([{ id: "m1" }] as never)
        : ([{ id: "g1" }] as never);
    },
  } as never;
  const lanes = recallMemoryLanes(stub, "w1");
  expect(lanes.workspaceMemories).toHaveLength(1);
  expect(lanes.globalMemories).toHaveLength(1);
  expect(asked).toEqual([
    { scope: "workspace:w1" },
    { scope: GLOBAL_MEMORY_SCOPE },
  ]);
  // A limit rides both lanes when given.
  recallMemoryLanes(stub, "w1", 5);
  expect(asked[2]).toMatchObject({ scope: "workspace:w1", limit: 5 });
  expect(asked[3]).toMatchObject({ scope: GLOBAL_MEMORY_SCOPE, limit: 5 });
});
