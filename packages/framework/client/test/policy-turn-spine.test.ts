/**
 * The correlation spine, in the policy gates (audit 缺口 3).
 *
 * Every diagnostic `policy.ts` publishes describes a denial at a gate that
 * already knows WHICH TURN asked — the hook event is built right above each
 * publish. A diagnostic without that subject cannot be grouped by turn, so
 * "which turn was refused" is unanswerable from the log while the thrown
 * message says only the path.
 *
 * The pin reads the source: three publishers exist today, and a fourth added
 * without `turnID` is the regression this file exists to catch — a behavior
 * test would need a live denial at each gate, which is a much larger harness
 * than the invariant needs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "runtime", "tool-execution", "policy.ts"),
  "utf8",
);

describe("a policy diagnostic carries the turn it belongs to", () => {
  // Every `publishForSession(..., { type: "diagnostic", ... })` object literal
  // in this file, at whatever depth it sits.
  const publishers = source.match(
    /publishForSession\([^)]*?\{[^{}]*?type: "diagnostic"[\s\S]*?\n\s*\}/gu,
  );

  test("the file publishes diagnostics at all (the pin would be vacuous)", () => {
    expect((publishers ?? []).length).toBe(3);
  });

  test("each of them names its turn", () => {
    const missing = (publishers ?? []).filter(
      (block) => !/turnID:/u.test(block),
    );
    expect(missing).toEqual([]);
  });

  test("and it uses a name the gate already knows, never an invented id", () => {
    for (const block of publishers ?? []) {
      // The value must be one of the names that already exists before the
      // publish: the hook event's own turn, or the session's active turn (with
      // the session-scoped sandbox key as its fallback). Never a literal, and
      // never a new id conjured to fill the field — the expression may wrap
      // across lines, which is why this allows the break.
      const value = block.slice(block.indexOf("turnID:"));
      expect(/hookEvent\.turnID|activeTurnID/u.test(value)).toBe(true);
      expect(/turnID:\s*["'`][\w:-]+["'`]/u.test(value)).toBe(false);
    }
  });
});
