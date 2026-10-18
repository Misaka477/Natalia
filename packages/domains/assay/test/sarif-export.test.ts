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
import { parseAssayDeclaration } from "../src/assay-declaration";
import { annotationsToSarif, declaredSarifRules } from "../src/sarif";

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

describe("declared rule metadata (D4)", () => {
  test("a declared rule is rendered with its title, description and level", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [
          {
            ruleId: "no-any",
            path: "src/a.ts",
            line: 3,
            message: "explicit any",
          },
        ],
        rules: [
          {
            id: "no-any",
            title: "No explicit any",
            level: "warning",
            description: "Typed holes leak into callers.",
          },
        ],
      }),
    ) as {
      runs: Array<{
        tool: { driver: { rules: Array<Record<string, unknown>> } };
        results: Array<{ level: string }>;
      }>;
    };
    const rule = document.runs[0]!.tool.driver.rules[0]!;
    expect(rule.shortDescription).toEqual({ text: "No explicit any" });
    expect(rule.fullDescription).toEqual({
      text: "Typed holes leak into callers.",
    });
    expect(rule.defaultConfiguration).toEqual({ level: "warning" });
    // The finding carries no level of its own, so the DECLARED default applies —
    // the severity the project set, not a hardcoded "error".
    expect(document.runs[0]!.results[0]!.level).toBe("warning");
  });

  test("a finding's own level beats the rule's default", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [
          { ruleId: "no-any", path: "a.ts", message: "x", level: "note" },
        ],
        rules: [{ id: "no-any", title: "No explicit any", level: "error" }],
      }),
    ) as { runs: Array<{ results: Array<{ level: string }> }> };
    expect(document.runs[0]!.results[0]!.level).toBe("note");
  });

  test("a declared rule that did not fire is still listed — the policy, not the summary", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [{ ruleId: "other", path: "a.ts", message: "x" }],
        rules: [
          { id: "no-any", title: "No explicit any" },
          { id: "other", title: "The other rule" },
        ],
      }),
    ) as {
      runs: Array<{
        tool: {
          driver: {
            rules: Array<{ id: string; shortDescription: { text: string } }>;
          };
        };
      }>;
    };
    expect(document.runs[0]!.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "no-any",
      "other",
    ]);
    expect(document.runs[0]!.tool.driver.rules[0]!.shortDescription.text).toBe(
      "No explicit any",
    );
  });

  test("a fired rule the project never declared keeps its id instead of vanishing", () => {
    const document = JSON.parse(
      annotationsToSarif({
        tool: "assay",
        findings: [{ ruleId: "undeclared-rule", path: "a.ts", message: "x" }],
        rules: [],
      }),
    ) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{ ruleIndex: number }>;
      }>;
    };
    expect(document.runs[0]!.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "undeclared-rule",
    ]);
    expect(document.runs[0]!.results[0]!.ruleIndex).toBe(0);
  });

  test("declaredSarifRules collects every check's rules, deduped by id", () => {
    const declaration = parseAssayDeclaration({
      version: 1,
      checks: [
        {
          id: "lint",
          command: "bun run lint",
          covers: ["validation:any"],
          rules: [{ id: "no-any", title: "No explicit any", level: "warning" }],
        },
        {
          id: "types",
          command: "bun run typecheck",
          covers: ["validation:typecheck"],
          rules: [
            {
              id: "no-any",
              title: "No explicit any (duplicate)",
              level: "error",
            },
            { id: "no-floating", title: "No floating promises" },
          ],
        },
      ],
    });
    const rules = declaredSarifRules(declaration);
    expect(rules.map((rule) => rule.id)).toEqual(["no-any", "no-floating"]);
    // First one wins, so a duplicated id cannot silently change severity.
    expect(rules[0]).toEqual({
      id: "no-any",
      title: "No explicit any",
      level: "warning",
    });
  });

  test("a declaration with no rules exports nothing declared (not a guess)", () => {
    expect(declaredSarifRules(parseAssayDeclaration({ checks: [] }))).toEqual(
      [],
    );
  });
});
