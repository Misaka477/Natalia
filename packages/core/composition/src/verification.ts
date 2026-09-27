import { spawnSync } from "node:child_process";
import { createCompositionRowRegistry } from "./profile";
import { compositionRowRegistrations } from "./rows";
import type {
  ConstitutionRule,
  Generation,
  RuntimeEvent,
} from "@anthelia/contracts";

/**
 * The verification gate (NGM study §4.3 — the shape borrowed from
 * update_engine's ActionPipe: a candidate passes only when every face
 * passes, in one verdict the journal carries).
 *
 * Faces: constitution (owned here — it needs nothing but the two rule
 * sets), guards / sandbox smoke / Nia audit (injected: each of those pulls
 * dependencies this package must not reach for — the repo's guard chain,
 * the runtime, the collaboration machinery). All required: a gate missing a
 * face would pass candidates it was built to stop, which is worse than no
 * gate at all.
 */

export type VerificationCheck = {
  check: string;
  ok: boolean;
  detail?: string;
};

export type VerificationFace = (
  generation: Generation,
) => Promise<VerificationCheck> | VerificationCheck;

/**
 * The architecture guards, exactly the set the plan and study name for
 * the candidate gate (imports/deps/contract/suppressions). The verify
 * chain's test-hygiene guards are deliberately NOT here: they judge the
 * repository's test suite, not a candidate's composition — and running
 * them from inside a test necessarily flags that test's own live
 * workspaces as residue.
 */
export const GUARD_SCRIPTS = [
  "guard:imports",
  "guard:contract",
  "guard:deps",
  "guard:suppressions",
] as const;

export type GuardRunner = (
  script: string,
  cwd: string,
) => {
  status: number;
  output: string;
};

const spawnGuard: GuardRunner = (script, cwd) => {
  const result = spawnSync("npm", ["run", script], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

/**
 * The architecture face: runs each guard script in the repo. A guard that
 * fails surfaces with its own output, aggregated under one face check — the
 * switch reads a single ok per face, and the evidence is not lost.
 */
export function guardsFace(options: {
  repoRoot: string;
  run?: GuardRunner;
}): VerificationFace {
  const run = options.run ?? spawnGuard;
  return () => {
    const perGuard = GUARD_SCRIPTS.map((script) => {
      const { status, output } = run(script, options.repoRoot);
      return {
        script,
        ok: status === 0,
        detail: output.slice(-2000).trim() || `exit ${status}`,
      };
    });
    const failed = perGuard.filter((guard) => !guard.ok);
    return {
      check: "guards",
      ok: failed.length === 0,
      ...(failed.length
        ? {
            detail: failed
              .map((guard) => `${guard.script}: ${guard.detail}`)
              .join("\n"),
          }
        : {}),
    };
  };
}

/**
 * The constitution face's verdict: every active critical/high rule the user
 * marked `forbidden` must still be carried by the candidate with the same
 * statement and enforcement — the study's non-rollback rule (a candidate
 * may add policy, never subtract protection). Missing, reworded, or
 * weakened rows all fail, each by name.
 */
export function constitutionCheck(
  candidate: Generation,
  activeRules: readonly ConstitutionRule[],
): VerificationCheck {
  const carried = new Map(candidate.policyRows.map((rule) => [rule.id, rule]));
  const violations: string[] = [];
  for (const rule of activeRules) {
    if (rule.overridePolicy !== "forbidden") continue;
    if (rule.priority !== "critical" && rule.priority !== "high") continue;
    const row = carried.get(rule.id);
    if (!row) {
      violations.push(`${rule.id}: dropped by the candidate`);
      continue;
    }
    if (row.enforcement !== rule.enforcement)
      violations.push(
        `${rule.id}: enforcement ${rule.enforcement} -> ${row.enforcement}`,
      );
    if (row.statement !== rule.statement)
      violations.push(`${rule.id}: statement changed`);
  }
  return {
    check: "constitution",
    ok: violations.length === 0,
    ...(violations.length ? { detail: violations.join("; ") } : {}),
  };
}

/** The live row registry — the caps vocabulary's home (G6). */
const rowRegistry = createCompositionRowRegistry(compositionRowRegistrations);

/**
 * G6's declarative-caps face: every capability a candidate declares must
 * live inside its row's registered vocabulary. The compose already
 * refuses an out-of-vocabulary key, but a candidate reaches the gate
 * from the JOURNAL (a stored generation, not a fresh compose) — the gate
 * is the second pair of eyes, and a capability nobody registered cannot
 * be sworn to by a candidate either.
 */
export function capsCheck(candidate: Generation): VerificationCheck {
  const problems: string[] = [];
  for (const [rowID, ref] of Object.entries(candidate.adapters)) {
    if (!ref.caps) continue;
    const vocabulary = rowRegistry.get(rowID)?.capKeys ?? [];
    for (const key of Object.keys(ref.caps))
      if (!vocabulary.includes(key))
        problems.push(
          `${rowID}: capability "${key}" is not registered (the vocabulary is [${vocabulary.join(", ")}])`,
        );
  }
  return {
    check: "caps",
    ok: problems.length === 0,
    ...(problems.length ? { detail: problems.join("; ") } : {}),
  };
}

export interface VerificationGateInput {
  /** The staged candidate's content id (the journal handle). */
  candidateID: string;
  candidate: Generation;
  /** The active ledger at verify time — what the candidate is compared to. */
  activeRules: readonly ConstitutionRule[];
  /**
   * Every face is required. `guards` is normally `guardsFace({ repoRoot })`;
   * `smoke` boots an isolated runtime with the candidate; `nia` drives the
   * read-only audit and returns its verdict — both wired by the client,
   * which owns the runtime and collaboration dependencies.
   */
  faces: {
    guards: VerificationFace;
    smoke: VerificationFace;
    nia: VerificationFace;
  };
  publish?: (event: RuntimeEvent) => void;
}

export type VerificationVerdict = {
  verdict: "passed" | "failed";
  checks: VerificationCheck[];
};

/**
 * Runs every face of the gate (in parallel — they are independent) and
 * publishes the journal's `composition.verified` record of what was checked.
 * The verdict is all-must-pass; nothing here decides to switch (that is the
 * orchestrator's job, after approval).
 */
export async function runVerificationGate(
  input: VerificationGateInput,
): Promise<VerificationVerdict> {
  // Each face settles into a check: a face that throws (provider down,
  // guard script crashed) is a FAILED check carrying the error, because the
  // switch decision must always receive a verdict — a gate that throws
  // instead would leave the candidate in an undefined state.
  const runFace = async (
    name: string,
    face: () => Promise<VerificationCheck> | VerificationCheck,
  ): Promise<VerificationCheck> => {
    try {
      return await face();
    } catch (error) {
      return {
        check: name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const results = await Promise.all([
    runFace("constitution", () =>
      constitutionCheck(input.candidate, input.activeRules),
    ),
    runFace("guards", () => input.faces.guards(input.candidate)),
    runFace("smoke", () => input.faces.smoke(input.candidate)),
    runFace("nia", () => input.faces.nia(input.candidate)),
  ]);
  const verdict: VerificationVerdict = {
    verdict: results.every((check) => check.ok) ? "passed" : "failed",
    checks: results,
  };
  input.publish?.({
    type: "composition.verified",
    candidateID: input.candidateID,
    verdict: verdict.verdict,
    checks: verdict.checks,
  });
  return verdict;
}
