import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { instructionRevision, openInvariantHits } from "@natalia/collab";

/**
 * Discovery D3's trigger pieces: the boundary folds D2's paired invariant
 * edges into drift signals, and reads the session's instruction epoch.
 */

const violation = (code: string, at: string, detail: string) =>
  ({
    type: "invariant.violation",
    at,
    owner: "session",
    invariant: "inv",
    code,
    detail,
    sessionID: "ses_x",
  }) as unknown as RuntimeEvent;

const resolved = (code: string, at: string, detail: string) =>
  ({
    type: "invariant.resolved",
    at,
    owner: "session",
    invariant: "inv",
    code,
    detail,
    sessionID: "ses_x",
  }) as unknown as RuntimeEvent;

test("open invariant hits fold the violation/resolved edges", () => {
  expect(openInvariantHits([])).toEqual([]);
  const events: RuntimeEvent[] = [
    violation("a", "t1", "d1"),
    violation("b", "t2", "d2"),
    resolved("a", "t3", "d1"),
    violation("a", "t4", "d1"), // re-open counts again
  ];
  expect(openInvariantHits(events)).toEqual([
    { code: "b", at: "t2", detail: "d2" },
    { code: "a", at: "t4", detail: "d1" },
  ]);
});

test("instruction revision is the max — the epoch never runs backwards", () => {
  const instructions = (revision: number) =>
    ({
      type: "context.instructions",
      id: `ci_${revision}`,
      kind: "config_reload",
      at: "2026-01-01T00:00:00.000Z",
      revision,
      summary: "reload",
    }) as unknown as RuntimeEvent;
  expect(instructionRevision([])).toBe(0);
  expect(
    instructionRevision([instructions(3), instructions(1), instructions(2)]),
  ).toBe(3);
});
