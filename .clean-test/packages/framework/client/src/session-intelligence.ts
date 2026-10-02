/**
 * Session Intelligence snapshot builder.
 *
 * P8 C1 shipped the read model — the `session.snapshot` event, its projector
 * (`latestSessionSnapshot`), the RPC/SDK query and the TUI dialog — but nothing
 * in production ever published the event, so every query answered `undefined`
 * and the dialog said "No snapshot available". This module is the writer's pure
 * half: it derives the journal-backed fields (changed files, unvalidated
 * changes, recent output) from the session's durable events and assembles the
 * event. The live half (agent status, active tool, PTY/sandbox presence) comes
 * from the runtime through `live`, so the builder itself stays testable without
 * a running runtime.
 *
 * Two rules shape it, following the work-graph writer's:
 *
 * 1. **Counts and safe strings only.** `changedFiles`/`unvalidatedChanges` are
 *    numbers; `recentOutput` is the last confirmed assistant output, bounded to
 *    the schema's 2000-character cap. File contents, tool arguments, command
 *    text and results never enter the snapshot.
 * 2. **Replayable by default.** Changed files are counted from the
 *    `workspace_change` Work Graph nodes the runtime already writes; validated
 *    changes come from `evidence.recorded` events (none exist yet, so all
 *    changes are unvalidated — that is the honest answer, not a bug). During a
 *    running turn, the runtime may override `recentOutput` with a bounded,
 *    redacted in-memory stream; replay falls back to the last `content.done`.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  sessionIntelligenceFactsFromEvents,
  type SessionIntelligenceFacts,
} from "@anthelia/session";

export type SessionIntelligenceLive = {
  agentStatus: string;
  currentStep?: string;
  activeTool?: string;
  recentOutput?: string;
  /**
   * The session's effective file-effect mode (the composition/config
   * chain's resolution). Rides `live` because it is a runtime truth, not
   * a journal fact — the escalation below is the journal half.
   */
  confinementMode?: import("@anthelia/contracts").ConfinementMode;
  /**
   * The L1 read fabric's counters, the same runtime-truth class as the
   * mode above: the cache's earning, readable without opening a metric
   * pipe (DoD #3).
   */
  cache?: {
    hits: number;
    misses: number;
    byKind: Record<string, { hits: number; misses: number; evictions: number }>;
    /** The provider prefix-cache tier (Phase 5), derived at read time. */
    provider?: {
      steps: number;
      inputTokens: number;
      cacheReadTokens: number;
      hitShare: number;
    };
  };
};

/** The changed workspace files, as recorded by the Work Graph writer. */
export function countChangedFiles(events: RuntimeEvent[]): number {
  return sessionIntelligenceFactsFromEvents(events).changedFiles;
}

/** Changes backed by `evidence.recorded` events. Zero today: no evidence writer. */
export function countValidatedChanges(events: RuntimeEvent[]): number {
  return sessionIntelligenceFactsFromEvents(events).validatedChanges;
}

/** The last confirmed assistant output, if any, before the snapshot moment. */
export function latestConfirmedOutput(
  events: RuntimeEvent[],
): string | undefined {
  return sessionIntelligenceFactsFromEvents(events).latestOutput;
}

/**
 * Whether a live PTY exists, derived from the durable `terminal.timeline`
 * journal. A pane is live when its last timeline action is not `exit`; a start
 * publishes `started`/`created`, a stop publishes `exit`, and intermediate
 * actions (`write`, `attach`, `secure_input`, …) only happen while the pane
 * exists. Journal-derived so replay answers the same way the live moment did.
 */
export function hasLivePTY(events: RuntimeEvent[]): boolean {
  return sessionIntelligenceFactsFromEvents(events).hasPTY;
}

/**
 * Whether a live sandbox exists, derived from the durable `sandbox.update`
 * journal. A sandbox is live when its latest status is not a terminal one
 * (`deleted`/`stopped`/`failed`); creation publishes `created`, deletion
 * publishes `deleted`. Journal-derived so replay answers the same way.
 */
export function hasLiveSandbox(events: RuntimeEvent[]): boolean {
  return sessionIntelligenceFactsFromEvents(events).hasSandbox;
}

export function buildSessionIntelligenceSnapshot(input: {
  id: string;
  events: RuntimeEvent[];
  live: SessionIntelligenceLive;
}): Extract<RuntimeEvent, { type: "session.snapshot" }> {
  return buildSessionIntelligenceSnapshotFromFacts({
    id: input.id,
    facts: sessionIntelligenceFactsFromEvents(input.events),
    live: input.live,
  });
}

/**
 * Assemble the snapshot from already-folded intelligence facts. The runtime's
 * incremental hot state uses this variant so an immediate-status read does not
 * re-scan the journal when the fact state is complete.
 */
export function buildSessionIntelligenceSnapshotFromFacts(input: {
  id: string;
  facts: SessionIntelligenceFacts;
  live: SessionIntelligenceLive;
}): Extract<RuntimeEvent, { type: "session.snapshot" }> {
  const output = input.live.recentOutput ?? input.facts.latestOutput;
  return {
    type: "session.snapshot",
    id: input.id,
    agentStatus: input.live.agentStatus,
    ...(input.live.currentStep ? { currentStep: input.live.currentStep } : {}),
    ...(input.live.activeTool ? { activeTool: input.live.activeTool } : {}),
    changedFiles: input.facts.changedFiles,
    unvalidatedChanges: input.facts.unvalidatedChanges,
    ...(output ? { recentOutput: output.slice(0, 2000) } : {}),
    hasPTY: input.facts.hasPTY,
    hasSandbox: input.facts.hasSandbox,
    ...(input.live.cache
      ? {
          cache: {
            hits: input.live.cache.hits,
            misses: input.live.cache.misses,
            byKind: input.live.cache.byKind,
            // The provider prefix-cache tier (Phase 5): it rides beside
            // the L1 counters, absent when the session ran no step.
            ...(input.live.cache.provider
              ? { provider: input.live.cache.provider }
              : {}),
          },
        }
      : {}),
    ...(input.live.confinementMode
      ? {
          confinement: {
            mode: input.live.confinementMode,
            ...(input.facts.lastEscalation
              ? {
                  escalatedAt: input.facts.lastEscalation.escalatedAt,
                  escalatedTo: input.facts.lastEscalation.escalatedTo,
                  justification: input.facts.lastEscalation.justification,
                }
              : {}),
          },
        }
      : {}),
  };
}
