/**
 * Failure annotations as SARIF — the format code scanning already understands.
 *
 * WHY A STANDARD FORMAT, AGAIN. An annotation says "this rule fired at this file
 * and line"; every editor, code-scanning uploader and review tool already reads
 * that from SARIF, so exporting our own shape would be a translation nobody
 * asked for.
 *
 * WHERE THE FINDINGS COME FROM IS THE DESIGN POINT. This module does NOT parse
 * command output: extracting "which test failed at which line" from arbitrary
 * output is language-specific guesswork, and a guess that is wrong is worse than
 * no annotation. Findings arrive DECLARED — by the project's check definition or
 * by the caller — and this only renders them.
 */

/** One finding, as a caller declares it. */
export type Annotation = {
  /** The rule that fired: a check id, a lint rule, a policy name. */
  ruleId: string;
  /** Repo-relative path the finding is about. */
  path: string;
  /** 1-based line; omitted for a file-level finding. */
  line?: number;
  message: string;
  level?: "error" | "warning" | "note";
};

/**
 * Render findings as a SARIF 2.1.0 log.
 *
 * `tool` names the producer (the check that produced the findings). The `rules`
 * array is derived from the findings so a reader can list what fired without
 * walking every result, and `ruleIndex` links the two — SARIF readers expect
 * both to agree.
 */
export function annotationsToSarif(input: {
  tool: string;
  findings: readonly Annotation[];
}): string {
  const ruleIds = [...new Set(input.findings.map((entry) => entry.ruleId))];
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: id },
  }));
  const results = input.findings.map((entry) => {
    const uri = entry.path.split("\\").join("/");
    const physicalLocation =
      entry.line === undefined
        ? { artifactLocation: { uri } }
        : { artifactLocation: { uri }, region: { startLine: entry.line } };
    return {
      ruleId: entry.ruleId,
      ruleIndex: ruleIds.indexOf(entry.ruleId),
      level: entry.level ?? "error",
      message: { text: entry.message },
      locations: [{ physicalLocation }],
    };
  });
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: input.tool,
              informationUri: "https://github.com/Misaka477/Natalia",
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  )}\n`;
}
