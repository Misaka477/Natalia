/**
 * Session intelligence snapshots and in-flight state — runtime/snapshot module.
 *
 * Owns the `session.snapshot` production writer, the snapshot trigger test, the
 * turn/tool id helpers, the event flush barrier, and the durable in-flight
 * operation writer. Reads live state through `RuntimeContext` at call time.
 */
import {
  projectSession,
  sessionFactActiveTurnIDs,
  sessionFactIntelligenceFacts,
} from "@anthelia/session";
import { providerCachePosture, rinaCache } from "@anthelia/rina";
import {
  buildSessionIntelligenceSnapshot,
  buildSessionIntelligenceSnapshotFromFacts,
} from "../session-intelligence";
import { effectiveConfinementMode } from "./tool-execution/execute-context";
import { compositionProfile } from "@anthelia/composition";
import type { SessionStoreController } from "@anthelia/session-store";
import { sessionStoreController as sessionStoreControllerToken } from "@anthelia/session-store";
import type { RuntimeEvent } from "@anthelia/contracts";
import type { DurableInFlightOperation } from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";

export function createSnapshot(ctx: RuntimeContext) {
  let sessionSnapshotSequence = 0;
  return {
    toolEventTurnID,
    isSessionSnapshotTrigger,
    currentSessionSnapshot,
    publishSessionSnapshot,
    runtimeEventFlushBarrier,
    setInFlightOperation,
    setInFlightOperationFor,
  };

  /**
   * The turn a tool event belongs to, from the `${turnID}:${callID}` id shape
   * the runtime publishes (the call id is repeated in `callID`, so only a real
   * suffix is stripped — the same normalisation the shared projection uses).
   */
  function toolEventTurnID(event: { id: string; callID?: string }): string {
    const suffix = event.callID ? `:${event.callID}` : "";
    return event.callID && event.id.endsWith(suffix)
      ? event.id.slice(0, -suffix.length)
      : event.id;
  }

  /** Work-state boundaries worth a fresh snapshot. */
  function isSessionSnapshotTrigger(event: RuntimeEvent): boolean {
    if (
      event.type === "turn.submitted" ||
      event.type === "turn.started" ||
      event.type === "turn.finished" ||
      event.type === "turn.cancelled"
    )
      return true;
    if (event.type === "tool.update")
      return (
        event.status === "running" ||
        ["succeeded", "failed", "rejected", "cancelled"].includes(event.status)
      );
    if (event.type === "sandbox.update")
      return event.status === "created" || event.status === "deleted";
    if (event.type === "terminal.timeline")
      return (
        event.action === "created" ||
        event.action === "started" ||
        event.action === "exit"
      );
    return false;
  }

  /**
   * The session intelligence production writer: builds the latest snapshot from
   * the journal-backed facts (changed files, validated changes, recent output,
   * live PTY/sandbox) plus live state (active tool), and publishes it as a
   * durable event so the `session.snapshot` read model answers real data.
   *
   * Agent status is derived from the journal rather than the live turn marker:
   * by the time this runs after a `turn.finished`, the event is already
   * appended, so `projectSession` reports the turn as complete — the snapshot
   * for the finished turn says `idle`, not `running`. Deriving from the journal
   * also makes the same snapshot reproducible from replay.
   */
  function currentSessionSnapshot(
    exec: SessionExecutionState,
    id: string,
  ): Extract<RuntimeEvent, { type: "session.snapshot" }> {
    const { redactToolOutput } = ctx.ports;
    const { activeToolByTurn, liveMainOutputByTurn } = ctx.state;
    // Prefer the incremental hot state when it was seeded from the full log;
    // otherwise fall back to the full journal fold. This keeps the snapshot
    // correct on fast-attach tails until the state can be completed.
    const factState =
      exec.factStateComplete === true ? exec.factState : undefined;
    const facts = factState
      ? sessionFactIntelligenceFacts(factState)
      : undefined;
    let activeTurnIDs: string[];
    let providerSteps: number | undefined;
    if (factState) {
      activeTurnIDs = sessionFactActiveTurnIDs(factState);
    } else {
      const events = exec.session.events;
      const cachedProjection = exec.snapshotProjection;
      const projection =
        cachedProjection && cachedProjection.eventCount === events.length
          ? cachedProjection.value
          : projectSession(exec.session);
      if (!cachedProjection || cachedProjection.eventCount !== events.length)
        exec.snapshotProjection = {
          eventCount: events.length,
          value: projection,
        };
      activeTurnIDs = projection.activeTurnIDs;
      providerSteps = projection.usage.main.steps;
    }
    const active = activeTurnIDs.length > 0;
    let agentStatus = "idle";
    if (exec.paused) agentStatus = "paused";
    else if (active) agentStatus = "running";
    // PROVIDER STEPS, the number the usage bar counts — ONE AUTHORITY, ONE WORD.
    //
    // This read `journalStatus().messageCount`, the journal's ENTRY count,
    // under the name "step". `session_snapshot` is what Navi and Nia read, so
    // they were told `step 423` while Natalia's own usage bar showed 200-
    // something for the same run ("navi看natalia是跑了四百多step，natalia用量条显示
    // 两百多step"). An entry count is a different measure: it moves with every
    // row a turn writes — tool calls, results, notices — so it is neither steps
    // nor anything a human asked for. The contracts note on `status.snapshot`
    // already records this same conflation costing `/status` its credibility
    // once; the snapshot a sister agent reads had kept it.
    //
    // `projection.usage.main.steps` is one per `runtime.step_usage`, which is
    // what the bar, `/status` and the usage view all count. The fact-state path
    // (a completed hot state) carries no usage fold, so it reports nothing
    // there rather than falling back to a different measure.
    const step = providerSteps;
    const activeTurnID = activeTurnIDs[0];
    const activeTool = activeTurnID
      ? activeToolByTurn.get(activeTurnID)
      : undefined;
    const liveOutput = activeTurnID
      ? redactToolOutput(liveMainOutputByTurn.get(activeTurnID) ?? "", true)
          .trim()
          .slice(-2000)
      : "";
    // The session's confinement posture (sandbox study §6b①): the effective
    // mode rides `live` (a runtime truth); the escalation facts are
    // journal-derived inside the builder. The UI's danger indicator reads
    // the snapshot and the journal — the same source, never a second state.
    // THE SESSION'S OWN RUNG OUTRANKS THE DEPLOYMENT DEFAULT.
    //
    // This read only the profile/config default, so a session that had been
    // moved to `workspace-write` kept publishing `danger-full-access` in its
    // snapshot — and the rung a front end shows is the PAIR of the approval mode
    // (journal) and this value. `applySessionRung` records the session's choice in
    // `sandboxModeOverride`, which is exactly the precedence the tool-execution
    // path resolves with (`resolveSandboxPolicy({ …, sessionMode })`); the snapshot
    // was the one reader that skipped it.
    const deploymentConfinementMode = effectiveConfinementMode({
      profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
      configMode: ctx.ports.getTsRuntimeConfig()?.confinement?.mode,
    });
    const confinementMode =
      exec.sandboxModeOverride ?? deploymentConfinementMode;
    // The L1 fabric's counters (DoD #3's "命中"): aggregated over its
    // kinds, per-kind split kept — an absent fabric (a bare runtime)
    // rides nothing rather than inventing zeros.
    const fabric = ctx.state.serviceDirectory.getOptional(rinaCache);
    const cache = fabric
      ? (() => {
          const byKind: Record<
            string,
            { hits: number; misses: number; evictions: number }
          > = {};
          let hits = 0;
          let misses = 0;
          for (const [kind, metrics] of Object.entries(fabric.metrics())) {
            byKind[kind] = {
              hits: metrics.hits,
              misses: metrics.misses,
              evictions: metrics.evictions,
            };
            hits += metrics.hits;
            misses += metrics.misses;
          }
          return { hits, misses, byKind };
        })()
      : undefined;
    // The provider prefix-cache tier (RINA Phase 5): the session's
    // accumulated steps, independent of the fabric — a runtime with no
    // fabric still reports how much input the provider cached.
    const provider = providerCachePosture(exec.providerCacheUsage);
    // Built explicitly (not spread) so the posture's required shape holds
    // even when the L1 half is absent.
    const cachePosture = cache
      ? { ...cache, ...(provider ? { provider } : {}) }
      : provider
        ? { hits: 0, misses: 0, byKind: {}, provider }
        : undefined;
    const live = {
      agentStatus,
      // Stated as provider steps, and only when a completed turn has really run
      // one: `step` is undefined on the fact-state path, and "step 0" beside a
      // running agent would be a number nobody counted.
      ...(active && step !== undefined ? { currentStep: `step ${step}` } : {}),
      ...(activeTool ? { activeTool } : {}),
      ...(liveOutput ? { recentOutput: liveOutput } : {}),
      confinementMode,
      ...(cachePosture ? { cache: cachePosture } : {}),
    };
    return facts
      ? buildSessionIntelligenceSnapshotFromFacts({ id, facts, live })
      : buildSessionIntelligenceSnapshot({
          id,
          events: exec.session.events,
          live,
        });
  }

  function publishSessionSnapshot(exec?: SessionExecutionState) {
    const { getActiveExec, publishForSession } = ctx.ports;
    const target = exec ?? getActiveExec();
    if (!target?.session) return;
    publishForSession(
      target,
      currentSessionSnapshot(
        target,
        `snapshot:${target.session.id}:${sessionSnapshotSequence++}`,
      ),
    );
  }

  function runtimeEventFlushBarrier(event: RuntimeEvent) {
    return (
      event.type === "approval.response" ||
      event.type === "question.response" ||
      event.type === "turn.finished" ||
      event.type === "turn.cancelled" ||
      event.type === "context.checkpoint"
    );
  }

  async function setInFlightOperation(
    operation: DurableInFlightOperation | undefined,
  ) {
    const { getActiveExec } = ctx.ports;
    const activeExec = getActiveExec();
    if (!activeExec) return;
    await setInFlightOperationFor(activeExec, operation);
  }

  async function setInFlightOperationFor(
    exec: SessionExecutionState,
    operation: DurableInFlightOperation | undefined,
  ) {
    const { getSessionPersistence, setSessionPersistence, publishForSession } =
      ctx.ports;
    const sessionStoreController = ctx.state.serviceDirectory.get(
      sessionStoreControllerToken,
    );
    const targetSession = exec.session;
    targetSession.metadata = { ...targetSession.metadata };
    if (operation) targetSession.metadata.inFlightOperation = operation;
    else delete targetSession.metadata.inFlightOperation;
    const sessionPersistence = ctx.ports.getSessionPersistenceForSession(
      exec.session.id,
    );
    const next = sessionPersistence
      .then(() =>
        sessionStoreController.updateMetadata(exec.session.id, {
          inFlightOperation: operation,
        }),
      )
      .catch((error) =>
        publishForSession(exec, {
          type: "diagnostic",
          level: "warning",
          message: `in-flight operation audit persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    ctx.ports.setSessionPersistenceForSession(exec.session.id, next);
    setSessionPersistence(
      Promise.allSettled([getSessionPersistence(), next]).then(() => undefined),
    );
    await next;
  }
}
