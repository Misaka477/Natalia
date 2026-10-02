import type { InputMutationResult, SessionID } from "@anthelia/contracts";
import {
  buildInputUpdated,
  sessionRunCoordinator,
  type AdmittedSessionInput,
} from "@anthelia/session";
import { type RuntimeServiceClient } from "@anthelia/runtime-services";
import { turnController } from "@anthelia/turn-orchestration";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
import type { TurnController } from "@anthelia/turn-orchestration";

type Surface = Pick<
  RuntimeServiceClient,
  "pause" | "resume" | "removeInput" | "replaceInput" | "promoteInput"
>;

function targetSessionID(ctx: RuntimeContext, sessionID?: string): SessionID {
  return (sessionID ?? ctx.ports.getSessionID()) as SessionID;
}

function requireTurnController(ctx: RuntimeContext): TurnController {
  return ctx.state.serviceDirectory.get(turnController);
}

function pendingInput(
  ctx: RuntimeContext,
  sessionID: SessionID,
  id: string,
): AdmittedSessionInput | undefined {
  return ctx.ports
    .getExecutionBySession()
    .get(sessionID)
    ?.session.inbox?.find((item) => item.id === id);
}

function toResult(
  input: AdmittedSessionInput | undefined,
  reason: NonNullable<InputMutationResult["reason"]>,
): InputMutationResult {
  if (!input) return { ok: false, reason };
  return {
    ok: true,
    input: {
      id: input.id,
      text: input.text,
      delivery: input.delivery,
      ...(input.promotedAt ? { promotedAt: input.promotedAt } : {}),
    },
  };
}

function publishInputEvent(
  ctx: RuntimeContext,
  sessionID: SessionID,
  event: import("@anthelia/contracts").RuntimeEvent,
): void {
  const exec = ctx.ports.getExecutionBySession().get(sessionID);
  if (exec) ctx.ports.publishForSession(exec, event);
}

/** Refusal is a value: callers learn an input was already claimed or is gone. */
function refuseIfNotPending(
  existing: AdmittedSessionInput | undefined,
): InputMutationResult | undefined {
  if (!existing) return { ok: false, reason: "input-not-found" };
  if (existing.promotedAt) return { ok: false, reason: "already-claimed" };
  return undefined;
}

export function createTurnControlSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    pause(reason = "user pause", sessionID?: string) {
      // Refusing is a value: a caller that gets `paused: true` when nothing was
      // paused has been told the turn is held when it is not.
      const exec = sessionID
        ? ctx.ports
            .getExecutionBySession()
            .get(sessionID as import("@anthelia/contracts").SessionID)
        : ctx.ports.getActiveExec();
      const turnID = exec?.activeTurnID;
      if (!turnID) return { paused: false, reason: "no turn is running" };
      if (exec.paused) return { paused: true, reason: "already paused" };
      exec.paused = true;
      ctx.ports.setPaused(true);
      ctx.ports.publishForSession(exec, {
        type: "turn.paused",
        id: turnID,
        reason,
      });
      ctx.ports.publishForSession(exec, {
        type: "status.update",
        status: "paused",
        detail: reason,
      });
      return { paused: true };
    },
    resume(sessionID?: string) {
      const exec = sessionID
        ? ctx.ports
            .getExecutionBySession()
            .get(sessionID as import("@anthelia/contracts").SessionID)
        : ctx.ports.getActiveExec();
      const turnID = exec?.activeTurnID;
      if (!turnID) return { resumed: false, reason: "no turn is running" };
      if (!exec.paused)
        return { resumed: false, reason: "the turn is not paused" };
      exec.paused = false;
      ctx.ports.setPaused(false);
      const waiters = exec.pauseWaiters;
      exec.pauseWaiters = [];
      for (const resolveWaiter of waiters) resolveWaiter();
      ctx.ports.publishForSession(exec, {
        type: "turn.resumed",
        id: turnID,
      });
      ctx.ports.publishForSession(exec, {
        type: "status.update",
        status: "running",
        detail: "resumed",
      });
      return { resumed: true };
    },
    async removeInput({ id, sessionID }) {
      const target = targetSessionID(ctx, sessionID);
      const refusal = refuseIfNotPending(pendingInput(ctx, target, id));
      if (refusal) return refusal;
      const controller = requireTurnController(ctx);
      const result = toResult(
        await controller.removeInput(target, id),
        "input-not-found",
      );
      if (result.ok)
        publishInputEvent(ctx, target, { type: "input.removed", id });
      return result;
    },
    async replaceInput({ id, text, sessionID }) {
      const target = targetSessionID(ctx, sessionID);
      const refusal = refuseIfNotPending(pendingInput(ctx, target, id));
      if (refusal) return refusal;
      const controller = requireTurnController(ctx);
      const result = toResult(
        await controller.replaceInput(target, id, text),
        "input-not-found",
      );
      if (result.ok)
        publishInputEvent(ctx, target, buildInputUpdated(id, text));
      return result;
    },
    async promoteInput({ id, sessionID }) {
      const target = targetSessionID(ctx, sessionID);
      const existing = pendingInput(ctx, target, id);
      const refusal = refuseIfNotPending(existing);
      if (refusal) return refusal;
      // Only a queued `next-turn` can be promoted; an already-`next-step` input
      // is waiting for a claim and has nothing to promote.
      if (existing?.delivery !== "next-turn")
        return { ok: false, reason: "already-step" };
      const controller = requireTurnController(ctx);
      const result = toResult(
        await controller.promoteInput(target, id),
        "input-not-found",
      );
      if (result.ok)
        publishInputEvent(ctx, target, { type: "input.promoted", id });
      // A running turn claims it at the next provider step. An idle session has
      // no loop to claim it, so wake a drain that will run it as a turn.
      if (result.ok && !sessionRunCoordinator(target).active)
        void sessionRunCoordinator(target).wake(
          ctx.ports.drainSessionFor(target),
        );
      return result;
    },
  };
}
