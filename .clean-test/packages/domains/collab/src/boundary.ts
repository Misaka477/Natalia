/**
 * Turn-boundary settlement and workspace observation — runtime/collaboration/
 * boundary module.
 *
 * A finished turn is the safe point for mailbox settlement (acknowledge the
 * already-delivered batch, deliver the queued batch), plan promotion (activate
 * the queued-next plan), and workspace observation reconcile (graph external
 * edits and drift-check them against the active plan). Reads live state through
 * `RuntimeContext` at call time.
 */
import {
  projectedMailboxMessages,
  sessionFactMailboxMessages,
} from "@anthelia/session";
import { buildMailboxStatus } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import { workspaceFiles } from "@anthelia/workspace";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import { activePlanForExec } from "./plan-doc-runtime";
import {
  projectedConstitutionRules,
  projectedEvidenceRecords,
  projectedWorkContracts,
  sessionFactConstitutionRules,
  sessionFactDiagnosticStreamEvents,
  sessionFactEvidenceRecords,
  sessionFactGoal,
  sessionFactWorkContracts,
} from "@anthelia/session";
import {
  injectFindingIntoMainAgent,
  injectProseQuestion,
} from "./drift-inject";
import {
  deriveDriftBehaviorSignals,
  proseRelevanceQuestion,
} from "@natalia/work-ledger";
import { foldGoal } from "@natalia/goal";
import { constitutionPathMatch as globPathMatch } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";

/**
 * The main agent's narration for the finished turn: the latest assistant
 * `content.done` text. Used only by the goal 问通道 (EI Phase 2 机制 3) to
 * detect low relevance against the goal objective — never judged, never
 * journaled. Returns the trimmed text, or undefined when the turn was silent.
 */
export function lastAssistantNarration(
  events: readonly import("@anthelia/contracts").RuntimeEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "content.done" && event.text?.trim())
      return event.text.trim();
  }
  return undefined;
}

/**
 * One goal 问通道 streak per session (EI Phase 2 机制 3): the question is asked
 * only after K consecutive low-relevance rounds, then the counter resets, so a
 * drifting agent is nudged rather than spammed.
 */
const GOAL_QUESTION_STREAK = 3;

/**
 * EI §3.3 机制 1: the delivered/acknowledged `constraint` intents from the Live
 * Work Chat mailbox, as explicit R constraint sentences. A queued/deferred/
 * superseded message is not yet (or no longer) binding, so it is excluded.
 * Pure so the selection is unit-testable without a boundary.
 */
export function deliveredMailboxConstraints(
  messages: readonly import("@anthelia/session").ProjectedMailboxMessage[],
): string[] {
  return messages
    .filter(
      (message) =>
        message.intent === "constraint" &&
        (message.status === "delivered" || message.status === "acknowledged"),
    )
    .map((message) => message.safeSummary)
    .filter((summary) => summary.trim().length > 0);
}

/**
 * The open (unresolved) invariant violations in a session journal
 * (Discovery D3): folds D2's paired edges — every `invariant.violation`
 * opens a hit, its `invariant.resolved` closes it — so drift sees exactly
 * what the projection sees, with no second opinion about state.
 */
import type { RuntimeEvent } from "@anthelia/contracts";

export function openInvariantHits(
  events: readonly RuntimeEvent[],
): Array<{ code: string; at: string; detail: string }> {
  const open = new Map<string, { code: string; at: string; detail: string }>();
  for (const event of events) {
    if (event.type === "invariant.violation") {
      open.set(`${event.code}|${event.detail}`, {
        code: event.code,
        at: event.at,
        detail: event.detail,
      });
    } else if (event.type === "invariant.resolved") {
      open.delete(`${event.code}|${event.detail}`);
    }
  }
  return [...open.values()];
}

/**
 * The session's instruction epoch: the highest `context.instructions`
 * revision (monotonic per session). A change means the reference frame
 * moved — config reload, agent switch, plan handoff — and drift must
 * re-anchor even when nothing on disk changed.
 */
export function instructionRevision(events: readonly RuntimeEvent[]): number {
  let revision = 0;
  for (const event of events)
    if (event.type === "context.instructions")
      revision = Math.max(revision, event.revision);
  return revision;
}

/** The epoch each execution was last evaluated under (boundary-local). */
const lastEvaluatedEpoch = new WeakMap<SessionExecutionState, number>();

/**
 * The drift judge's full read policy: its constraint inputs (the
 * constitution rules and work contracts it judges against) and its trigger
 * inputs (the open invariant violations and the instruction epoch that force
 * a re-evaluation) — all from the complete fact state when available, the
 * resident array as the belt. A fast-attach tail cannot hold pre-epoch
 * rules, contracts, violations or instruction notices, so a judgement made
 * from it alone is made against an empty constraint set and a missed
 * reference-frame change. Exported pure so the policy is testable without a
 * runtime (the reconcile path's own e2e is full-attach, where belt and fact
 * agree and cannot discriminate).
 */
export function driftJudgeReadsFor(exec?: SessionExecutionState) {
  if (exec?.factStateComplete === true && exec.factState)
    return {
      constitutionRules: sessionFactConstitutionRules(exec.factState),
      workContracts: sessionFactWorkContracts(exec.factState),
      invariantHits: openInvariantHits(
        sessionFactDiagnosticStreamEvents(exec.factState),
      ),
      instructionRevision: instructionRevision(
        sessionFactDiagnosticStreamEvents(exec.factState),
      ),
    };
  return {
    constitutionRules: projectedConstitutionRules(exec?.session.events ?? []),
    workContracts: projectedWorkContracts(exec?.session.events ?? []),
    invariantHits: openInvariantHits(exec?.session.events ?? []),
    instructionRevision: instructionRevision(exec?.session.events ?? []),
  };
}

export function createCollaborationBoundary(ctx: RuntimeContext) {
  const proseStreaks = new Map<string, number>();

  /**
   * EI §8.4: read the session's evidence ids from the complete fact state when
   * available (a fast-attach tail would under-report the evidence_gap rule's
   * only input). Falls back to the projected events for a tail-only attach.
   */
  function evidenceRecordsFor(exec?: SessionExecutionState) {
    if (exec?.factStateComplete === true && exec.factState)
      return sessionFactEvidenceRecords(exec.factState);
    return projectedEvidenceRecords(exec?.session.events ?? []);
  }

  function mailboxMessagesFor(exec?: SessionExecutionState) {
    // The hot state is complete even when session.events is a fast-attach tail.
    if (exec?.factStateComplete === true && exec.factState)
      return sessionFactMailboxMessages(exec.factState);
    const snapshot = exec?.collabSnapshot;
    if (
      snapshot &&
      snapshot.eventCount ===
        (exec?.eventCount ?? exec?.session.events.length ?? -1)
    )
      return snapshot.mailboxMessages;
    return projectedMailboxMessages(exec?.session.events ?? []);
  }

  /**
   * The current goal: the fact state's view when complete, else the strict
   * domain fold over the resident events (which keeps its
   * throw-on-malformed-tail contract for the caller's best-effort catch).
   */
  function goalFor(exec?: SessionExecutionState) {
    if (exec?.factStateComplete === true && exec.factState)
      return sessionFactGoal(exec.factState);
    return foldGoal(exec?.session.events ?? []);
  }

  return {
    settleMailboxAtBoundary,
    acknowledgeDeliveredMailboxAtBoundary,
    deliverQueuedMailboxAtBoundary,
    takeLiveUserMessages,
    reconcileWorkspaceObservation,
  };

  /**
   * P8 C3: settle the mailbox at the turn boundary. Already-delivered messages
   * (injected into the turn that just finished) are acknowledged so they stop
   * re-injecting. Queued messages are also delivered here as a fallback if a
   * live step did not already take them. A cancelled/aborted turn is NOT a
   * settlement.
   */
  function settleMailboxAtBoundary(exec?: SessionExecutionState) {
    acknowledgeDeliveredMailboxAtBoundary(exec);
    deliverQueuedMailboxAtBoundary(exec);
  }

  /**
   * Acknowledge every message that is still `delivered` (it was injected into
   * the turn that just finished, so the main agent has seen it). Acknowledged
   * messages no longer re-inject as ordinary tagged user messages.
   */
  function acknowledgeDeliveredMailboxAtBoundary(exec?: SessionExecutionState) {
    const { publishForSession, nextMailboxSequence } = ctx.ports;
    const target = exec;
    if (!target?.session) return;
    const delivered = mailboxMessagesFor(target).filter(
      (message) => message.status === "delivered",
    );
    if (!delivered.length) return;
    const at = new Date().toISOString();
    for (const message of delivered)
      publishForSession(
        target,
        buildMailboxStatus({
          id: `${message.messageID}:acknowledged:${nextMailboxSequence()}`,
          messageID: message.messageID,
          status: "acknowledged",
          at,
        }),
      );
  }

  /**
   * The safe-boundary delivery half of the mailbox: every queued message moves
   * to `delivered` at the safe point. The projection drives this — only
   * messages still `queued` are delivered, so deferred/superseded messages are
   * left alone, and a message that was already delivered is untouched.
   */
  function deliverQueuedMailboxAtBoundary(exec?: SessionExecutionState) {
    const { publishForSession, nextMailboxSequence } = ctx.ports;
    const target = exec;
    if (!target?.session) return;
    const queued = mailboxMessagesFor(target).filter(
      (message) => message.status === "queued",
    );
    if (!queued.length) return;
    const at = new Date().toISOString();
    for (const message of queued)
      publishForSession(
        target,
        buildMailboxStatus({
          id: `${message.messageID}:delivered:${nextMailboxSequence()}`,
          messageID: message.messageID,
          status: "delivered",
          at,
        }),
      );
  }

  function takeLiveUserMessages(exec?: SessionExecutionState) {
    const target = exec;
    if (!target?.session) return [];
    deliverQueuedMailboxAtBoundary(target);
    const injected = target.injectedMailboxIDs;
    const fresh = mailboxMessagesFor(target).filter(
      (message) =>
        message.status === "delivered" && !injected.has(message.messageID),
    );
    const messages: Array<{ source: "user" | "navi"; text: string }> = [];
    for (const message of fresh) {
      injected.add(message.messageID);
      const tag = message.source === "system" ? "[Navi]" : "[user]";
      messages.push({
        source: message.source === "system" ? "navi" : "user",
        text: `${tag} ${message.text}`,
      });
    }
    return messages;
  }

  /**
   * WG4: reconcile the watcher hints against the current workspace, graph any
   * confirmed external changes as isolated nodes, and run them through the
   * DriftEvaluator against the active plan (Phase 4 + Phase 5). This is both the
   * `confirmedWorkspaceChanges()` read surface and the turn-end automatic
   * reconcile — a finished turn reconciles so external edits are discovered,
   * graphed and drift-checked without an explicit call.
   */
  function reconcileWorkspaceObservation(exec?: SessionExecutionState): Promise<
    Array<{
      id: string;
      workspaceRoot: string;
      path: string;
      operation: "added" | "modified" | "deleted" | "renamed";
      origin:
        | "tool"
        | "sandbox_merge"
        | "checkpoint_rollback"
        | "external"
        | "unknown";
      attribution: "attributed" | "unattributed" | "indeterminate";
      correlation: {
        sessionID?: string;
        episodeID?: string;
        turnID?: string;
        callID?: string;
        operationID?: string;
      };
      health: "healthy" | "degraded" | "unavailable";
      at: string;
    }>
  > {
    return (async () => {
      if (ctx.ports.isDisposed()) return [];
      const { publishForSession } = ctx.ports;
      const workLedgerController = ctx.state.serviceDirectory.get(
        workLedgerControllerToken,
      );
      const workspaceFilesController =
        ctx.state.serviceDirectory.getOptional(workspaceFiles);
      const target = exec;
      if (!target?.session || ctx.ports.isDisposed()) return [];
      let confirmed: Awaited<
        ReturnType<NonNullable<typeof workspaceFilesController>["reconcile"]>
      > = [];
      try {
        confirmed = (await workspaceFilesController?.reconcile()) ?? [];
      } catch (error) {
        if (ctx.ports.isDisposed()) return [];
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return [];
        throw error;
      }
      for (const change of confirmed) {
        if (change.attribution === "attributed") continue;
        publishForSession(
          target,
          workLedgerController.externalWorkspaceChangeNode({
            confirmedChangeID: change.id,
            path: change.path,
            sessionID: target.session.id,
          }),
        );
      }
      const activePlan = activePlanForExec(ctx, target);
      const objective = activePlan?.title ?? "";
      // The drift judge's read policy, fact-first: one read serves the drift
      // branch's constraints and triggers and the goal question channel below.
      const judgeReads = driftJudgeReadsFor(target);
      // EI Phase 2 机制 2: the L4 behaviour signals (no-progress window, failure
      // loop) run every turn-end, even when there were no workspace changes.
      const behavior = deriveDriftBehaviorSignals(target.session.events);
      // Discovery D3's two triggers beyond external edits: open invariant
      // violations (D2's edges folded back as an R6 signal) and an
      // instruction-epoch change (the reference frame moved — force a full
      // evaluation even with an empty change set). Both come from the judge's
      // read policy: a fast-attach tail would otherwise miss a pre-epoch
      // violation or notice.
      const invariantHits = judgeReads.invariantHits;
      const epoch = judgeReads.instructionRevision;
      const epochChanged =
        epoch > 0 && lastEvaluatedEpoch.get(target) !== epoch;
      lastEvaluatedEpoch.set(target, epoch);
      if (confirmed.length || epochChanged) {
        // EI §8.1: the evaluator needs the R's evidence and constraint keys
        // (a/p/c — attribution/plan/constitution) so validated work is not
        // judged as drift. Wire the session's recorded evidence and the
        // constitution rules that apply to the changed paths.
        const evidenceRefs = evidenceRecordsFor(target).map(
          (record) => record.id,
        );
        if (epochChanged) evidenceRefs.push(`epoch:instructions:${epoch}`);
        // EI §3.3 机制 1: a user constraint delivered through the Live Work Chat
        // mailbox is an explicit R constraint, not just context prose — feed
        // the delivered/acknowledged `constraint` intents into the judged
        // constraint set alongside the constitution rules that match the paths.
        const mailboxConstraints = deliveredMailboxConstraints(
          mailboxMessagesFor(target),
        );
        const applicableConstraints = [
          ...judgeReads.constitutionRules
            .filter((rule) =>
              rule.appliesTo?.paths?.some((pattern) =>
                confirmed.some((change) => globPathMatch(pattern, change.path)),
              ),
            )
            .map((rule) => rule.ruleID),
          ...mailboxConstraints,
        ];
        // EI Phase 2: the same matched rules, carrying enforcement, so a deny
        // hit opens a high constitution_conflict finding.
        const constitutionHits = judgeReads.constitutionRules
          .filter((rule) =>
            rule.appliesTo?.paths?.some((pattern) =>
              confirmed.some((change) => globPathMatch(pattern, change.path)),
            ),
          )
          .map((rule) => ({
            ruleID: rule.ruleID,
            enforcement: rule.enforcement ?? "warn",
          }));
        // EI §8.6: the R is the accepted WorkContract — the evaluator judges
        // against the user-tier commitment when one exists.
        const contract = judgeReads.workContracts.find(
          (candidate) => candidate.status === "current",
        );
        const driftSignal = {
          sessionID: target.session.id,
          turnID: target.activeTurnID,
          objective,
          currentActivity: confirmed
            .map((change) => `${change.operation}:${change.path}`)
            .join(", "),
          applicableConstraints,
          changes: confirmed.map((change) => ({
            path: change.path,
            action: change.operation,
          })),
          evidenceRefs,
          recentActions: behavior.recentActions,
          recentFailures: behavior.recentFailures,
          invariantHits,
          constitutionHits,
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
        };
        const findings = workLedgerController.evaluateDrift(driftSignal);
        for (const finding of findings) {
          publishForSession(target, finding);
          // EI §3.5 / Phase 2 B3: a warning/high finding is auto-injected into
          // the Main Agent's next step as an internal input, so the next
          // provider request must drift_acknowledge (explain/dispute), correct
          // the work, or detour_declare. advisory findings are noise-level and
          // are NOT injected. The text carries only the findingID, severity and
          // rule summary — never chain-of-thought.
          injectFindingIntoMainAgent(ctx, target, finding);
        }
      } else {
        // No workspace changes this turn: still evaluate the behaviour signals so
        // a spinning or stuck agent opens a no-progress / failure-loop finding.
        const behaviorFindings = workLedgerController.evaluateBehaviorDrift({
          sessionID: target.session.id,
          turnID: target.activeTurnID,
          objective,
          currentActivity: "",
          applicableConstraints: [],
          changes: [],
          evidenceRefs: [],
          recentActions: behavior.recentActions,
          recentFailures: behavior.recentFailures,
          invariantHits,
        });
        for (const finding of behaviorFindings) {
          publishForSession(target, finding);
          injectFindingIntoMainAgent(ctx, target, finding);
        }
      }
      // EI Phase 2 机制 3 (goal 问通道): with an active goal but no accepted
      // contract the judge channel is silent, so a goal whose main agent keeps
      // narrating work barely related to the objective gets an ASK — never a
      // finding — and only after K consecutive low-relevance rounds (误问=打扰,
      // 漏问=自查, 代价不对称). The question compares the goal objective with
      // the agent's own narration; a plan contract silences it (the plan judge
      // channel owns that case).
      let goal: import("@anthelia/contracts").GoalSnapshot | undefined;
      try {
        goal = goalFor(target);
      } catch {
        // A mid-history tail cannot be folded; the question channel is
        // best-effort and never blocks turn settlement.
        goal = undefined;
      }
      if (goal?.phase === "active") {
        const hasContract = judgeReads.workContracts.some(
          (candidate) => candidate.status === "current",
        );
        const narration = hasContract
          ? undefined
          : lastAssistantNarration(target.session.events);
        const question = narration
          ? proseRelevanceQuestion({
              sessionID: target.session.id,
              turnID: target.activeTurnID,
              objective: goal.objective,
              currentActivity: narration,
              applicableConstraints: [],
              changes: [],
              evidenceRefs: [],
            })
          : undefined;
        const streak = question
          ? (proseStreaks.get(target.session.id) ?? 0) + 1
          : 0;
        proseStreaks.set(target.session.id, streak);
        if (question && streak >= GOAL_QUESTION_STREAK) {
          proseStreaks.set(target.session.id, 0);
          injectProseQuestion(ctx, target, question, target.activeTurnID);
        }
      }
      return confirmed;
    })();
  }
}
