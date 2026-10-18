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
import type { AssayDeclaration } from "./assay-declaration";

/** The rules a declaration carries, deduped by id (first one wins). */
export function declaredSarifRules(
  declaration: AssayDeclaration,
): DeclaredSarifRule[] {
  const rules = new Map<string, DeclaredSarifRule>();
  for (const check of declaration.checks)
    for (const rule of check.rules ?? [])
      if (!rules.has(rule.id))
        rules.set(rule.id, {
          id: rule.id,
          title: rule.title,
          ...(rule.level ? { level: rule.level } : {}),
          ...(rule.description ? { description: rule.description } : {}),
        });
  return [...rules.values()];
}

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

/** A rule the project DECLARED, with the metadata SARIF readers show. */
export type DeclaredSarifRule = {
  id: string;
  title: string;
  level?: "error" | "warning" | "note";
  description?: string;
};

/**
 * Render findings as a SARIF 2.1.0 log.
 *
 * `tool` names the producer (the check that produced the findings). `rules` is
 * the D4 half of the design: a rule's id, title and default severity are
 * DECLARED by the project (its check declaration), so the rule list a code
 * scanner shows is the project's own vocabulary rather than a guess made from
 * some language's output. A rule declared but not fired is still listed — that is
 * what makes the list a policy instead of a summary — and a finding whose rule
 * the project never declared keeps its own id and appears as its own rule, which
 * is visibly un-declared rather than silently dropped.
 */
export function annotationsToSarif(input: {
  tool: string;
  findings: readonly Annotation[];
  rules?: readonly DeclaredSarifRule[];
}): string {
  const declared = new Map<string, DeclaredSarifRule>();
  for (const rule of input.rules ?? [])
    if (!declared.has(rule.id)) declared.set(rule.id, rule);
  const fired = [...new Set(input.findings.map((entry) => entry.ruleId))];
  for (const id of fired)
    if (!declared.has(id)) declared.set(id, { id, title: id });
  const ruleIds = [...declared.keys()];
  const rules = ruleIds.map((id) => {
    const declaration = declared.get(id)!;
    return {
      id,
      name: id,
      shortDescription: { text: declaration.title },
      ...(declaration.description
        ? { fullDescription: { text: declaration.description } }
        : {}),
      ...(declaration.level
        ? { defaultConfiguration: { level: declaration.level } }
        : {}),
    };
  });
  const results = input.findings.map((entry) => {
    const uri = entry.path.split("\\").join("/");
    const physicalLocation =
      entry.line === undefined
        ? { artifactLocation: { uri } }
        : { artifactLocation: { uri }, region: { startLine: entry.line } };
    return {
      ruleId: entry.ruleId,
      ruleIndex: ruleIds.indexOf(entry.ruleId),
      level: entry.level ?? declared.get(entry.ruleId)?.level ?? "error",
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
