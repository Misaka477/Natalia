/**
 * Collaboration wake scheduling — runtime/collaboration/wake.ts.
 *
 * The main-agent wake (a queued/steered internal collaboration turn), the
 * tracking of in-flight internal wake tasks, the chat-runtime wake request,
 * and Navi's own wake turn. Reads live state through `RuntimeContext` at call
 * time.
 */
import {
  admitInput,
  buildInputAdmission,
  sessionRunCoordinator,
} from "@anthelia/session";
import type { ProviderModelController } from "@anthelia/provider-model";
import { providerModelController } from "@anthelia/provider-model";
import type { SessionID, SubmitInput } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ProductRuntimeContext } from "./product-context";
import type { SessionExecutionState } from "@anthelia/substrate";
import { streamEvent } from "./chat-turn-common";
import { logOf } from "@anthelia/operation-log";

/**
 * The advisor model for a consult: the session's own expert profile
 * first, the config's advisorModel second, and NOTHING — Navi's chat
 * model, the same family as the main agent's — when neither is set.
 * That last case is the default by design: the advisor's value is an
 * independent second read, not a capability tier (the user's amendment:
 * the advisor is not required to differ from the main model).
 */
export function advisorModelFor(
  expertProfile:
    | import("@anthelia/contracts").ChatModelProfile["expert"]
    | undefined,
  configAdvisorModel: string | undefined,
): { modelID: string; variant?: string } | undefined {
  const modelID = expertProfile?.modelID ?? configAdvisorModel;
  if (!modelID) return undefined;
  return {
    modelID,
    ...(expertProfile?.variant ? { variant: expertProfile.variant } : {}),
  };
}

export function createCollaborationWake(ctx: ProductRuntimeContext) {
  return {
    wakeMainForCollaboration,
    scheduleInternalWake,
    requestNaviWake,
    wakeNavi,
    requestNiaWake,
    wakeNia,
    deliverInternalWake,
  };

  /**
   * The internal-wake delivery core, shared by the collaboration wake and
   * the settlement spine's notices: a message for a main turn that is
   * actually running is injected into its next provider step synchronously
   * (the provider loop can claim it before the current step's
   * correction/error path decides the model ignored it); an idle main
   * agent gets a durable separate turn. Both paths journal the admitted
   * input, so replay sees what the model was told.
   */
  function deliverInternalWake(
    exec: SessionExecutionState,
    id: string,
    text: string,
  ) {
    const delivery = exec.activeTurnID ? "next-step" : "next-turn";
    if (delivery === "next-step") {
      const admitted = admitInput(exec.session, {
        id,
        text,
        delivery: "next-step",
        internal: true,
      });
      ctx.ports.publishForSession(
        exec,
        buildInputAdmission({
          id: admitted.id,
          text: admitted.text,
          internal: true,
          delivery: admitted.delivery,
          admittedAt: admitted.admittedAt,
          admittedSeq: admitted.admittedSeq,
        }),
      );
      logOf(ctx.state.serviceDirectory).info("collab-wake-inject", "", {
        id,
        sessionID: exec.session.id,
        admittedSeq: admitted.admittedSeq,
      });
      return delivery;
    }
    scheduleInternalWake(exec, { id, text, delivery });
    return delivery;
  }

  function wakeMainForCollaboration(
    exec: SessionExecutionState,
    sourceID: string,
    kind: string,
    source: "Navi" | "Nia" = "Navi",
  ) {
    if (ctx.ports.isDisposed()) return;
    const coordinator = sessionRunCoordinator(exec.session.id as SessionID);
    const delivery = exec.activeTurnID ? "next-step" : "next-turn";
    const id = `turn_collab_${sourceID.replace(/[^a-zA-Z0-9]/gu, "_")}`;
    const text =
      source === "Nia"
        ? `(internal collaboration wake: Nia sent a ${kind}; read her audit findings in <nia_collaborations>, perform the required remediation work now, then reply to Nia with what you changed. Do not acknowledge with chat alone. This is not a user message.)`
        : `(internal collaboration wake: ${source} sent a ${kind}; read the collaboration context. This is not a user message.)`;
    logOf(ctx.state.serviceDirectory).info("collab-wake-main", "", {
      source,
      kind,
      sourceID,
      sessionID: exec.session.id,
      delivery,
      coordinatorActive: coordinator.active,
    });
    deliverInternalWake(exec, id, text);
  }

  function scheduleInternalWake(
    exec: SessionExecutionState,
    input: SubmitInput,
  ) {
    const { isDisposed, submitInput } = ctx.ports;
    const { internalWakeTasks } = ctx.state;
    if (isDisposed()) return;
    logOf(ctx.state.serviceDirectory).info("collab-wake-submit", "scheduling", {
      id: input.id,
      sessionID: exec.session.id,
      delivery: input.delivery,
      text: input.text.slice(0, 160),
    });
    const task = submitInput(
      { ...input, internal: true },
      exec.session.id as SessionID,
    )
      .then((submitted) => {
        logOf(ctx.state.serviceDirectory).info(
          "collab-wake-submit",
          "admitted",
          {
            id: input.id,
            sessionID: exec.session.id,
            submittedID: submitted?.id,
          },
        );
        return submitted;
      })
      .catch((error) => {
        logOf(ctx.state.serviceDirectory).error(
          "collab-wake-submit",
          "FAILED",
          {
            id: input.id,
            sessionID: exec.session.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      })
      .finally(() => internalWakeTasks.delete(task));
    internalWakeTasks.add(task);
  }

  function requestNaviWake(exec: SessionExecutionState) {
    logOf(ctx.state.serviceDirectory).info("navi-wake", "requestNaviWake", {
      sessionID: exec.session.id,
    });
    const controller = ctx.state.serviceDirectory.getOptional(
      providerModelController,
    );
    const sessionID = exec.session.id as SessionID;
    // Mirror the main-agent policy: while Navi is already in a chat turn,
    // inject the wake at its next provider step instead of waiting for the
    // whole current turn to finish.
    if (
      controller?.naviBusy(sessionID) &&
      !exec.naviPendingQueue.some((item) =>
        item.messageID.startsWith("navi-collab-wake:"),
      )
    ) {
      exec.naviPendingQueue.push({
        messageID: `navi-collab-wake:${Date.now().toString(36)}`,
        text: "(internal collaboration wake: read <natalia_collaborations> for the latest Natalia message and respond according to the collaboration rules. This is not a user message.)",
      });
      return;
    }
    controller?.requestNaviWake(sessionID);
  }

  async function wakeNavi(exec: SessionExecutionState) {
    logOf(ctx.state.serviceDirectory).info("navi-wake", "wakeNavi start", {
      sessionID: exec.session.id,
    });
    const { publishForSession, nextChatSequence } = ctx.ports;
    const controller = ctx.state.serviceDirectory.getOptional(
      providerModelController,
    );
    if (!controller) return;
    const responseMessageID = `chat:${Date.now().toString(36)}:${nextChatSequence()}`;
    const expert = exec.advisorPending === true;
    const expertProfile = exec.naviChatModelProfile?.expert;
    const advisorModel = advisorModelFor(
      expertProfile,
      ctx.ports.getTsRuntimeConfig?.()?.runtime?.collaboration?.advisorModel,
    );
    if (expert) {
      publishForSession(
        exec,
        streamEvent({
          type: "navi.chat.message.new",
          id: `${responseMessageID}:advisor`,
          messageID: responseMessageID,
          role: "user",
          text: "(internal advisor request: Natalia consults you at a decision point. Read the Main context and give concise technical advice per the advisor contract; declining is legitimate when the question is outside your remit.)",
          at: new Date().toISOString(),
        }),
      );
      exec.advisorPending = false;
    }
    try {
      await controller.runNaviChatTurn({
        sessionID: exec.session.id as SessionID,
        text: "",
        responseMessageID,
        internal: true,
        ...(expert && advisorModel ? { model: advisorModel } : {}),
        reasoningEffort: expert ? expertProfile?.reasoningEffort : undefined,
      });
    } catch (cause) {
      publishForSession(
        exec,
        streamEvent({
          type: "navi.chat.message.new",
          id: `${responseMessageID}:chat`,
          messageID: responseMessageID,
          role: "chat",
          text: `(live work chat error: ${
            cause instanceof Error ? cause.message : String(cause)
          })`,
          at: new Date().toISOString(),
        }),
      );
    }
  }

  function requestNiaWake(exec: SessionExecutionState) {
    if (ctx.ports.isDisposed()) return;
    logOf(ctx.state.serviceDirectory).info("nia-wake", "requestNiaWake", {
      sessionID: exec.session.id,
    });
    const controller = ctx.state.serviceDirectory.getOptional(
      providerModelController,
    );
    const sessionID = exec.session.id as SessionID;
    // Same busy-turn policy as Navi: an active Nia turn claims the wake on its
    // next provider step; an idle Nia gets a fresh chat turn.
    if (
      controller?.niaBusy(sessionID) &&
      !exec.niaPendingQueue.some((item) =>
        item.messageID.startsWith("nia-collab-wake:"),
      )
    ) {
      exec.niaPendingQueue.push({
        messageID: `nia-collab-wake:${Date.now().toString(36)}`,
        text: "(internal collaboration wake: read the latest collaboration context and respond according to the Nia audit rules. This is not a user message.)",
      });
      return;
    }
    controller?.requestNiaWake(sessionID);
  }

  async function wakeNia(exec: SessionExecutionState) {
    const { nextChatSequence, publishForSession } = ctx.ports;
    const controller = ctx.state.serviceDirectory.getOptional(
      providerModelController,
    );
    if (!controller) {
      logOf(ctx.state.serviceDirectory).warn(
        "nia-wake",
        "wakeNia skipped: controller unavailable",
        {
          sessionID: exec.session.id,
        },
      );
      return;
    }
    const responseMessageID = `chat:${Date.now().toString(36)}:${nextChatSequence()}`;
    logOf(ctx.state.serviceDirectory).info("nia-wake", "wakeNia start", {
      sessionID: exec.session.id,
      responseMessageID,
      model: exec.niaChatModelProfile?.normal?.modelID,
    });
    try {
      const normalProfile = exec.niaChatModelProfile?.normal;
      await controller.runNiaChatTurn({
        sessionID: exec.session.id as SessionID,
        text: "",
        responseMessageID,
        internal: true,
        ...(normalProfile?.modelID
          ? {
              model: {
                modelID: normalProfile.modelID,
                variant: normalProfile.variant,
              },
            }
          : {}),
        reasoningEffort: normalProfile?.reasoningEffort,
      });
    } catch (cause) {
      publishForSession(
        exec,
        streamEvent({
          type: "nia.chat.message.new",
          id: `${responseMessageID}:chat`,
          messageID: responseMessageID,
          role: "chat",
          text: `(Nia wake error: ${
            cause instanceof Error ? cause.message : String(cause)
          })`,
          at: new Date().toISOString(),
        }),
      );
    }
  }
}
