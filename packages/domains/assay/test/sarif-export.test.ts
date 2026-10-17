/**
 * Findings render as SARIF, and only findings a caller declared.
 *
 * The defect this closes: a failed check had no machine-readable annotation, so
 * a reader could learn that something failed but not which rule at which file and
 * line. The design point is where the findings come from — declared, never
 * parsed out of command output: extracting "which test failed where" from
 * arbitrary text is language-specific guesswork, and a wrong guess is worse than
 * no annotation.
 */
import { describe, expect, test } from "bun:test";
import { annotationsToSarif } from "../src/sarif";

describe("annotationsToSarif", () => {
  test("renders a rule, a result and a file:line location", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [
          {
            ruleId: "validation:test",
            path: "packages/core\\src\\a.ts",
            line: 42,
            message: "the contour parser drops the last segment",
          },
        ],
      }),
    ) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          ruleIndex: number;
          level: string;
          message: { text: string };
          locations: Array<{
            physicalLocation: {
              artifactLocation: { uri: string };
              region?: { startLine: number };
            };
          }>;
        }>;
      }>;
    };
    expect(document.version).toBe("2.1.0");
    const run = document.runs[0]!;
    expect(run.tool.driver.name).toBe("assay");
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "validation:test",
    ]);
    const result = run.results[0]!;
    expect(result.ruleIndex).toBe(0);
    expect(result.level).toBe("error");
    expect(result.message.text).toContain("drops the last segment");
    // Paths are portable: a SARIF consumer expects forward slashes.
    expect(result.locations[0]!.physicalLocation.artifactLocation.uri).toBe(
      "packages/core/src/a.ts",
    );
    expect(result.locations[0]!.physicalLocation.region).toEqual({
      startLine: 42,
    });
  });

  test("a file-level finding has no region, and the level is preserved", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [
          {
            ruleId: "docs:stale",
            path: "README.md",
            message: "the usage section is out of date",
            level: "warning",
          },
        ],
      }),
    ) as {
      runs: Array<{
        results: Array<{
          level: string;
          locations: Array<{ physicalLocation: { region?: unknown } }>;
        }>;
      }>;
    };
    const result = document.runs[0]!.results[0]!;
    expect(result.level).toBe("warning");
    expect(result.locations[0]!.physicalLocation.region).toBeUndefined();
  });

  test("two findings on one rule share a single rule entry", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [
          { ruleId: "r", path: "a.ts", line: 1, message: "one" },
          { ruleId: "r", path: "b.ts", line: 2, message: "two" },
        ],
      }),
    ) as {
      runs: Array<{
        tool: { driver: { rules: unknown[] } };
        results: Array<{ ruleIndex: number }>;
      }>;
    };
    expect(document.runs[0]!.tool.driver.rules).toHaveLength(1);
    expect(document.runs[0]!.results.map((entry) => entry.ruleIndex)).toEqual([
      0, 0,
    ]);
  });

  test("an empty run is a valid document", () => {
    const document = JSON.parse(
      annotationsToSarif({ tool: "assay", findings: [] }),
    ) as { runs: Array<{ results: unknown[] }> };
    expect(document.runs[0]!.results).toEqual([]);
  });
});
