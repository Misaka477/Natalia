import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { SessionExecutionState } from "@anthelia/substrate";
import { mainTurnHasInfrastructureError } from "../src/runtime/event-sink";

function execWith(events: RuntimeEvent[]): SessionExecutionState {
  return {
    session: { id: "ses_infrastructure_error", events },
  } as unknown as SessionExecutionState;
}

function turnEvents(turnID: string, retryID: string): RuntimeEvent[] {
  return [
    {
      type: "turn.submitted",
      id: turnID,
      text: "work",
      byteLength: 4,
      lineCount: 1,
      sha256: "hash",
    },
    {
      type: "step.retry.exhausted",
      id: retryID,
      operation: "llm_step",
      step: 1,
      attempts: 1,
      maxAttempts: null,
      reason: "invalid_request",
      statusCode: 400,
      retryable: false,
      message: "invalid_request (400)",
    },
    {
      type: "turn.finished",
      id: turnID,
      stopReason: "error",
    },
  ];
}

test("provider retry exhausted with the bare turn id is an infrastructure error", () => {
  const turnID = "turn_provider_400";
  expect(
    mainTurnHasInfrastructureError(
      execWith(turnEvents(turnID, turnID)),
      turnID,
    ),
  ).toBe(true);
});

test("nested retry ids remain infrastructure errors", () => {
  const turnID = "turn_context_limit";
  expect(
    mainTurnHasInfrastructureError(
      execWith(turnEvents(turnID, `${turnID}:context-limit`)),
      turnID,
    ),
  ).toBe(true);
});
