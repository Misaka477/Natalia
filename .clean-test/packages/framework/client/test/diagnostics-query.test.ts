import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { OperationRecord } from "@anthelia/operation-log";
import { queryDiagnostics } from "../src/runtime/diagnostics-query";

/**
 * The unified diagnostics query (decisions §5: journal + operational log,
 * ONE face): one filter over two heterogeneous sources, honest about what
 * each side has.
 */

const event = (over: Partial<RuntimeEvent> & { type: string }): RuntimeEvent =>
  ({ id: "e1", ...over }) as RuntimeEvent;

const record = (over: Partial<OperationRecord>): OperationRecord => ({
  at: "2026-01-01T00:00:00.000Z",
  level: "info",
  component: "collab",
  message: "m",
  ...over,
});

const events: RuntimeEvent[] = [
  event({
    type: "context.instructions",
    id: "ci_1",
    kind: "config_reload",
    at: "2026-01-01T00:00:00.000Z",
    revision: 1,
    summary: "reload",
    sessionID: "ses_a",
  }),
  event({ type: "turn.finished", sessionID: "ses_b" }), // no at
  event({ type: "tool.update", sessionID: "ses_a", name: "run_shell" }),
];
const records: OperationRecord[] = [
  record({
    at: "2026-01-01T00:00:00.000Z",
    level: "info",
    component: "collab",
  }),
  record({
    at: "2026-01-02T00:00:00.000Z",
    level: "error",
    component: "shutdown",
    message: "boom",
  }),
  record({
    at: "2026-01-02T00:00:00.000Z",
    level: "warn",
    component: "collab",
    corr: { sessionID: "ses_a" },
  }),
];

test("one filter, two sources — with each side's honest semantics", () => {
  // sessionID scopes BOTH halves (the operational side via corr).
  const scoped = queryDiagnostics({
    events,
    records,
    filter: { sessionID: "ses_a" },
  });
  expect(scoped.journal.map((e) => (e as { type: string }).type)).toEqual([
    "context.instructions",
    "tool.update",
  ]);
  expect(scoped.operational).toHaveLength(1);
  expect(scoped.operational[0]!.corr?.sessionID).toBe("ses_a");

  // level/component exist only on the operational half.
  const severe = queryDiagnostics({
    events,
    records,
    filter: { level: "warn" },
  });
  expect(severe.operational).toHaveLength(2); // warn + error
  expect(severe.journal).toHaveLength(3); // journal has no levels: unchanged

  // since: both sides, and a journal event WITHOUT an at is excluded
  // rather than guessed about (the honesty rule).
  const recent = queryDiagnostics({
    events,
    records,
    filter: { since: "2026-01-02T00:00:00.000Z" },
  });
  // turn.started carries 01-01 (< since) and the other two carry no at:
  // all excluded — a timestamp filter never guesses.
  expect(recent.journal).toHaveLength(0);
  expect(recent.operational).toHaveLength(2);

  // contains reaches into payloads on both halves.
  const boom = queryDiagnostics({
    events,
    records,
    filter: { contains: "boom" },
  });
  expect(boom.operational).toHaveLength(1);
  expect(boom.journal).toHaveLength(0);

  // The per-side tail cap.
  const capped = queryDiagnostics({ events, records, filter: { limit: 1 } });
  expect(capped.journal).toHaveLength(1);
  expect(capped.operational).toHaveLength(1);
  expect(capped.operational[0]!.message).toBe("m"); // newest per side? records[2] is warn 'm'
});
