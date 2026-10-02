import { expect, test } from "bun:test";
import type { OperationRecord } from "@anthelia/contracts";
import {
  newestOperationRecords,
  operationRecordLine,
} from "../src/operation-records";

/**
 * The telemetry rows' view contract (T3/T4): the line carries the
 * record's own facts — level, the component family the operator greps
 * for, the message, the time — and the correlation ids ride the title.
 * Nothing is invented; a record without correlation titles with just the
 * component and time.
 */

test("a record's line carries its own facts, correlation in the title", () => {
  const record: OperationRecord = {
    at: "2026-09-24T00:00:00.000Z",
    level: "error",
    component: "[natalia-turn]",
    message: "finished",
    corr: { sessionID: "ses_a", turnID: "turn_1" },
  };
  const line = operationRecordLine(record);
  expect(line).toMatchObject({
    level: "error",
    component: "[natalia-turn]",
    message: "finished",
    at: "2026-09-24T00:00:00.000Z",
  });
  // The title joins the correlation with the separator the panel greps.
  expect(line.title).toContain("sessionID: ses_a · turnID: turn_1");
  expect(line.title).toContain("[natalia-turn] @ 2026-09-24T00:00:00.000Z");
  // A record without correlation: no dangling separator.
  expect(operationRecordLine({ ...record, corr: undefined }).title).toBe(
    "[natalia-turn] @ 2026-09-24T00:00:00.000Z",
  );
});

test("the newest-N tail renders newest first and stays bounded", () => {
  const records: OperationRecord[] = Array.from(
    { length: 100 },
    (_, index) => ({
      at: `2026-09-24T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      level: "info",
      component: `c${index}`,
      message: `m${index}`,
    }),
  );
  const shown = newestOperationRecords(records, 10);
  expect(shown).toHaveLength(10);
  expect(shown[0]!.component).toBe("c99");
  expect(shown[9]!.component).toBe("c90");
  // Fewer records than the bound: all of them, still newest first.
  expect(
    newestOperationRecords(records.slice(0, 3), 60).map((r) => r.component),
  ).toEqual(["c2", "c1", "c0"]);
});
