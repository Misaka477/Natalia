import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  lastFinishedTurnID,
  verdictAlreadyRequested,
  verdictWakeDue,
} from "../src/verdict-trigger";

/**
 * S9's trigger law: a HUMAN submission after a FINISHED assistant turn.
 * Each exclusion is a real way to wake her for nothing.
 */

const started = (id: string) =>
  ({ type: "turn.started", id }) as unknown as RuntimeEvent;
const finished = (id: string) =>
  ({
    type: "turn.finished",
    id,
    stopReason: "done",
    durationMs: 10,
  }) as unknown as RuntimeEvent;

test("a human submission after a finished turn is the verdict shape", () => {
  const decision = verdictWakeDue({ lastFinishedTurnID: "turn_a" });
  expect(decision.wake).toBe(true);
  expect(decision.turnID).toBe("turn_a");
});

test("an internal wake is nobody speaking — no verdict", () => {
  const decision = verdictWakeDue({
    lastFinishedTurnID: "turn_a",
    submissionInternal: true,
  });
  expect(decision.wake).toBe(false);
  expect(decision.reason).toContain("internal wake");
});

test("a turn still in flight has no answer to judge", () => {
  // The journal's newest turn started but never finished.
  expect(lastFinishedTurnID([started("turn_a"), finished("turn_b")])).toBe(
    "turn_b",
  );
  expect(
    lastFinishedTurnID([finished("turn_a"), started("turn_b")]),
  ).toBeUndefined();
  expect(lastFinishedTurnID([])).toBeUndefined();
  const decision = verdictWakeDue({
    lastFinishedTurnID: lastFinishedTurnID([
      finished("turn_a"),
      started("turn_b"),
    ]),
  });
  expect(decision.wake).toBe(false);
  expect(decision.reason).toContain("nothing to judge");
});

test("the wake is idempotent: the journal's fact says she was already asked", () => {
  const events = [
    {
      type: "verdict.requested",
      id: "vr_1",
      turnID: "turn_a",
      at: "2026-10-13T00:00:00.000Z",
    } as unknown as RuntimeEvent,
  ];
  expect(verdictAlreadyRequested(events, "turn_a")).toBe(true);
  expect(verdictAlreadyRequested(events, "turn_b")).toBe(false);
});
