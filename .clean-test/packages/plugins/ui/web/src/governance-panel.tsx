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

export type GovernanceTab =
  | "constitution"
  | "decisions"
  | "evidence"
  | "completions"
  | "drift"
  | "workgraph"
  | "notices";
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

/** The RPC action behind the [新增规则] button (user creates a rule). */
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
  const [activityExpanded, setActivityExpanded] = createSignal(false);
  const [evidenceExpanded, setEvidenceExpanded] = createSignal(false);
  const finding = () => props.finding;

  const activityRefs = () => splitActivityRefs(finding().currentActivity ?? "");
  const activityView = () => collapseList(activityRefs(), activityExpanded());
  const evidenceItems = (): any[] => finding().evidence ?? [];
  const evidenceView = () => collapseList(evidenceItems(), evidenceExpanded());

  return (
    <div class="drift-card">
      <div class="drift-card-head">
        <span class="neu-gov-title" data-priority={finding().severity}>
          {finding().severity} · {Math.round(finding().confidence * 100)}%
        </span>
        <span class="drift-card-status" data-status={finding().status}>
          {finding().status}
        </span>
        <Show when={(finding().reopenedCount ?? 0) > 0}>
          <span class="drift-card-reopened">
            已翻案 {finding().reopenedCount} 次
          </span>
        </Show>
      </div>
      <div class="drift-card-goal">Goal: {finding().originalObjective}</div>
      <Show when={finding().planID}>
        <div class="drift-card-meta">Plan: {finding().planID}</div>
      </Show>
      <Show when={props.resolveContract(finding().planID)}>
        {(contract) => (
          <div class="drift-card-section">
            <div class="drift-card-section-title">Reference frame</div>
            <Show when={contract().scope?.length}>
              <div class="drift-card-evidence">
                scope: {contract().scope!.join(", ")}
              </div>
            </Show>
            <Show when={contract().verification?.length}>
              <div class="drift-card-evidence">
                verification: {contract().verification!.join(", ")}
              </div>
            </Show>
            <Show when={contract().constraints?.length}>
              <div class="drift-card-evidence">
                constraints: {contract().constraints!.join(", ")}
              </div>
            </Show>
            <div class="drift-card-meta">
              contract {contract().status} v{contract().version}
            </div>
          </div>
        )}
      </Show>
      <div class="drift-card-current">
        Current: {activityView().shown.join(", ")}
        <Show when={activityView().hiddenCount > 0 || activityExpanded()}>
          <button
            type="button"
            class="drift-card-expand"
            onClick={() => setActivityExpanded(!activityExpanded())}
          >
            {activityExpanded()
              ? "收起"
              : `展开全部 (+${activityView().hiddenCount})`}
          </button>
        </Show>
      </div>
      <Show
        when={
          ruleHitsFor(finding()).length ||
          finding().contractVersion !== undefined
        }
      >
        <div class="drift-card-section">
          <div class="drift-card-section-title">Why this fired</div>
          <Show when={finding().contractVersion !== undefined}>
            <div class="drift-card-meta">
              contract v{finding().contractVersion}
            </div>
          </Show>
          <For each={ruleHitsFor(finding())}>
            {(hit) => (
              <div class="drift-card-rule">
                {hit.rule} · {Math.round(hit.confidence * 100)}%
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={evidenceItems().length}>
        <div class="drift-card-section">
          <div class="drift-card-section-title">Evidence</div>
          <For each={evidenceView().shown}>
            {(item) => <div class="drift-card-evidence">{item}</div>}
          </For>
          <Show when={evidenceView().hiddenCount > 0 || evidenceExpanded()}>
            <button
              type="button"
              class="drift-card-expand"
              onClick={() => setEvidenceExpanded(!evidenceExpanded())}
            >
              {evidenceExpanded()
                ? "收起"
                : `展开全部 evidence (+${evidenceView().hiddenCount})`}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={finding().applicableConstraints?.length}>
        <div class="drift-card-section">
          <div class="drift-card-section-title">Constraints</div>
          <For each={finding().applicableConstraints}>
            {(item) => <div class="drift-card-evidence">{item}</div>}
          </For>
        </div>
      </Show>
      <Show when={finding().rationale}>
        <div class="drift-card-rationale">{finding().rationale}</div>
      </Show>
      <Show when={finding().status === "open"}>
        <div class="drift-card-actions">
          <button
            type="button"
            class="drift-card-btn"
            disabled={props.actionBusy()}
            onClick={() => {
              // An explanation is only auditable with a rationale; prompt for
              // one and skip the acknowledgement if it is empty.
              const rationale = window.prompt("解释这条发现，给出理由：");
              if (rationale?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "explained",
                  rationale.trim(),
                );
            }}
          >
            解释
          </button>
          <button
            type="button"
            class="drift-card-btn"
            data-kind="dispute"
            disabled={props.actionBusy()}
            onClick={() => {
              const reason = window.prompt("声明这是误报，给出理由：");
              if (reason?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "disputed",
                  reason.trim(),
                );
            }}
          >
            误报
          </button>
          <button
            type="button"
            class="drift-card-btn"
            data-kind="dismiss"
            disabled={props.actionBusy()}
            onClick={() =>
              props.onAcknowledge(finding().findingID, "dismissed")
            }
          >
            忽略
          </button>
          <button
            type="button"
            class="drift-card-btn"
            data-kind="correct"
            disabled={props.actionBusy()}
            onClick={() => {
              // Correcting realigns the work: capture the correction plan so the
              // rationale is auditable.
              const plan = window.prompt(
                "生成纠正 plan，说明如何让工作回到目标：",
              );
              if (plan?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "corrected",
                  plan.trim(),
                );
            }}
          >
            纠正
          </button>
          <button
            type="button"
            class="drift-card-btn"
            data-kind="detour"
            disabled={props.actionBusy()}
            onClick={() => {
              // A detour is an explicit, sanctioned pause; capture why.
              const reason = window.prompt(
                "声明这是有意绕行，给出理由（会显式暂停）：",
              );
              if (reason?.trim())
                props.onAcknowledge(
                  finding().findingID,
                  "detour_declared",
                  reason.trim(),
                );
            }}
          >
            绕行
          </button>
        </div>
      </Show>
      <Show
        when={
          finding().status === "dismissed" || finding().status === "explained"
        }
      >
        <div class="drift-card-actions">
          <button
            type="button"
            class="drift-card-btn"
            data-kind="reopen"
            disabled={props.actionBusy()}
            onClick={() => props.onReopen(finding().findingID)}
          >
            重新打开
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
function RuleOverrides(props: { overrides: GovernanceOverrideView[] }) {
  const [expanded, setExpanded] = createSignal(false);
  const view = () => collapseList(props.overrides, expanded());
  return (
    <Show when={props.overrides.length > 0}>
      <div class="constitution-row-overrides">
        <div class="constitution-row-overrides-title">
          已授 override ×{props.overrides.length}
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
            {expanded() ? "收起" : `展开全部 (+${view().hiddenCount})`}
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function GovernancePane(props: {
  state: AppState;
  runtime?: RuntimeClient;
  sessionID?: string;
  /** Optional deep-link target; defaults to the drift review view. */
  initialTab?: GovernanceTab;
}) {
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
        `加载下一页失败：${error instanceof Error ? error.message : String(error)}`,
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
    const note = window.prompt(
      `为 ${taskID} 记录人工验收（写入 completion 卡片，用户为准）：`,
    );
    if (!note?.trim()) return;
    setActionBusy(true);
    try {
      const result = await props.runtime?.recordHumanValidation?.(
        { taskID, validation: note.trim() },
        props.sessionID,
      );
      setActionNotice(
        result?.recorded
          ? "已记录人工验收"
          : `失败：${result?.reason ?? "未知原因"}`,
      );
      if (result?.recorded) await load();
    } catch (error) {
      setActionNotice(
        `失败：${error instanceof Error ? error.message : String(error)}`,
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
          ? `已更新：${findingID} → ${status}`
          : `未更新：${findingID} 已不是 open，或服务端没找到这条 finding。`,
      );
      await load();
    } catch (error) {
      setActionNotice(
        `更新失败：${error instanceof Error ? error.message : String(error)}`,
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
            ? "已新增规则"
            : "已更新规则"
          : `失败：${outcome?.reason ?? "未知原因"}`,
      );
      if (ok) setRuleEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        `失败：${error instanceof Error ? error.message : String(error)}`,
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
      setActionNotice(`失败：${draft.reason}`);
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
          `已提交 override 请求（${draft.input.ruleID}）——审批通过即生效；拒绝则记录在案`,
        );
      else setActionNotice(`失败：${result?.reason ?? "未知原因"}`);
      if (result?.requested) setOverrideEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        `失败：${error instanceof Error ? error.message : String(error)}`,
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
          ? `已更新文档规则「${editor.section}」`
          : `失败：${outcome?.reason ?? "未知原因"}`,
      );
      if (outcome?.updated) setDocRuleEditor(undefined);
      await load();
    } catch (error) {
      setActionNotice(
        `失败：${error instanceof Error ? error.message : String(error)}`,
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
          ? `已翻案：${findingID} → open`
          : `无法翻案：${result?.reason ?? "未知原因"}`,
      );
      await load();
    } catch (error) {
      setActionNotice(
        `翻案失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div class="governance-pane">
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
      </div>
      <div
        class="neu-governance-content"
        ref={setContentEl}
        onScroll={() => autoAppend.check()}
      >
        <Show when={loadErrors().length}>
          <div class="neu-gov-error">{loadErrors().join(" · ")}</div>
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
              新增规则
            </button>
          </div>
          <Show when={ruleEditor()}>
            {(editor) => (
              <div class="constitution-editor">
                <input
                  class="constitution-input"
                  placeholder="规则内容（statement）"
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
                    placeholder="tools（逗号分隔）"
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
                    placeholder="paths（逗号分隔）"
                    value={editor().paths}
                    onInput={(event) =>
                      setRuleEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
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
                    {editor().mode === "add" ? "新增" : "保存"}
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setRuleEditor(undefined)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={overrideEditor()}>
            {(editor) => (
              <div class="constitution-editor">
                <div class="neu-gov-title">
                  申请 override：{editor().ruleID}
                </div>
                <input
                  class="constitution-input"
                  placeholder="理由（必填）——为什么这次可以破例"
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
                    placeholder="paths（逗号分隔，可空）"
                    value={editor().paths}
                    onInput={(event) =>
                      setOverrideEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
                  />
                  <input
                    class="constitution-input"
                    placeholder="taskID（可空）"
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
                    placeholder="过期时间 ISO（可空）"
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
                    提交审批
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setOverrideEditor(undefined)}
                  >
                    取消
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
                  <span class="neu-gov-title" data-priority={rule.priority}>
                    {rule.ruleID}
                  </span>
                  <span class="neu-gov-text">{rule.statement}</span>
                  <span class="neu-gov-meta">
                    {rule.scope} · {rule.enforcement}
                  </span>
                  <RuleOverrides
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
                      编辑
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
                      停用
                    </button>
                    <button
                      type="button"
                      class="constitution-btn"
                      data-danger
                      onClick={() =>
                        void (async () => {
                          const ok = await confirm({
                            title: "删除规则",
                            message: `删除 ${rule.ruleID}？记录进 journal（墓碑），历史保留。`,
                            confirmLabel: "删除",
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
                      删除
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
                    title="Runtime 硬保护规则：由执行路径（SELF_PROTECTION_PATTERNS）强制，面板不可编辑/停用/删除，模型也只能提案、不能修改；journal 行仅是镜像。"
                  >
                    系统保护
                  </span>
                </Show>
              </div>
            )}
          </For>
          <Show when={liveDocRules().length}>
            <div class="neu-gov-section-label">文档规则（可提升）</div>
            <For each={liveDocRules()}>
              {(rule) => (
                <div class="constitution-row">
                  <div class="constitution-row-main">
                    <span class="neu-gov-title">{rule.section}</span>
                    <span class="neu-gov-text">{rule.statement}</span>
                    <span class="neu-gov-meta">
                      {rule.source} · {rule.enforcement}
                      {rule.annotated ? " · 已标注" : " · prose"}
                    </span>
                  </div>
                  <div class="constitution-row-actions">
                    <button
                      type="button"
                      class="constitution-btn"
                      onClick={() => openDocRuleEditor(rule)}
                    >
                      编辑
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
                              ? `已提升为正式规则 ${result.ruleID}`
                              : `提升失败：${result?.reason ?? "未知原因"}`,
                          );
                          await load();
                        })()
                      }
                    >
                      提升为正式规则
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
                  <span class="neu-gov-meta">
                    编辑文档规则「{editor().section}」（{editor().source}）
                  </span>
                </div>
                <textarea
                  class="constitution-input constitution-textarea"
                  placeholder="规则内容（statement，写回文档段落）"
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
                    <option value="warn">warn（软约束）</option>
                    <option value="approval">approval</option>
                    <option value="deny">deny</option>
                  </select>
                  <input
                    class="constitution-input"
                    placeholder="tools（逗号分隔；deny/approval 必填）"
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
                    placeholder="paths（逗号分隔）"
                    value={editor().paths}
                    onInput={(event) =>
                      setDocRuleEditor({
                        ...editor(),
                        paths: event.currentTarget.value,
                      })
                    }
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
                    保存到文档
                  </button>
                  <button
                    type="button"
                    class="constitution-btn"
                    onClick={() => setDocRuleEditor(undefined)}
                  >
                    取消
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
          <div class="gov-scope-switch">
            <button
              type="button"
              class="gov-scope-btn"
              data-active={decisionScope() === "session"}
              onClick={() => setDecisionScope("session")}
            >
              This session
            </button>
            <button
              type="button"
              class="gov-scope-btn"
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
              <div class="gov-card">
                <div class="gov-card-head">
                  <span class="neu-gov-title" data-priority={record.status}>
                    {record.status}
                  </span>
                  <span class="gov-card-meta">{record.id}</span>
                </div>
                <div class="gov-card-section">
                  <div class="gov-card-label">Decision</div>
                  <div class="gov-card-text">{record.decision}</div>
                </div>
                <Show when={record.rationale?.length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Rationale</div>
                    <div class="gov-card-text">
                      {(record.rationale ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.alternatives?.length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Alternatives</div>
                    <For each={record.alternatives ?? []}>
                      {(item: { option: string; rejectedReason?: string }) => (
                        <div class="gov-card-text">
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
                  <div class="gov-card-section">
                    <div class="gov-card-label">Consequences</div>
                    <div class="gov-card-text">
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
              <div class="gov-card">
                <div class="gov-card-head">
                  <span class="neu-gov-title" data-priority={record.status}>
                    {record.status}
                  </span>
                  <span class="gov-card-meta">{record.taskID}</span>
                </div>
                <div class="gov-card-text">{record.objective}</div>
                <Show when={record.validations?.length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Validations</div>
                    <For each={record.validations ?? []}>
                      {(validation: {
                        command: string;
                        result: string;
                        safeSummary: string;
                      }) => (
                        <div class="gov-card-text">
                          [{validation.result}] {validation.command} —{" "}
                          {validation.safeSummary}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={record.changes?.length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">
                      Changes ({record.changes!.length})
                    </div>
                    <For each={record.changes ?? []}>
                      {(change: {
                        path: string;
                        changeType?: string;
                        summary?: string;
                      }) => (
                        <div class="gov-card-text">
                          {change.changeType ?? "change"}: {change.path}
                          {change.summary ? ` — ${change.summary}` : ""}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={record.knownGaps?.length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Known gaps</div>
                    <div class="gov-card-text">
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
              <div class="gov-card gov-completion-card">
                <div class="gov-card-head">
                  <span class="neu-gov-title" data-priority="validated">
                    {record.taskID}
                  </span>
                  <span class="gov-card-meta">{record.recordedAt}</span>
                  <button
                    type="button"
                    class="constitution-btn"
                    disabled={actionBusy()}
                    onClick={() => void recordHumanValidation(record.taskID)}
                  >
                    记录人工验收
                  </button>
                </div>
                <div class="gov-card-section">
                  <div class="gov-card-label">Target</div>
                  <div class="gov-card-text">{record.objective}</div>
                </div>
                <div class="gov-card-section">
                  <div class="gov-card-label">Changes</div>
                  <div class="gov-card-text">{record.changeSummary}</div>
                </div>
                <Show when={record.behaviorImpact}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Behavior impact</div>
                    <div class="gov-card-text">{record.behaviorImpact}</div>
                  </div>
                </Show>
                <div class="gov-card-section">
                  <div class="gov-card-label">Validation matrix</div>
                  <Show
                    when={(record.validations ?? []).length}
                    fallback={
                      <div class="gov-card-text">no validation recorded</div>
                    }
                  >
                    <For each={record.validations ?? []}>
                      {(validation: {
                        command: string;
                        result: string;
                        safeSummary: string;
                      }) => (
                        <div class="gov-card-text">
                          [{validation.result}] {validation.command} —{" "}
                          {validation.safeSummary}
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
                <Show when={(record.knownGaps ?? []).length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Known gaps</div>
                    <div class="gov-card-text">
                      {(record.knownGaps ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.humanValidation}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Human validation</div>
                    <div class="gov-card-text">{record.humanValidation}</div>
                  </div>
                </Show>
                <Show when={(record.externalSideEffects ?? []).length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">External side effects</div>
                    <div class="gov-card-text">
                      {(record.externalSideEffects ?? []).join("; ")}
                    </div>
                  </div>
                </Show>
                <Show when={(record.evidenceIDs ?? []).length}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Evidence IDs</div>
                    <div class="gov-card-text">
                      {(record.evidenceIDs ?? []).join(", ")}
                    </div>
                  </div>
                </Show>
                <Show when={record.rollbackState}>
                  <div class="gov-card-section">
                    <div class="gov-card-label">Rollback</div>
                    <div class="gov-card-text">{record.rollbackState}</div>
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
          <div class="wg-tab">
            <div class="wg-view-toggle">
              <button
                type="button"
                class="constitution-btn"
                data-active={workGraphView() === "tree"}
                onClick={() => setWorkGraphView("tree")}
              >
                因果树
              </button>
              <button
                type="button"
                class="constitution-btn"
                data-active={workGraphView() === "graph"}
                onClick={() => setWorkGraphView("graph")}
              >
                图导航
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
          <div class="neu-gov-section-title">Runtime Notices</div>
          <For
            each={
              liveNotices().length
                ? liveNotices()
                : (props.state.runtimeNotices ?? [])
            }
          >
            {(notice) => (
              <div class="neu-gov-row">
                <span class="neu-gov-title" data-priority={notice.kind}>
                  {notice.kind} · r{notice.revision}
                </span>
                <span class="neu-gov-text">{notice.summary}</span>
                <span class="neu-gov-meta">{notice.at}</span>
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
      </div>
    </div>
  );
}
