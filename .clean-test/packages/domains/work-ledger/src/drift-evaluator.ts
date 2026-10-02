/**
 * DriftEvaluator — the sole production writer of `drift.finding_opened`
 * (mainline plan §56.9; drift plan §5/§6; EI §8.6 rewrite).
 *
 * A drift finding answers "the actual work diverged from the objective or a
 * constraint, and here is why" — as a scored, explainable heuristic, never a
 * guess dressed up as a fact. Three rules govern it (drift plan §5):
 *
 * 1. **Detection only, no write power.** The evaluator opens findings; it never
 *    cancels, rolls back, discards a sandbox or modifies a plan. Even a high
 *    finding only escalates to an approval/Chat/mailbox prompt unless a
 *    Constitution hard-deny conflict already exists.
 * 2. **Explainable evidence, no secrets.** `evidence` is a list of safe
 *    metadata references — path classes, action types, targets, summaries —
 *    never file content, diffs, patches, command text, tool arguments/results,
 *    context snapshots or raw errors. `assertSecretSafeDriftFact` enforces the
 *    boundary at one point.
 * 3. **Ordinary user edits are not drift.** Only divergence from the objective,
 *    an applicable constraint, an expected mutation or completion evidence
 *    opens a finding.
 *
 * The EI §8.6 rewrite makes the judgment explicit and the reference frame
 * first-class:
 *
 * - **The R is the accepted WorkContract.** A finding is only judge-able
 *   against a user-approved contract; without one (no contract or a stale
 *   draft), the evaluator produces at most an advisory "unverifiable" finding
 *   (EI §3.8 P-1.b: a lack of commitment is itself a fact).
 * - **CJK-aware objective overlap.** Latin word-splitting scored Chinese
 *   objectives as zero overlap, which was the single largest false-positive
 *   source; the metric now counts CJK bigrams as well as words.
 * - **contractVersion.** Every finding carries the rule-set version it was
 *   judged under, and `ruleHits` exposes which rules fired and how strongly.
 * - **The status matrix is explicit.** open → explained (agent acknowledges
 *   with rationale) → disputed (agent disagrees) / detour_declared (a
 *   sanctioned detour) → dismissed (user closes) / corrected (work realigns).
 *
 * This module is the evaluator's pure half: it takes safe signals and produces
 * findings. The runtime owns when to call it (turn-end, observation reconcile)
 * and owns publishing. The writer-owner constant is enforced by convention:
 * no other module constructs a `drift.finding_opened` event.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import type { WorkspaceChangeOrigin } from "@anthelia/contracts";

export const DRIFT_FINDING_WRITER_OWNER = "DriftEvaluator" as const;

/**
 * The evaluation contract version (EI §8.6). Bumped when the rule set or the
 * scoring changes, so a finding is always judge-able against the contract
 * that opened it — a contractVersion mismatch means the finding predates the
 * current rules and must not be silently re-interpreted.
 */
export const DRIFT_CONTRACT_VERSION = 2;

const FORBIDDEN_DRIFT_FACT_KEYS = new Set([
  "content",
  "diff",
  "patch",
  "command",
  "args",
  "arguments",
  "result",
  "output",
  "thinking",
  "reasoning",
  "context",
  "error",
  "stderr",
  "stdout",
]);

function assertSecretSafeDriftFact(fact: Record<string, unknown>): void {
  for (const key of Object.keys(fact)) {
    if (FORBIDDEN_DRIFT_FACT_KEYS.has(key))
      throw new Error(`drift fact carries a forbidden field: ${key}`);
  }
}

/**
 * An action kind for the no-progress window (EI Phase 2, 机制 2). A progress
 * marker is workspace_change / evidence.recorded / plan_step / completion.recorded;
 * a run of plain tool_call actions with no marker opens an advisory no-progress
 * finding. Counts only — never content.
 */
export type DriftActionKind =
  | "workspace_change"
  | "evidence.recorded"
  | "plan_step"
  | "completion.recorded"
  | "tool_call";

/** The action kinds that count as forward progress (EI Phase 2 no-progress). */
export const DRIFT_PROGRESS_MARKERS: ReadonlySet<DriftActionKind> = new Set([
  "workspace_change",
  "evidence.recorded",
  "plan_step",
  "completion.recorded",
]);

/** The no-progress window: this many recent actions with no marker fires it. */
export const DRIFT_NO_PROGRESS_WINDOW = 8;

/** The failure-loop threshold: this many identical failures fires it. */
export const DRIFT_FAILURE_LOOP_THRESHOLD = 3;

export type DriftSignal = {
  sessionID?: string;
  episodeID?: string;
  turnID?: string;
  objective: string;
  currentActivity: string;
  /** Applicable constraints, each a sentence. */
  applicableConstraints: string[];
  /** Safe metadata about what actually changed (path/action/target/summary refs). */
  changes: Array<{
    path?: string;
    action?: string;
    target?: string;
    summary?: string;
    origin?: WorkspaceChangeOrigin;
  }>;
  /** Completion evidence collected so far (safe refs). */
  evidenceRefs: string[];
  /**
   * Recent action kinds, oldest→newest, for the no-progress window (EI Phase 2,
   * 机制 2 — an L4 runtime behaviour signal that runs even without a contract).
   */
  recentActions?: Array<{ kind: DriftActionKind }>;
  /**
   * Recent failed tool calls for the failure-loop rule (EI Phase 2, L4): the
   * same (toolName + normalized key) failing ≥ threshold opens a warning. `key`
   * is a secret-safe normalized form of the arguments (a hash), never raw args.
   */
  recentFailures?: Array<{ toolName: string; key: string }>;
  /**
   * Open invariant violations in this session (Discovery D3's linkage:
   * D2's edge facts become R6's signal) — a violated data relation is
   * behavior that diverged, cited as secret-safe `invariant:code@at` refs.
   */
  invariantHits?: Array<{ code: string; at: string; detail: string }>;
  /**
   * The accepted WorkContract judged against (EI §3.3 铁律): the user-tier R.
   * Absent (no contract, or only a stale draft) → at most an advisory
   * unverifiable finding — "no commitment yet" is a fact, not a drift.
   */
  contract?: {
    planID: string;
    scope?: string[];
    verification?: string[];
    constraints?: string[];
  };
  /**
   * Constitution rules the changes touch (EI Phase 2 判定矩阵): a change that
   * matches a deny rule's anchor is an L0 constitution conflict (high). Counts
   * and rule ids only — never the rule statement or change content.
   */
  constitutionHits?: Array<{
    ruleID: string;
    enforcement: "deny" | "approval" | "warn";
  }>;
};

export type DriftFindingInput = {
  id: string;
  findingID: string;
  severity: "advisory" | "warning" | "high";
  confidence: number;
  originalObjective: string;
  currentActivity: string;
  evidence: string[];
  applicableConstraints: string[];
  contractVersion?: number;
  ruleHits?: Array<{ rule: string; confidence: number }>;
  planID?: string;
};

/** Redact secret-shaped tokens from anything that crosses into a finding. */
function redact(text: string): string {
  return text.replace(
    /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/giu,
    (match) => `${match.split(/[:=]/u)[0]}=[REDACTED]`,
  );
}

export type DriftFindingStatus =
  | "open"
  | "explained"
  | "disputed"
  | "dismissed"
  | "corrected"
  | "detour_declared";

/**
 * A finding's status transition (P7 D3: rationale acknowledgement). The Main
 * Agent acknowledges a finding as explained (with a rationale), disputes it,
 * or declares a sanctioned detour; the user dismisses it or the work corrects
 * it. `rationale` is safe prose — never a command, content or secret — and is
 * redacted before journaling.
 */
export function buildDriftFindingUpdate(input: {
  id: string;
  findingID: string;
  status: DriftFindingStatus;
  rationale?: string;
}): Extract<RuntimeEvent, { type: "drift.finding_updated" }> {
  const event: Extract<RuntimeEvent, { type: "drift.finding_updated" }> = {
    type: "drift.finding_updated",
    id: input.id,
    findingID: input.findingID,
    status: input.status,
    ...(input.rationale ? { rationale: redact(input.rationale) } : {}),
  };
  assertSecretSafeDriftFact(event);
  return event;
}

export function buildDriftFinding(
  input: DriftFindingInput,
): Extract<RuntimeEvent, { type: "drift.finding_opened" }> {
  const event: Extract<RuntimeEvent, { type: "drift.finding_opened" }> = {
    type: "drift.finding_opened",
    id: input.id,
    findingID: input.findingID,
    severity: input.severity,
    confidence: input.confidence,
    originalObjective: redact(input.originalObjective),
    currentActivity: redact(input.currentActivity),
    evidence: input.evidence.map(redact),
    applicableConstraints: input.applicableConstraints.map(redact),
    contractVersion: input.contractVersion ?? DRIFT_CONTRACT_VERSION,
    ...(input.ruleHits ? { ruleHits: input.ruleHits } : {}),
    ...(input.planID ? { planID: input.planID } : {}),
  };
  assertSecretSafeDriftFact(event);
  return event;
}

/**
 * CJK-aware token extraction (EI §8.6): Latin words split on non-word
 * characters; CJK text has no word separators, so it is split into
 * overlapping bigrams (plus unigrams for single-character coverage). The old
 * word-only metric scored Chinese objectives as zero overlap — the single
 * largest false-positive source.
 */
function tokens(text: string): Set<string> {
  const set = new Set<string>();
  const words = text.toLowerCase().split(/\W+/u).filter(Boolean);
  for (const word of words) set.add(word);
  const cjkRuns = text.toLowerCase().match(/[\u4e00-\u9fff\u3040-\u30ff]+/gu);
  for (const run of cjkRuns ?? []) {
    for (let index = 0; index < run.length; index += 1) set.add(run[index]!);
    for (let index = 0; index + 1 < run.length; index += 1)
      set.add(run.slice(index, index + 2));
  }
  return set;
}

/**
 * Token-set containment, 0..1 (CJK-aware): the fraction of `right`'s tokens
 * that appear in `left`. Asymmetric on purpose — NOT Jaccard, so a long
 * objective does not dilute a short on-topic activity. Test-pinned by
 * proseRelevanceQuestion.
 */
function overlap(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!rightTokens.size || !leftTokens.size) return 0;
  let hits = 0;
  for (const token of rightTokens) if (leftTokens.has(token)) hits += 1;
  return hits / rightTokens.size;
}

/** A rule: name, severity, and a safe explanation of why it fired. */
type Rule = {
  name: string;
  severity: "advisory" | "warning" | "high";
  /**
   * Session-scoped rules (the L4 behaviour signals) use a per-session findingID
   * (no turnID) so a persistent condition is one finding, not one per turn.
   */
  sessionScoped?: boolean;
  match: (
    signal: DriftSignal,
  ) => { confidence: number; evidence: string[] } | undefined;
};

/**
 * Bounds a comma-joined activity list by ITEM count, never mid-item (EI §2
 * principle 2: the finding carries refs, and a char slice would cut
 * "deleted:path" into "dele"). The list keeps its first `maxItems` entries and
 * states how many were dropped, so the card is bounded but never lies about
 * what it shows.
 */
/**
 * How many activity refs a finding keeps. High enough that a normal turn's
 * change set is stored whole (so the card can offer "view all"), with a safety
 * net for a pathological turn; beyond it the dropped count is stated.
 */
const MAX_ACTIVITY_REFS = 500;

function boundActivity(text: string, maxItems: number): string {
  const items = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (items.length <= 1 || items.length <= maxItems) return text;
  return `${items.slice(0, maxItems).join(", ")}, …+${items.length - maxItems} more`;
}

/** The prose-relevance 问通道 threshold (EI Phase 2): below this overlap, ask. */
export const PROSE_RELEVANCE_THRESHOLD = 0.15;

/**
 * The prose-relevance 问通道 (EI Phase 2, 机制 3): when there is no accepted
 * contract (so the judge channel is silent) and the main agent's recent activity
 * barely relates to the goal objective, ASK — do not judge. Returns a question
 * prompt, or undefined when on-track or a contract governs. This is a 问 (an
 * interaction), not a finding: it is not journaled and is shown for the current
 * turn only. The objective_activity_mismatch rule that used to open an advisory
 * finding here is the false-positive source this replaces.
 */
export function proseRelevanceQuestion(
  signal: DriftSignal,
): string | undefined {
  if (signal.contract) return undefined;
  const objective = signal.objective.trim();
  const activity = signal.currentActivity.trim();
  if (!objective || !activity) return undefined;
  if (overlap(objective, activity) >= PROSE_RELEVANCE_THRESHOLD)
    return undefined;
  const clip = (value: string) =>
    value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return `你最近在做「${clip(activity)}」，与目标「${clip(
    objective,
  )}」的关联不大——确认在推进目标吗？`;
}

function constraintViolationRule(): Rule {
  // Constraint-adjacent words: when the current activity touches something a
  // constraint forbids, flag it. The constraint sentence itself is the
  // evidence, never a command or content.
  const forbiddenWords = new Set([
    "commit",
    "push",
    "delete",
    "remove",
    "rewrite",
    "ignore",
    "skip",
    "bypass",
  ]);
  return {
    name: "constraint_violation_signal",
    severity: "high",
    match: (signal) => {
      const activity = signal.currentActivity.toLowerCase();
      // The R's committed constraints join the session's applicable ones:
      // the user's own constraint is as binding as a seeded rule.
      const constraints = [
        ...signal.applicableConstraints,
        ...(signal.contract?.constraints ?? []),
      ].filter((constraint) =>
        constraint.split(/\W+/u).some((word) => forbiddenWords.has(word)),
      );
      if (!constraints.length) return undefined;
      const activityHits = [...forbiddenWords].filter((word) =>
        activity.includes(word),
      );
      if (!activityHits.length) return undefined;
      return {
        confidence: 0.75 + 0.05 * Math.min(activityHits.length, 5),
        evidence: [
          `constraint:${constraints[0]!.slice(0, 120)}`,
          `activity_signal:${activityHits.join(",")}`,
        ],
      };
    },
  };
}

function evidenceGapRule(): Rule {
  return {
    name: "evidence_gap",
    severity: "warning",
    match: (signal) => {
      // An objective (or committed verification) that says "verify"/"test"/
      // "check" but has collected no evidence refs and changed files is a
      // completion gap.
      const verification = [
        signal.objective,
        ...(signal.contract?.verification ?? []),
      ].join(" ");
      if (!/verify|test|check|validate/iu.test(verification)) return undefined;
      if (signal.evidenceRefs.length > 0) return undefined;
      if (!signal.changes.length) return undefined;
      return {
        confidence: 0.7,
        evidence: ["completion:no_evidence_refs"],
      };
    },
  };
}

/**
 * D4 `dependency_signal`: a change to a dependency manifest or lockfile when
 * the objective has nothing to do with dependencies is a mild drift signal.
 */
const DEPENDENCY_MANIFESTS = [
  "package.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.toml",
  "Cargo.lock",
  "requirements.txt",
  "pyproject.toml",
];

function dependencyRule(): Rule {
  return {
    name: "dependency_signal",
    severity: "advisory",
    match: (signal) => {
      const depChange = signal.changes.find((change) =>
        DEPENDENCY_MANIFESTS.some(
          (manifest) =>
            change.path === manifest || change.path?.endsWith(`/${manifest}`),
        ),
      );
      if (!depChange) return undefined;
      if (
        /\bdependen\w*|install\w*|lockfile|manifest\w*/iu.test(signal.objective)
      )
        return undefined;
      return {
        confidence: 0.55,
        evidence: [`dependency:${depChange.path}`],
      };
    },
  };
}

/**
 * D4 `target_drift`: a change lands outside the directory the objective names
 * (e.g. objective says "src" but the change touched "dist"). The objective's
 * quoted path segments — and the R's committed scope — are the expected
 * targets.
 */
/**
 * True when `path` sits inside one of the scope targets (equal, or nested
 * under it). Shared by the target_drift rule and the contract-revision
 * auto-correction so the two never disagree about what "inside the scope"
 * means.
 */
export function pathInScope(path: string, scope: readonly string[]): boolean {
  return scope.some(
    (target) =>
      Boolean(target) && (path === target || path.startsWith(`${target}/`)),
  );
}

/**
 * EI §3.4 auto-correction: a target_drift finding is corrected when a contract
 * revision absorbs every path it flagged into the new scope — the reference
 * frame moved to meet the work, so the finding's premise is gone (the same way
 * an approved detour does). Pure; the caller owns the journal write.
 */
export function targetDriftAbsorbedByScope(input: {
  finding: { evidence?: readonly string[]; planID?: string };
  planID: string;
  scope: readonly string[];
}): boolean {
  if (input.finding.planID !== input.planID) return false;
  const outside = (input.finding.evidence ?? [])
    .filter((entry) => entry.startsWith("outside_target:"))
    .map((entry) => entry.slice("outside_target:".length));
  if (!outside.length) return false;
  return outside.every((changedPath) => pathInScope(changedPath, input.scope));
}

function targetDriftRule(): Rule {
  return {
    name: "target_drift",
    severity: "advisory",
    match: (signal) => {
      const targets = [
        ...[...signal.objective.matchAll(/"([^"]+)"/gu)].map((match) =>
          match[1]!.replace(/^\.\//u, "").replace(/\/$/u, ""),
        ),
        ...(signal.contract?.scope ?? []),
      ];
      if (!targets.length || !signal.changes.length) return undefined;
      const outside = signal.changes.filter(
        (change) => change.path && !pathInScope(change.path, targets),
      );
      if (!outside.length) return undefined;
      return {
        confidence: 0.6,
        evidence: outside.map((change) => `outside_target:${change.path}`),
      };
    },
  };
}

/**
 * The advisory "no reference frame" finding (EI §3.8 P-1.b): changes exist
 * but the user has not committed to a WorkContract. It is deliberately
 * advisory-only and named, so a UI can show "no commitment yet" instead of a
 * drift score against nothing.
 */
function unverifiableRule(): Rule {
  return {
    name: "unverifiable_no_contract",
    severity: "advisory",
    match: (signal) => {
      if (signal.contract) return undefined;
      if (!signal.changes.length) return undefined;
      return {
        confidence: 0.5,
        evidence: ["reference:no_accepted_contract"],
      };
    },
  };
}

/**
 * No-progress window (EI Phase 2, 机制 2 — an L4 runtime behaviour signal that
 * runs even without a contract). If the last `DRIFT_NO_PROGRESS_WINDOW` actions
 * carry no progress marker (only plain tool_call actions), the work is spinning
 * without advancing → an advisory finding. Counts only, never content.
 */
function noProgressRule(): Rule {
  return {
    name: "no_progress",
    severity: "advisory",
    sessionScoped: true,
    match: (signal) => {
      const actions = signal.recentActions ?? [];
      if (actions.length < DRIFT_NO_PROGRESS_WINDOW) return undefined;
      const tail = actions.slice(-DRIFT_NO_PROGRESS_WINDOW);
      if (tail.some((action) => DRIFT_PROGRESS_MARKERS.has(action.kind)))
        return undefined;
      return {
        confidence: 0.6,
        evidence: [
          `no_progress:last_${DRIFT_NO_PROGRESS_WINDOW}_actions`,
          "marker:none",
        ],
      };
    },
  };
}

/**
 * Consecutive failure loop (EI Phase 2, 机制 2 — L4). The same
 * (toolName + normalized key) failing ≥ threshold times means the agent is stuck
 * retrying the same thing → a warning. The key is secret-safe (a hash); only the
 * tool name and the count are carried as evidence.
 */
function failureLoopRule(): Rule {
  return {
    name: "failure_loop",
    severity: "warning",
    sessionScoped: true,
    match: (signal) => {
      const failures = signal.recentFailures ?? [];
      const counts = new Map<string, { toolName: string; count: number }>();
      for (const failure of failures) {
        const id = `${failure.toolName}::${failure.key}`;
        const entry = counts.get(id) ?? {
          toolName: failure.toolName,
          count: 0,
        };
        entry.count += 1;
        counts.set(id, entry);
      }
      for (const entry of counts.values()) {
        if (entry.count >= DRIFT_FAILURE_LOOP_THRESHOLD) {
          return {
            confidence: 0.7,
            evidence: [
              `failure_loop:${entry.toolName}:${entry.count}x`,
              `threshold:${DRIFT_FAILURE_LOOP_THRESHOLD}`,
            ],
          };
        }
      }
      return undefined;
    },
  };
}

/**
 * Constitution conflict (EI Phase 2 判定矩阵, L0 high/判): a change that matches
 * a deny constitution rule is the strongest divergence signal. The approval
 * layer already intercepts the tool call; this finding records the conflict for
 * the audit trail / Work Graph / Nia audit.
 */
/**
 * An open domain-invariant violation near this turn (Discovery D3
 * linkage: D2 -> R6). Session-scoped like the other behaviour signals: a
 * broken data relation needs no WorkContract to be a fact, and the
 * evaluator still has no write power — the finding only escalates to the
 * review surfaces.
 */
function invariantViolationRule(): Rule {
  return {
    name: "invariant_violation",
    severity: "warning",
    sessionScoped: true,
    match: (signal) => {
      const hits = signal.invariantHits ?? [];
      if (!hits.length) return undefined;
      return {
        confidence: 0.75,
        evidence: hits.map((hit) => `invariant:${hit.code}@${hit.at}`),
      };
    },
  };
}

function constitutionConflictRule(): Rule {
  return {
    name: "constitution_conflict",
    severity: "high",
    match: (signal) => {
      const denyHits = (signal.constitutionHits ?? []).filter(
        (hit) => hit.enforcement === "deny",
      );
      if (!denyHits.length) return undefined;
      return {
        confidence: 0.9,
        evidence: denyHits.map((hit) => `constitution:${hit.ruleID}`),
      };
    },
  };
}

export function createDriftEvaluator(input: {
  /** Keep findings stable per turn: same signals do not reopen the same finding. */
  openFindingIDs: () => ReadonlySet<string>;
  /** False-positive tuning: rules below this confidence are not opened. */
  minimumConfidence?: number;
}) {
  const minimumConfidence = input.minimumConfidence ?? 0.5;
  const rules: Rule[] = [
    constraintViolationRule(),
    evidenceGapRule(),
    dependencyRule(),
    targetDriftRule(),
    unverifiableRule(),
    noProgressRule(),
    failureLoopRule(),
    constitutionConflictRule(),
    invariantViolationRule(),
  ];

  /**
   * Evaluate a turn's signals against the rules. Returns the findings to open,
   * each ready to publish. Findings already open (per `openFindingIDs`) are not
   * reopened — a finding is one fact per divergence, not one per evaluation.
   * D4: a rule result below `minimumConfidence` is not opened (false-positive
   * tuning — weak signals should not spam the ledger).
   */
  function runRules(
    rulesToRun: readonly Rule[],
    signal: DriftSignal,
  ): Array<Extract<RuntimeEvent, { type: "drift.finding_opened" }>> {
    const open = input.openFindingIDs();
    const findings: Array<
      Extract<RuntimeEvent, { type: "drift.finding_opened" }>
    > = [];
    for (const rule of rulesToRun) {
      const result = rule.match(signal);
      if (!result) continue;
      if (result.confidence < minimumConfidence) continue;
      const findingID = rule.sessionScoped
        ? `drift:${rule.name}:session:${signal.sessionID ?? ""}`
        : `drift:${rule.name}:${signal.turnID ?? "session"}:${signal.sessionID ?? ""}`;
      if (open.has(findingID)) continue;
      findings.push(
        buildDriftFinding({
          id: `drift:${Date.now().toString(36)}:${rule.name}`,
          findingID,
          severity: rule.severity,
          confidence: result.confidence,
          originalObjective: signal.objective.slice(0, 200),
          currentActivity: boundActivity(
            signal.currentActivity,
            MAX_ACTIVITY_REFS,
          ),
          evidence: result.evidence,
          applicableConstraints: signal.applicableConstraints,
          contractVersion: DRIFT_CONTRACT_VERSION,
          // Each finding carries only its own rule hit — a per-rule finding
          // must not inherit the hits of rules that fired before it.
          ruleHits: [{ rule: rule.name, confidence: result.confidence }],
          ...(signal.contract?.planID
            ? { planID: signal.contract.planID }
            : {}),
        }),
      );
    }
    return findings;
  }

  function evaluate(
    signal: DriftSignal,
  ): Array<Extract<RuntimeEvent, { type: "drift.finding_opened" }>> {
    return runRules(rules, signal);
  }

  /**
   * Evaluate only the L4 behaviour signals (no-progress / failure loop) — used
   * at turn-end when there were no workspace changes, so a spinning agent still
   * opens a finding without the contract/objective rules firing on an empty
   * activity.
   */
  function evaluateBehavior(
    signal: DriftSignal,
  ): Array<Extract<RuntimeEvent, { type: "drift.finding_opened" }>> {
    return runRules(
      rules.filter((rule) => rule.sessionScoped),
      signal,
    );
  }

  return { evaluate, evaluateBehavior };
}
