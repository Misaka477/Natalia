import styles from "./styles/governance-panel.module.css";
import wg from "./styles/work-graph.module.css";
import drift from "./styles/drift-cards.module.css";
import { createSignal, createEffect, createMemo, Show, For } from "solid-js";
import type {
  RuntimeClient,
  WorkGraphEdgeView,
  WorkGraphNodeView,
} from "@anthelia/contracts";
import { isHardProtectedConstitutionRule } from "@anthelia/contracts";
import type { AppState, WorkGraphState } from "@natalia/view-store";
import { WorkGraphTree } from "./components/WorkGraphTree";
import { WorkGraphGraph } from "./components/WorkGraphGraph";
import { useConfirmDialog } from "./components/ConfirmDialog";
import { createScrollAutoAppend } from "./auto-append";
import { PathBrowseButton } from "./path-browse-button";

export type GovernanceTab =
  | "constitution"
  | "decisions"
  | "evidence"
  | "completions"
  | "drift"
  | "workgraph"
  | "notices"
  | "growth"
  | "eval";
type Tab = GovernanceTab;

/**
 * Legacy findings predate `ruleHits`/`contractVersion` in the journal. Infer a
 * rule label from the safe evidence prefix so old cards are still judge-able
 * instead of showing an unexplained 100%.
 */
function ruleHitsFor(finding: {
  ruleHits?: Array<{ rule: string; confidence: number }>;
  evidence?: string[];
  confidence?: number;
}): Array<{ rule: string; confidence: number }> {
  if (finding.ruleHits?.length) return finding.ruleHits;
  const names = new Set<string>();
  for (const item of finding.evidence ?? []) {
    if (
      item.startsWith("objective_overlap:") ||
      item.startsWith("activity:") ||
      item.startsWith("activity_count:")
    )
      names.add("objective_activity_mismatch");
    else if (item.startsWith("constraint:"))
      names.add("constraint_violation_signal");
    else if (item.startsWith("completion:")) names.add("evidence_gap");
    else if (item.startsWith("dependency:")) names.add("dependency_signal");
    else if (item.startsWith("outside_target:")) names.add("target_drift");
    else if (item.startsWith("reference:no_accepted_contract"))
      names.add("unverifiable_no_contract");
  }
  return [...names].map((rule) => ({
    rule: `${rule} (legacy)`,
    confidence: finding.confidence ?? 0,
  }));
}

/**
 * How many activity refs / evidence lines a drift card shows before it offers a
 * "view all" toggle. The truncation here is presentation-only and always paired
 * with a reveal path: the evaluator keeps the full list (see its activity cap),
 * so "view all" always has everything to show. Truncation without a reveal path
 * is not allowed.
 */
export const DRIFT_COLLAPSE_LIMIT = 6;

/** Split a comma-joined activity string into trimmed, non-empty refs. */
export function splitActivityRefs(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Collapse a long list to its first `limit` entries, reporting how many are
 * hidden so the card can render a "view all (+N)" toggle. A list that already
 * fits (or an expanded one) is returned whole with hiddenCount 0. Pure so the
 * collapse contract is unit-testable without a DOM; the caller owns the flag.
 */
export function collapseList<T>(
  items: readonly T[],
  expanded: boolean,
  limit: number = DRIFT_COLLAPSE_LIMIT,
): { shown: readonly T[]; hiddenCount: number } {
  if (expanded || items.length <= limit) {
    return { shown: items, hiddenCount: 0 };
  }
  return { shown: items.slice(0, limit), hiddenCount: items.length - limit };
}

/**
 * The per-tab data bundle the governance pane renders. Kept outside the
 * component so a headless host can verify data, empty and failure states
 * without a DOM.
 */
/** Page metadata for a paginated governance list (EI Phase 1). */
export type GovernancePageInfo = {
  nextCursor?: string;
  total: number;
  truncated: boolean;
};

/** The governance tabs whose lists paginate (EI Phase 1). */
export type GovernanceListTab =
  | "decisions"
  | "evidence"
  | "completions"
  | "drift";

export type GovernanceOverrideView = {
  id: string;
  ruleID: string;
  reason: string;
  approvedBy: "user";
  paths?: string[];
  taskID?: string;
  expiresAt?: string;
};

export type GovernanceSliceBundle = {
  constitution: any[];
  docRules: any[];
  /** Granted scoped overrides, companion to the constitution slice. */
  overrides: GovernanceOverrideView[];
  decisions: any[];
  evidence: any[];
  completions: any[];
  drift: any[];
  notices: any[];
  /**
   * The Work Graph read surface (EI Phase 3). Unlike the live view-store graph,
   * this folds the session's durable event window, so the tab survives a web
   * reload / reattach instead of showing an empty graph until new work happens.
   */
  workGraphNodes: WorkGraphNodeView[];
  workGraphEdges: WorkGraphEdgeView[];
  /**
   * The self-iteration read surfaces (L1). The growth faces were implemented,
   * contracted and routed long before anything consumed them; these four are
   * that consumer. Proposals and promotions are journaled facts (durable);
   * triggers are DERIVED on each read — there is no trigger event, so the
   * RPC face is the only source and the live state carries no mirror of it.
   */
  growthProposals: any[];
  growthTriggers: any[];
  growthPromotions: any[];
  /** The external benchmark's per-task comparison (baseline vs our runs). */
  externalJoinedTasks: any[];
  /** Cursor metadata for the first page of each paginated list tab. */
  pageInfo: Partial<Record<GovernanceListTab, GovernancePageInfo>>;
  errors: string[];
};

/** The first page size for a governance list (EI Phase 1, mailbox parity). */
export const GOVERNANCE_PAGE_SIZE = 50;

/**
 * Load one page of a paginated governance list (EI Phase 1). Shared by the
 * first-page bundle load and the tab's "load more" so the two never diverge.
 * An unavailable RPC or a load error yields an empty page, never a throw.
 */
export async function loadGovernancePage(
  runtime: RuntimeClient | undefined,
  tab: GovernanceListTab,
  sessionID?: string,
  options: {
    decisionScope?: "session" | "workspace" | "all";
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ items: any[]; pageInfo: GovernancePageInfo }> {
  const limit = options.limit ?? GOVERNANCE_PAGE_SIZE;
  const cursor = options.cursor;
  const input = {
    ...(sessionID ? { sessionID } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  };
  // Errors propagate to the caller so it can record the failing tab; an
  // unavailable RPC (undefined method) is simply an empty page.
  let page: any;
  if (tab === "decisions")
    page = await runtime?.decisionRecords?.({
      ...input,
      scope: options.decisionScope ?? "session",
    });
  else if (tab === "evidence") page = await runtime?.evidenceRecords?.(input);
  else if (tab === "completions") page = await runtime?.completions?.(input);
  else page = await runtime?.driftFindings?.(input);
  return {
    items: page?.items ?? [],
    pageInfo: {
      total: page?.total ?? 0,
      truncated: page?.truncated ?? false,
      ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
  };
}

/**
 * Merge the durable RPC Work Graph (a session's event window) with the live
 * view-store graph so the tab shows history after a reload AND any node that
 * happened before the next RPC flush. Nodes merge by nodeID (the RPC read wins
 * on a collision); edges are de-duped by content because the two sources key
 * them differently (the view-store keys by event id).
 */
export function mergeWorkGraphState(
  liveState: Pick<AppState, "workGraphNodes" | "workGraphEdges">,
  rpcNodes: readonly WorkGraphNodeView[],
  rpcEdges: readonly WorkGraphEdgeView[],
): WorkGraphState {
  // The RPC returns the flat view; the view-store graph is keyed by the durable
  // event shape. Re-hydrate the event envelope so both sources share one type.
  type UiNode = AppState["workGraphNodes"][string];
  type UiEdge = AppState["workGraphEdges"][string];
  const nodes: AppState["workGraphNodes"] = {};
  const edges = new Map<string, UiEdge>();
  const edgeKey = (edge: WorkGraphEdgeView) =>
    `${edge.sourceID}|${edge.targetID}|${edge.kind}`;
  for (const node of Object.values(liveState.workGraphNodes ?? {}))
    nodes[node.nodeID] = node;
  for (const edge of Object.values(liveState.workGraphEdges ?? {}))
    edges.set(edgeKey(edge), edge);
  for (const node of rpcNodes)
    nodes[node.nodeID] = {
      type: "workgraph.node_added",
      id: node.nodeID,
      ...node,
    } as UiNode;
  for (const edge of rpcEdges)
    edges.set(edgeKey(edge), {
      type: "workgraph.edge_added",
      id: edgeKey(edge),
      ...edge,
    } as UiEdge);
  return {
    workGraphNodes: nodes,
    workGraphEdges: Object.fromEntries(edges),
  };
}

/**
 * Load every governance read surface independently: one unavailable tab must
 * not blank the others, and the failed label is preserved for the UI. The four
 * paginated lists load their first page; cursor metadata is returned in
 * `pageInfo` so a tab can append older pages on demand.
 */
export async function loadGovernanceSlices(
  runtime: RuntimeClient | undefined,
  sessionID?: string,
  options: {
    decisionScope?: "session" | "workspace" | "all";
    pageSize?: number;
  } = {},
): Promise<GovernanceSliceBundle> {
  const errors: string[] = [];
  const loadSlice = async <T,>(
    label: string,
    load: () => Promise<T[] | undefined>,
  ): Promise<T[]> => {
    try {
      return (await load()) ?? [];
    } catch (error) {
      errors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  };
  const listLabel: Record<GovernanceListTab, string> = {
    decisions: "Decisions",
    evidence: "Evidence",
    completions: "Completions",
    drift: "Drift",
  };
  const loadList = async (tab: GovernanceListTab) => {
    try {
      return await loadGovernancePage(runtime, tab, sessionID, {
        ...(options.decisionScope
          ? { decisionScope: options.decisionScope }
          : {}),
        ...(options.pageSize ? { limit: options.pageSize } : {}),
      });
    } catch (error) {
      errors.push(
        `${listLabel[tab]}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { items: [], pageInfo: { total: 0, truncated: false } };
    }
  };
  const [
    constitution,
    docRules,
    overrides,
    decisions,
    evidence,
    completions,
    drift,
    notices,
    workGraphNodes,
    workGraphEdges,
    growthProposals,
    growthTriggers,
    growthPromotions,
    externalJoinedTasks,
  ] = await Promise.all([
    loadSlice(
      "Constitution",
      () => runtime?.constitutionRules?.(sessionID) ?? Promise.resolve([]),
    ),
    loadSlice(
      "ConstitutionDocs",
      () => runtime?.constitutionDocRules?.(sessionID) ?? Promise.resolve([]),
    ),
    loadSlice(
      "ConstitutionOverrides",
      () => runtime?.constitutionOverrides?.(sessionID) ?? Promise.resolve([]),
    ),
    loadList("decisions"),
    loadList("evidence"),
    loadList("completions"),
    loadList("drift"),
    loadSlice(
      "Notices",
      () => runtime?.notices?.(sessionID) ?? Promise.resolve([]),
    ),
    loadSlice(
      "WorkGraphNodes",
      () =>
        runtime?.workGraphNodes?.(sessionID ? { sessionID } : undefined) ??
        Promise.resolve([]),
    ),
    loadSlice(
      "WorkGraphEdges",
      () =>
        runtime?.workGraphEdges?.(sessionID ? { sessionID } : undefined) ??
        Promise.resolve([]),
    ),
    loadSlice(
      "GrowthProposals",
      () => runtime?.growthProposals?.(sessionID) ?? Promise.resolve([]),
    ),
    // Derived per read — the trigger is an assembly of the four growth
    // systems' views, not a journaled fact, so it has no durable mirror.
    loadSlice(
      "GrowthTriggers",
      () => runtime?.growthTriggers?.(sessionID) ?? Promise.resolve([]),
    ),
    loadSlice(
      "GrowthPromotions",
      () => runtime?.growthPromotions?.(sessionID) ?? Promise.resolve([]),
    ),
    loadSlice(
      "ExternalJoinedTasks",
      () => runtime?.externalJoinedTasks?.(sessionID) ?? Promise.resolve([]),
    ),
  ]);
  return {
    constitution,
    docRules,
    overrides: overrides as GovernanceOverrideView[],
    decisions: decisions.items,
    evidence: evidence.items,
    completions: completions.items,
    drift: drift.items,
    notices,
    workGraphNodes,
    workGraphEdges,
    growthProposals,
    growthTriggers,
    growthPromotions,
    externalJoinedTasks,
    pageInfo: {
      decisions: decisions.pageInfo,
      evidence: evidence.pageInfo,
      completions: completions.pageInfo,
      drift: drift.pageInfo,
    },
    errors,
  };
}

/**
 * The RPC action behind the drift card buttons. A headless test can call the
 * same function a click invokes and then re-read through loadGovernanceSlices,
 * proving the journal-backed read surface changed.
 */
export async function acknowledgeDriftFindingViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  findingID: string,
  status:
    | "explained"
    | "disputed"
    | "dismissed"
    | "corrected"
    | "detour_declared",
  rationale?: string,
) {
  return runtime?.acknowledgeDriftFinding?.(
    { findingID, status, ...(rationale ? { rationale } : {}) },
    sessionID,
  );
}

/**
 * The RPC action behind a drift card's [重新打开] (reopen / 翻案) button — a
 * user-only lift of a dismissed/explained finding back to open. A headless
 * test can call the same function a click invokes.
 */
export async function reopenDriftFindingViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  findingID: string,
) {
  return runtime?.reopenDriftFinding?.({ findingID }, sessionID);
}

/** The RPC action behind a constitution rule disable/re-enable click. */
export async function updateConstitutionRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  ruleID: string,
  enabled: boolean,
) {
  return runtime?.updateConstitutionRule?.({ ruleID, enabled }, sessionID);
}

/** The RPC action behind a constitution rule tombstone click. */
export async function removeConstitutionRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  ruleID: string,
) {
  return runtime?.removeConstitutionRule?.({ ruleID }, sessionID);
}

/**
 * Which row affordance a constitution rule gets (EI §3.8 P-1.c, per the user's
 * decision 硬保护不能删/其余可删改). Only rules backed by the hard-coded
 * runtime `SELF_PROTECTION_PATTERNS` (C-TERM-*, the shared set in
 * @anthelia/contracts) are protected: the RPC refuses their edits and the panel
 * shows a "系统保护" label instead of an empty action slot. Every other rule —
 * including the release-scope runtime-policy rules C-REL-* and user-owned
 * project/package rules — keeps 编辑/停用/删除. Pure so it is unit-testable
 * without a DOM.
 */
export function constitutionRuleAffordance(rule: {
  ruleID?: string;
}): "editable" | "protected" {
  return isHardProtectedConstitutionRule(rule.ruleID ?? "")
    ? "protected"
    : "editable";
}

/** The RPC action behind a constitution document-rule promote click. */
export async function promoteConstitutionDocRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  id: string,
) {
  return runtime?.promoteConstitutionDocRule?.({ id }, sessionID);
}

/**
 * L7's trigger surface: the RPC action behind a Growth trigger row's
 * [{t("gov.promote")}]. It records the `growth.promoted` fact — where the trigger
 * lands (its destination class) and what approval it needs. **It applies
 * nothing**: the promotion's `next` names who acts, and the approval
 * policy decides. The loop's automation ends at this button on purpose —
 * the human is the one who hands a ranked trigger to the mutation path.
 */
export async function promoteGrowthTriggerViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  capability: string,
) {
  return runtime?.promoteGrowthTrigger?.({ capability }, sessionID);
}

/**
 * The RPC action behind a constitution document-rule [编辑] click (EI §3.8
 * P-1.c 软规则): the user rewrites the section's prose and syncs its
 * enforcement / appliesTo annotations; the runtime writes the document back.
 */
export async function updateConstitutionDocRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  input: {
    id: string;
    statement?: string;
    enforcement?: "deny" | "approval" | "warn";
    appliesTo?: {
      tools?: string[];
      paths?: string[];
      commandPattern?: string;
    };
  },
) {
  return runtime?.updateConstitutionDocRule?.(input, sessionID);
}

/** The RPC action behind the [{t("gov.newRule")}] button (user creates a rule). */
export async function createConstitutionRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  input: {
    statement: string;
    enforcement: "deny" | "approval" | "warn";
    scope?: "project" | "package";
    appliesTo?: {
      tools?: string[];
      paths?: string[];
      commandPattern?: string;
    };
    priority?: "critical" | "high" | "medium" | "low";
  },
) {
  return runtime?.createConstitutionRule?.(input, sessionID);
}

/** The granted overrides for one rule, in journal order. */
export function overridesForRule(
  overrides: readonly GovernanceOverrideView[],
  ruleID: string,
): GovernanceOverrideView[] {
  return overrides.filter((override) => override.ruleID === ruleID);
}

/** One override's summary: the reason, then its scope and expiry when set. */
export function overrideLine(override: GovernanceOverrideView): string {
  const scope = [
    ...(override.paths?.length ? [`paths: ${override.paths.join(", ")}`] : []),
    ...(override.taskID ? [`task: ${override.taskID}`] : []),
    ...(override.expiresAt ? [`expires: ${override.expiresAt}`] : []),
  ];
  return scope.length
    ? `${override.reason} (${scope.join("; ")})`
    : override.reason;
}

/**
 * Which override affordance a constitution rule gets (ledger plan §3:
 * "critical/forbidden 规则不可 override"). The rule's own overridePolicy is
 * the authority — and the RPC refuses a forbidden rule anyway, so the panel
 * must not offer an action the backend will reject. Pure so it is
 * unit-testable without a DOM.
 */
export function constitutionOverrideAffordance(rule: {
  overridePolicy?: string;
}): "requestable" | "forbidden" {
  return rule.overridePolicy === "forbidden" ? "forbidden" : "requestable";
}

/**
 * The override request from the panel's draft (ledger plan §3's
 * ScopedOverride). The reason is the only required field — the backend
 * refuses an empty one too, so the panel says it first rather than
 * round-tripping a refusal. Scope fields are optional and omitted when
 * empty: an absent path list means "the rule's whole scope", not "no
 * scope". Pure so the validation is unit-testable without a DOM.
 */
export function overrideRequestFromDraft(draft: {
  ruleID: string;
  reason: string;
  paths: string;
  taskID: string;
  expiresAt: string;
}):
  | {
      ok: true;
      input: {
        ruleID: string;
        reason: string;
        paths?: string[];
        taskID?: string;
        expiresAt?: string;
      };
    }
  | { ok: false; reason: string } {
  const reason = draft.reason.trim();
  if (!reason) return { ok: false, reason: "override requires a reason" };
  const paths = splitActivityRefs(draft.paths);
  const taskID = draft.taskID.trim();
  const expiresAt = draft.expiresAt.trim();
  return {
    ok: true,
    input: {
      ruleID: draft.ruleID,
      reason,
      ...(paths.length ? { paths } : {}),
      ...(taskID ? { taskID } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

/**
 * The RPC action behind an override request. The request publishes an
 * `approval.request` (scope `constitution_override`) through the same
 * interactive seam every plan acceptance uses — the approval prompt the
 * user already knows IS the grant, and the granted event lands in the
 * journal and the governance store. This face only STARTS the request.
 */
export async function requestOverrideViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  input: {
    ruleID: string;
    reason: string;
    paths?: string[];
    taskID?: string;
    expiresAt?: string;
  },
) {
  return runtime?.requestOverride?.(input, sessionID);
}

/** The RPC action behind a constitution rule [编辑] (tighten/edit) click. */
export async function editConstitutionRuleViaRpc(
  runtime: RuntimeClient | undefined,
  sessionID: string | undefined,
  input: {
    ruleID: string;
    statement?: string;
    enforcement?: "deny" | "approval" | "warn";
    priority?: "critical" | "high" | "medium" | "low";
    appliesTo?: {
      tools?: string[];
      paths?: string[];
      commandPattern?: string;
    };
  },
) {
  return runtime?.updateConstitutionRule?.(input, sessionID);
}

/**
 * One drift finding card (EI Phase 2 / §3.5). A finding is a suspicion, not a
 * verdict — the card is a read-only audit view (finding + rationale + status
 * transitions) with the minimal user exits. The two long lists it can carry
 * (the Current activity refs and the Evidence lines) collapse to a few entries
 * with a "view all" toggle: the data layer keeps them whole, so the reveal path
 * always has everything to show. Extracted as its own component so each card
 * owns its expand state locally (no per-card bookkeeping in the pane).
 */
function DriftCard(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  finding: any;
  resolveContract: (planID?: string) => any;
  actionBusy: () => boolean;
  onAcknowledge: (
    findingID: string,
    status:
      | "explained"
      | "disputed"
      | "dismissed"
      | "corrected"
      | "detour_declared",
    rationale?: string,
  ) => void;
  onReopen: (findingID: string) => void;
}) {
  const t = props.t;
  const [activityExpanded, setActivityExpanded] = createSignal(false);
  const [evidenceExpanded, setEvidenceExpanded] = createSignal(false);
  const finding = () => props.finding;

  const activityRefs = () => splitActivityRefs(finding().currentActivity ?? "");
  const activityView = () => collapseList(activityRefs(), activityExpanded());
  const evidenceItems = (): any[] => finding().evidence ?? [];
  const evidenceView = () => collapseList(evidenceItems(), evidenceExpanded());

  return (
    <div class={drift.card}>
      <div class={drift.head}>
        <span class={styles.title} data-priority={finding().severity}>
          {finding().severity} · {Math.round(finding().confidence * 100)}%
        </span>
        <span class={drift.status} data-status={finding().status}>
          {finding().status}
        </span>
        <Show when={(finding().reopenedCount ?? 0) > 0}>
          <span class={drift.reopened}>
            {t("gov.reopenedCount", { count: finding().reopenedCount })}
          </span>
        </Show>
      </div>
      <div class={drift.goal}>Goal: {finding().originalObjective}</div>
      <Show when={finding().planID}>
        <div class={drift.meta}>Plan: {finding().planID}</div>
      </Show>
      <Show when={props.resolveContract(finding().planID)}>
        {(contract) => (
          <div class={drift.section}>
            <div class={drift.sectionTitle}>Reference frame</div>
            <Show when={contract().scope?.length}>
              <div class={drift.evidence}>
                scope: {contract().scope!.join(", ")}
              </div>
            </Show>
            <Show when={contract().verification?.length}>
              <div class={drift.evidence}>
                verification: {contract().verification!.join(", ")}
              </div>
            </Show>
            <Show when={contract().constraints?.length}>
              <div class={drift.evidence}>
                constraints: {contract().constraints!.join(", ")}
              </div>
            </Show>
            <div class={drift.meta}>
              contract {contract().status} v{contract().version}
            </div>
          </div>
        )}
      </Show>
      <div class={drift.current}>
        Current: {activityView().shown.join(", ")}
        <Show when={activityView().hiddenCount > 0 || activityExpanded()}>
          <button
            type="button"
            class={drift.expand}
            onClick={() => setActivityExpanded(!activityExpanded())}
          >
            {activityExpanded()
              ? t("common.collapse")
              : t("gov.expandAll", { count: activityView().hiddenCount })}
          </button>
        </Show>
      </div>
      <Show
        when={
          ruleHitsFor(finding()).length ||
          finding().contractVersion !== undefined
        }
      >
        <div class={drift.section}>
          <div class={drift.sectionTitle}>Why this fired</div>
          <Show when={finding().contractVersion !== undefined}>
            <div class={drift.meta}>contract v{finding().contractVersion}</div>
          </Show>
          <For each={ruleHitsFor(finding())}>
            {(hit) => (
              <div class={drift.rule}>
                {hit.rule} · {Math.round(hit.confidence * 100)}%
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={evidenceItems().length}>
        <div class={drift.section}>
          <div class={drift.sectionTitle}>Evidence</div>
          <For each={evidenceView().shown}>
            {(item) => <div class={drift.evidence}>{item}</div>}
          </For>
          <Show when={evidenceView().hiddenCount > 0 || evidenceExpanded()}>
            <button
              type="button"
              class={drift.expand}
              onClick={() => setEvidenceExpanded(!evidenceExpanded())}
            >
              {evidenceExpanded()
                ? t("common.collapse")
                : t("gov.expandEvidence", {
                    count: evidenceView().hiddenCount,
                  })}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={finding().applicableConstraints?.length}>
        <div class={drift.section}>
          <div class={drift.sectionTitle}>Constraints</div>
          <For each={finding().applicableConstraints}>
            {(item) => <div class={drift.evidence}>{item}</div>}
          </For>
        </div>
      </Show>
      <Show when={finding().rationale}>
        <div class={drift.rationale}>{finding().rationale}</div>
      </Show>
      <Show when={finding().status === "open"}>
        <div class={drift.actions}>
          <button
            type="button"
            class={drift.btn}
            disabled={props.actionBusy()}
            onClick={() => {
              // An explanation is only auditable with a rationale; prompt for
              // one and skip the acknowledgement if it is empty.
              const rationale = window.prompt(t("gov.explainPrompt"));
              if (rationale?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "explained",
                  rationale.trim(),
                );
            }}
          >
            {t("gov.explain")}
          </button>
          <button
            type="button"
            class={drift.btn}
            data-kind="dispute"
            disabled={props.actionBusy()}
            onClick={() => {
              const reason = window.prompt(t("gov.falsePositivePrompt"));
              if (reason?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "disputed",
                  reason.trim(),
                );
            }}
          >
            {t("gov.falsePositive")}
          </button>
          <button
            type="button"
            class={drift.btn}
            data-kind="dismiss"
            disabled={props.actionBusy()}
            onClick={() =>
              props.onAcknowledge(finding().findingID, "dismissed")
            }
          >
            {t("gov.ignore")}
          </button>
          <button
            type="button"
            class={drift.btn}
            data-kind="correct"
            disabled={props.actionBusy()}
            onClick={() => {
              // Correcting realigns the work: capture the correction plan so the
              // rationale is auditable.
              const plan = window.prompt(t("gov.correctPrompt"));
              if (plan?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "corrected",
                  plan.trim(),
                );
            }}
          >
            {t("gov.correct")}
          </button>
          <button
            type="button"
            class={drift.btn}
            data-kind="detour"
            disabled={props.actionBusy()}
            onClick={() => {
              // A detour is an explicit, sanctioned pause; capture why.
              const reason = window.prompt(t("gov.bypassPrompt"));
              if (reason?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "detour_declared",
                  reason.trim(),
                );
            }}
          >
            {t("gov.bypass")}
          </button>
        </div>
      </Show>
      <Show
        when={
          finding().status === "dismissed" || finding().status === "explained"
        }
      >
        <div class={drift.actions}>
          <button
            type="button"
            class={drift.btn}
            data-kind="reopen"
            disabled={props.actionBusy()}
            onClick={() => props.onReopen(finding().findingID)}
          >
            {t("gov.reopen")}
          </button>
        </div>
      </Show>
    </div>
  );
}

/**
 * The governance pane content (EI Phase 2): the six governance sub-tabs and
 * their rows, reading the live RPC surfaces with the view-store projection as
 * the fallback. Extracted from the modal so the same content mounts both in
 * the right-sidebar composite tab (the plan's target host) and, during the
 * transition, in the retiring modal. Cost/dashboard-free: this is the
 * governance surface only.
 */
/**
 * A rule's granted overrides: the companion display to the Override action.
 * The list truncates with a reveal path (the house's collapse discipline —
 * truncation without a reveal is not allowed), and an absent list renders
 * nothing rather than an empty section.
 */
function RuleOverrides(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  overrides: GovernanceOverrideView[];
}) {
  const t = props.t;
  const [expanded, setExpanded] = createSignal(false);
  const view = () => collapseList(props.overrides, expanded());
  return (
    <Show when={props.overrides.length > 0}>
      <div class="constitution-row-overrides">
        <div class="constitution-row-overrides-title">
          {t("gov.overrideCount", { count: props.overrides.length })}
        </div>
        <For each={view().shown}>
          {(override) => (
            <div class="constitution-row-override">
              {overrideLine(override)}
            </div>
          )}
        </For>
        <Show when={view().hiddenCount > 0 || expanded()}>
          <button
            type="button"
            class="constitution-btn"
            onClick={() => setExpanded(!expanded())}
          >
            {expanded()
              ? t("common.collapse")
              : t("gov.expandAll", { count: view().hiddenCount })}
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function GovernancePane(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  state: AppState;
  runtime?: RuntimeClient;
  sessionID?: string;
  /** Optional deep-link target; defaults to the drift review view. */
  initialTab?: GovernanceTab;
}) {
  const t = props.t;
  const [tab, setTab] = createSignal<Tab>(props.initialTab ?? "drift");
  const [contentEl, setContentEl] = createSignal<HTMLDivElement>();
  const [workGraphView, setWorkGraphView] = createSignal<"tree" | "graph">(
    "tree",
  );
  const [liveConstitution, setLiveConstitution] = createSignal<any[]>([]);
  const [liveDocRules, setLiveDocRules] = createSignal<any[]>([]);
  const [liveOverrides, setLiveOverrides] = createSignal<
    GovernanceOverrideView[]
  >([]);
  const [liveDecisions, setLiveDecisions] = createSignal<any[]>([]);
  const [decisionScope, setDecisionScope] = createSignal<
    "session" | "workspace" | "all"
  >("session");
  const [liveEvidence, setLiveEvidence] = createSignal<any[]>([]);
  const [liveCompletions, setLiveCompletions] = createSignal<any[]>([]);
  const [liveDrift, setLiveDrift] = createSignal<any[]>([]);
  // ADR Phase C: the projected runtime notices (dual ingestion — the live
  // event stream and the server-projected contract converge here).
  const [liveNotices, setLiveNotices] = createSignal<any[]>([]);
  // L1: the self-iteration read surfaces. Proposals and promotions also
  // exist in the view-store's observation slices, so a live session and a
  // reloaded one converge (the RPC read is the durable half, the state fold
  // the live half — the same dual ingestion the notices tab uses). Triggers
  // are derived per read and exist nowhere else.
  const [liveGrowthProposals, setLiveGrowthProposals] = createSignal<any[]>([]);
  const [liveGrowthTriggers, setLiveGrowthTriggers] = createSignal<any[]>([]);
  const [liveGrowthPromotions, setLiveGrowthPromotions] = createSignal<any[]>(
    [],
  );
  /**
   * Whether the Growth tab has ANYTHING to show. Four sections that each
   * say "nothing here" is a screen of prose, not an interface — a person
   * who opens this page needs one answer ("is there anything for me?"),
   * and five paragraphs cannot give it. When everything is empty the page
   * says ONE thing; a section appears when it has something in it.
   */
  const growthHasAnything = () =>
    liveGrowthTriggers().length > 0 ||
    (props.state.growthProposals ?? []).length > 0 ||
    liveGrowthProposals().length > 0 ||
    (props.state.growthPromotions ?? []).length > 0 ||
    liveGrowthPromotions().length > 0;
  const [liveExternalJoinedTasks, setLiveExternalJoinedTasks] = createSignal<
    any[]
  >([]);
  const [liveWorkGraphNodes, setLiveWorkGraphNodes] = createSignal<
    WorkGraphNodeView[]
  >([]);
  const [liveWorkGraphEdges, setLiveWorkGraphEdges] = createSignal<
    WorkGraphEdgeView[]
  >([]);
  // EI Phase 1: cursor metadata for the paginated list tabs; a non-empty
  // nextCursor means "load more" is available for that tab.
  const [pageInfo, setPageInfo] = createSignal<
    Partial<Record<GovernanceListTab, GovernancePageInfo>>
  >({});
  const [loadErrors, setLoadErrors] = createSignal<string[]>([]);
  const [actionNotice, setActionNotice] = createSignal<string | undefined>();
  const [actionBusy, setActionBusy] = createSignal(false);
  // The constitution rule editor (add / edit a hard rule): the user owns these
  // rules, so the panel can create, tighten/edit and delete them.
  const [ruleEditor, setRuleEditor] = createSignal<
    | {
        mode: "add" | "edit";
        ruleID?: string;
        statement: string;
        enforcement: "deny" | "approval" | "warn";
        tools: string;
        paths: string;
        commandPattern: string;
      }
    | undefined
  >();
  // The scoped-override requester (ledger plan §3): a reason plus the
  // optional scope fields, submitted through the approval seam — the grant
  // is the approval prompt, not this dialog.
  const [overrideEditor, setOverrideEditor] = createSignal<
    | {
        ruleID: string;
        reason: string;
        paths: string;
        taskID: string;
        expiresAt: string;
      }
    | undefined
  >();
  // The constitution document-rule editor (EI §3.8 P-1.c 软规则): edits a soft
  // section's prose + enforcement/appliesTo and writes the document back.
  const [docRuleEditor, setDocRuleEditor] = createSignal<
    | {
        id: string;
        section: string;
        source: string;
        statement: string;
        enforcement: "deny" | "approval" | "warn";
        tools: string;
        paths: string;
        commandPattern: string;
      }
    | undefined
  >();
  const { confirm, dialog } = useConfirmDialog();

  const load = async () => {
    const bundle = await loadGovernanceSlices(props.runtime, props.sessionID, {
      decisionScope: decisionScope(),
    });
    setLiveConstitution(bundle.constitution);
    setLiveDocRules(bundle.docRules);
    setLiveOverrides(bundle.overrides);
    setLiveDecisions(bundle.decisions);
    setLiveEvidence(bundle.evidence);
    setLiveCompletions(bundle.completions);
    setLiveDrift(bundle.drift);
    setLiveNotices(bundle.notices);
    setLiveGrowthProposals(bundle.growthProposals);
    setLiveGrowthTriggers(bundle.growthTriggers);
    setLiveGrowthPromotions(bundle.growthPromotions);
    setLiveExternalJoinedTasks(bundle.externalJoinedTasks);
    setLiveWorkGraphNodes(bundle.workGraphNodes);
    setLiveWorkGraphEdges(bundle.workGraphEdges);
    setPageInfo(bundle.pageInfo);
    setLoadErrors(bundle.errors);
  };

  // EI Phase 1 面板分页: append the next durable page for one list tab. The
  // cursor comes from the first-page bundle; the tab keeps the accumulated list
  // so scrolling to the end appends instead of replacing.
  async function loadMore(tab: GovernanceListTab) {
    const info = pageInfo()[tab];
    if (!info?.nextCursor || actionBusy()) return;
    setActionBusy(true);
    try {
      const { items, pageInfo: next } = await loadGovernancePage(
        props.runtime,
        tab,
        props.sessionID,
        { decisionScope: decisionScope(), cursor: info.nextCursor },
      );
      if (tab === "decisions")
        setLiveDecisions((current) => [...current, ...items]);
      else if (tab === "evidence")
        setLiveEvidence((current) => [...current, ...items]);
      else if (tab === "completions")
        setLiveCompletions((current) => [...current, ...items]);
      else setLiveDrift((current) => [...current, ...items]);
      setPageInfo((current) => ({ ...current, [tab]: next }));
    } catch (error) {
      setActionNotice(
        t("gov.loadNextFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  // Scroll-driven pagination for the list tabs (unified-scroll plan §9): the
  // reader never clicks "加载更多"; reaching the end of the pane appends the
  // next durable page for the active tab, and a first page that cannot fill the
  // pane extends itself instead of trapping the reader at a dead end.
  const listRowCount = (): number => {
    const which = tab();
    if (which === "decisions") return liveDecisions().length;
    if (which === "evidence") return liveEvidence().length;
    if (which === "completions") return liveCompletions().length;
    if (which === "drift") return liveDrift().length;
    return 0;
  };
  const autoAppend = createScrollAutoAppend({
    scrollEl: contentEl,
    moreAvailable: () => {
      const which = tab();
      if (
        which !== "decisions" &&
        which !== "evidence" &&
        which !== "completions" &&
        which !== "drift"
      )
        return false;
      return !!pageInfo()[which]?.nextCursor && !actionBusy();
    },
    rowCount: listRowCount,
    append: () => {
      const which = tab();
      if (
        which === "decisions" ||
        which === "evidence" ||
        which === "completions" ||
        which === "drift"
      )
        void loadMore(which);
    },
  });
  // A tab switch or a freshly loaded bundle can leave a page shorter than the
  // pane: check after every list change so the pane self-extends when needed.
  createEffect(() => {
    void liveDecisions();
    void liveEvidence();
    void liveCompletions();
    void liveDrift();
    autoAppend.check();
  });
  // ("用户走 UI 补 humanValidation").
  async function recordHumanValidation(taskID: string) {
    const note = window.prompt(t("gov.humanValidatePrompt", { taskID }));
    if (!note?.trim()) return;
    setActionBusy(true);
    try {
      const result = await props.runtime?.recordHumanValidation?.(
        { taskID, validation: note.trim() },
        props.sessionID,
      );
      setActionNotice(
        result?.recorded
          ? t("gov.humanValidated")
          : t("gov.failedUnknown", {
              reason: result?.reason ?? t("gov.unknownReason"),
            }),
      );
      if (result?.recorded) await load();
    } catch (error) {
      setActionNotice(
        t("gov.failedUnknown", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  // Reload when the active session changes so the pane follows the session.
  createEffect(() => {
    void props.state.sessionID;
    void decisionScope();
    void load();
  });

  // EI Phase 3: the Work Graph tab must survive a reload, so it folds the
  // durable RPC graph (loadGovernanceSlices) together with the live view-store
  // graph (a just-happened live node may not be persisted into the RPC window
  // yet). See mergeWorkGraphState.
  const workGraphState = createMemo<WorkGraphState>(() =>
    mergeWorkGraphState(
      props.state,
      liveWorkGraphNodes(),
      liveWorkGraphEdges(),
    ),
  );

  // EI §3.5: acknowledge a drift finding — the Main Agent explains it or
  // disputes it as a false positive (with a user-supplied rationale). Only an
  // open finding transitions; reload to reflect the new status.
  function contractFor(planID?: string) {
    return planID ? props.state.workContracts?.[planID] : undefined;
  }

  async function acknowledgeFinding(
    findingID: string,
    status:
      | "explained"
      | "disputed"
      | "dismissed"
      | "corrected"
      | "detour_declared",
    rationale?: string,
  ) {
    setActionBusy(true);
    setActionNotice(undefined);
    try {
      const result = await acknowledgeDriftFindingViaRpc(
        props.runtime,
        props.sessionID,
        findingID,
        status,
        rationale,
      );
      setActionNotice(
        result?.acknowledged
          ? t("gov.updated", { id: findingID, status })
          : t("gov.notUpdated", { id: findingID }),
      );
      await load();
    } catch (error) {
      setActionNotice(
        t("gov.updateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  function openRuleEditor(
    mode: "add" | "edit",
    rule?: {
      ruleID: string;
      statement: string;
      enforcement: string;
      appliesTo?: {
        tools?: string[];
        paths?: string[];
        commandPattern?: string;
      };
    },
  ) {
    setActionNotice(undefined);
    setRuleEditor({
      mode,
      ...(rule ? { ruleID: rule.ruleID } : {}),
      statement: rule?.statement ?? "",
      enforcement:
        (rule?.enforcement as "deny" | "approval" | "warn") ?? "warn",
      tools: (rule?.appliesTo?.tools ?? []).join(", "),
      paths: (rule?.appliesTo?.paths ?? []).join(", "),
      commandPattern: rule?.appliesTo?.commandPattern ?? "",
    });
  }

  async function saveRule() {
    const editor = ruleEditor();
    if (!editor) return;
    setActionBusy(true);
    setActionNotice(undefined);
    try {
      const list = (value: string) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      const appliesTo = {
        ...(list(editor.tools).length ? { tools: list(editor.tools) } : {}),
        ...(list(editor.paths).length ? { paths: list(editor.paths) } : {}),
        ...(editor.commandPattern.trim()
          ? { commandPattern: editor.commandPattern.trim() }
          : {}),
      };
      const result =
        editor.mode === "add"
          ? await createConstitutionRuleViaRpc(props.runtime, props.sessionID, {
              statement: editor.statement,
              enforcement: editor.enforcement,
              ...(Object.keys(appliesTo).length ? { appliesTo } : {}),
            })
          : await editConstitutionRuleViaRpc(props.runtime, props.sessionID, {
              ruleID: editor.ruleID!,
              statement: editor.statement,
              enforcement: editor.enforcement,
              ...(Object.keys(appliesTo).length ? { appliesTo } : {}),
            });
      const outcome = result as
        | { created?: boolean; updated?: boolean; reason?: string }
        | undefined;
      const ok = editor.mode === "add" ? outcome?.created : outcome?.updated;
      setActionNotice(
        ok
          ? editor.mode === "add"
            ? t("gov.ruleAdded")
            : t("gov.ruleUpdated")
          : t("gov.failedUnknown", {
              reason: outcome?.reason ?? t("gov.unknownReason"),
            }),
      );
      if (ok) setRuleEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        t("gov.failedUnknown", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  function openOverrideEditor(rule: { ruleID: string }) {
    setActionNotice(undefined);
    setOverrideEditor({
      ruleID: rule.ruleID,
      reason: "",
      paths: "",
      taskID: "",
      expiresAt: "",
    });
  }

  async function submitOverride() {
    const editor = overrideEditor();
    if (!editor) return;
    const draft = overrideRequestFromDraft(editor);
    if (!draft.ok) {
      setActionNotice(t("gov.failedUnknown", { reason: draft.reason }));
      return;
    }
    setActionBusy(true);
    setActionNotice(undefined);
    try {
      const result = (await requestOverrideViaRpc(
        props.runtime,
        props.sessionID,
        draft.input,
      )) as
        | { requested?: boolean; requestID?: string; reason?: string }
        | undefined;
      if (result?.requested)
        setActionNotice(
          t("gov.overrideSubmitted", { ruleID: draft.input.ruleID }),
        );
      else
        setActionNotice(
          t("gov.failedUnknown", {
            reason: result?.reason ?? t("gov.unknownReason"),
          }),
        );
      if (result?.requested) setOverrideEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        t("gov.failedUnknown", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  function openDocRuleEditor(rule: {
    id: string;
    section: string;
    source: string;
    statement: string;
    enforcement: string;
    appliesTo?: {
      tools?: string[];
      paths?: string[];
      commandPattern?: string;
    };
  }) {
    setActionNotice(undefined);
    setDocRuleEditor({
      id: rule.id,
      section: rule.section,
      source: rule.source,
      statement: rule.statement,
      enforcement: (rule.enforcement as "deny" | "approval" | "warn") ?? "warn",
      tools: (rule.appliesTo?.tools ?? []).join(", "),
      paths: (rule.appliesTo?.paths ?? []).join(", "),
      commandPattern: rule.appliesTo?.commandPattern ?? "",
    });
  }

  async function saveDocRule() {
    const editor = docRuleEditor();
    if (!editor) return;
    setActionBusy(true);
    setActionNotice(undefined);
    try {
      const list = (value: string) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      const appliesTo = {
        ...(list(editor.tools).length ? { tools: list(editor.tools) } : {}),
        ...(list(editor.paths).length ? { paths: list(editor.paths) } : {}),
        ...(editor.commandPattern.trim()
          ? { commandPattern: editor.commandPattern.trim() }
          : {}),
      };
      const result = await updateConstitutionDocRuleViaRpc(
        props.runtime,
        props.sessionID,
        {
          id: editor.id,
          statement: editor.statement,
          enforcement: editor.enforcement,
          ...(Object.keys(appliesTo).length ? { appliesTo } : {}),
        },
      );
      const outcome = result as
        | { updated?: boolean; reason?: string }
        | undefined;
      setActionNotice(
        outcome?.updated
          ? t("gov.docRuleUpdated", { section: editor.section })
          : t("gov.failedUnknown", {
              reason: outcome?.reason ?? t("gov.unknownReason"),
            }),
      );
      if (outcome?.updated) setDocRuleEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        t("gov.failedUnknown", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function reopenFinding(findingID: string) {
    setActionBusy(true);
    setActionNotice(undefined);
    try {
      const result = await reopenDriftFindingViaRpc(
        props.runtime,
        props.sessionID,
        findingID,
      );
      setActionNotice(
        result?.reopened
          ? t("gov.reopened", { id: findingID })
          : t("gov.reopenFailed", {
              reason: result?.reason ?? t("gov.unknownReason"),
            }),
      );
      await load();
    } catch (error) {
      setActionNotice(
        t("gov.reopenError", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div class={styles.pane}>
      <div class="review-subtabs">
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "drift"}
          onClick={() => setTab("drift")}
        >
          Drift
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "constitution"}
          onClick={() => setTab("constitution")}
        >
          Constitution
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "decisions"}
          onClick={() => setTab("decisions")}
        >
          Decisions
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "evidence"}
          onClick={() => setTab("evidence")}
        >
          Evidence
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "completions"}
          onClick={() => setTab("completions")}
        >
          Completions
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "workgraph"}
          onClick={() => setTab("workgraph")}
        >
          Work Graph
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "notices"}
          onClick={() => setTab("notices")}
        >
          Notices
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "growth"}
          onClick={() => setTab("growth")}
        >
          Growth
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "eval"}
          onClick={() => setTab("eval")}
        >
          Eval
        </button>
      </div>
      <div
        class={styles.content}
        ref={setContentEl}
        onScroll={() => autoAppend.check()}
      >
        <Show when={loadErrors().length}>
          <div class={styles.error}>{loadErrors().join(" · ")}</div>
        </Show>
        <Show when={actionNotice()}>
          <div class="neu-gov-action-note">{actionNotice()}</div>
        </Show>
        <Show when={tab() === "drift"}>
          <For
            each={
              liveDrift().length
                ? liveDrift()
                : (props.state.driftFindings ?? [])
            }
          >
            {(finding) => (
              <DriftCard
                t={t}
                finding={finding}
                resolveContract={contractFor}
                actionBusy={actionBusy}
                onAcknowledge={acknowledgeFinding}
                onReopen={reopenFinding}
              />
            )}
          </For>
          <Show
            when={
              !liveDrift().length && !(props.state.driftFindings ?? []).length
            }
          >
            <div class="neu-gov-empty">
              No drift findings yet. The evaluator opens them from accepted
              contracts, constitution hits or behaviour signals.
            </div>
          </Show>
        </Show>
        <Show when={tab() === "constitution"}>
          <div class="constitution-toolbar">
            <button
              type="button"
              class="constitution-btn"
              disabled={actionBusy()}
              onClick={() => openRuleEditor("add")}
            >
              {t("gov.newRule")}
            </button>
          </div>
          <Show when={ruleEditor()}>
            {(editor) => (
              <div class="constitution-editor">
                <input
                  class="constitution-input"
                  placeholder={t("gov.statementPh")}
                  value={editor().statement}
                  onInput={(event) =>
                    setRuleEditor({
                      ...editor(),
                      statement: event.currentTarget.value,
                    })
                  }
                />
                <div class="constitution-editor-row">
                  <select
                    class="constitution-input"
                    value={editor().enforcement}
                    onChange={(event) =>
                      setRuleEditor({
                        ...editor(),
                        enforcement: event.currentTarget.value as
                          | "deny"
                          | "approval"
                          | "warn",
                      })
                    }
                  >
                    <option value="warn">warn</option>
                    <option value="approval">approval</option>
                    <option value="deny">deny</option>
                  </select>
                  <input
                    class="constitution-input"
                    placeholder={t("gov.toolsPh")}
                    value={editor().tools}
                    onInput={(event) =>
                      setRuleEditor({
                        ...editor(),
                        tools: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    class="constitution-input"
                    placeholder={t("gov.pathsPh")}
                    value={editor().paths}
                    onInput={(event) =>
                      setRuleEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
                  />
                  {/* A LIST, so the chooser APPENDS the picked directory rather
                      than replacing the field: browsing for a second path must
                      not silently drop the first. */}
                  <PathBrowseButton
                    runtime={props.runtime}
                    class="constitution-input constitution-browse"
                    onPick={(chosen) => {
                      const existing = editor()
                        .paths.split(",")
                        .map((entry) => entry.trim())
                        .filter((entry) => entry && entry !== chosen);
                      setRuleEditor({
                        ...editor(),
                        paths: [...existing, chosen].join(","),
                      });
                    }}
                  />
                  <input
                    class="constitution-input"
                    placeholder="commandPattern"
                    value={editor().commandPattern}
                    onInput={(event) =>
                      setRuleEditor({
                        ...editor(),
                        commandPattern: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                <div class="constitution-editor-actions">
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() => void saveRule()}
                  >
                    {editor().mode === "add" ? t("gov.add") : t("gov.save")}
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setRuleEditor(undefined)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={overrideEditor()}>
            {(editor) => (
              <div class="constitution-editor">
                <div class={styles.title}>
                  {t("gov.overrideRequest", { ruleID: editor().ruleID })}
                </div>
                <input
                  class="constitution-input"
                  placeholder={t("gov.reasonPh")}
                  value={editor().reason}
                  onInput={(event) =>
                    setOverrideEditor({
                      ...editor(),
                      reason: event.currentTarget.value,
                    })
                  }
                />
                <div class="constitution-editor-row">
                  <input
                    class="constitution-input"
                    placeholder={t("gov.overridePathsPh")}
                    value={editor().paths}
                    onInput={(event) =>
                      setOverrideEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
                  />
                  {/* Same rule as the rule editor's row: a LIST appends the
                      picked directory rather than replacing it. */}
                  <PathBrowseButton
                    runtime={props.runtime}
                    class="constitution-input constitution-browse"
                    onPick={(chosen) => {
                      const existing = editor()
                        .paths.split(",")
                        .map((entry) => entry.trim())
                        .filter((entry) => entry && entry !== chosen);
                      setOverrideEditor({
                        ...editor(),
                        paths: [...existing, chosen].join(","),
                      });
                    }}
                  />
                  <input
                    class="constitution-input"
                    placeholder={t("gov.taskIDPh")}
                    value={editor().taskID}
                    onInput={(event) =>
                      setOverrideEditor({
                        ...editor(),
                        taskID: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    class="constitution-input"
                    placeholder={t("gov.expiryPh")}
                    value={editor().expiresAt}
                    onInput={(event) =>
                      setOverrideEditor({
                        ...editor(),
                        expiresAt: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                <div class="constitution-editor-actions">
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() => void submitOverride()}
                  >
                    {t("gov.submitApproval")}
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setOverrideEditor(undefined)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </Show>
          <For
            each={
              liveConstitution().length
                ? liveConstitution()
                : Object.values(props.state.constitutionRules ?? {})
            }
          >
            {(rule) => (
              <div class="constitution-row">
                <div class="constitution-row-main">
                  <span class={styles.title} data-priority={rule.priority}>
                    {rule.ruleID}
                  </span>
                  <span class={styles.text}>{rule.statement}</span>
                  <span class={styles.meta}>
                    {rule.scope} · {rule.enforcement}
                  </span>
                  <RuleOverrides
                    t={t}
                    overrides={overridesForRule(liveOverrides(), rule.ruleID)}
                  />
                </div>
                <Show when={constitutionRuleAffordance(rule) === "editable"}>
                  <div class="constitution-row-actions">
                    <button
                      type="button"
                      class="constitution-btn"
                      disabled={actionBusy()}
                      onClick={() => openRuleEditor("edit", rule)}
                    >
                      {t("gov.edit")}
                    </button>
                    <Show
                      when={
                        constitutionOverrideAffordance(rule) === "requestable"
                      }
                    >
                      <button
                        type="button"
                        class="constitution-btn"
                        disabled={actionBusy()}
                        onClick={() => openOverrideEditor(rule)}
                      >
                        Override
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="constitution-btn"
                      onClick={() =>
                        void updateConstitutionRuleViaRpc(
                          props.runtime,
                          props.sessionID,
                          rule.ruleID,
                          false,
                        ).then(() => load())
                      }
                    >
                      {t("gov.disable")}
                    </button>
                    <button
                      type="button"
                      class="constitution-btn"
                      data-danger
                      onClick={() =>
                        void (async () => {
                          const ok = await confirm({
                            title: t("gov.deleteRuleTitle"),
                            // 说清到底发生什么，不承诺没交付的东西：规则立刻
                            // 永久失效；journal 留一条删除记录且不可擦除（只增
                            // 不改是这套 journal 的硬约束，和 feedback 的「撤
                            // 回」同理）。「历史保留」这种说法听着像在替你保管
                            // 数据，其实那条记录目前没有任何界面读它——空头承
                            // 诺不如不说。
                            message: t("gov.deleteRuleBody", {
                              ruleID: rule.ruleID,
                            }),
                            confirmLabel: t("gov.deleteConfirm"),
                            danger: true,
                          });
                          if (ok)
                            await removeConstitutionRuleViaRpc(
                              props.runtime,
                              props.sessionID,
                              rule.ruleID,
                            ).then(() => load());
                        })()
                      }
                    >
                      {t("gov.delete")}
                    </button>
                  </div>
                </Show>
                {/*
                  Only the hard-coded runtime self-protection rules
                  (C-TERM-001/002/003, enforced by SELF_PROTECTION_PATTERNS in
                  the tool-execution path) are locked: the journal row mirrors
                  a guarantee a panel click cannot remove, and the RPC refuses
                  its edits. Every other rule — including C-REL-* — is
                  editable/disableable/deletable. The panel must SAY why these
                  have no actions instead of rendering an empty slot that reads
                  as "broken".
                */}
                <Show when={constitutionRuleAffordance(rule) === "protected"}>
                  <span
                    class="constitution-protected"
                    title={t("gov.systemProtectedTitle")}
                  >
                    系统保护
                  </span>
                </Show>
              </div>
            )}
          </For>
          <Show when={liveDocRules().length}>
            <div class="neu-gov-section-label">{t("gov.docRulesSection")}</div>
            <For each={liveDocRules()}>
              {(rule) => (
                <div class="constitution-row">
                  <div class="constitution-row-main">
                    <span class={styles.title}>{rule.section}</span>
                    <span class={styles.text}>{rule.statement}</span>
                    <span class={styles.meta}>
                      {rule.source} · {rule.enforcement}
                      {rule.annotated ? t("gov.annotated") : t("gov.prose")}
                    </span>
                  </div>
                  <div class="constitution-row-actions">
                    <button
                      type="button"
                      class="constitution-btn"
                      onClick={() => openDocRuleEditor(rule)}
                    >
                      {t("gov.edit")}
                    </button>
                    <button
                      type="button"
                      class="constitution-btn"
                      onClick={() =>
                        void (async () => {
                          const result = await promoteConstitutionDocRuleViaRpc(
                            props.runtime,
                            props.sessionID,
                            rule.id,
                          );
                          setActionNotice(
                            result?.promoted
                              ? t("gov.promoted", { ruleID: result.ruleID })
                              : t("gov.promoteFailed", {
                                  reason:
                                    result?.reason ?? t("gov.unknownReason"),
                                }),
                          );
                          await load();
                        })()
                      }
                    >
                      {t("gov.promote")}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
          <Show when={docRuleEditor()}>
            {(editor) => (
              <div class="constitution-editor">
                <div class="constitution-editor-row">
                  <span class={styles.meta}>
                    {t("gov.docRuleEditorTitle", {
                      section: editor().section,
                      source: editor().source,
                    })}
                  </span>
                </div>
                <textarea
                  class="constitution-input constitution-textarea"
                  placeholder={t("gov.docRuleStatementPh")}
                  value={editor().statement}
                  onInput={(event) =>
                    setDocRuleEditor({
                      ...editor(),
                      statement: event.currentTarget.value,
                    })
                  }
                />
                <div class="constitution-editor-row">
                  <select
                    class="constitution-input"
                    value={editor().enforcement}
                    onChange={(event) =>
                      setDocRuleEditor({
                        ...editor(),
                        enforcement: event.currentTarget.value as
                          | "deny"
                          | "approval"
                          | "warn",
                      })
                    }
                  >
                    <option value="warn">{t("gov.warnOption")}</option>
                    <option value="approval">approval</option>
                    <option value="deny">deny</option>
                  </select>
                  <input
                    class="constitution-input"
                    placeholder={t("gov.docRuleToolsPh")}
                    value={editor().tools}
                    onInput={(event) =>
                      setDocRuleEditor({
                        ...editor(),
                        tools: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    class="constitution-input"
                    placeholder={t("gov.pathsPh")}
                    value={editor().paths}
                    onInput={(event) =>
                      setDocRuleEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
                  />
                  {/* Same rule as the other two path rows: a LIST appends the
                      picked directory rather than replacing it. */}
                  <PathBrowseButton
                    runtime={props.runtime}
                    class="constitution-input constitution-browse"
                    onPick={(chosen) => {
                      const existing = editor()
                        .paths.split(",")
                        .map((entry) => entry.trim())
                        .filter((entry) => entry && entry !== chosen);
                      setDocRuleEditor({
                        ...editor(),
                        paths: [...existing, chosen].join(","),
                      });
                    }}
                  />
                  <input
                    class="constitution-input"
                    placeholder="commandPattern"
                    value={editor().commandPattern}
                    onInput={(event) =>
                      setDocRuleEditor({
                        ...editor(),
                        commandPattern: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                <div class="constitution-editor-actions">
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() => void saveDocRule()}
                  >
                    {t("gov.saveToDoc")}
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setDocRuleEditor(undefined)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show
            when={
              !liveConstitution().length &&
              !Object.values(props.state.constitutionRules ?? {}).length
            }
          >
            <div class="neu-gov-empty">
              No constitution rules loaded. Seeded self-protection rules and
              user/project rules appear here.
            </div>
          </Show>
          {dialog}
        </Show>
        <Show when={tab() === "decisions"}>
          <div class={styles.scopeSwitch}>
            <button
              type="button"
              class={styles.scopeBtn}
              data-active={decisionScope() === "session"}
              onClick={() => setDecisionScope("session")}
            >
              This session
            </button>
            <button
              type="button"
              class={styles.scopeBtn}
              data-active={decisionScope() === "workspace"}
              onClick={() => setDecisionScope("workspace")}
            >
              Workspace
            </button>
          </div>
          <For
            each={
              liveDecisions().length
                ? liveDecisions()
                : (props.state.decisions ?? [])
            }
          >
            {(record) => (
              <div class={styles.card}>
                <div class={styles.cardHead}>
                  <span class={styles.title} data-priority={record.status}>
                    {record.status}
                  </span>
                  <span class={styles.cardMeta}>{record.id}</span>
                </div>
                <div class={styles.cardSection}>
                  <div class={styles.cardLabel}>Decision</div>
                  <div class={styles.cardText}>{record.decision}</div>
                </div>
                <Show when={record.rationale?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Rationale</div>
                    <div class={styles.cardText}>
                      {(record.rationale ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.alternatives?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Alternatives</div>
                    <For each={record.alternatives ?? []}>
                      {(item: { option: string; rejectedReason?: string }) => (
                        <div class={styles.cardText}>
                          {item.option}
                          {item.rejectedReason
                            ? ` — ${item.rejectedReason}`
                            : ""}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={record.consequences?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Consequences</div>
                    <div class={styles.cardText}>
                      {(record.consequences ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show
            when={
              !liveDecisions().length && !(props.state.decisions ?? []).length
            }
          >
            <div class="neu-gov-empty">
              No decision.recorded for this {decisionScope()} scope yet. Session
              decisions appear when the model calls record_decision; workspace
              decisions come from an explicit workspace promotion.
            </div>
          </Show>
        </Show>
        <Show when={tab() === "evidence"}>
          <For
            each={
              liveEvidence().length
                ? liveEvidence()
                : (props.state.evidence ?? [])
            }
          >
            {(record) => (
              <div class={styles.card}>
                <div class={styles.cardHead}>
                  <span class={styles.title} data-priority={record.status}>
                    {record.status}
                  </span>
                  <span class={styles.cardMeta}>{record.taskID}</span>
                </div>
                <div class={styles.cardText}>{record.objective}</div>
                <Show when={record.validations?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Validations</div>
                    <For each={record.validations ?? []}>
                      {(validation: {
                        command: string;
                        result: string;
                        safeSummary: string;
                      }) => (
                        <div class={styles.cardText}>
                          [{validation.result}] {validation.command} —{" "}
                          {validation.safeSummary}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={record.changes?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>
                      Changes ({record.changes!.length})
                    </div>
                    <For each={record.changes ?? []}>
                      {(change: {
                        path: string;
                        changeType?: string;
                        summary?: string;
                      }) => (
                        <div class={styles.cardText}>
                          {change.changeType ?? "change"}: {change.path}
                          {change.summary ? ` — ${change.summary}` : ""}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={record.knownGaps?.length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Known gaps</div>
                    <div class={styles.cardText}>
                      {(record.knownGaps ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show
            when={
              !liveEvidence().length && !(props.state.evidence ?? []).length
            }
          >
            <div class="neu-gov-empty">
              No evidence.recorded for this session yet. Evidence appears after
              the model runs record_validation / record_completion or Nia
              submits an audit report.
            </div>
          </Show>
        </Show>
        <Show when={tab() === "completions"}>
          <For
            each={
              liveCompletions().length
                ? liveCompletions()
                : (props.state.completions ?? [])
            }
          >
            {(record) => (
              <div class={`${styles.card} ${styles.completionCard}`}>
                <div class={styles.cardHead}>
                  <span class={styles.title} data-priority="validated">
                    {record.taskID}
                  </span>
                  <span class={styles.cardMeta}>{record.recordedAt}</span>
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() => void recordHumanValidation(record.taskID)}
                  >
                    {t("gov.recordHuman")}
                  </button>
                </div>
                <div class={styles.cardSection}>
                  <div class={styles.cardLabel}>Target</div>
                  <div class={styles.cardText}>{record.objective}</div>
                </div>
                <div class={styles.cardSection}>
                  <div class={styles.cardLabel}>Changes</div>
                  <div class={styles.cardText}>{record.changeSummary}</div>
                </div>
                <Show when={record.behaviorImpact}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Behavior impact</div>
                    <div class={styles.cardText}>{record.behaviorImpact}</div>
                  </div>
                </Show>
                <div class={styles.cardSection}>
                  <div class={styles.cardLabel}>Validation matrix</div>
                  <Show
                    when={(record.validations ?? []).length}
                    fallback={
                      <div class={styles.cardText}>no validation recorded</div>
                    }
                  >
                    <For each={record.validations ?? []}>
                      {(validation: {
                        command: string;
                        result: string;
                        safeSummary: string;
                      }) => (
                        <div class={styles.cardText}>
                          [{validation.result}] {validation.command} —{" "}
                          {validation.safeSummary}
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
                <Show when={(record.knownGaps ?? []).length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Known gaps</div>
                    <div class={styles.cardText}>
                      {(record.knownGaps ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.humanValidation}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Human validation</div>
                    <div class={styles.cardText}>{record.humanValidation}</div>
                  </div>
                </Show>
                <Show when={(record.externalSideEffects ?? []).length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>External side effects</div>
                    <div class={styles.cardText}>
                      {(record.externalSideEffects ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={(record.evidenceIDs ?? []).length}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Evidence IDs</div>
                    <div class={styles.cardText}>
                      {(record.evidenceIDs ?? []).join(", ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.rollbackState}>
                  <div class={styles.cardSection}>
                    <div class={styles.cardLabel}>Rollback</div>
                    <div class={styles.cardText}>{record.rollbackState}</div>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show
            when={
              !liveCompletions().length &&
              !(props.state.completions ?? []).length
            }
          >
            <div class="neu-gov-empty">
              No completion.recorded yet. A completion card appears after the
              model calls record_completion with its validation matrix.
            </div>
          </Show>
        </Show>
        <Show when={tab() === "workgraph"}>
          <div class={wg.tab}>
            <div class={wg.viewToggle}>
              <button
                type="button"
                class="constitution-btn"
                data-active={workGraphView() === "tree"}
                onClick={() => setWorkGraphView("tree")}
              >
                {t("gov.causalTree")}
              </button>
              <button
                type="button"
                class="constitution-btn"
                data-active={workGraphView() === "graph"}
                onClick={() => setWorkGraphView("graph")}
              >
                {t("gov.graphNav")}
              </button>
            </div>
            <Show
              when={workGraphView() === "tree"}
              fallback={<WorkGraphGraph state={workGraphState()} />}
            >
              <WorkGraphTree state={workGraphState()} />
            </Show>
          </div>
        </Show>
        <Show when={tab() === "notices"}>
          <div class={styles.sectionTitle}>Runtime Notices</div>
          <For
            each={
              liveNotices().length
                ? liveNotices()
                : (props.state.runtimeNotices ?? [])
            }
          >
            {(notice) => (
              <div class={styles.row}>
                <span class={styles.title} data-priority={notice.kind}>
                  {notice.kind} · r{notice.revision}
                </span>
                <span class={styles.text}>{notice.summary}</span>
                <span class={styles.meta}>{notice.at}</span>
              </div>
            )}
          </For>
          <Show
            when={
              !liveNotices().length &&
              !(props.state.runtimeNotices ?? []).length
            }
          >
            <div class="neu-gov-empty">
              No runtime notices yet — a config reload or agent switch records
              one here.
            </div>
          </Show>
        </Show>
        <Show when={tab() === "growth"}>
          {/* 全空时这个页面只说一件事。四段平铺的「什么都没有」是一屏散
              文——需要行动的人打开它，得到的是一次阅读作业。哪一段有东
              西，哪一段才出现。 */}
          <Show
            when={growthHasAnything()}
            fallback={
              <div class="neu-gov-empty">
                {t("gov.growthEmpty")}
                <br />
                {t("gov.growthEmptyHint")}
              </div>
            }
          >
            <div class={styles.sectionTitle}>Growth Triggers</div>
            {/* S4: the order is the triage's (frequency × potential, stable
              tie-break), not the sources' own — the rank used to be
              computed and read by nobody, so the operator re-derived the
              priority by eye. The subtitle says which yardstick the order
              is, so a reader never mistakes it for a chronology. */}
            <div class={styles.text} style="margin-bottom:6px;">
              {t("gov.growthSortHint")}
            </div>
            <For each={liveGrowthTriggers()}>
              {(trigger) => (
                <div class={styles.row}>
                  <span class={styles.title}>{trigger.capability}</span>
                  <span class={styles.text}>{trigger.reason}</span>
                  <span class={styles.meta}>
                    {trigger.rule} · {trigger.class} ·{" "}
                    {Object.entries(trigger.evidence ?? {})
                      .map(([key, value]) => `${key}=${value}`)
                      .join(" ")}
                  </span>
                  {/* L7: the trigger surface. One click records the promotion
                    fact (destination + required approval) and reloads — it
                    does NOT run a mutation. The human hands the ranked
                    trigger onward; the loop never takes itself from here. */}
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() =>
                      void (async () => {
                        const result = await promoteGrowthTriggerViaRpc(
                          props.runtime,
                          props.sessionID,
                          trigger.capability,
                        );
                        setActionNotice(
                          result?.promoted
                            ? t("gov.promotionRecorded", {
                                capability: trigger.capability,
                                destination: result.destination,
                                approval: result.approval,
                                next: result.next,
                              })
                            : t("gov.promotionNotRecorded", {
                                reason:
                                  result?.reason ?? t("gov.unknownReason"),
                              }),
                        );
                        await load();
                      })()
                    }
                  >
                    {t("gov.promote")}
                  </button>
                </div>
              )}
            </For>
            <Show when={!liveGrowthTriggers().length}>
              <div class="neu-gov-empty">
                No growth trigger right now. A trigger is derived on each read
                from the four growth systems (internal runs, external benchmark
                gaps, correction patterns, capability curriculum) — nothing is
                staged, and a trigger applies nothing.
              </div>
            </Show>
            <div class={styles.sectionTitle}>Growth Proposals</div>
            <For
              each={
                liveGrowthProposals().length
                  ? liveGrowthProposals()
                  : (props.state.growthProposals ?? [])
              }
            >
              {(proposal) => (
                <div class={styles.row}>
                  <span class={styles.title}>{proposal.at}</span>
                  <For each={proposal.suggestions ?? []}>
                    {(suggestion) => (
                      <span class={styles.text}>
                        [{suggestion.kind}] {suggestion.capability} —{" "}
                        {suggestion.reason} ({suggestion.observations}{" "}
                        observations)
                      </span>
                    )}
                  </For>
                  <span class={styles.meta}>
                    considered {proposal.considered?.tasks ?? 0} tasks ·{" "}
                    {proposal.considered?.gaps ?? 0} gaps
                  </span>
                </div>
              )}
            </For>
            <Show
              when={
                !liveGrowthProposals().length &&
                !(props.state.growthProposals ?? []).length
              }
            >
              <div class="neu-gov-empty">
                No growth proposal yet. A proposal is a FACT — recording one
                applies nothing; the destination's approval policy decides.
              </div>
            </Show>
            <div class={styles.sectionTitle}>Growth Promotions</div>
            <For
              each={
                liveGrowthPromotions().length
                  ? liveGrowthPromotions()
                  : (props.state.growthPromotions ?? [])
              }
            >
              {(promotion) => (
                <div class={styles.row}>
                  <span class={styles.title}>
                    {promotion.trigger?.capability ?? promotion.promotionID}
                  </span>
                  <span class={styles.text}>
                    → {promotion.destination} ({promotion.approval}) ·{" "}
                    {promotion.next}
                  </span>
                  <span class={styles.meta}>{promotion.at}</span>
                </div>
              )}
            </For>
            <Show
              when={
                !liveGrowthPromotions().length &&
                !(props.state.growthPromotions ?? []).length
              }
            >
              <div class="neu-gov-empty">
                No promotion yet. Promoting a trigger records where it lands and
                what approval it needs — it applies nothing by itself.
              </div>
            </Show>
          </Show>
        </Show>
        <Show when={tab() === "eval"}>
          {/* 同一个病：两段「什么都没有」。有数据才展开。 */}
          <Show
            when={
              liveExternalJoinedTasks().length > 0 ||
              (props.state.externalRuns ?? []).length > 0
            }
            fallback={<div class="neu-gov-empty">{t("gov.evalEmpty")}</div>}
          >
            <div class={styles.sectionTitle}>
              External Benchmark — Per-Task Comparison
            </div>
            <For each={liveExternalJoinedTasks()}>
              {(task) => (
                <div class={styles.row}>
                  <span class={styles.title}>{task.externalTaskID}</span>
                  <span class={styles.text}>
                    baseline {Math.round((task.baselineSuccessRate ?? 0) * 100)}
                    % · ours {Math.round((task.ourSuccessRate ?? 0) * 100)}%
                    over {task.ourRuns} run{task.ourRuns === 1 ? "" : "s"}
                  </span>
                  <span class={styles.meta}>
                    {task.ourRuns > 0 &&
                    (task.ourSuccessRate ?? 0) > (task.baselineSuccessRate ?? 0)
                      ? "above baseline"
                      : task.ourRuns > 0
                        ? "at or below baseline"
                        : "no runs yet"}
                  </span>
                </div>
              )}
            </For>
            <Show when={!liveExternalJoinedTasks().length}>
              <div class="neu-gov-empty">
                No external benchmark runs joined yet. `natalia eval` records
                one join per task; the comparison reads the benchmark's own
                baseline against our recorded runs.
              </div>
            </Show>
            <div class={styles.sectionTitle}>This Session's Recorded Runs</div>
            <For each={props.state.externalRuns ?? []}>
              {(run) => (
                <div class={styles.row}>
                  <span class={styles.title}>{run.externalTaskID}</span>
                  <span class={styles.text}>
                    {run.success === undefined
                      ? "unscored"
                      : run.success
                        ? "success"
                        : "failure"}{" "}
                    · {run.benchmark}
                  </span>
                  <span class={styles.meta}>{run.at}</span>
                </div>
              )}
            </For>
            <Show when={!(props.state.externalRuns ?? []).length}>
              <div class="neu-gov-empty">
                No external run recorded in this session yet.
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
