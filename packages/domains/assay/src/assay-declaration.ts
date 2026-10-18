/**
 * The project's OWN declaration of its checks — the file that replaces a
 * built-in evidence matrix.
 *
 * THE THREE REFUSALS, MADE CONCRETE. The first one said: do not ship a matrix of
 * "what a task kind must prove" and judge every project by it — let the project
 * say what its checks are, and let the platform read that instead of guessing.
 * B6 took the first half of that step (a run may DECLARE the classes it covers,
 * cross-checked against its command text). This is the second half: the list of
 * checks itself, written down once, in the project's words.
 *
 * WHAT IT BUYS, all of it the same file:
 *
 *   - the run page's "not run" row: a declared check with no matching recorded
 *     command is shown as declared-and-not-run, which is the honest form of a
 *     green that skipped something (a CI page's grey row; ours says who chose it)
 *   - comparability: two greens are comparable only when the SAME check set ran
 *     on the same tree — the declaration is what "same" means
 *   - annotation rules (D4): a rule's id, title and severity live here, declared,
 *     never parsed out of some language's output
 *   - the worker self-check's subset: a change footprint selects the declared
 *     checks whose `scope` matches, instead of the worker inventing commands
 *
 * The format is JSON at `.natalia/assay.json`, deliberately boring: a command is
 * a string, a class is one of the platform's closed vocabulary, and anything this
 * module does not recognise is REPORTED rather than silently dropped — a
 * declaration that quietly loses half its checks is the failure mode that makes
 * a green meaningless.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Where a project's declaration lives, relative to the workspace root. */
export const ASSAY_DECLARATION_PATH = ".natalia/assay.json";

/** One declared check: a command, what it proves, and where it applies. */
export type DeclaredCheck = {
  /** Stable identity. Two greens are comparable only with the same ids. */
  id: string;
  /** The command the check runs. Run through the same seam as any validation. */
  command: string;
  /** Evidence classes this check establishes when it passes (closed vocabulary). */
  covers: string[];
  /** Optional per-check budget; the platform clamps it like any other. */
  timeoutSec?: number;
  /**
   * Globs (repo-relative, `*` and `**`) a change must match for this check to
   * apply. Absent means the check applies to every change — the whole set.
   */
  scope?: string[];
  /** Optional SARIF rule metadata for findings this check can report. */
  rules?: DeclaredRule[];
  /** A human note about why the check exists; shown on the run page. */
  note?: string;
};

/** A declared annotation rule — D4: declared, never inferred from output. */
export type DeclaredRule = {
  id: string;
  title: string;
  /** SARIF default level for a finding of this rule. */
  level?: "error" | "warning" | "note";
  description?: string;
};

export type AssayDeclaration = {
  version: number;
  checks: DeclaredCheck[];
  /** What was ignored, so a typo is visible instead of silent. */
  warnings: string[];
};

/** The closed class vocabulary a declaration may name. */
const EVIDENCE_CLASSES = [
  "validation:any",
  "validation:install",
  "validation:typecheck",
  "validation:test",
  "validation:parser",
] as const;

const RULE_LEVELS = ["error", "warning", "note"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Parse a declaration from already-decoded JSON.
 *
 * It never throws: a project's config is user input, and a throw here would take
 * down whatever read it. Everything unusable becomes a `warning` line and is left
 * out, and a declaration that ends up with no checks is reported as such — the
 * caller decides whether an empty declaration is acceptable (the run page does;
 * a `require`-style caller does not).
 */
export function parseAssayDeclaration(value: unknown): AssayDeclaration {
  const warnings: string[] = [];
  if (!isRecord(value))
    return {
      version: 0,
      checks: [],
      warnings: ["the declaration is not a JSON object"],
    };
  const version = typeof value.version === "number" ? value.version : 1;
  if (value.version !== undefined && typeof value.version !== "number")
    warnings.push("`version` is not a number; read as 1");
  if (version > 1)
    warnings.push(
      `the declaration says version ${version}; this platform reads version 1 and ignores what it does not know`,
    );
  const rawChecks = Array.isArray(value.checks) ? value.checks : [];
  if (!Array.isArray(value.checks))
    warnings.push(
      "`checks` is missing or not an array; the declaration has no checks",
    );
  const checks: DeclaredCheck[] = [];
  const seen = new Set<string>();
  rawChecks.forEach((raw, index) => {
    const where = `checks[${index}]`;
    if (!isRecord(raw)) {
      warnings.push(`${where} is not an object`);
      return;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!id || !command) {
      warnings.push(`${where} needs a non-empty \`id\` and \`command\``);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`${where} repeats the id \`${id}\`; the first one stands`);
      return;
    }
    seen.add(id);
    const covers = strings(raw.covers) ?? [];
    const unknownClasses = covers.filter(
      (entry) => !(EVIDENCE_CLASSES as readonly string[]).includes(entry),
    );
    if (unknownClasses.length > 0)
      warnings.push(
        `${where} names unknown evidence class(es) ${unknownClasses.join(", ")}; the closed vocabulary is ${EVIDENCE_CLASSES.join(", ")}`,
      );
    if (covers.length === 0)
      warnings.push(
        `${where} declares no \`covers\`; a pass establishes nothing, so it cannot satisfy any requirement`,
      );
    const rules: DeclaredRule[] = [];
    for (const [ruleIndex, rawRule] of (Array.isArray(raw.rules)
      ? raw.rules
      : []
    ).entries()) {
      const at = `${where}.rules[${ruleIndex}]`;
      if (!isRecord(rawRule)) {
        warnings.push(`${at} is not an object`);
        continue;
      }
      const ruleID = typeof rawRule.id === "string" ? rawRule.id.trim() : "";
      const title =
        typeof rawRule.title === "string" ? rawRule.title.trim() : "";
      if (!ruleID || !title) {
        warnings.push(`${at} needs a non-empty \`id\` and \`title\``);
        continue;
      }
      const level =
        typeof rawRule.level === "string" &&
        (RULE_LEVELS as readonly string[]).includes(rawRule.level)
          ? (rawRule.level as DeclaredRule["level"])
          : undefined;
      if (rawRule.level !== undefined && level === undefined)
        warnings.push(
          `${at} names level \`${String(rawRule.level)}\`; it must be ${RULE_LEVELS.join(", ")}`,
        );
      rules.push({
        id: ruleID,
        title,
        ...(level ? { level } : {}),
        ...(typeof rawRule.description === "string" &&
        rawRule.description.trim()
          ? { description: rawRule.description.trim() }
          : {}),
      });
    }
    const timeoutSec =
      typeof raw.timeoutSec === "number" && raw.timeoutSec > 0
        ? raw.timeoutSec
        : undefined;
    if (raw.timeoutSec !== undefined && timeoutSec === undefined)
      warnings.push(`${where}.timeoutSec is not a positive number; ignored`);
    checks.push({
      id,
      command,
      covers,
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
      ...(strings(raw.scope)?.length ? { scope: strings(raw.scope) } : {}),
      ...(rules.length > 0 ? { rules } : {}),
      ...(typeof raw.note === "string" && raw.note.trim()
        ? { note: raw.note.trim() }
        : {}),
    });
  });
  return { version, checks, warnings };
}

/**
 * Read the workspace's declaration.
 *
 * No file is not an error — a project that never wrote one has no declared
 * checks, which is exactly what the platform should then say. A file that cannot
 * be READ or PARSED is an error with the reason, because silently behaving as if
 * the project declared nothing would hide the project's own green behind a typo.
 */
export async function loadAssayDeclaration(
  workspaceRoot: string,
): Promise<AssayDeclaration> {
  const path = resolve(workspaceRoot, ASSAY_DECLARATION_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { version: 1, checks: [], warnings: [] };
    throw new Error(
      `assay declaration ${ASSAY_DECLARATION_PATH} could not be read: ${(error as Error).message}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `assay declaration ${ASSAY_DECLARATION_PATH} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parseAssayDeclaration(decoded);
}

/**
 * The declared checks that apply to a change footprint — the worker self-check's
 * subset (B10e).
 *
 * A check with no `scope` applies to everything; a scoped check applies when at
 * least one changed path matches one of its globs. This is the rule that keeps a
 * worker's pre-submit self-check honest without letting it choose its own
 * commands: it runs the subset the PROJECT declared for what it touched, and its
 * verdict is still labelled `self-reported`.
 */
export function declaredChecksForFootprint(
  checks: readonly DeclaredCheck[],
  changedPaths: readonly string[],
): DeclaredCheck[] {
  if (changedPaths.length === 0)
    return checks.filter((check) => !check.scope || check.scope.length === 0);
  const paths = changedPaths.map((path) => path.split("\\").join("/"));
  return checks.filter((check) => {
    if (!check.scope || check.scope.length === 0) return true;
    return check.scope.some((glob) => {
      const pattern = globMatcher(glob.split("\\").join("/"));
      return paths.some((path) => pattern.test(path));
    });
  });
}

/**
 * A minimal glob matcher for `*` (one segment), `**` (any depth) and `?`.
 *
 * Deliberately not a dependency: the declaration is a handful of path patterns,
 * and their meaning has to be readable in this file rather than in a library's
 * documentation.
 */
function globMatcher(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        // `**/` may match zero segments, so `packages/**/test` also matches
        // `packages/test`.
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else pattern += ".*";
      } else pattern += "[^/]*";
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${pattern}$`, "u");
}
