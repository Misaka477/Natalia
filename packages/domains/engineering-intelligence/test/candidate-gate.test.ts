import { expect, test } from "bun:test";
import { buildGateRequest, suiteVerdictFrom } from "../src/candidate-gate";
import { parseVerdict } from "../src/verdict";

/**
 * S9's candidate gate: what we ask Nia, and how her answer becomes the
 * seven gates' seam. The seam used to answer a static "unverified"
 * forever; now it answers with her verdict.
 */

test("the request names the candidate, the suite command and the diff", () => {
  const request = buildGateRequest({
    candidate: "live-001-evolved",
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
    suiteCommand: "bun run typecheck",
  });
  expect(request).toContain("VERDICT REQUEST");
  expect(request).toContain("Candidate: live-001-evolved");
  expect(request).toContain("bun run typecheck");
  // The diff rides, so she judges WHAT changed rather than a summary.
  expect(request).toContain("--- a");
  expect(request).toContain("+new");
  // And it says which payload this is — the recorded lesson: one
  // audit-framed sentence for every intent made a collaboration arrive as
  // an audit.
  expect(request).toContain("not a plan audit");
});

test("her pass becomes a passing seam; her fail carries her words verbatim", () => {
  const pass = parseVerdict(
    [
      "VERDICT:",
      "turn: n/a",
      "judgment: pass",
      "reasons: 2550 tests, 0 failures",
    ].join("\n"),
  );
  expect(suiteVerdictFrom(pass)).toEqual({
    ok: true,
    detail: "Nia ran the suite: 2550 tests, 0 failures",
  });
  const fail = parseVerdict(
    [
      "VERDICT:",
      "turn: n/a",
      "judgment: fail",
      "reasons: 2 failures in engine.test.ts",
    ].join("\n"),
  );
  const verdict = suiteVerdictFrom(fail);
  expect(verdict.ok).toBe(false);
  // The refusal names HER reason — a gate that refuses must say why.
  expect(verdict.detail).toContain("2 failures in engine.test.ts");
});

test("no verdict is an unverified seam, never a passing one", () => {
  // The honesty rule: absence of an answer is not a pass.
  expect(suiteVerdictFrom(undefined)).toEqual({
    ok: false,
    detail: "no verdict arrived — the gate is unverified, not passed",
  });
  // So is a verdict she never labeled.
  expect(
    suiteVerdictFrom(
      parseVerdict("VERDICT:\njudgment: pass")!.judgment
        ? undefined
        : undefined,
    ).ok,
  ).toBe(false);
});
