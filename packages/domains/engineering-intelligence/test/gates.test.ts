import { expect, test } from "bun:test";
import {
  SIZE_CAPS,
  SEMANTIC_OVERLAP_FLOOR,
  gateCandidate,
  semanticOverlap,
  type GateInput,
} from "../src/gates";

/**
 * L5's gate matrix: every gate bites, and every refusal is named.
 *
 * The load-bearing tests are the refusals: a gate that passes everything is
 * not a gate. Each one is proven by a candidate that violates exactly it,
 * and the composite's refusals carry `name: reason` lines in the shape the
 * journal's field expects.
 */

const baseline =
  "Run the release checklist: build the distribution, run the seven guards, then the full test suite, then the CLI suite.";

// Within the +20% growth cap (the baseline is 117 bytes; this is ~129).
const goodCandidate =
  "Run the release checklist: build the distribution, run the seven guards, then the full test suite, then the CLI suite, then push.";

const gateInput = (overrides: Partial<GateInput> = {}): GateInput => ({
  target: { kind: "skill", name: "release-checklist" },
  baseline,
  candidate: goodCandidate,
  suite: { ok: true, detail: "3475 tests, 0 failures" },
  benchmark: { ok: true, detail: "no capability regression" },
  ...overrides,
});

test("a clean candidate passes every gate with no refusals", () => {
  const report = gateCandidate(gateInput());
  expect(report.passed).toBe(true);
  expect(report.refusals).toEqual([]);
  expect(report.gates.map((gate) => gate.gate)).toEqual([
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
    "G6",
    "G7",
  ]);
});

test("G1 refuses a candidate on a red suite, naming the failure", () => {
  const report = gateCandidate(
    gateInput({ suite: { ok: false, detail: "2 failures in checkpoint" } }),
  );
  expect(report.passed).toBe(false);
  expect(report.refusals).toEqual([
    "release-checklist: G1 suite failed — 2 failures in checkpoint",
  ]);
});

test("G2's cap is per target kind: a skill's 15KB, a tool description's 500 chars", () => {
  expect(SIZE_CAPS.skill).toBe(15_000);
  expect(SIZE_CAPS["tool-description"]).toBe(500);
  expect(SIZE_CAPS["parameter-description"]).toBe(200);
  // A 600-character tool description is refused even though it would fit a
  // skill's cap — the cap follows the target, not the artifact's mood.
  const report = gateCandidate(
    gateInput({
      target: { kind: "tool-description", name: "sandbox_diff" },
      baseline: "Read a sandbox candidate's diff.",
      candidate: `${"x".repeat(600)} Read a sandbox candidate's diff.`,
    }),
  );
  expect(report.passed).toBe(false);
  expect(report.refusals[0]).toContain("G2");
  expect(report.refusals[0]).toContain("exceeds the 500 cap");
});

test("G3 refuses past the growth cap and admits up to it", () => {
  const base = "a".repeat(1_000);
  // +19% passes.
  expect(
    gateCandidate(
      gateInput({ baseline: base, candidate: "a".repeat(1_190) }),
    ).gates.find((gate) => gate.gate === "G3")!.ok,
  ).toBe(true);
  // +21% is refused.
  const report = gateCandidate(
    gateInput({ baseline: base, candidate: "a".repeat(1_210) }),
  );
  expect(report.gates.find((gate) => gate.gate === "G3")!.ok).toBe(false);
  expect(report.refusals.some((line) => line.includes("G3"))).toBe(true);
});

test("G4 refuses a candidate that drifted into a different artifact", () => {
  // A "code review skill" drifted into a poetry skill: same length ballpark,
  // nothing in common with the baseline.
  const drifted =
    "Compose a sonnet about the moon: fourteen lines, iambic pentameter, a turn in the final couplet.";
  const report = gateCandidate(gateInput({ baseline, candidate: drifted }));
  expect(report.gates.find((gate) => gate.gate === "G4")!.ok).toBe(false);
  expect(report.refusals.some((line) => line.includes("drifted"))).toBe(true);
  // The floor is one-directional on purpose: a candidate that keeps every
  // baseline token and adds to it is fine however long.
  expect(semanticOverlap(baseline, goodCandidate)).toBeGreaterThan(
    SEMANTIC_OVERLAP_FLOOR,
  );
});

test("G5 and G6 refuse the claims that break the two structural laws", () => {
  const live = gateCandidate(gateInput({ claims: { effectiveNow: true } }));
  expect(live.passed).toBe(false);
  expect(live.refusals[0]).toContain("G5");
  expect(live.refusals[0]).toContain("next session boundary");
  const auto = gateCandidate(gateInput({ claims: { selfApproved: true } }));
  expect(auto.passed).toBe(false);
  expect(auto.refusals[0]).toContain("G6");
  expect(auto.refusals[0]).toContain("a human approves every landing");
});

test("G7 treats an absent benchmark as a refusal, not a pass", () => {
  // "Nobody checked" must never read as "checked and fine": the seam is
  // absent until L6 exists, and until then every candidate is unverified.
  const absent = gateCandidate(gateInput({ benchmark: undefined }));
  expect(absent.passed).toBe(false);
  expect(absent.refusals.some((line) => line.includes("G7"))).toBe(true);
  expect(absent.refusals.some((line) => line.includes("unverified"))).toBe(
    true,
  );
  const regressed = gateCandidate(
    gateInput({ benchmark: { ok: false, detail: "TBLite subset -5%" } }),
  );
  expect(regressed.refusals.some((line) => line.includes("regressed"))).toBe(
    true,
  );
});

test("every refusal is a name: reason line, and a failed gate never blocks the others", () => {
  // One candidate violating three gates: all three are named, and the
  // gates that passed still report — the report is the whole picture.
  const report = gateCandidate(
    gateInput({
      suite: { ok: false, detail: "red" },
      benchmark: { ok: false, detail: "regressed" },
      claims: { effectiveNow: true },
    }),
  );
  expect(report.refusals).toHaveLength(3);
  for (const line of report.refusals)
    expect(line).toMatch(/^release-checklist: G[1-7] /u);
  expect(
    report.gates.filter((gate) => gate.ok).map((gate) => gate.gate),
  ).toEqual(["G2", "G3", "G4", "G6"]);
});
