/**
 * Status projection: context budget, compaction, retries, selections, policy
 * outcomes and the session intelligence snapshot.
 *
 * Banners here are advisory strings a UI may show while something transient is
 * happening. They are derived, never durable truth — clearing one changes
 * nothing about the runtime.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import { resetStreamsForRetry, upsertInto } from "./conversation";
import {
  appendBounded,
  completionLimit,
  constitutionConflictLimit,
  emptySessionUsageStats,
  constitutionOverrideLimit,
  decisionLimit,
  driftFindingLimit,
  evidenceLimit,
  invariantFindingLimit,
  policyDecisionLimit,
  upsertBlock,
  type AppState,
} from "./state";

type UsageEvent = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  llmMs?: number;
  toolMs?: number;
  ttftMs?: number;
  decodeMs?: number;
};

function accumulateUsage(
  target: import("./state").SessionUsageStats,
  event: UsageEvent,
) {
  target.steps += 1;
  target.inputTokens += event.inputTokens ?? 0;
  target.outputTokens += event.outputTokens ?? 0;
  target.cacheReadInputTokens += event.cacheReadInputTokens ?? 0;
  target.cacheCreationInputTokens += event.cacheCreationInputTokens ?? 0;
  target.llmMs += event.llmMs ?? 0;
  target.toolMs += event.toolMs ?? 0;
  if (event.ttftMs !== undefined) {
    target.ttftMs += event.ttftMs;
    target.ttftSteps += 1;
  }
  target.decodeMs += event.decodeMs ?? 0;
}

/** Returns true when the event belongs to this projection. */
export function applyStatusEvent(
  state: AppState,
  event: RuntimeEvent,
): boolean {
  switch (event.type) {
    case "runtime.step_usage": {
      // Session-wide aggregate (backwards compatible) plus the stream that
      // actually produced the step. Absent fields contribute nothing; a step
      // without provider usage still counts and carries timing.
      accumulateUsage(state.sessionUsage, event);
      // Legacy shared-event replay only: live writers emit
      // navi./nia.runtime.step_usage with no channel tag. `channel` is the
      // journal-compatibility discriminator for events written before the
      // namespaced events existed.
      const channel = event.channel ?? "main";
      if (!state.usageByChannel[channel])
        state.usageByChannel[channel] = emptySessionUsageStats();
      accumulateUsage(state.usageByChannel[channel], event);
      return true;
    }
    case "navi.runtime.step_usage": {
      accumulateUsage(state.sessionUsage, event);
      if (!state.usageByChannel.navi)
        state.usageByChannel.navi = emptySessionUsageStats();
      accumulateUsage(state.usageByChannel.navi, event);
      return true;
    }
    case "nia.runtime.step_usage": {
      accumulateUsage(state.sessionUsage, event);
      if (!state.usageByChannel.nia)
        state.usageByChannel.nia = emptySessionUsageStats();
      accumulateUsage(state.usageByChannel.nia, event);
      return true;
    }
    case "work_contract.drafted":
      state.workContracts[event.planID] = {
        planID: event.planID,
        version: event.planVersion,
        ...(event.scope ? { scope: event.scope } : {}),
        ...(event.verification ? { verification: event.verification } : {}),
        ...(event.constraints ? { constraints: event.constraints } : {}),
        status: "draft",
      };
      return true;
    case "work_contract.accepted":
      state.workContracts[event.planID] = {
        planID: event.planID,
        version: event.planVersion,
        ...(event.scope ? { scope: event.scope } : {}),
        ...(event.verification ? { verification: event.verification } : {}),
        ...(event.constraints ? { constraints: event.constraints } : {}),
        status: "current",
        acceptedBy: event.acceptedBy,
        acceptedAt: event.acceptedAt,
        ...(event.unverifiable ? { unverifiable: true } : {}),
      };
      return true;
    case "plan.doc.updated": {
      // A plan document edit invalidates a draft extracted from the older
      // version (EI §8.2); an accepted contract is the user's commitment and
      // survives until a new one is approved.
      const contract = state.workContracts[event.planID];
      if (contract && contract.status === "draft") contract.stale = true;
      return true;
    }
    case "status.update":
      state.status = event.status;
      state.footer = [event.status, event.detail].filter(Boolean).join(" - ");
      return true;
    case "status.snapshot":
      state.statusSegments = [
        "mode:runtime",
        `model:${event.model}`,
        `provider:${event.provider}`,
        `ctx:${event.context}`,
        `step:${event.step}`,
        event.permissions,
        `bg:${event.background}`,
        // The host, as the runtime named it. Absent in a journal written
        // before the field existed — the settings surface treats that as
        // "unknown host" rather than assuming either way.
        ...(event.platform ? [`host:${event.platform}`] : []),
      ];
      return true;
    case "context.status": {
      // Journal replay only: a live writer emits the namespaced
      // `navi./nia.context.snapshot`, and the shared `context.status` for the
      // main channel. `channel` is the discriminator that older journals carry,
      // so it decides which meter an old entry belongs to — dropping it would
      // file a replayed navi status under the main channel.
      const usage: import("./state").ContextUsageView = {
        used: event.used,
        max: event.max,
        source: event.source,
        thresholdPercent: event.thresholdPercent,
        reserved: event.reserved,
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
      };
      if (event.channel === "navi") state.navi.context = usage;
      else if (event.channel === "nia") state.nia.context = usage;
      else state.context = usage;
      state.footer = `context ${event.used}/${event.max} source=${event.source}${
        event.trigger ? ` trigger=${event.trigger}` : ""
      }`;
      return true;
    }
    case "context.snapshot": {
      // Legacy journal replay only: live writers emit
      // navi./nia.context.snapshot.
      const usage: import("./state").ContextUsageView = {
        used: event.projectedTokens ?? event.pressureTokens ?? event.usedTokens,
        ...(event.contextWindow === undefined
          ? {}
          : { max: event.contextWindow }),
        source: event.source,
        contextWindow: event.contextWindow,
        pressureTokens: event.pressureTokens,
        projectedTokens: event.projectedTokens,
      };
      if (event.channel === "navi") state.navi.context = usage;
      else if (event.channel === "nia") state.nia.context = usage;
      else state.context = usage;
      return true;
    }
    case "navi.context.snapshot": {
      state.navi.context = {
        used: event.projectedTokens ?? event.pressureTokens ?? event.usedTokens,
        ...(event.contextWindow === undefined
          ? {}
          : { max: event.contextWindow }),
        source: event.source,
        contextWindow: event.contextWindow,
        pressureTokens: event.pressureTokens,
        projectedTokens: event.projectedTokens,
      };
      return true;
    }
    case "nia.context.snapshot": {
      state.nia.context = {
        used: event.projectedTokens ?? event.pressureTokens ?? event.usedTokens,
        ...(event.contextWindow === undefined
          ? {}
          : { max: event.contextWindow }),
        source: event.source,
        contextWindow: event.contextWindow,
        pressureTokens: event.pressureTokens,
        projectedTokens: event.projectedTokens,
      };
      return true;
    }
    case "context.checkpoint":
      return true;
    case "compaction.begin":
      state.compactionBanner = {
        kind: "compacting",
        text: `Compacting after ${event.trigger} · before ${event.beforeTokens}/${event.maxTokens} · reserved ${event.reservedTokens}`,
      };
      state.footer = state.compactionBanner.text;
      return true;
    case "compaction.end":
      state.compactionBanner = undefined;
      // Compaction rewrites what the model can still see, so the outcome belongs
      // in the transcript rather than only in a banner that disappears.
      upsertBlock(
        state,
        event.id,
        "system",
        event.success
          ? `compaction complete: ${event.beforeTokens} -> ${event.afterTokens} tokens in ${event.durationMs}ms`
          : `compaction failed atomically: ${event.error ?? "unknown"}`,
        event.success ? "compacted" : "failed",
      );
      state.footer = event.success
        ? "compaction complete"
        : "compaction failed";
      return true;
    case "context.limit.recovery":
      upsertBlock(
        state,
        `${event.id}:context-limit`,
        "system",
        event.compacted
          ? "context-limit recovery compacted once; retrying original step"
          : "context-limit recovery requested",
        "context_limit",
      );
      return true;
    case "step.retry":
      resetStreamsForRetry(state, event.id, event.attempt);
      // Stated from the event's own fields. Turning a retry into friendlier
      // prose is presentation, and belongs to whichever UI renders it.
      state.retryBanner = {
        kind: "step_retry",
        text: `Retrying ${event.operation} after ${event.reason} · attempt ${event.attempt}/${event.maxAttempts ?? "unlimited"} · waiting ${event.waitMs}ms`,
      };
      return true;
    case "step.retry.cleared":
      state.retryBanner = undefined;
      state.footer = `retry recovered after ${event.attempts} attempts`;
      return true;
    case "step.retry.exhausted":
      state.retryBanner = undefined;
      // Exhaustion is terminal for the step, so it is recorded, not just shown.
      upsertBlock(
        state,
        `${event.id}:retry:exhausted`,
        "system",
        event.message,
        "retry_exhausted",
      );
      state.footer =
        event.retryable === false
          ? `not retryable: ${event.reason}`
          : `retry exhausted: ${event.reason}`;
      return true;
    case "agent.selection":
      state.agentSelection = { name: event.name, pending: event.pending };
      return true;
    case "context.instructions": {
      // ADR Phase C: a prompt-level instruction change arrives as a durable
      // event; the projection keeps the latest revision per kind (latest
      // wins), so a replay and a live stream converge on the same view.
      const existing = state.runtimeNotices.find(
        (notice) => notice.kind === event.kind,
      );
      if (existing && existing.revision >= event.revision) return true;
      const notice = {
        noticeID: event.id,
        kind: event.kind,
        revision: event.revision,
        at: event.at,
        summary: event.summary,
        ...(event.detail ? { detail: event.detail } : {}),
      };
      state.runtimeNotices = [
        ...state.runtimeNotices.filter((n) => n.kind !== event.kind),
        notice,
      ].sort((left, right) => left.at.localeCompare(right.at));
      // ADR Phase C: interleave the notice into the transcript at its sequence
      // position as a system bubble (fold order = event order, so upserting
      // here lands it between the turns it actually separates), never stacked
      // at the top. A replay and a live stream converge on the same rows.
      upsertInto(
        state.natalia.messages,
        `notice:${event.id}`,
        "system",
        `${event.kind}: ${event.summary}`,
      );
      return true;
    }
    case "model.selection":
      state.modelSelection = {
        modelID: event.modelID,
        variant: event.variant,
      };
      return true;
    case "drift.finding_opened": {
      if (
        state.driftFindings.some(
          (finding) => finding.findingID === event.findingID,
        )
      )
        return true;
      state.driftFindings = appendBounded(
        state.driftFindings,
        { ...event, status: "open", reopenedCount: 0 },
        driftFindingLimit,
      );
      return true;
    }
    case "drift.finding_updated": {
      const index = state.driftFindings.findIndex(
        (finding) => finding.findingID === event.findingID,
      );
      if (index < 0) return true;
      const existing = state.driftFindings[index]!;
      const reopenedCount =
        event.status === "open" && existing.status !== "open"
          ? existing.reopenedCount + 1
          : existing.reopenedCount;
      state.driftFindings = state.driftFindings.map((finding, current) =>
        current === index
          ? {
              ...finding,
              status: event.status,
              ...(event.rationale ? { rationale: event.rationale } : {}),
              reopenedCount,
            }
          : finding,
      );
      return true;
    }
    case "evidence.recorded":
      state.evidence = appendBounded(state.evidence, event, evidenceLimit);
      upsertBlock(
        state,
        event.id,
        "system",
        `${event.status} · ${event.objective}`,
        event.status,
        { taskID: event.taskID },
      );
      return true;
    case "completion.recorded":
      state.completions = appendBounded(
        state.completions,
        event,
        completionLimit,
      );
      return true;
    case "constitution.rule_added":
      state.constitutionRules = {
        ...state.constitutionRules,
        [event.ruleID]: event,
      };
      return true;
    case "constitution.rule_updated": {
      const existing = state.constitutionRules[event.ruleID];
      if (!existing) return true;
      state.constitutionRules = {
        ...state.constitutionRules,
        [event.ruleID]: {
          ...existing,
          statement: event.statement ?? existing.statement,
          priority: event.priority ?? existing.priority,
        },
      };
      return true;
    }
    case "constitution.override_granted":
      state.constitutionOverrides = appendBounded(
        state.constitutionOverrides,
        event,
        constitutionOverrideLimit,
      );
      return true;
    case "decision.recorded":
      // Workspace-tier decisions are shown through an explicit workspace
      // query, never silently mixed into a session transcript view.
      if (event.scope === "workspace") return true;
      if (state.decisions.some((record) => record.id === event.id)) return true;
      state.decisions = appendBounded(state.decisions, event, decisionLimit);
      return true;
    case "policy.decision":
      // Kept so a UI can explain why a tool did not run. Allows are recorded
      // too, because "nothing was denied" is also an answer.
      state.policyDecisions = appendBounded(
        state.policyDecisions,
        event,
        policyDecisionLimit,
      );
      return true;
    case "constitution.check":
      // Only a conflicting check is worth surfacing; a rule that passed is not
      // news. Note this projection is empty in practice today: no production
      // code emits constitution rules, so nothing can conflict with them.
      if (!event.conflict) return true;
      state.constitutionConflicts = appendBounded(
        state.constitutionConflicts,
        event,
        constitutionConflictLimit,
      );
      upsertBlock(
        state,
        `constitution:${event.id}`,
        "system",
        `${event.enforcement} · ${event.statement} (${event.action} on ${event.resource})`,
        event.enforcement,
      );
      return true;
    case "session.snapshot":
      state.intelligence = event;
      return true;
    case "diagnostic":
      state.footer = `${event.level}: ${event.message}`;
      return true;
    case "invariant.violation": {
      // The edge opens the record once — a replayed or repeated violation
      // of the same identity must not stack (the journal holds one fact,
      // the view holds one row per open/closed lifecycle).
      const key = `${event.owner}|${event.invariant}|${event.code}|${event.detail}`;
      if (
        state.invariantFindings.some(
          (finding) => finding.key === key && !finding.resolved,
        )
      )
        return true;
      state.invariantFindings = appendBounded(
        state.invariantFindings,
        {
          key,
          at: event.at,
          owner: event.owner,
          invariant: event.invariant,
          code: event.code,
          detail: event.detail,
          ...(event.sessionID ? { sessionID: event.sessionID } : {}),
          resolved: false,
        },
        invariantFindingLimit,
      );
      return true;
    }
    case "invariant.resolved": {
      const key = `${event.owner}|${event.invariant}|${event.code}|${event.detail}`;
      const open = state.invariantFindings.find(
        (finding) => finding.key === key && !finding.resolved,
      );
      if (open) open.resolved = true;
      return true;
    }
    default:
      return false;
  }
}
