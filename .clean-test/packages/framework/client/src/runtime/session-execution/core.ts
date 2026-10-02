import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { turnController } from "@anthelia/turn-orchestration";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { sessionRunCoordinator } from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
import type { TurnController } from "@anthelia/turn-orchestration";
type Surface = Pick<
  RuntimeServiceClient,
  | "service"
  | "start"
  | "submit"
  | "submitAndWait"
  | "cancel"
  | "snapshot"
  | "diagnostic"
  | "lastSubmission"
  | "respondApproval"
  | "respondQuestion"
  | "respondInteractive"
>;
export function createCoreSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async service<T>(name: string) {
      await ctx.ports.ensureReady();
      return ctx.ports.getCapabilityRegistry().service<T>(name);
    },
    start(onEvent, startOptions) {
      ctx.ports.setSink(onEvent);
      ctx.ports.setReplayMode(startOptions?.replay ?? "all");
      // Idempotent: a second subscriber (e.g. the transport server attaching
      // its event sink after the TUI) must not re-run initialize. Re-running
      // it opened a second sqlite connection and a second workspace watcher,
      // which on Windows fails the sqlite open and leaks the first watcher,
      // keeping the process alive after dispose.
      void ctx.ports.ensureReady();
    },
    async submit(text, sessionID) {
      return await ctx.ports.submitInput({
        text,
        ...(sessionID ? { sessionID } : {}),
      });
    },
    async submitAndWait(input) {
      const normalized = typeof input === "string" ? { text: input } : input;
      const submitted = await ctx.ports.submitInput(normalized);
      const exec = ctx.ports
        .getExecutionBySession()
        .get((normalized.sessionID ?? ctx.ports.getSessionID()) as never);
      await waitForTurnSettled(
        submitted.id,
        Boolean(exec?.activeTurnID),
        normalized.sessionID,
      );
      return submitted;
    },
    cancel(reason = "user cancel", sessionID) {
      const cancelledSessionID = (sessionID ??
        ctx.ports.getSessionID()) as SessionID;
      const coordinator = sessionRunCoordinator(cancelledSessionID);
      const cancelledExec =
        ctx.ports
          .getExecutionBySession()
          .get(cancelledSessionID as SessionID) ?? ctx.ports.getActiveExec();
      const runningTurnID = cancelledExec?.activeTurnID;
      const pendingTurnID = runningTurnID
        ? undefined
        : cancelledExec?.lastSubmitted?.id;
      const pendingSessionID = pendingTurnID
        ? (ctx.ports.getTurnSession().get(pendingTurnID) ?? cancelledSessionID)
        : undefined;
      const pendingSession = pendingTurnID
        ? (ctx.ports.getExecutionBySession().get(pendingSessionID!)?.session ??
          ctx.ports.getSession())
        : undefined;
      const pendingInput = pendingSession?.inbox?.find(
        (input) => input.id === pendingTurnID && !input.promotedAt,
      );
      if (pendingInput && pendingSession) {
        pendingSession.inbox = pendingSession.inbox?.filter(
          (input) => input.id !== pendingTurnID,
        );
        if (cancelledExec && cancelledExec.lastSubmitted?.id === pendingTurnID)
          cancelledExec.lastSubmitted = undefined;
      }
      if (cancelledExec) cancelledExec.paused = false;
      ctx.ports.setPaused(false);
      const waiters =
        cancelledExec?.pauseWaiters ?? ctx.ports.getPauseWaiters();
      if (cancelledExec) cancelledExec.pauseWaiters = [];
      else ctx.ports.setPauseWaiters([]);
      for (const resolveWaiter of waiters) resolveWaiter();
      cancelledExec?.activeAbort?.abort(reason);
      if (runningTurnID) {
        ctx.ports.publish({
          type: "turn.cancelled",
          id: runningTurnID,
          reason,
        });
      } else if (pendingInput) {
        // A pending input never started a turn, so it is removed from the queue
        // slice rather than cancelled as a turn.
        const pendingExec = pendingSessionID
          ? ctx.ports.getExecutionBySession().get(pendingSessionID)
          : undefined;
        if (pendingExec)
          ctx.ports.publishForSession(pendingExec, {
            type: "input.removed",
            id: pendingInput.id,
          });
      } else if (coordinator.active && cancelledExec?.lastSubmitted) {
        ctx.ports.publish({
          type: "turn.cancelled",
          id: cancelledExec.lastSubmitted.id,
          reason,
        });
      }
      void (async () => {
        if (pendingInput) {
          const controller = ctx.state.serviceDirectory.get(turnController);
          await controller.persistPromotion(pendingSessionID!);
        }
        await coordinator.interrupt();
        // `interrupt` clears stale wakeups. Only restart the drain when a queued
        // prompt is already admitted; a user Stop should stay idle until they
        // send the next message.
        if (pendingInput)
          await coordinator.wake(
            ctx.ports.drainSessionFor(pendingSessionID ?? cancelledSessionID),
          );
      })().catch((error) =>
        ctx.ports.publishForSession(cancelledExec, {
          type: "diagnostic",
          level: "warning",
          message: `session cancellation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    },
    snapshot() {
      const event: RuntimeEvent = {
        type: "snapshot.created",
        id: `snap_${Date.now().toString(36)}`,
        files: [],
      };
      ctx.ports.publish(event);
      return event;
    },
    diagnostic(message, level = "warning") {
      ctx.ports.publish({ type: "diagnostic", level, message });
    },
    lastSubmission() {
      return ctx.ports.getActiveExec()?.lastSubmitted;
    },
    async respondApproval(response) {
      await ctx.ports.getReady();
      return ctx.ports.getInteractive().respondApproval(response);
    },
    async respondQuestion(response) {
      await ctx.ports.getReady();
      return ctx.ports.getInteractive().respondQuestion(response);
    },
    async respondInteractive(response) {
      await ctx.ports.getReady();
      return ctx.ports.getInteractive().respondInteractive(response);
    },
  };

  async function waitForTurnSettled(
    id: string,
    activeAtSubmit: boolean,
    explicitSessionID?: string,
  ) {
    const sessionID = (explicitSessionID ??
      ctx.ports.getSessionID()) as SessionID;
    let submittedIndex = -1;
    let started = false;
    while (!ctx.ports.isDisposed()) {
      const exec = ctx.ports.getExecutionBySession().get(sessionID);
      const events = exec?.session.events ?? [];
      if (submittedIndex < 0) {
        submittedIndex = events.findIndex(
          (event) => event.type === "turn.submitted" && event.id === id,
        );
        if (submittedIndex < 0) {
          // A queued input removed before it ever started a turn settles here;
          // there is no turn event to wait for.
          if (
            events.some(
              (event) => event.type === "input.removed" && event.id === id,
            )
          )
            return;
          // A `next-step` injected into a turn already running is announced as
          // `turn.input`, never as its own `turn.submitted`. It settles with
          // that turn: return once the injected turn has terminalized and left
          // the active slot. If the running turn ends without claiming it, it
          // is drained as its own turn and the `turn.submitted` path above
          // takes over.
          const injected = events.find(
            (event): event is Extract<RuntimeEvent, { type: "turn.input" }> =>
              event.type === "turn.input" && event.inputID === id,
          );
          if (injected) {
            const settled = events.some(
              (event) =>
                (event.type === "turn.finished" ||
                  event.type === "turn.cancelled") &&
                event.id === injected.turnID,
            );
            if (settled && exec?.activeTurnID !== injected.turnID) return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
      }
      const exactFinished = events.some(
        (event) => event.type === "turn.finished" && event.id === id,
      );
      if (exactFinished) return;
      const exactCancelled = events.some(
        (event) => event.type === "turn.cancelled" && event.id === id,
      );
      // A cancellation event can be published before the provider/tool actually
      // settles. Only treat it as complete when the turn is no longer active.
      if (exactCancelled && !exec?.activeTurnID) return;
      if (exactCancelled && exec?.activeTurnID && exec.activeTurnID !== id)
        return;

      if (activeAtSubmit) {
        // A turn was already running when the blocking submit was made. Do not
        // be fooled by that older turn's terminal event: wait for the newly
        // submitted turn to actually start and then leave the active slot.
        if (
          exec?.activeTurnID === id ||
          events.some(
            (event) => event.type === "turn.started" && event.id === id,
          )
        )
          started = true;
        if (started && exec?.activeTurnID !== id) return;
      } else {
        // Some collaborative/mailbox boundaries execute an internal turn and
        // settle the session without a terminal event carrying the caller's
        // submitted turn id. For an idle submission the first settlement after
        // this submission is the work it woke.
        if (
          events
            .slice(submittedIndex + 1)
            .some((event) => event.type === "turn.finished")
        )
          return;
        // A cancellation can be published before the provider/tool actually
        // settles. Wait for the in-flight turn to leave the active slot before
        // treating `turn.cancelled` as complete; a turn cancelled before it
        // started has no active id and settles immediately.
        const cancelled = events
          .slice(submittedIndex + 1)
          .some((event) => event.type === "turn.cancelled");
        if (cancelled && !exec?.activeTurnID) return;
        if (cancelled && exec?.activeTurnID && exec.activeTurnID !== id) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
