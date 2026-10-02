/**
 * Static constitution pre-check for WorkContract proposals and detours
 * (EI Open Question: "契约 handoff 撞 constitution — 拦在 propose 还是
 * handoff？"，决定：**拦在 propose / detour_declare（事前）**).
 *
 * A contract (or detour delta) whose scope explicitly names a path that a
 * `deny` constitution rule covers is internally inconsistent: approving it
 * would make the user commit to work the runtime will never allow, and the
 * handoff would then dead-end. Catching the contradiction at the proposal
 * point lets the model re-propose inside the existing feedback loop, before
 * the user gate ever fires — the user's approval attention is never spent on
 * a contract that cannot be executed.
 *
 * What is checked, and why only this:
 *
 * - **`scope` entries only, against `deny` rules with `appliesTo.paths`.**
 *   Scope is the declared work surface — a path token there IS a declaration
 *   that the plan touches that path, so the glob match is deterministic, no
 *   guessing about intent. Verification entries are skipped (they name
 *   read/test activities; read-vs-write is not decidable from prose), and
 *   constraints are skipped (a constraint that NAMES a deny path is the model
 *   respecting the rule, not violating it). An `approval` rule is not a
 *   contradiction (the path may be touched once the user approves at the tool
 *   gate); `warn` is prose. Tools and commandPattern anchors are deliberately
 *   not checked here: the contract text is prose, not commands, and matching
 *   it against command patterns would manufacture false contradictions. Those
 *   anchors keep their enforcement at execution time (the approval layer and
 *   the `constitution_conflict` drift finding, EI Phase 2 判定矩阵).
 *
 * Runtime-side coverage stays unchanged: even with this pre-check, a change
 * that later matches a deny rule still opens the high `constitution_conflict`
 * finding (rules can be added between propose and execution).
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import { constitutionPathMatch } from "@natalia/governance-ledger";

/** A deny constitution rule as projected from the journal. */
type ConstitutionRule = Extract<
  RuntimeEvent,
  { type: "constitution.rule_added" }
>;

/** One contradiction: a contract entry naming a path a deny rule covers. */
export type ConstitutionConflict = {
  ruleID: string;
  /** The contract entry that declared the conflicting path. */
  entry: string;
  /** The path token extracted from the entry. */
  path: string;
};

/**
 * Strips prose decoration around a token (backticks, quotes, brackets, and
 * trailing sentence punctuation) so `edit `.env` now` yields `.env`.
 */
function cleanToken(raw: string): string {
  return raw.replace(/^[\s"'`([{<]+/u, "").replace(/[\s"'`)\]}>.,;:!?]+$/u, "");
}

/**
 * True when a token names a path: it carries a path separator (`/`), a
 * leading dot (`.env`, `.github/workflows`), or is a glob (`src/**`). Prose
 * entries ("no new runtime dependency", "delete the old evaluator") yield no
 * tokens, so the check stays silent unless the entry really names a path.
 */
function looksLikePathToken(token: string): boolean {
  return (
    token.includes("/") ||
    (token.startsWith(".") && token.length > 1) ||
    token.includes("*")
  );
}

/** The path-like tokens one contract entry declares, decoration stripped. */
function entryPathTokens(entry: string): string[] {
  const tokens = new Set<string>();
  for (const raw of entry.split(/\s+/u)) {
    const token = cleanToken(raw);
    if (token && looksLikePathToken(token)) tokens.add(token);
  }
  return [...tokens];
}

/**
 * Checks contract entries against the effective deny constitution rules and
 * returns one conflict per (entry, matching path token, rule). Only deny rules
 * with a non-empty `appliesTo.paths` anchor participate; a token that is
 * itself a glob (or a bare directory) also conflicts when a deny pattern
 * lives under its literal prefix — the declared scope then covers the deny
 * path even if the token is broader.
 */
/**
 * The rules a contract check consults: deny rules with a path anchor. The
 * proposal's user gate states this set, so the approval decision shows the
 * conflict-check result the proposal was judged against (ledger plan §5:
 * "每个 plan proposal 显示冲突检查结果").
 */
export function constitutionDenyAnchoredRules(
  rules: readonly ConstitutionRule[],
): readonly ConstitutionRule[] {
  return rules.filter(
    (rule) => rule.enforcement === "deny" && rule.appliesTo?.paths?.length,
  );
}

export function checkContractAgainstConstitution(input: {
  entries: readonly string[];
  rules: readonly ConstitutionRule[];
}): ConstitutionConflict[] {
  const denyRules = constitutionDenyAnchoredRules(input.rules);
  if (!denyRules.length) return [];
  const conflicts: ConstitutionConflict[] = [];
  const seen = new Set<string>();
  for (const entry of input.entries) {
    for (const token of entryPathTokens(entry)) {
      for (const rule of denyRules) {
        const matched = rule.appliesTo!.paths!.some(
          (pattern) =>
            constitutionPathMatch(pattern, token) ||
            tokenUnderGlobPrefix(token, pattern),
        );
        if (!matched) continue;
        const key = `${rule.ruleID}|${entry}|${token}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ ruleID: rule.ruleID, entry, path: token });
      }
    }
  }
  return conflicts;
}

/**
 * True when a token's literal directory prefix covers a deny pattern: the
 * token `src/**` or `src/` declares the whole `src/` subtree, so a deny
 * pattern anchored anywhere under it (`src/legacy/**`) is a contradiction.
 * Tokens with no glob and no trailing slash are plain paths and handled by
 * `constitutionPathMatch` alone.
 */
function tokenUnderGlobPrefix(token: string, pattern: string): boolean {
  let prefix = token;
  if (prefix.endsWith("/")) {
    // already a directory
  } else if (prefix.includes("**")) {
    prefix = prefix.slice(0, prefix.indexOf("**"));
  } else if (prefix.includes("*")) {
    // A single-segment glob token (`src/*`) is still a path-level token; the
    // deny pattern must match it exactly under its own segments, which
    // constitutionPathMatch already covers in the pattern→token direction.
    return false;
  } else {
    return false;
  }
  if (!prefix) return false;
  const normalizedPrefix = prefix.replace(/^\.\//u, "");
  const normalizedPattern = pattern.replace(/^\.\//u, "");
  return normalizedPattern.startsWith(normalizedPrefix);
}
