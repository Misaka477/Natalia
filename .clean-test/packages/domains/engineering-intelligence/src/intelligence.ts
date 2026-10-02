import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { RuntimeEvent } from "@anthelia/contracts";
import { sessionStoreController } from "@anthelia/session-store";
import { workLedgerController } from "@natalia/work-ledger";
import { type ConstitutionDocRule } from "@anthelia/runtime-services";
import { governanceLedgerController } from "@natalia/governance-ledger";
import { loadProjectDocuments } from "./project-docs";
import { applyConstitutionDocEdit } from "./constitution-doc";
import { writeWorkspaceFile } from "@anthelia/workspace";
import type { SessionFactState } from "@anthelia/session";
import {
  projectedGrowthPromotions,
  projectedExternalRuns,
  projectedGrowthProposals,
  sessionFactExternalRuns,
  sessionFactGrowthPromotions,
  sessionFactGrowthProposals,
} from "@anthelia/session";
import {
  projectedCanonicalTools,
  projectedWorkGraphNodes,
  projectedWorkGraphEdges,
  projectedMailboxMessages,
  projectedCollabMessages,
  projectedCompletions,
  projectedConstitutionRules,
  projectedConstitutionOverrides,
  projectedRuntimeNotices,
  projectedWorkContracts,
  projectedDecisionRecords,
  projectedDriftFindings,
  projectedEvidenceRecords,
  projectedPlanDocs,
  sessionFactConstitutionRules,
  sessionFactCompletions,
  sessionFactDecisionRecords,
  sessionFactHumanValidation,
  sessionFactDriftFindings,
  sessionFactEvidenceRecords,
} from "@anthelia/session";
import type { PlanLifecycleState } from "@anthelia/runtime-services";
import { deriveGrowthCurriculum, type TaskOutcome } from "./growth";
import { createHash } from "node:crypto";
import { groupRunsByPrompt, scoreRun, segmentTurns } from "./run-scorer";
import { loadExternalTask, readExternalBenchmark } from "./eval-reader";
import { deriveCorrectionPatterns, readCorrections } from "./corrections";
import { deriveGrowthTriggers } from "./growth-trigger";
import { deriveGrowthPromotion } from "./growth-promotion";
import { isHardProtectedConstitutionRule } from "@anthelia/contracts";
import type { EpisodeID } from "@anthelia/contracts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendInstanceEvent,
  loadInstanceGovernance,
  resolveGovernanceRoot,
} from "@natalia/governance-ledger";
import {
  parsePlanTasks,
  projectPlanTaskStates,
  unattributedChangeNodes,
  verifyWorkGraphIntegrity,
} from "@natalia/work-ledger";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { requestAuditAfterCompletion } from "./audit-request";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import { injectFindingIntoMainAgent } from "@natalia/collab";
import {
  ensureSessionEventWindow,
  sessionWindowEvents,
} from "@anthelia/substrate";
import { redactToolOutput } from "./redaction";
import { runValidationCommand } from "./validation";
import { captureRepositoryEvidenceFields } from "@anthelia/substrate";
import type { SessionStoreController } from "@anthelia/session-store";
import type { WorkLedgerController } from "@natalia/work-ledger";

/**
 * The `ClientSurfaceOptions` the engineering-intelligence surface shares with
 * the other client surfaces. Declared here (instead of importing the
 * client-surface copy) so the runtime feature stays self-contained; the shape
 * is the subset of runtime client options consumed by this feature.
 */
type ClientSurfaceOptions = {
  episodeID?: EpisodeID;
  globalConfigPath?: string;
};

type Surface = Pick<
  RuntimeServiceClient,
  | "growthPropose"
  | "externalBenchmark"
  | "recordExternalRun"
  | "correctionPatterns"
  | "growthTriggers"
  | "promoteGrowthTrigger"
  | "growthPromotions"
  | "promoteGrowthTrigger"
  | "growthPromotions"
  | "externalJoinedTasks"
  | "promptRunGroups"
  | "growthProposals"
  | "constitutionRules"
  | "constitutionOverrides"
  | "decisionRecords"
  | "recordDecision"
  | "evidenceRecords"
  | "recordValidation"
  | "completions"
  | "recordCompletion"
  | "recordHumanValidation"
  | "driftFindings"
  | "evaluateDrift"
  | "acknowledgeDriftFinding"
  | "reopenDriftFinding"
  | "confirmedWorkspaceChanges"
  | "registeredTools"
  | "requestOverride"
  | "approveOverride"
  | "updateConstitutionRule"
  | "removeConstitutionRule"
  | "createConstitutionRule"
  | "constitutionDocRules"
  | "promoteConstitutionDocRule"
  | "updateConstitutionDocRule"
  | "planTaskStates"
  | "workGraphIntegrity"
  | "unattributedChanges"
  | "notices"
>;
async function projectedCanonicalToolsWithFallback(
  events: import("@anthelia/contracts").RuntimeEvent[],
) {
  try {
    const { projectedCanonicalToolsInWorker } = await import(
      "@anthelia/substrate"
    );
    const result = (await projectedCanonicalToolsInWorker(events)) as Array<{
      name: string;
      owner: string;
      scope: string;
      recovery: string;
      precedence: number;
      requiresApproval: boolean;
    }>;
    return result;
  } catch {
    return projectedCanonicalTools(events);
  }
}

async function runSessionProjectionWithFallback(
  name:
    | "planDocs"
    | "evidenceRecords"
    | "constitutionRules"
    | "decisionRecords"
    | "workGraphNodes"
    | "workGraphEdges"
    | "mailboxMessages"
    | "collabMessages"
    | "notices",
  events: import("@anthelia/contracts").RuntimeEvent[],
) {
  try {
    const { runSessionProjectionInWorker } = await import(
      "@anthelia/substrate"
    );
    return await runSessionProjectionInWorker(name, events);
  } catch {
    switch (name) {
      case "planDocs":
        return projectedPlanDocs(events);
      case "evidenceRecords":
        return projectedEvidenceRecords(events);
      case "constitutionRules":
        return projectedConstitutionRules(events);
      case "decisionRecords":
        return projectedDecisionRecords(events);
      case "workGraphNodes":
        return projectedWorkGraphNodes(events);
      case "workGraphEdges":
        return projectedWorkGraphEdges(events);
      case "mailboxMessages":
        return projectedMailboxMessages(events);
      case "collabMessages":
        return projectedCollabMessages(events);
      case "notices":
        return projectedRuntimeNotices(events);
    }
  }
}

/**
 * B6 read-surface helper: fold the session's hot fact state (O(1) over the
 * live window) instead of rescanning the full journal when it is complete;
 * fall back to the projected-events path for a tail-only attach. Returns the
 * fact-state slice and whether it was used.
 */
/**
 * EI Phase 1 "降档": when the bounded hot state evicted terminal facts, a read
 * that needs the complete set reconstructs it by paging the durable log (降档≠
 * 丢失). Falls back to the live events when no store can page.
 */
async function readCompleteFacts<T>(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  project: (events: import("@anthelia/contracts").RuntimeEvent[]) => T[],
): Promise<T[]> {
  const store = ctx.state.serviceDirectory.getOptional(sessionStoreController);
  if (!store) return project(exec.session.events);
  const events: import("@anthelia/contracts").RuntimeEvent[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.history(exec.session.id, exec.session.events, {
      offset,
      limit: 2_000,
    });
    for (const entry of page.events) events.push(entry.event);
    if (!page.hasMore || page.events.length === 0) break;
    offset += page.events.length;
  }
  return project(events);
}

function readFactSlice<T>(
  exec: { factStateComplete?: boolean; factState?: SessionFactState },
  select: (state: SessionFactState) => T[],
  fallback: () => T[],
): T[] {
  if (exec.factStateComplete === true && exec.factState)
    return select(exec.factState);
  return fallback();
}

/** Pagination for a read surface: cursor is an offset, limit bounded. */
/**
 * The governance list page shape (EI Phase 1, mailbox_status parity): the same
 * `{ items, returned, total, truncated, nextCursor }` envelope for decisions /
 * evidence / completions / drift, so every list surface paginates identically.
 * Called with no limit/cursor it returns the whole set as one page
 * (`truncated: false`), preserving the pre-pagination read for callers that
 * want everything.
 */
function paginate<T>(
  items: T[],
  limit?: number,
  cursor?: string,
): import("@anthelia/contracts").GovernancePage<T> {
  const total = items.length;
  const parsed = cursor ? Number(cursor) : 0;
  const offset =
    Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  const size = limit ?? total;
  const page = items.slice(offset, offset + Math.max(size, 1));
  const returned = page.length;
  const truncated = offset + returned < total;
  return {
    items: page,
    returned,
    total,
    truncated,
    ...(truncated ? { nextCursor: String(offset + returned) } : {}),
  };
}

/** The external decision view: the journal fact plus its data scope. */
function decisionView(
  record: ReturnType<typeof projectedDecisionRecords>[number],
  scope: "session" | "workspace",
) {
  return {
    id: record.id,
    scope,
    decision: record.decision,
    rationale: record.rationale ?? [],
    alternatives: record.alternatives ?? [],
    consequences: record.consequences ?? [],
    status: record.status,
    linkedPlans: record.linkedPlans ?? [],
    linkedConstraints: record.linkedConstraints ?? [],
  };
}

/**
 * True when the rule is release-scope runtime self-protection (EI §3.8 P-1.c):
 * it cannot be edited or removed by any UI action, only bypassed through the
 * explicit override path.
 */
/**
 * EI §3.8 P-1.c, per the user's decision (硬保护不能删，其余用户可删改): only the
 * rules backed by the tool-execution `SELF_PROTECTION_PATTERNS` are locked from
 * UI edits; release-scope runtime-policy rules (C-REL-*) and user rules are
 * editable/disableable/deletable. The shared set lives in @anthelia/contracts so
 * the runtime and the governance UI agree on exactly which rules are protected.
 */
function isHardProtectedRule(ruleID: string): boolean {
  return isHardProtectedConstitutionRule(ruleID);
}

export function createIntelligenceSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  function requireGovernanceLedger() {
    const ledger = ctx.state.serviceDirectory.getOptional(
      governanceLedgerController,
    );
    if (!ledger)
      throw new Error(
        "governance ledger unavailable (natalia-governance-ledger)",
      );
    return ledger;
  }
  function requireWorkLedger() {
    const ledger = ctx.state.serviceDirectory.get(workLedgerController);
    return ledger;
  }
  async function intelligenceExecWindow(sessionID?: string) {
    // `start()` only kicks composition off in the background. Intelligence
    // reads may be the first routed calls on a workspace proxy, so every
    // surface must wait for the session-store before ensureExecution runs.
    await ctx.ports.getReady();
    const exec = sessionID
      ? (ctx.ports
          .getExecutionBySession()
          .get(sessionID as import("@anthelia/contracts").SessionID) ??
        (await ctx.ports.ensureExecution(
          sessionID as import("@anthelia/contracts").SessionID,
        )))
      : ctx.ports.getActiveExec();
    return exec;
  }

  /**
   * Read surfaces must see the same history the writer saw. Fast attach keeps
   * only a tail; complete the fact state before reading so a finding opened
   * outside the current window is still returned after it is updated.
   */
  async function completeIntelligenceExec(sessionID?: string) {
    const exec = await intelligenceExecWindow(sessionID);
    if (exec?.session) await ensureCompleteSessionFactState(ctx, exec);
    return exec;
  }
  return {
    async confirmedWorkspaceChanges(sessionID?: string) {
      await ctx.ports.getReady();
      const exec = await intelligenceExecWindow(sessionID);
      const reconciled = exec
        ? await ctx.ports.reconcileWorkspaceObservation(exec)
        : [];
      // Merge best-effort workspace mutation log so newly recorded tool writes
      // are visible even when observation data has not been reconciled yet.
      try {
        const logPath = resolve(
          ctx.ports.getWorkspaceRoot(),
          ".natalia",
          "workspace-mutations.json",
        );
        const rows = JSON.parse(await readFile(logPath, "utf8")) as Array<{
          sessionID?: string;
          path: string;
          operation: "add" | "modify" | "delete" | "rename";
        }>;
        const seen = new Set(reconciled.map((change) => change.path));
        const merged = [...reconciled];
        for (const row of rows) {
          if (sessionID && row.sessionID !== sessionID) continue;
          if (seen.has(row.path)) continue;
          seen.add(row.path);
          merged.push({
            id: `mutation:${row.path}`,
            workspaceRoot: ctx.ports.getWorkspaceRoot(),
            path: row.path,
            operation:
              row.operation === "add"
                ? "added"
                : row.operation === "delete"
                  ? "deleted"
                  : row.operation === "rename"
                    ? "renamed"
                    : "modified",
            origin: "tool",
            attribution: row.sessionID ? "attributed" : "unattributed",
            correlation: row.sessionID ? { sessionID: row.sessionID } : {},
            health: "healthy",
            at: new Date().toISOString(),
          });
        }
        return merged;
      } catch {
        return reconciled;
      }
    },
    async constitutionRules(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      const instance = loadInstanceGovernance(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
      );
      const rules = (await runSessionProjectionWithFallback(
        "constitutionRules",
        [...instance.events, ...exec.session.events],
      )) as ReturnType<typeof projectedConstitutionRules>;
      return rules.map((r) => ({
        ruleID: r.ruleID,
        statement: r.statement,
        scope: r.scope,
        priority: r.priority,
        source: r.source,
        enforcement: r.enforcement,
        overridePolicy: r.overridePolicy,
        ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
        ...(r.proposedBy ? { proposedBy: r.proposedBy } : {}),
        ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}),
      }));
    },
    async constitutionOverrides(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      const instance = loadInstanceGovernance(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
      );
      // The same merge as constitutionRules — workspace-tier grants plus the
      // session's — deduplicated by event id: an instance grant is published
      // into the session once, so the naive concatenation would count it
      // twice (the rule fold dedups by ruleID, the override list does not).
      // Filtering to the grants first keeps the id key honest (the event
      // union does not promise every member carries one).
      const grants = [...instance.events, ...exec.session.events].filter(
        (
          event,
        ): event is Extract<
          RuntimeEvent,
          { type: "constitution.override_granted" }
        > => event.type === "constitution.override_granted",
      );
      const merged = new Map<
        string,
        Extract<RuntimeEvent, { type: "constitution.override_granted" }>
      >();
      for (const grant of grants)
        if (!merged.has(grant.id)) merged.set(grant.id, grant);
      return projectedConstitutionOverrides([...merged.values()]).map(
        (grant) => ({
          id: grant.id,
          ruleID: grant.ruleID,
          reason: grant.reason,
          approvedBy: grant.approvedBy,
          ...(grant.paths?.length ? { paths: grant.paths } : {}),
          ...(grant.taskID ? { taskID: grant.taskID } : {}),
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
        }),
      );
    },
    async decisionRecords(
      input?:
        | string
        | {
            sessionID?: string;
            scope?: "session" | "workspace" | "all";
            limit?: number;
            cursor?: string;
          },
    ) {
      const params = typeof input === "string" ? {} : (input ?? {});
      const sessionID = typeof input === "string" ? input : input?.sessionID;
      const scope =
        typeof input === "string" ? "session" : (input?.scope ?? "session");
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return paginate([], params.limit, params.cursor);
      // Session decisions are the default. Legacy facts without a scope are
      // session-scoped; workspace facts carry an explicit scope and must be
      // requested through scope workspace/all.
      const sessionDecisionRecords = exec.factStateTerminalEvicted
        ? await readCompleteFacts(ctx, exec, projectedDecisionRecords)
        : readFactSlice(exec, sessionFactDecisionRecords, () =>
            projectedDecisionRecords(exec.session.events),
          );
      const sessionRecords = sessionDecisionRecords
        .filter((record) => record.scope !== "workspace")
        .map((record) => decisionView(record, "session"));
      if (scope === "session")
        return paginate(sessionRecords, params.limit, params.cursor);
      const instance = loadInstanceGovernance(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
      );
      // Instance records are workspace-tier. A legacy instance event without an
      // explicit scope is workspace-scoped by construction.
      const workspaceRecords = projectedDecisionRecords(instance.events)
        .filter((record) => record.scope !== "session")
        .map((record) => decisionView(record, "workspace"));
      if (scope === "workspace")
        return paginate(workspaceRecords, params.limit, params.cursor);
      const seen = new Set<string>();
      const merged: ReturnType<typeof decisionView>[] = [];
      for (const record of [...workspaceRecords, ...sessionRecords]) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        merged.push(record);
      }
      return paginate(merged, params.limit, params.cursor);
    },
    /**
     * The `decision.recorded` production writer. Decisions are durable facts —
     * a decision text and rationale may reach the journal — so this is the
     * surface the Chat/override loop (CST3) records through. The event
     * constructor in `constitution-ledger.ts` keeps the secret-safe boundary:
     * decision text and rationale are prose, never tool output or file content.
     */
    async recordDecision(
      input: {
        decision: string;
        rationale?: string[];
        alternatives?: {
          option: string;
          rejectedReason?: string;
        }[];
        consequences?: string[];
        linkedPlans?: string[];
        linkedConstraints?: string[];
        scope?: "session" | "workspace";
      },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session) return { recorded: false as const };
      const { scope: requestedScope, ...decisionInput } = input;
      const scope = requestedScope === "workspace" ? "workspace" : "session";
      const event = requireGovernanceLedger().recordDecision({
        id: `decision:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
        ...decisionInput,
        ...(scope === "workspace" ? { scope } : {}),
      });
      // Workspace promotion is explicit opt-in; the default session decision
      // never reaches the shared instance file and therefore cannot leak into
      // another session's governance panel.
      if (scope === "workspace" && event.status === "accepted")
        appendInstanceEvent(
          resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
          "decisions.jsonl",
          event,
        );
      ctx.ports.publishForSession(exec, event);
      // CST4 Work Graph linkage: the decision is a `decision` node in the graph.
      ctx.ports.publishForSession(
        exec,
        requireWorkLedger().decisionNode({
          decisionID: event.id,
          decision: event.decision,
          sessionID: exec.session.id,
        }),
      );
      return { recorded: true as const };
    },
    async evidenceRecords(
      input?: { sessionID?: string; limit?: number; cursor?: string },
      sessionID?: string,
    ) {
      const resolvedSessionID = input?.sessionID ?? sessionID;
      const exec = await completeIntelligenceExec(resolvedSessionID);
      if (!exec?.session) return paginate([], input?.limit, input?.cursor);
      // P2 E3: the effective status of each evidence record is driven by the
      // workspace-level lifecycle of the plan whose task it belongs to (a
      // projection policy — the journal keeps the recorded status; the query
      // answers what it means now). Plan documents are workspace-level, so
      // evidence can resolve even when the plan was created in another session.
      const plans = ctx.ports.planDocRuntime.planDocSnapshot();
      const planStateForTask = new Map<string, string>();
      for (const plan of plans) {
        planStateForTask.set(plan.planID, plan.status);
      }
      // B6: the hot fact state is authoritative after the complete-history
      // check above; the projected-events path is the fallback for a
      // tail-only attach.
      const evidence = (
        exec.factStateTerminalEvicted
          ? await readCompleteFacts(ctx, exec, projectedEvidenceRecords)
          : readFactSlice(exec, sessionFactEvidenceRecords, () =>
              projectedEvidenceRecords(exec.session.events),
            )
      ) as ReturnType<typeof projectedEvidenceRecords>;
      return paginate(
        evidence.map((r) => ({
          taskID: r.taskID,
          objective: r.objective,
          status: r.status,
          effectiveStatus:
            r.taskID && planStateForTask.has(r.taskID)
              ? requireGovernanceLedger().evidenceStatusForPlanState(
                  planStateForTask.get(r.taskID)! as PlanLifecycleState,
                  r.status,
                )
              : r.status,
          changes: r.changes ?? [],
          validations: r.validations ?? [],
          knownGaps: r.knownGaps ?? [],
          ...(r.recordedAt ? { recordedAt: r.recordedAt } : {}),
          ...(r.environment ? { environment: r.environment } : {}),
          ...(r.repositoryVersion
            ? { repositoryVersion: r.repositoryVersion }
            : {}),
          ...(r.commit ? { commit: r.commit } : {}),
          ...(r.manifestRef ? { manifestRef: r.manifestRef } : {}),
        })),
        input?.limit,
        input?.cursor,
      );
    },
    /**
     * Discovery G-b — the internal-evaluation face: the SAME prompt's
     * success distribution, scored from the journal (a replay fold, no
     * fork required — the study's "同 prompt N 次重放的成败/成本分布").
     * The runs our fork/duplicate infrastructure already made turn up as
     * turns sharing a promptKey; the face reads them.
     *
     * Defensive reads only: a legacy event misses its optional fields and
     * the scorer reports what it can see (missing numbers stay undefined,
     * never zero-invented).
     */
    /**
     * Discovery G-c — the external baseline (the study's "读 devref/eval
     * 的任务格式；先内后外"). The face reads the frozen eval's directory
     * (the caller names it, or NATALIA_EVAL_DIR does) and answers the
     * baseline BESIDE the internal position — no per-task delta: our
     * journal's runs have no key joining them to the external tasks, so
     * the gap is answered as the two positions, with the join's absence
     * stated (the same honesty as G-a's dropped prompt-group link). The
     * per-task comparison unlocks when the external tasks actually run
     * through our harness — the study's "先内后外" sequencing.
     */
    async externalBenchmark(input?: { dir?: string }, sessionID?: string) {
      const dir = input?.dir ?? process.env.NATALIA_EVAL_DIR;
      if (!dir)
        return {
          joined: false,
          reason: "no_eval_dir",
          note: "name the frozen eval's directory (or set NATALIA_EVAL_DIR)",
        } as const;
      const benchmark = await readExternalBenchmark(dir);
      const cells = benchmark.tasks.reduce(
        (sum, task) => sum + task.expected,
        0,
      );
      const successes = benchmark.tasks.reduce(
        (sum, task) => sum + task.successful,
        0,
      );
      // The internal side: the same journal, aggregated across prompts
      // (G-b's groups) — one honest number beside the baseline.
      const groups = await this.promptRunGroups!(sessionID);
      const internalRuns = groups.reduce((sum, group) => sum + group.runs, 0);
      const internalSuccesses = groups.reduce(
        (sum, group) => sum + group.successes,
        0,
      );
      // The joins recorded for this benchmark (G-c's outer half): each
      // task's own runs beside its baseline — the explicit-key
      // comparison the study's adapter layer unlocks.
      const exec = await completeIntelligenceExec(sessionID);
      const joins = exec
        ? readFactSlice(exec, sessionFactExternalRuns, () =>
            projectedExternalRuns(exec.session.events),
          )
        : [];
      const byTask = new Map<string, { runs: number; successes: number }>();
      for (const join of joins) {
        if (join.benchmark !== benchmark.name) continue;
        const bucket = byTask.get(join.externalTaskID) ?? {
          runs: 0,
          successes: 0,
        };
        bucket.runs += 1;
        if (join.success) bucket.successes += 1;
        byTask.set(join.externalTaskID, bucket);
      }
      const perTask = benchmark.tasks
        .map((task) => {
          const runs = byTask.get(task.id);
          return runs
            ? {
                externalTaskID: task.id,
                baselineSuccessRate: task.successRate,
                ourRuns: runs.runs,
                ourSuccessRate:
                  Math.round((runs.successes / runs.runs) * 1000) / 1000,
              }
            : undefined;
        })
        .filter((entry) => entry !== undefined);
      return {
        joined: perTask.length > 0,
        benchmark,
        external: {
          tasks: benchmark.taskCount,
          harnesses: benchmark.harnessCount,
          configurations: benchmark.configurationCount,
          cells,
          successes,
          successRate: cells
            ? Math.round((successes / cells) * 1000) / 1000
            : 0,
        },
        internal: {
          promptGroups: groups.length,
          runs: internalRuns,
          successes: internalSuccesses,
          successRate: internalRuns
            ? Math.round((internalSuccesses / internalRuns) * 1000) / 1000
            : 0,
        },
        perTask,
        note:
          perTask.length > 0
            ? "the joins this harness recorded answer the per-task comparison"
            : "the two sides measure different task sets until the external tasks run through this harness; the join's absence is stated, not bridged",
      } as const;
    },
    /**
     * Discovery G-c's join (the adapter layer's record): one of OUR runs
     * against an external task. The turn's score is READ from the
     * journal (the G-b scorer over its window — no new telemetry), the
     * task's baseline rate rides the record, and the record is the
     * `external_run.recorded` fact whose explicit task id unlocks the
     * per-task comparison (the study's outer half).
     */
    async recordExternalRun(
      input: { dir?: string; taskID: string; turnID: string },
      sessionID?: string,
    ) {
      const dir = input.dir ?? process.env.NATALIA_EVAL_DIR;
      if (!dir) return { recorded: false as const, reason: "no_eval_dir" };
      const benchmark = await readExternalBenchmark(dir);
      const task = benchmark.tasks.find((entry) => entry.id === input.taskID);
      const detail = await loadExternalTask(dir, input.taskID);
      if (!task || !detail)
        return { recorded: false as const, reason: "unknown_task" as const };
      const exec = await completeIntelligenceExec(sessionID);
      // The turn's own score from the journal (the same fold G-b reads).
      let success: boolean | undefined;
      let stopReason: string | undefined;
      let durationMs: number | undefined;
      if (exec?.session) {
        const windows = segmentTurns(exec.session.events);
        const window = windows.find((entry) => entry.turnID === input.turnID);
        if (window) {
          const score = scoreRun(window);
          success = score.success;
          stopReason = score.stopReason;
          durationMs = score.durationMs;
        }
      }
      const at = new Date().toISOString();
      const event = {
        type: "external_run.recorded" as const,
        id: `xrun:${createHash("sha256")
          .update(`${input.taskID}:${input.turnID}`)
          .digest("hex")
          .slice(0, 16)}`,
        at,
        ...(exec?.session?.id ? { sessionID: exec.session.id } : {}),
        externalTaskID: input.taskID,
        benchmark: benchmark.name,
        turnID: input.turnID,
        ...(success === undefined ? {} : { success }),
        ...(stopReason ? { stopReason } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        baselineSuccessRate: task.successRate,
      };
      if (exec) ctx.ports.publishForSession(exec, event);
      return {
        recorded: true as const,
        externalTaskID: input.taskID,
        turnID: input.turnID,
        ...(success === undefined ? {} : { success }),
        baselineSuccessRate: task.successRate,
      };
    },
    /**
     * Discovery G-d — the repeated correction patterns: the human's
     * corrections across the journal's three safe sources (mailbox's
     * user messages, the completion validations, the rejected
     * alternatives), clustered, answered as固化 suggestions naming
     * their destination. A suggestion applies nothing (the study's
     * growth 默认不自授权); the destination's class (rule needs a human,
     * a skill may auto-apply) is the constitution's table, not this
     * face's.
     */
    /**
     * The growth branch's trigger face (the study's "G-d + 触发面"):
     * the four growth systems' views ASSEMBLED into one answer — which
     * growth signal deserves the human's attention now. The trigger
     * applies nothing (growth 默认不自授权): each trigger names its
     * rule, its evidence (the source's own numbers) and its
     * destination class, and the NGM proposal interface plus the
     * constitution's approval policy decide what becomes real.
     */
    async growthTriggers(sessionID?: string) {
      const [groups, joins, corrections, curriculum] = await Promise.all([
        this.promptRunGroups!(sessionID),
        this.externalJoinedTasks!(sessionID),
        this.correctionPatterns!(sessionID),
        this.growthPropose!(undefined, sessionID),
      ]);
      return deriveGrowthTriggers({
        runGroups: groups,
        joins,
        corrections: corrections.suggestions,
        curriculum: curriculum.suggestions,
      });
    },
    /**
     * The joined per-task view alone (the trigger's G-c input): the
     * joins this harness recorded against the external benchmark. Read
     * separately so the trigger's assembly does not re-read the eval.
     */
    async externalJoinedTasks(sessionID?: string) {
      const dir = process.env.NATALIA_EVAL_DIR;
      if (!dir) return [];
      const answer = await this.externalBenchmark!({ dir }, sessionID);
      if ("reason" in answer) return [];
      return answer.perTask;
    },
    /**
     * Block ②'s writer: promote ONE growth trigger to a proposal. The
     * trigger is selected by its capability (exact), the promotion is
     * derived through the constitution's class policy, and the
     * `growth.promoted` fact records where it lands and what approval
     * it needs. **This face applies nothing** — the composition's
     * apply_generation keeps its own approval floor; the promotion's
     * `next` names who acts.
     */
    async promoteGrowthTrigger(
      input: { capability: string },
      sessionID?: string,
    ) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session)
        return { promoted: false as const, reason: "no_session" };
      const triggers = await this.growthTriggers!(sessionID);
      const trigger = triggers.find(
        (entry) => entry.capability === input.capability,
      );
      if (!trigger)
        return { promoted: false as const, reason: "unknown_trigger" };
      const promotion = deriveGrowthPromotion(trigger);
      const at = new Date().toISOString();
      const id = `promo:${createHash("sha256")
        .update(`${trigger.rule}:${trigger.capability}`)
        .digest("hex")
        .slice(0, 16)}`;
      // Idempotence is the WRITER's job (the journal's events table is
      // seq-keyed with no id dedup — the same lesson as the growth
      // proposal's writer): a repeat promotion of the same trigger
      // appends nothing and answers the recorded fact.
      const already = readFactSlice(exec, sessionFactGrowthPromotions, () =>
        projectedGrowthPromotions(exec.session.events),
      ).some((entry) => entry.id === id);
      if (already)
        return {
          promoted: true as const,
          destination: promotion.destination,
          approval: promotion.approval,
          appliedBy: promotion.appliedBy,
          next: promotion.next,
          reason: promotion.reason,
        };
      const event = {
        type: "growth.promoted" as const,
        id,
        at,
        ...(exec.session.id ? { sessionID: exec.session.id } : {}),
        trigger: promotion.trigger,
        destination: promotion.destination,
        approval: promotion.approval,
        appliedBy: promotion.appliedBy,
        next: promotion.next,
        reason: promotion.reason,
      };
      ctx.ports.publishForSession(exec, event);
      return {
        promoted: true as const,
        destination: promotion.destination,
        approval: promotion.approval,
        appliedBy: promotion.appliedBy,
        next: promotion.next,
        reason: promotion.reason,
      };
    },
    /**
     * Block ②'s reader: the journaled promotions (the audit trail), each
     * naming its destination, its approval and its next step. A read —
     * the promotion's application stays the destination face's.
     */
    async growthPromotions(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      return readFactSlice(exec, sessionFactGrowthPromotions, () =>
        projectedGrowthPromotions(exec.session.events),
      ).map((event) => ({
        promotionID: event.id,
        at: event.at,
        trigger: event.trigger,
        destination: event.destination,
        approval: event.approval,
        appliedBy: event.appliedBy,
        next: event.next,
        reason: event.reason,
      }));
    },
    async correctionPatterns(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session)
        return { suggestions: [], considered: { corrections: 0 } };
      return deriveCorrectionPatterns(readCorrections(exec.session.events));
    },
    async promptRunGroups(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      const windows = segmentTurns(exec.session.events);
      const scores = windows.map((window) =>
        scoreRun(window, {
          ...(exec.session.id ? { sessionID: exec.session.id } : {}),
        }),
      );
      return groupRunsByPrompt(scores);
    },
    /**
     * Discovery G-a's growth face (the reader): the journaled proposals,
     * newest first. A read — the derivation and its journaling are
     * `growthPropose`'s, not a read's.
     */
    async growthProposals(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      return readFactSlice(exec, sessionFactGrowthProposals, () =>
        projectedGrowthProposals(exec.session.events),
      ).map((event) => ({
        proposalID: event.id,
        at: event.at,
        suggestions: event.suggestions,
        considered: event.considered,
        ...(event.sessionID ? { sessionID: event.sessionID } : {}),
      }));
    },
    /**
     * Discovery G-a's growth face (the writer): derive the curriculum
     * from the journal — the completions' known gaps and the plan's
     * unbacked tasks — record the proposal as the `growth.proposed`
     * fact, and answer it. The proposal's id is its content's hash, so
     * a repeat derivation appends nothing (the journal dedups by id).
     *
     * Growth 默认不自授权 (the study's approval policy): this records a
     * proposal and applies nothing; the NGM proposal interface and the
     * constitution's class policy decide what may become real.
     */
    async growthPropose(input?: { planID?: string }, sessionID?: string) {
      const resolvedSessionID = sessionID;
      const exec = await completeIntelligenceExec(resolvedSessionID);
      const emptyAt = new Date().toISOString();
      if (!exec?.session)
        // No session to read: an empty curriculum, answered in the
        // contract's shape, journaling nothing (an empty derivation is
        // not a fact worth the journal's space).
        return {
          proposalID: "growth:none",
          at: emptyAt,
          suggestions: [],
          considered: { tasks: 0, gaps: 0 },
        };
      const completions = readFactSlice(exec, sessionFactCompletions, () =>
        projectedCompletions(exec.session.events),
      );
      const taskStates = await this.planTaskStates!(input, sessionID);
      const tasks: TaskOutcome[] = [
        ...completions.map((record) => ({
          text: record.objective,
          ...(record.knownGaps?.length ? { gaps: record.knownGaps } : {}),
        })),
        ...taskStates
          .filter((task) => task.state === "gap")
          .map((task) => ({ text: task.text, unbacked: true })),
      ];
      const curriculum = deriveGrowthCurriculum({ tasks });
      if (curriculum.suggestions.length === 0)
        // Nothing to propose: no write, and the answer names the empty
        // derivation (an empty proposal in the journal is a fact with
        // nothing to say).
        return {
          proposalID: "growth:none",
          at: new Date().toISOString(),
          suggestions: [],
          considered: curriculum.considered,
        };
      const digest = createHash("sha256")
        .update(JSON.stringify(curriculum.suggestions))
        .digest("hex")
        .slice(0, 16);
      const id = `growth:${digest}`;
      // Idempotence is the WRITER's job: the journal's events table is
      // seq-keyed with no id dedup, so a repeat derivation would append
      // the same fact twice. The last proposal's id is the guard — an
      // unchanged curriculum appends nothing and answers the recorded
      // fact's id and time.
      const previous = readFactSlice(exec, sessionFactGrowthProposals, () =>
        projectedGrowthProposals(exec.session.events),
      )[0];
      if (previous?.id === id)
        return { ...curriculum, proposalID: previous.id, at: previous.at };
      const at = new Date().toISOString();
      ctx.ports.publishForSession(exec, {
        type: "growth.proposed",
        id,
        at,
        ...(exec.session.id ? { sessionID: exec.session.id } : {}),
        suggestions: curriculum.suggestions,
        considered: curriculum.considered,
      });
      return { ...curriculum, proposalID: id, at };
    },
    async completions(
      input?: { sessionID?: string; limit?: number; cursor?: string },
      sessionID?: string,
    ) {
      const resolvedSessionID = input?.sessionID ?? sessionID;
      const exec = await completeIntelligenceExec(resolvedSessionID);
      if (!exec?.session) return paginate([], input?.limit, input?.cursor);
      const completions = exec.factStateTerminalEvicted
        ? await readCompleteFacts(ctx, exec, projectedCompletions)
        : readFactSlice(exec, sessionFactCompletions, () =>
            projectedCompletions(exec.session.events),
          );
      // EI Phase 0: a user-recorded human validation on the card overrides the
      // model's own (the user has the last word on acceptance).
      const humanValidation =
        exec.factStateComplete === true && exec.factState
          ? sessionFactHumanValidation(exec.factState)
          : new Map<string, string>();
      return paginate(
        completions.map((c) => {
          const validated = humanValidation.get(c.taskID) ?? c.humanValidation;
          return {
            completionID: c.id,
            taskID: c.taskID,
            objective: c.objective,
            changeSummary: c.changeSummary,
            ...(c.behaviorImpact ? { behaviorImpact: c.behaviorImpact } : {}),
            validations: c.validations,
            ...(validated ? { humanValidation: validated } : {}),
            knownGaps: c.knownGaps ?? [],
            externalSideEffects: c.externalSideEffects ?? [],
            ...(c.rollbackState ? { rollbackState: c.rollbackState } : {}),
            evidenceIDs: c.evidenceIDs ?? [],
            recordedAt: c.recordedAt,
          };
        }),
        input?.limit,
        input?.cursor,
      );
    },
    /**
     * EI Phase 0: the user records a human validation note on a completion card
     * ("用户走 UI 补 humanValidation"). Durable; `completions` merges the latest
     * note per task onto the card.
     */
    async recordHumanValidation(
      input: { taskID: string; validation: string },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session)
        return { recorded: false as const, reason: "no session" };
      const taskID = input.taskID?.trim();
      const validation = input.validation?.trim();
      if (!taskID || !validation)
        return {
          recorded: false as const,
          reason: "recordHumanValidation requires taskID and validation",
        };
      const governanceLedger = requireGovernanceLedger();
      if (!governanceLedger)
        return {
          recorded: false as const,
          reason: "governance ledger unavailable",
        };
      ctx.ports.publishForSession(
        exec,
        governanceLedger.buildHumanValidation({
          id: `human_validation:${taskID}:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
          taskID,
          validation: redactToolOutput(validation, true),
          recordedAt: new Date().toISOString(),
        }),
      );
      return { recorded: true as const };
    },
    /**
     * The plan task state machine (EI §4 Phase 4): reads the plan document's
     * markdown checkboxes (the declaration source) and projects each against
     * the session's recorded evidence (the fact source), evidence-first. A
     * checked box with no backing evidence is a `gap`, never `verified`; a
     * skipped box stays visible. The planID defaults to the active plan.
     */
    async planTaskStates(input?: { planID?: string }, sessionID?: string) {
      const resolvedSessionID = input?.planID ? sessionID : sessionID;
      const exec = await completeIntelligenceExec(resolvedSessionID);
      if (!exec?.session) return [];
      const planID =
        input?.planID?.trim() ||
        (await ctx.ports.planDocRuntime.planDocActive(exec.session.id as never))
          ?.planID;
      if (!planID) return [];
      let content: string;
      try {
        const doc = await ctx.ports.planDocRuntime.planDocRead({
          planID,
          sessionID: exec.session.id as never,
        });
        content = doc.content;
      } catch {
        return [];
      }
      const evidence = [
        ...readFactSlice(exec, sessionFactEvidenceRecords, () =>
          projectedEvidenceRecords(exec.session.events),
        ).map((record) => ({
          taskID: record.taskID,
          objective: record.objective,
        })),
        ...readFactSlice(exec, sessionFactCompletions, () =>
          projectedCompletions(exec.session.events),
        ).map((record) => ({
          taskID: record.taskID,
          objective: record.objective,
        })),
      ];
      return projectPlanTaskStates(parsePlanTasks(content), evidence);
    },
    /**
     * Work Graph integrity (EI WG4 / Phase 3 D): rebuilds the graph from the
     * session's complete event history and verifies the causal chain is not
     * faked — no dangling edges, no silently-attributed (session-less) nodes,
     * no duplicate ids. A headless consumer can assert `stable` before trusting
     * the graph.
     */
    async workGraphIntegrity(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session)
        return {
          nodeCount: 0,
          edgeCount: 0,
          danglingEdges: [],
          incompleteNodes: [],
          duplicateNodeIDs: [],
          stable: true,
        };
      return verifyWorkGraphIntegrity(exec.session.events);
    },
    /**
     * The unattributed workspace changes (EI WG4 / Phase 3 D): the
     * `workspace_change` nodes an external reconcile produced with no reliable
     * turn identity. These are the changes the runtime could not attribute to a
     * tool call — surfaced for diagnosis, never silently folded into the
     * causal chain (EI §2 principle 5).
     */
    async unattributedChanges(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      return unattributedChangeNodes(exec.session.events).map((node) => ({
        nodeID: node.nodeID,
        path: node.target ?? "",
        sessionID: node.sessionID,
      }));
    },
    /**
     * The `evidence.recorded` production writer (E2 起步): runs a validation
     * command against the workspace, redacts secrets and truncates the summary,
     * then records the outcome as a durable evidence fact. This is the
     * validation-runner adapter — the command runs with the workspace as cwd,
     * bounded output and a timeout, and only the command, outcome, bounded safe
     * summary and duration reach the journal. Raw output never does.
     */
    async recordValidation(
      input: {
        taskID: string;
        objective: string;
        command: string;
        timeoutSec?: number;
        knownGaps?: string[];
      },
      sessionID?: string,
    ) {
      const owner = await intelligenceExecWindow(sessionID);
      if (!owner) return { recorded: false as const };
      if (
        typeof input.taskID !== "string" ||
        input.taskID.trim().length === 0 ||
        typeof input.objective !== "string" ||
        input.objective.trim().length === 0 ||
        typeof input.command !== "string" ||
        input.command.trim().length === 0
      )
        return { recorded: false as const };
      const startedAt = performance.now();
      let result: "passed" | "failed" | "skipped" = "failed";
      let safeSummary = "validation command did not run";
      try {
        const run = await runValidationCommand(
          input.command,
          ctx.ports.getWorkspaceRoot(),
          input.timeoutSec ?? 120,
        );
        result = run.exitCode === 0 ? "passed" : "failed";
        safeSummary = run.safeSummary;
      } catch (error) {
        safeSummary = `validation runner failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const outcome = requireGovernanceLedger().boundValidationOutcome({
        command: redactToolOutput(input.command, true),
        result,
        safeSummary,
        durationMs: performance.now() - startedAt,
      });
      // EI E2: a runtime-recorded validation is evidence like any other — stamp
      // the same repository refs as the record_validation tool so "which tree
      // validated this" is answerable from the record alone.
      const repoRefs = await captureRepositoryEvidenceFields(
        ctx.ports.getWorkspaceRoot(),
      );
      const event = requireGovernanceLedger().buildEvidenceRecorded({
        id: `evidence:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`,
        taskID: input.taskID,
        objective: input.objective,
        status: result === "passed" ? "validated" : "failed",
        validations: [outcome],
        knownGaps: input.knownGaps,
        ...repoRefs,
      });
      ctx.ports.publishForSession(owner, event);
      return {
        recorded: true as const,
        result,
        safeSummary: outcome.safeSummary,
      };
    },
    /**
     * Record a completion card (P2 E4): the fixed report structure (§5) that
     * answers "is it really done, what evidence is missing". The card is safe
     * prose — changeSummary is a summary, never a diff or file content — and a
     * `validated_by` Work Graph edge connects each completed change to the card.
     */
    async recordCompletion(
      input: {
        taskID: string;
        objective: string;
        changeSummary: string;
        behaviorImpact?: string;
        validations?: Array<{
          command: string;
          result: "passed" | "failed" | "skipped";
          safeSummary: string;
        }>;
        humanValidation?: string;
        knownGaps?: string[];
        externalSideEffects?: string[];
        rollbackState?: "clean" | "available" | "none" | "needs_promotion";
        evidenceIDs?: string[];
        changePaths?: string[];
      },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session) return { recorded: false as const };
      if (
        !input.taskID.trim() ||
        !input.objective.trim() ||
        !input.changeSummary.trim()
      )
        return { recorded: false as const };
      const recordedAt = new Date().toISOString();
      const completionID = `completion:${Date.now().toString(36)}:${ctx.ports.nextCompletionSequence()}`;
      const event = requireGovernanceLedger().buildCompletionRecorded({
        id: completionID,
        taskID: input.taskID,
        objective: input.objective,
        changeSummary: redactToolOutput(input.changeSummary, true),
        ...(input.behaviorImpact
          ? { behaviorImpact: redactToolOutput(input.behaviorImpact, true) }
          : {}),
        validations: (input.validations ?? []).map((validation) =>
          requireGovernanceLedger().boundValidationOutcome({
            command: redactToolOutput(validation.command, true),
            result: validation.result,
            safeSummary: validation.safeSummary,
          }),
        ),
        ...(input.humanValidation
          ? { humanValidation: redactToolOutput(input.humanValidation, true) }
          : {}),
        knownGaps: input.knownGaps,
        externalSideEffects: input.externalSideEffects,
        rollbackState: input.rollbackState,
        evidenceIDs: input.evidenceIDs,
        recordedAt,
      });
      ctx.ports.publishForSession(exec, event);
      // EI §3.9: completion.recorded is one of the two explicit audit triggers
      // (the other is awaiting_audit/auditing).
      await requestAuditAfterCompletion(ctx, exec, event);
      // P2 E4 Work Graph integration: each completed change is validated by the
      // card through a `validated_by` edge.
      for (const path of input.changePaths ?? [])
        ctx.ports.publishForSession(
          exec,
          requireWorkLedger().completionValidationEdge({
            changeID: event.taskID,
            path,
            completionID,
          }),
        );
      return { recorded: true as const, completionID };
    },
    async driftFindings(
      input?: { sessionID?: string; limit?: number; cursor?: string },
      sessionID?: string,
    ) {
      const resolvedSessionID = input?.sessionID ?? sessionID;
      const exec = await completeIntelligenceExec(resolvedSessionID);
      if (!exec?.session) return paginate([], input?.limit, input?.cursor);
      const findings = exec.factStateTerminalEvicted
        ? await readCompleteFacts(ctx, exec, projectedDriftFindings)
        : readFactSlice(exec, sessionFactDriftFindings, () =>
            projectedDriftFindings(exec.session.events),
          );
      return paginate(
        findings.map((f) => ({
          findingID: f.findingID,
          severity: f.severity,
          confidence: f.confidence,
          originalObjective: f.originalObjective,
          currentActivity: f.currentActivity,
          evidence: f.evidence,
          applicableConstraints: f.applicableConstraints,
          status: f.status,
          reopenedCount: f.reopenedCount,
          contractVersion: f.contractVersion,
          ruleHits: f.ruleHits,
          ...(f.planID ? { planID: f.planID } : {}),
          ...(f.rationale ? { rationale: f.rationale } : {}),
        })),
        input?.limit,
        input?.cursor,
      );
    },
    /**
     * Run the DriftEvaluator against safe signals and publish any findings it
     * opens. The evaluator is the only production writer of
     * `drift.finding_opened` (§56.9); it has no write power — a finding only
     * escalates to an approval/Chat/mailbox prompt, never a cancellation.
     * Already-open findings are not reopened.
     */
    async evaluateDrift(
      input: {
        objective: string;
        currentActivity: string;
        applicableConstraints?: string[];
        changes?: Array<{
          path?: string;
          action?: string;
          target?: string;
          summary?: string;
        }>;
        evidenceRefs?: string[];
        /** EI Phase 2 机制 2: recent action kinds for the no-progress window. */
        recentActions?: Array<{
          kind: import("@natalia/work-ledger").DriftActionKind;
        }>;
        /** EI Phase 2 机制 2: recent failed tool calls for the failure-loop rule. */
        recentFailures?: Array<{ toolName: string; key: string }>;
      },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session) return { opened: 0 as const };
      if (!input.objective.trim() || !input.currentActivity.trim())
        return { opened: 0 as const };
      // EI §8.6: the R is the accepted WorkContract. The evaluator judges
      // against it when one exists; without it (no contract or a stale
      // draft) it produces at most the advisory unverifiable finding.
      const contract = projectedWorkContracts(exec.session.events).find(
        (candidate) => candidate.status === "current",
      );
      const findings = requireWorkLedger().evaluateDrift({
        sessionID: exec.session.id,
        turnID: exec.activeTurnID,
        objective: input.objective,
        currentActivity: input.currentActivity,
        applicableConstraints: input.applicableConstraints ?? [],
        changes: input.changes ?? [],
        evidenceRefs: input.evidenceRefs ?? [],
        ...(input.recentActions ? { recentActions: input.recentActions } : {}),
        ...(input.recentFailures
          ? { recentFailures: input.recentFailures }
          : {}),
        ...(contract
          ? {
              contract: {
                planID: contract.planID,
                ...(contract.scope ? { scope: contract.scope } : {}),
                ...(contract.verification
                  ? { verification: contract.verification }
                  : {}),
                ...(contract.constraints
                  ? { constraints: contract.constraints }
                  : {}),
              },
            }
          : {}),
      });
      for (const finding of findings) {
        ctx.ports.publishForSession(exec, finding);
        // EI §3.5 / Phase 2 B3: a warning/high finding is auto-injected into
        // the Main Agent's next step; advisory findings are not.
        injectFindingIntoMainAgent(ctx, exec, finding);
      }
      return { opened: findings.length };
    },
    /**
     * Acknowledge a drift finding (P7 D3 / EI §8.6): the Main Agent explains
     * it, disputes it, or declares a sanctioned detour; the user dismisses it
     * or the work corrects it. Only an open finding can transition.
     */
    async acknowledgeDriftFinding(
      input: {
        findingID: string;
        status:
          | "explained"
          | "disputed"
          | "dismissed"
          | "corrected"
          | "detour_declared";
        rationale?: string;
      },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session) return { acknowledged: false as const };
      if (!input.findingID.trim()) return { acknowledged: false as const };
      // A finding may have been opened long before the current window, so use
      // the hot state when it is complete; a fast-attach tail completes it from
      // paged history before we look.
      await ensureCompleteSessionFactState(ctx, exec);
      const findings =
        exec.factStateComplete === true && exec.factState
          ? sessionFactDriftFindings(exec.factState)
          : projectedDriftFindings(exec.session.events);
      const finding = findings.find(
        (candidate) =>
          candidate.findingID === input.findingID &&
          candidate.status === "open",
      );
      if (!finding) return { acknowledged: false as const };
      ctx.ports.publishForSession(
        exec,
        requireWorkLedger().buildDriftFindingUpdate({
          id: `drift:${Date.now().toString(36)}:${input.findingID}`,
          findingID: input.findingID,
          status: input.status,
          rationale: input.rationale,
        }),
      );
      return { acknowledged: true as const };
    },
    /**
     * Reopen a terminal drift finding (翻案, EI §3.5) — a user-only action that
     * lifts a dismissed/explained finding back to open so it is reviewed again.
     * The findingID is unchanged (it is the same suspicion, re-examined); the
     * reopen is a new `drift.finding_updated(status:"open")` and the projection
     * counts it as `reopenedCount`. A corrected finding is not reopenable — its
     * premise (the contract revision) is gone. The Main Agent cannot reopen:
     * self-correction goes through a fresh finding or the chat flow.
     */
    async reopenDriftFinding(input: { findingID: string }, sessionID?: string) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session || !input.findingID.trim())
        return { reopened: false as const, reason: "no finding" };
      await ensureCompleteSessionFactState(ctx, exec);
      const findings =
        exec.factStateComplete === true && exec.factState
          ? sessionFactDriftFindings(exec.factState)
          : projectedDriftFindings(exec.session.events);
      const finding = findings.find(
        (candidate) => candidate.findingID === input.findingID,
      );
      if (!finding)
        return { reopened: false as const, reason: "unknown finding" };
      if (finding.status !== "dismissed" && finding.status !== "explained")
        return {
          reopened: false as const,
          reason: `only a dismissed or explained finding can be reopened (this one is ${finding.status})`,
        };
      ctx.ports.publishForSession(
        exec,
        requireWorkLedger().buildDriftFindingUpdate({
          id: `drift:reopen:${Date.now().toString(36)}:${input.findingID}`,
          findingID: input.findingID,
          status: "open",
        }),
      );
      // EI §3.5 / Phase 2 B2: a reopened warning/high finding is re-injected
      // into the main agent's next step so it is re-reviewed — with a note not
      // to repeat the rationale it gave last time (reopenedCount + 1 is this
      // review's ordinal). advisory findings are not re-injected.
      const reopenedCount = finding.reopenedCount + 1;
      injectFindingIntoMainAgent(ctx, exec, finding, {
        reviewNote:
          `This is reopen #${reopenedCount}; do not repeat the rationale you ` +
          `gave last time.`,
        idSuffix: `reopen_${reopenedCount}`,
      });
      return { reopened: true as const, reopenedCount };
    },
    async requestOverride(
      input: {
        ruleID: string;
        reason: string;
        paths?: string[];
        taskID?: string;
        expiresAt?: string;
      },
      sessionID?: string,
    ) {
      await ctx.ports.getReady();
      const exec = await intelligenceExecWindow(sessionID);
      const session = exec?.session;
      if (!session || !input.ruleID.trim() || !input.reason.trim())
        return {
          requested: false as const,
          reason: "invalid override request",
        };
      // A rule may predate the current window, so use the hot state when it is
      // complete; a fast-attach tail completes it from paged history first.
      await ensureCompleteSessionFactState(ctx, exec);
      const rules =
        exec.factStateComplete === true && exec.factState
          ? sessionFactConstitutionRules(exec.factState)
          : projectedConstitutionRules(exec.session.events);
      const rule = rules.find((candidate) => candidate.ruleID === input.ruleID);
      if (!rule) return { requested: false as const, reason: "unknown rule" };
      if (rule.overridePolicy === "forbidden")
        return { requested: false as const, reason: "override forbidden" };
      const requestID = `override:${input.ruleID}:${ctx.ports.nextDecisionSequence()}`;
      const response = await ctx.ports.getInteractive().requirePlanAcceptance({
        approvalID: requestID,
        planID: input.ruleID,
        title: `Override ${input.ruleID}`,
        preview: `Allow ${input.ruleID} (${input.reason})`,
        detail: input.reason,
        scope: "constitution_override",
      });
      if (!response || response.decision === "reject")
        return { requested: false as const, requestID, reason: "rejected" };
      const granted = {
        type: "constitution.override_granted" as const,
        id: requestID,
        ruleID: input.ruleID,
        reason: input.reason,
        approvedBy: "user" as const,
        ...(input.paths?.length ? { paths: input.paths } : {}),
        ...(input.taskID ? { taskID: input.taskID } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      appendInstanceEvent(
        resolveGovernanceRoot(ctx.ports.getWorkspaceRoot()),
        "decisions.jsonl",
        granted,
      );
      ctx.ports.publishForSession(exec, granted);
      return { requested: true as const, requestID };
    },
    async approveOverride(input: {
      requestID: string;
      decision: "once" | "reject";
    }) {
      const outcome = ctx.ports.getInteractive().respondApproval({
        requestID: input.requestID,
        decision: input.decision,
      });
      return { approved: outcome.accepted && input.decision === "once" };
    },
    /**
     * Update a constitution rule (EI §3.8 P-1.c, user-owned): disable or
     * re-enable a hard rule. `enabled:false` is a reversible update; the
     * durable tombstone is removeConstitutionRule.
     */
    async updateConstitutionRule(
      input: {
        ruleID: string;
        enabled?: boolean;
        statement?: string;
        enforcement?: "deny" | "approval" | "warn";
        priority?: "critical" | "high" | "medium" | "low";
        appliesTo?: {
          tools?: string[];
          paths?: string[];
          commandPattern?: string;
        };
      },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session || !input.ruleID.trim())
        return { updated: false as const };
      // Hard-coded runtime self-protection (C-TERM-*): the guarantee survives
      // a journal edit, so the panel must not pretend it can be changed. Every
      // other rule (C-REL-*, user rules) is user-editable (EI §3.8 P-1.c).
      if (isHardProtectedRule(input.ruleID)) return { updated: false as const };
      const governanceLedger = requireGovernanceLedger();
      if (!governanceLedger) return { updated: false as const };
      // A deny/approval rule must keep a non-empty structured anchor so the
      // runtime matcher has something to execute against (EI §3.8 P-1.c).
      const enforcement = input.enforcement;
      const anchor = input.appliesTo;
      if (
        (enforcement === "deny" || enforcement === "approval") &&
        !(
          anchor &&
          (anchor.tools?.length ||
            anchor.paths?.length ||
            anchor.commandPattern)
        )
      )
        return {
          updated: false as const,
          reason: `${enforcement} requires a non-empty appliesTo anchor`,
        };
      ctx.ports.publishForSession(
        exec,
        governanceLedger.buildConstitutionRuleUpdate({
          id: `constitution:update:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
          ruleID: input.ruleID,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.statement ? { statement: input.statement } : {}),
          ...(enforcement ? { enforcement } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(anchor ? { appliesTo: anchor } : {}),
        }),
      );
      return { updated: true as const };
    },
    /**
     * Remove a constitution rule (EI §3.8 P-1.c, user-owned): an append-only
     * tombstone — the journal keeps the rule's full history, the effective
     * set drops it. The caller confirms before this is invoked.
     */
    async removeConstitutionRule(
      input: { ruleID: string },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session || !input.ruleID.trim())
        return { removed: false as const };
      // Hard-coded runtime self-protection (C-TERM-*): the guarantee cannot
      // be removed by deleting the journal row, so deletion is refused. Every
      // other rule (C-REL-*, user rules) is user-removable.
      if (isHardProtectedRule(input.ruleID)) return { removed: false as const };
      const governanceLedger = requireGovernanceLedger();
      if (!governanceLedger) return { removed: false as const };
      ctx.ports.publishForSession(
        exec,
        governanceLedger.buildConstitutionRuleRemoved({
          id: `constitution:removed:${Date.now().toString(36)}:${ctx.ports.nextDecisionSequence()}`,
          ruleID: input.ruleID,
          removedAt: new Date().toISOString(),
        }),
      );
      return { removed: true as const };
    },
    /**
     * Add a user-owned constitution rule (EI §3.8 P-1.c): the user creates a
     * rule directly from the Constitution tab (no model proposal, no gate).
     * Provenance is `source: "user"`. Release scope is rejected — the runtime's
     * self-protection rules are not the user's to add. A deny/approval rule
     * requires a non-empty appliesTo anchor so the matcher can execute it.
     */
    async createConstitutionRule(
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
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session || !input.statement?.trim())
        return {
          created: false as const,
          reason: "a rule requires a statement",
        };
      const anchor = input.appliesTo;
      if (
        (input.enforcement === "deny" || input.enforcement === "approval") &&
        !(
          anchor &&
          (anchor.tools?.length ||
            anchor.paths?.length ||
            anchor.commandPattern)
        )
      )
        return {
          created: false as const,
          reason: `${input.enforcement} requires a non-empty appliesTo anchor`,
        };
      const governanceLedger = requireGovernanceLedger();
      if (!governanceLedger)
        return {
          created: false as const,
          reason: "governance ledger unavailable",
        };
      const ruleID = `P-USER-${Date.now().toString(36).toUpperCase()}`;
      ctx.ports.publishForSession(
        exec,
        governanceLedger.buildUserConstitutionRule({
          id: `constitution:created:${ruleID}:${ctx.ports.nextDecisionSequence()}`,
          ruleID,
          statement: input.statement,
          enforcement: input.enforcement,
          ...(input.scope ? { scope: input.scope } : {}),
          ...(anchor ? { appliesTo: anchor } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
        }),
      );
      return { created: true as const, ruleID };
    },
    /**
     * The constitution/AGENTS document rules (EI §3.8 P-1.c): the sections
     * parsed from the workspace documents, each tagged with its enforcement
     * (prose → warn, `<!-- enforcement -->` → hard with appliesTo). These are
     * the soft rules the governance panel can promote into journal rules.
     */
    async constitutionDocRules(
      _sessionID?: string,
    ): Promise<ConstitutionDocRule[]> {
      await ctx.ports.getReady();
      const snapshot = await loadProjectDocuments(ctx.ports.getWorkspaceRoot());
      return snapshot.documents.flatMap((document) => document.rules);
    },
    /**
     * Promote a parsed document rule into the executable journal (EI §3.8
     * P-1.c): a user lifts a soft section into a hard `constitution.rule_added`
     * (source "user", no gate). A deny/approval rule must already carry a
     * non-empty appliesTo anchor — the same hard-rule invariant the proposal
     * path enforces; a promote without one is refused so the model cannot be
     * handed an unenforceable hard rule.
     */
    async promoteConstitutionDocRule(
      input: { id: string },
      sessionID?: string,
    ) {
      const exec = await intelligenceExecWindow(sessionID);
      if (!exec?.session || !input.id.trim())
        return { promoted: false as const, reason: "no rule id" };
      await ctx.ports.getReady();
      const snapshot = await loadProjectDocuments(ctx.ports.getWorkspaceRoot());
      const rule = snapshot.documents
        .flatMap((document) => document.rules)
        .find((candidate) => candidate.id === input.id);
      if (!rule)
        return { promoted: false as const, reason: "unknown document rule id" };
      const anchored = Boolean(
        rule.appliesTo &&
          (rule.appliesTo.tools?.length ||
            rule.appliesTo.paths?.length ||
            rule.appliesTo.commandPattern),
      );
      if (rule.enforcement !== "warn" && !anchored)
        return {
          promoted: false as const,
          reason:
            "a deny/approval rule requires a non-empty appliesTo anchor; annotate the section first",
        };
      const governanceLedger = requireGovernanceLedger();
      if (!governanceLedger)
        return {
          promoted: false as const,
          reason: "governance ledger unavailable",
        };
      const ruleID = `P-DOC-${rule.id.replace(/[^a-zA-Z0-9]+/gu, "-")}`;
      ctx.ports.publishForSession(
        exec,
        governanceLedger.buildPromotedConstitutionRule({
          id: `constitution:promoted:${rule.id}:${ctx.ports.nextDecisionSequence()}`,
          ruleID,
          statement: rule.statement,
          enforcement: rule.enforcement,
          ...(rule.appliesTo ? { appliesTo: rule.appliesTo } : {}),
        }),
      );
      return { promoted: true as const, ruleID };
    },

    /**
     * Edit a soft (document) rule in place and write it back (EI §3.8 P-1.c
     * 软规则编辑): the user rewrites a section's prose and syncs its
     * enforcement / appliesTo HTML-comment annotations. The document is the
     * source of truth for soft rules — there is no journal event; the change
     * is picked up by the hash-based runtime-context re-derivation. The model
     * never calls this (§3.6): only the user, through the governance panel.
     */
    async updateConstitutionDocRule(
      input: {
        id: string;
        statement?: string;
        enforcement?: ConstitutionDocRule["enforcement"];
        appliesTo?: ConstitutionDocRule["appliesTo"];
      },
      sessionID?: string,
    ) {
      if (!input.id.trim())
        return { updated: false as const, reason: "no rule id" };
      const statement = input.statement?.trim();
      if (input.statement !== undefined && !statement)
        return {
          updated: false as const,
          reason: "statement must not be empty",
        };
      await ctx.ports.getReady();
      const workspaceRoot = ctx.ports.getWorkspaceRoot();
      const snapshot = await loadProjectDocuments(workspaceRoot);
      const document = snapshot.documents.find((candidate) =>
        candidate.rules.some((rule) => rule.id === input.id),
      );
      if (!document)
        return { updated: false as const, reason: "unknown document rule id" };
      const current = document.rules.find((rule) => rule.id === input.id)!;
      const next = {
        statement: statement ?? current.statement,
        enforcement: input.enforcement ?? current.enforcement,
        ...(input.appliesTo !== undefined
          ? { appliesTo: input.appliesTo }
          : current.appliesTo
            ? { appliesTo: current.appliesTo }
            : {}),
      };
      const edited = applyConstitutionDocEdit(
        document.content,
        document.source,
        input.id,
        next,
      );
      if (!edited.ok) return { updated: false as const, reason: edited.reason };
      await writeWorkspaceFile({
        workspaceRoot,
        path: document.path,
        content: edited.content,
      });
      return { updated: true as const };
    },
    async registeredTools(sessionID?: string) {
      await ctx.ports.getReady();
      const exec = await intelligenceExecWindow(sessionID);
      const window = exec
        ? await ensureSessionEventWindow(ctx, exec)
        : undefined;
      const events = window
        ? sessionWindowEvents(exec!, window)
        : (exec?.session.events ?? []);
      const projected = events.length
        ? (await projectedCanonicalToolsWithFallback(events)).map((t) => ({
            name: t.name,
            owner: t.owner,
            scope: t.scope,
            recovery: t.recovery,
            precedence: t.precedence,
            requiresApproval: t.requiresApproval,
          }))
        : [];
      // The live tool registry is the authoritative list of currently loaded
      // tools. Some plugin tools are registered before their projection events
      // are persisted into the session, so merge them into the reported set.
      const live = [...ctx.state.tools.values()].map((tool) => ({
        name: tool.name,
        owner:
          ctx.state.capabilityRegistry.ownerOf("tools", tool.name) ?? "kernel",
        scope: "session" as const,
        recovery: "none" as const,
        precedence: 0,
        requiresApproval: tool.requiresApproval,
      }));
      const merged = new Map<string, (typeof projected)[number]>();
      for (const tool of [...live, ...projected]) merged.set(tool.name, tool);
      return [...merged.values()];
    },
    async notices(sessionID?: string) {
      const exec = await completeIntelligenceExec(sessionID);
      if (!exec?.session) return [];
      return (await runSessionProjectionWithFallback(
        "notices",
        exec.session.events,
      )) as import("@anthelia/contracts").RuntimeProjectedNotice[];
    },
  };
}
