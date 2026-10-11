import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  shouldWakeForVerdict,
  verdictAlreadyRequested,
} from "../src/verdict-trigger";

/**
 * S9's trigger law. A verdict wake is due when a HUMAN turn follows a
 * FINISHED assistant turn — the user's follow-up is the verdict on the
 * answer that preceded it. Each exclusion is a real way to wake her for
 * nothing.
 */

const submitted = (internal?: boolean) =>
  ({
    type: "turn.submitted",
    id: "adm",
    text: "why is the build red",
    byteLength: 17,
    lineCount: 1,
    sha256: "sha",
    ...(internal ? { internal: true } : {}),
  }) as unknown as RuntimeEvent;

const started = (id: string) =>
  ({ type: "turn.started", id }) as unknown as RuntimeEvent;

const finished = (id: string) =>
  ({
    type: "turn.finished",
    id,
    stopReason: "done",
    durationMs: 10,
  }) as unknown as RuntimeEvent;

test("a human turn after a finished assistant turn is the verdict shape", () => {
  const decision = shouldWakeForVerdict([
    submitted(),
    started("turn_a"),
    finished("turn_a"),
    submitted(),
  ]);
  expect(decision.wake).toBe(true);
  expect(decision.turnID).toBe("turn_a");
});

test("an internal wake is nobody speaking — no verdict", () => {
  const decision = shouldWakeForVerdict([
    submitted(),
    started("turn_a"),
    finished("turn_a"),
    submitted(true),
  ]);
  expect(decision.wake).toBe(false);
  expect(decision.reason).toContain("internal wake");
});

test("an unfinished turn has no answer to judge", () => {
  const decision = shouldWakeForVerdict([
    submitted(),
    started("turn_a"),
    submitted(),
  ]);
  expect(decision.wake).toBe(false);
  expect(decision.reason).toContain("still in flight");
});

test("the wake is idempotent: the journal's fact says she was already asked", () => {
  const events = [
    ...[],
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
