import { expect, test } from "bun:test";
import { foldGoal, GoalService } from "@natalia/goal";
import { goalTools } from "@natalia/goal-runtime";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { RuntimeTool } from "@anthelia/tools";

/**
 * The smallest runtime the goal tools touch: a session in the execution map, a
 * real goal service folding that session's journal, and a driver whose only
 * consulted method is stubbed.
 *
 * The driver is stubbed because the authority layer (`canStopGoal`) is not this
 * test's subject — the completion gate is, and it only becomes reachable once
 * that layer has let the call through. Everything the gate itself does runs for
 * real.
 */
function harness(input: {
  /** Events already in the session journal — a create, typically. */
  events: Parameters<GoalService["current"]>[1];
  /** The turn the goal tool call runs inside. */
  turnID: string;
  /** Inbox entries, so `isHumanTurn` can classify the turn. */
  inbox?: Array<{ id: string; internal?: boolean }>;
  /** Whether this turn counts as a goal round. */
  isGoalRound?: boolean;
  /** The injected completion check, standing in for the configured command. */
  completionCheck?: () =>
    | { ok: boolean; command?: string; detail?: string }
    | undefined;
}) {
  let nextEvent = 0;
  const service = new GoalService({
    now: () => "2026-01-01T00:00:00.000Z",
    nextEventId: () => `evt_${++nextEvent}`,
    nextGoalId: () => "goal_1",
  });
  // Mutations publish into the same journal the service folds, so a test can
  // assert the durable outcome rather than only that no refusal was returned.
  const journal = [...input.events] as Parameters<GoalService["current"]>[1] &
    RuntimeEvent[];
  const exec = {
    session: {
      id: "ses_goal_gate" as never,
      events: journal,
      inbox: input.inbox ?? [{ id: input.turnID, internal: true }],
    },
    activeTurnID: input.turnID,
  } as unknown as SessionExecutionState;
  const executions = new Map([["ses_goal_gate" as never, exec]]);
  const ctx = {
    ports: {
      getSessionID: () => "ses_goal_gate" as never,
      getExecutionBySession: () => executions,
      getTsRuntimeConfig: () => ({}),
      publishForSession: (_exec: unknown, event: unknown) => {
        journal.push(event as never);
      },
    },
  } as unknown as RuntimeContext;
  const goalRuntime = {
    service,
    driver: { isGoalRound: () => input.isGoalRound ?? true },
  } as unknown as Parameters<typeof goalTools>[1];
  const tools = goalTools(
    ctx,
    goalRuntime,
    input.completionCheck ? { completionCheck: input.completionCheck } : {},
  );
  return {
    tools,
    service,
    journal,
    update: tool(tools, "update_goal"),
  };
}

const tool = (tools: RuntimeTool[], name: string) =>
  tools.find((candidate) => candidate.name === name)!;

/** A created goal, as the session journal would hold it. */
function createdGoal() {
  const service = new GoalService({
    now: () => "2026-01-01T00:00:00.000Z",
    nextEventId: () => "evt_create",
    nextGoalId: () => "goal_1",
  });
  return service.create("ses_goal_gate" as never, undefined, {
    objective: "ship the thing",
    maxGoalRounds: 4,
  }).event;
}

/** A model-initiated completion, on a goal-round turn. */
const completeCall = {
  goal_id: "goal_1",
  revision: 1,
  action: "complete",
};
const toolContext = { workspaceRoot: "/tmp" } as never;

test("a model completion is refused when the configured check fails", async () => {
  const { update } = harness({
    events: [createdGoal()],
    turnID: "turn_goal",
    completionCheck: () => ({
      ok: false,
      command: "false",
      detail: "Exit code 1",
    }),
  });

  const answer = await update.execute(completeCall, toolContext);

  expect(answer).toContain("complete is refused");
  expect(answer).toContain("completion check failed");
});

test("a refused completion names the command, the reason, and what to do", async () => {
  const { update } = harness({
    events: [createdGoal()],
    turnID: "turn_goal",
    completionCheck: () => ({
      ok: false,
      command: "bun run verify",
      detail: "Exit code 1\n2 tests failed",
    }),
  });

  const answer = await update.execute(completeCall, toolContext);

  // Handed to the model, so it must be enough to act on.
  expect(answer).toContain("bun run verify");
  expect(answer).toContain("2 tests failed");
  expect(answer).toContain("Keep the goal active");
});

test("a model completion is accepted when the check passes", async () => {
  const { update, journal } = harness({
    events: [createdGoal()],
    turnID: "turn_goal",
    completionCheck: () => ({ ok: true, command: "true" }),
  });

  const answer = await update.execute(completeCall, toolContext);

  expect(answer).not.toContain("refused");
  // The durable outcome, not merely the absence of a refusal: a `blocked` or
  // `stopped` goal would pass the weaker assertion while failing the model.
  const goal = foldGoal(journal);
  expect(goal?.phase).toBe("complete");
});

test("a human completion is never blocked by the configured check", async () => {
  // A human saying "done" is the authority, for the same reason a human may stop
  // a goal immediately — the check judges the model's claim, not the user's.
  let ran = 0;
  const { update } = harness({
    events: [createdGoal()],
    turnID: "turn_human",
    inbox: [{ id: "turn_human", internal: false }],
    isGoalRound: false,
    completionCheck: () => {
      ran += 1;
      return { ok: false, command: "false", detail: "should not run" };
    },
  });

  await update.execute(completeCall, toolContext);

  expect(ran).toBe(0);
});

test("with no check configured, a completion behaves exactly as before", async () => {
  // No invented default: a workspace without the config is not gated at all, and
  // the completion lands exactly as it did before the gate existed.
  const { update, journal } = harness({
    events: [createdGoal()],
    turnID: "turn_goal",
  });

  const answer = await update.execute(completeCall, toolContext);

  expect(answer).not.toContain("refused");
  expect(foldGoal(journal)?.phase).toBe("complete");
});
