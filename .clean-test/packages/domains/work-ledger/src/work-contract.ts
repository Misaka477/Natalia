/**
 * WorkContract source facts (EI §8.2, Phase -1.b).
 *
 * The WorkContract is R — the reference frame drift is judged against (§3.0):
 * without a user-tier commitment, "偏移" has no definition. It is produced at
 * the existing user-confirmation points (plan handoff / activate gate): the
 * model drafts scope/verification/constraints extracted from the plan document
 * it just wrote (grounding, not invention), the runtime validates the draft,
 * and the user approves it once through the plan-acceptance gate.
 *
 * Two rules shape this module:
 *
 * 1. **Placeholders are rejected, not guessed.** A field that is a single
 *    character or a pure generic word ("all", "everything", "相关") carries no
 *    commitment and must never reach the journal as one; the proposer gets the
 *    rejection as feedback and re-drafts.
 * 2. **A plan document edit invalidates the draft, never the acceptance.**
 *    `drafted` carries the planVersion it was extracted from; the projection
 *    marks a draft stale when the document changed after it. An accepted
 *    contract is the user's promise and stays current until a new one is
 *    approved — nothing replaces it silently.
 */
import type { RuntimeEvent } from "@anthelia/contracts";

export type WorkContractDraftedEvent = Extract<
  RuntimeEvent,
  { type: "work_contract.drafted" }
>;
export type WorkContractAcceptedEvent = Extract<
  RuntimeEvent,
  { type: "work_contract.accepted" }
>;
export type DetourRequestedEvent = Extract<
  RuntimeEvent,
  { type: "detour.requested" }
>;
export type DetourReviewedEvent = Extract<
  RuntimeEvent,
  { type: "detour.reviewed" }
>;

export type WorkContractFields = {
  scope?: string[];
  verification?: string[];
  constraints?: string[];
};

/** Pure generic words that carry no commitment, in either language. */
const GENERIC_PLACEHOLDERS = new Set([
  "all",
  "everything",
  "anything",
  "any",
  "none",
  "n/a",
  "na",
  "tbd",
  "todo",
  "misc",
  "various",
  "stuff",
  "things",
  "everything else",
  "all files",
  "全部",
  "所有",
  "任何",
  "一切",
  "相关",
  "待定",
  "未定",
  "略",
]);

/** True when a single field value carries no real commitment. */
export function isPlaceholderContractValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return true;
  return GENERIC_PLACEHOLDERS.has(trimmed.toLowerCase());
}

/**
 * Validates a proposed draft's fields (EI §8.2 runtime validation):
 *
 * - a provided field must be a non-empty array (an empty array provided means
 *   the proposer did not actually extract anything);
 * - no value may be a placeholder (single character or a pure generic word).
 *
 * Returns the rejection reasons; an empty array means the draft is valid.
 * An all-empty draft is NOT invalid — it produces an `unverifiable` acceptance
 * (advisory-only judgment), per EI §3.8 P-1.b.
 */
export function validateWorkContractFields(
  fields: WorkContractFields,
): string[] {
  const problems: string[] = [];
  for (const field of ["scope", "verification", "constraints"] as const) {
    const values = fields[field];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length === 0) {
      problems.push(
        `${field} was provided but is empty; omit it or extract concrete entries`,
      );
      continue;
    }
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) {
        problems.push(`${field} contains an empty entry`);
        continue;
      }
      if (isPlaceholderContractValue(value))
        problems.push(
          `${field} entry "${value.trim().slice(0, 40)}" is a placeholder; extract concrete entries`,
        );
    }
  }
  return problems;
}

/** True when the draft extracted no structured fields at all. */
export function isUnverifiableContract(fields: WorkContractFields): boolean {
  return (
    !(fields.scope?.length ?? false) &&
    !(fields.verification?.length ?? false) &&
    !(fields.constraints?.length ?? false)
  );
}

/**
 * Builds a `work_contract.drafted` event. Repeatable: a rejected draft is
 * re-proposed with the user's feedback folded in, and the projection keeps the
 * latest draft per plan. Empty field arrays are omitted rather than emitted as
 * `[]` so a consumer can tell "nothing extracted" from "empty extraction".
 */
export function buildWorkContractDrafted(input: {
  id: string;
  planID: string;
  planVersion: number;
  scope?: string[];
  verification?: string[];
  constraints?: string[];
  draftedAt: string;
}): WorkContractDraftedEvent {
  return {
    type: "work_contract.drafted",
    id: input.id,
    planID: input.planID,
    planVersion: input.planVersion,
    ...(input.scope && input.scope.length ? { scope: input.scope } : {}),
    ...(input.verification && input.verification.length
      ? { verification: input.verification }
      : {}),
    ...(input.constraints && input.constraints.length
      ? { constraints: input.constraints }
      : {}),
    draftedAt: input.draftedAt,
    source: "model",
  };
}

/**
 * Builds the user-approved `work_contract.accepted` event — the R drift is
 * judged against. `acceptedBy` is always "user": only a user confirmation
 * makes a contract judge-able (EI §3.3 铁律). `unverifiable` marks a plan
 * approved with no extractable fields (advisory-only judgment).
 */
export function buildWorkContractAccepted(input: {
  id: string;
  planID: string;
  planVersion: number;
  scope?: string[];
  verification?: string[];
  constraints?: string[];
  acceptedAt: string;
  unverifiable?: boolean;
}): WorkContractAcceptedEvent {
  return {
    type: "work_contract.accepted",
    id: input.id,
    planID: input.planID,
    planVersion: input.planVersion,
    ...(input.scope && input.scope.length ? { scope: input.scope } : {}),
    ...(input.verification && input.verification.length
      ? { verification: input.verification }
      : {}),
    ...(input.constraints && input.constraints.length
      ? { constraints: input.constraints }
      : {}),
    acceptedBy: "user",
    acceptedAt: input.acceptedAt,
    ...(input.unverifiable ? { unverifiable: true } : {}),
  };
}

/**
 * Task-type heuristics and the minimum-evidence matrix (EI §8.8).
 *
 * "Done" is only judge-able when the evidence matches the task's kind: a
 * dependency bump needs a lockfile check, a parser change needs parser tests,
 * a docs-only change needs none. The heuristic classifies the objective (and
 * the committed scope) into a task kind; the matrix then states the minimum
 * validation evidence each kind requires. The completion card consumes it to
 * answer "is it really done, what evidence is missing".
 */
export type TaskKind =
  | "dependency"
  | "parser"
  | "test"
  | "docs"
  | "config"
  | "code";

/**
 * The minimum evidence matrix (EI §8.8): which validation evidence each task
 * kind needs before a completion claim is judge-able. `patterns` are matched
 * against the objective and committed scope; `requires` names the evidence
 * classes the completion card must show.
 */
export const MINIMUM_EVIDENCE_MATRIX: Record<
  TaskKind,
  {
    patterns: RegExp;
    requires: string[];
    note: string;
  }
> = {
  dependency: {
    patterns:
      /\bdependen\w*|install\w*|upgrade|bump|lockfile|manifest\w*|package\.json|bun\.lock|cargo|pyproject|requirements\b/iu,
    requires: ["validation:install", "validation:typecheck"],
    note: "a dependency change must show the install and typecheck evidence",
  },
  parser: {
    patterns: /\bparser|parsing|tokeniz\w*|lexer|grammar|AST\b/iu,
    requires: ["validation:parser"],
    note: "a parser change must show parser test evidence",
  },
  test: {
    patterns: /\btest|spec|coverage|assertion/iu,
    requires: ["validation:test"],
    note: "a test change must show the test-run evidence",
  },
  docs: {
    patterns:
      /\bdocs?\b|readme|documentation|comment\w*|constitution\.md|agents\.md/iu,
    requires: [],
    note: "a docs-only change needs no runtime validation",
  },
  config: {
    patterns: /\bconfig|settings?|\.env|tsconfig|permissionMode/iu,
    requires: ["validation:typecheck"],
    note: "a config change must show a typecheck or load check",
  },
  code: {
    patterns: /.*/u,
    requires: ["validation:test"],
    note: "a code change must show a test or equivalent validation",
  },
};

/**
 * A change's path class (EI §8.8 / Phase 4 E3): inferred from the file path,
 * never from agent self-report or plan metadata — zero declaration, zero false
 * positive. Drives the minimum-evidence matrix.
 */
export type PathClass = "source" | "test" | "docs" | "config" | "other";

/** Classify one path by extension / layout. */
function pathClassOf(path: string): PathClass {
  const p = path.toLowerCase().replace(/\\/gu, "/");
  if (/\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|\/tests?\//iu.test(p))
    return "test";
  if (/\.(md|mdx|txt|rst|adoc)$/iu.test(p)) return "docs";
  if (
    /(^|\/)(package\.json|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.ya?ml|tsconfig[^/]*\.json|deno\.json|\.env[^/]*)$/iu.test(
      p,
    ) ||
    /\.(ya?ml|toml|ini|cfg|conf)$/iu.test(p)
  )
    return "config";
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|kts|scala|c|cc|cpp|cxx|h|hpp|cs|swift|zig|nim|lua|php|ex|exs|erl|hs|ml|clj|dart)$/iu.test(
      p,
    )
  )
    return "source";
  return "other";
}

/**
 * Classify a change set into one path class (EI §8.8). The highest-evidence
 * requirement wins, so a mixed source+docs change is treated as source (it must
 * still be validated). An empty set is "other".
 */
export function classifyPathClass(paths: readonly string[]): PathClass {
  if (!paths.length) return "other";
  const classes = paths.map(pathClassOf);
  if (classes.includes("test")) return "test";
  if (classes.includes("source")) return "source";
  if (classes.includes("config")) return "config";
  if (classes.includes("docs")) return "docs";
  return "other";
}

/**
 * The path-class minimum-evidence matrix (EI §8.8 / Phase 4 E3): a source or
 * test change must show at least one passing validation; docs / config / other
 * need none (unverified is acceptable and labelled).
 */
export const PATH_CLASS_EVIDENCE: Record<
  PathClass,
  { requires: string[]; note: string }
> = {
  source: {
    requires: ["validation:any"],
    note: "a source change must show at least one passing validation",
  },
  test: {
    requires: ["validation:test"],
    note: "a test change must show the test-run evidence",
  },
  docs: { requires: [], note: "a docs change needs no runtime validation" },
  config: { requires: [], note: "a config change needs no runtime validation" },
  other: { requires: [], note: "no runtime validation required" },
};

/** Classifies an objective (+ optional committed scope) into a task kind. */
export function classifyTaskKind(
  objective: string,
  scope: string[] = [],
): TaskKind {
  const haystack = `${objective} ${scope.join(" ")}`.toLowerCase();
  const kinds: TaskKind[] = ["dependency", "parser", "test", "docs", "config"];
  for (const kind of kinds)
    if (MINIMUM_EVIDENCE_MATRIX[kind].patterns.test(haystack)) return kind;
  return "code";
}

/**
 * The completion card's judgment (EI §8.8): given the task kind and the
 * evidence actually recorded, which required evidence classes are still
 * missing. An empty `missing` list means the completion claim is judge-able;
 * a docs-only task is always judge-able.
 */
export function evaluateCompletionCard(input: {
  objective: string;
  scope?: string[];
  /** The changed paths — the primary (path-based) classification source. */
  changes?: string[];
  evidenceRefs: string[];
  validations?: Array<{
    command?: string;
    result?: string;
    safeSummary?: string;
  }>;
}): {
  kind: TaskKind | PathClass;
  classifiedBy: "path" | "objective";
  requires: string[];
  missing: string[];
  judgeable: boolean;
  note: string;
} {
  // Path-based classification is primary (EI §8.8: zero declaration, zero false
  // positive); the objective/scope text classifier is the fallback when no
  // change paths are known.
  const pathClass = input.changes?.length
    ? classifyPathClass(input.changes)
    : undefined;
  const kind: TaskKind | PathClass =
    pathClass ?? classifyTaskKind(input.objective, input.scope ?? []);
  const matrix = pathClass
    ? PATH_CLASS_EVIDENCE[pathClass]
    : MINIMUM_EVIDENCE_MATRIX[kind as TaskKind];
  const present = new Set<string>();
  for (const reference of input.evidenceRefs) present.add(reference);
  for (const validation of input.validations ?? []) {
    const command = validation.command?.toLowerCase() ?? "";
    if (validation.result !== "passed") continue;
    present.add("validation:any");
    if (/bun install|npm install|pnpm install|yarn install/iu.test(command))
      present.add("validation:install");
    if (/tsc|typecheck/iu.test(command)) present.add("validation:typecheck");
    if (/bun test|vitest|jest|pytest|go test|cargo test/iu.test(command)) {
      present.add("validation:test");
      if (/parser|tokeniz|lexer|grammar/iu.test(command))
        present.add("validation:parser");
    }
  }
  const missing = matrix.requires.filter((entry) => !present.has(entry));
  return {
    kind,
    classifiedBy: pathClass ? "path" : "objective",
    requires: matrix.requires,
    missing,
    judgeable: missing.length === 0,
    note: matrix.note,
  };
}

/**
 * Builds a `detour.requested` event (EI §3.4): the model declares it needs to
 * work outside the accepted contract's scope. `currentVersion` is the
 * optimistic lock against the accepted contract; the deltas are merged into a
 * new accepted contract (v+1) only after the user approves.
 */
export function buildDetourRequested(input: {
  id: string;
  detourID: string;
  planID: string;
  currentVersion: number;
  reason: string;
  scopeDelta: string[];
  verificationDelta?: string[];
  constraintDelta?: string[];
  requestedAt: string;
}): DetourRequestedEvent {
  return {
    type: "detour.requested",
    id: input.id,
    detourID: input.detourID,
    planID: input.planID,
    currentVersion: input.currentVersion,
    reason: input.reason,
    scopeDelta: input.scopeDelta,
    ...(input.verificationDelta?.length
      ? { verificationDelta: input.verificationDelta }
      : {}),
    ...(input.constraintDelta?.length
      ? { constraintDelta: input.constraintDelta }
      : {}),
    requestedAt: input.requestedAt,
    requestedBy: "model",
  };
}

/**
 * Builds a `detour.reviewed` event (EI §3.4): Nia's independent opinion
 * (approve / reject) or `unavailable` when Nia could not review. Nia's verdict
 * is always a reference; the user's approval lands as work_contract.accepted.
 */
export function buildDetourReviewed(input: {
  id: string;
  detourID: string;
  planID: string;
  verdict: "approve" | "reject" | "unavailable";
  reviewedBy: "nia" | "user";
  reviewedAt: string;
  rationale?: string;
}): DetourReviewedEvent {
  return {
    type: "detour.reviewed",
    id: input.id,
    detourID: input.detourID,
    planID: input.planID,
    verdict: input.verdict,
    ...(input.rationale ? { rationale: input.rationale } : {}),
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
  };
}

/**
 * Validates a detour declaration (EI §3.4): the reason must be non-empty and
 * at least one delta must be present (a detour that changes nothing is not a
 * detour). The scopeDelta must not overlap the accepted scope — a detour adds
 * new scope, it does not re-commit scope already covered. Returns the rejection
 * reasons; an empty array means the detour is valid.
 */
export function validateDetour(input: {
  reason: string;
  scopeDelta: string[];
  verificationDelta?: string[];
  constraintDelta?: string[];
  currentScope?: string[];
}): string[] {
  const problems: string[] = [];
  if (!input.reason.trim())
    problems.push("a detour requires a non-empty reason");
  const hasDelta =
    input.scopeDelta.length > 0 ||
    (input.verificationDelta?.length ?? 0) > 0 ||
    (input.constraintDelta?.length ?? 0) > 0;
  if (!hasDelta)
    problems.push(
      "a detour requires at least one scope/verification/constraint delta",
    );
  for (const entry of input.scopeDelta) {
    if (typeof entry !== "string" || !entry.trim()) {
      problems.push("scopeDelta contains an empty entry");
      continue;
    }
    if (isPlaceholderContractValue(entry))
      problems.push(
        `scopeDelta entry "${entry.trim().slice(0, 40)}" is a placeholder`,
      );
    // A scopeDelta that overlaps the committed scope is not a detour — it is
    // already covered, so declaring it is a no-op the user should not gate on.
    if (
      (input.currentScope ?? []).some(
        (existing) =>
          existing === entry.trim() ||
          entry.trim().startsWith(`${existing}`) ||
          existing.startsWith(entry.trim()),
      )
    )
      problems.push(
        `scopeDelta entry "${entry.trim().slice(0, 40)}" overlaps the accepted scope`,
      );
  }
  return problems;
}

/**
 * Merges an approved detour's deltas into the accepted contract, producing the
 * next version's fields (EI §3.4): scope/verification/constraints are unions
 * (deduped, order-preserving). The objective direction never changes through a
 * detour — only the scope/verification/constraints increments are absorbed.
 */
export function mergeDetourIntoContract(
  current: WorkContractFields,
  detour: {
    scopeDelta: string[];
    verificationDelta?: string[];
    constraintDelta?: string[];
  },
): WorkContractFields {
  const union = (...lists: Array<string[] | undefined>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const list of lists)
      for (const entry of list ?? [])
        if (entry.trim() && !seen.has(entry)) {
          seen.add(entry);
          result.push(entry);
        }
    return result;
  };
  return {
    scope: union(current.scope, detour.scopeDelta),
    ...(current.verification?.length || detour.verificationDelta?.length
      ? { verification: union(current.verification, detour.verificationDelta) }
      : {}),
    ...(current.constraints?.length || detour.constraintDelta?.length
      ? { constraints: union(current.constraints, detour.constraintDelta) }
      : {}),
  };
}
