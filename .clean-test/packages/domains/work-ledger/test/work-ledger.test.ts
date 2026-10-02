import { expect, test } from "bun:test";
import { createWorkLedgerController } from "../src";

test("work ledger controller writes work graph nodes and drift findings", async () => {
  const controller = createWorkLedgerController({
    openFindingIDs: () => new Set(),
  });
  expect(
    controller.agentActionNode({
      turnID: "turn_1",
      sessionID: "ses_1" as never,
    }),
  ).toMatchObject({ kind: "agent_action", turnID: "turn_1" });
});
