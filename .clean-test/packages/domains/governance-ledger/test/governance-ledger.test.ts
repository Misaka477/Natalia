import { expect, test } from "bun:test";
import { createGovernanceLedgerController } from "../src";

test("governance ledger controller records decisions and seeds constitution rules", () => {
  const controller = createGovernanceLedgerController();
  expect(
    controller.recordDecision({ id: "decision:1", decision: "ship" }),
  ).toMatchObject({ type: "decision.recorded", status: "accepted" });
  expect(controller.seedConstitutionRules([]).length).toBeGreaterThan(0);
});
