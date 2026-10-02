/**
 * Input admission — runtime/session-admission.ts.
 *
 * `submitInput` admits a user turn to a session: it applies the team-mode
 * directive, stores attachments, publishes the durable `input.admitted` fact,
 * wakes and runs the session's drain, and records the work graph agent node.
 * `turn.submitted` is published later, when a turn actually starts. Reads host
 * state through `RuntimeContext` at call time.
 */
import {
  admittedInputs,
  admitInput,
  buildInputAdmission,
  buildSubmittedTurn,
  sessionRunCoordinator,
} from "@anthelia/session";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { workLedgerController } from "@natalia/work-ledger";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import type {
  SessionID,
  SubmitInput,
  SubmittedTurn,
} from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { AttachmentService } from "@anthelia/runtime";

export function createSessionAdmission(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    submitInput,
  };

  async function submitInput(
    input: SubmitInput & { internal?: boolean },
    forSessionID?: SessionID,
  ) {
    const {
      getReady,
      isDisposed,
      getSessionID,
      ensureExecution,
      teamBehavior,
      publishForSession,
      getActiveExec,
      setLastSubmitted,
      rememberTitleInput,
      drainSessionFor,
    } = ctx.ports;
    const { turnSession } = ctx.state;
    await getReady();
    if (isDisposed()) throw new Error("runtime disposed");
    const attachmentService = ctx.state.serviceDirectory.get(
      attachmentServiceToken,
    );
    const workLedger = ctx.state.serviceDirectory.get(workLedgerController);
    const targetSessionID = (input.sessionID ??
      forSessionID ??
      getSessionID()) as SessionID;
    const targetExec = await ensureExecution(targetSessionID);
    if (isDisposed()) throw new Error("runtime disposed");
    const targetSession = targetExec.session;
    let text = input.text;
    // /team <message>: the user explicitly requests the agent team. Inject the
    // forcing directive into the turn's context and run the rest as a normal
    // turn — the model must decompose and fan out instead of working
    // sequentially. Handled here (not as a slash command) so the turn runs
    // normally instead of nesting a submit inside a command.
    const activeTeamBehavior = teamBehavior();
    if (activeTeamBehavior && text.trim().startsWith("/team")) {
      const message = text.trim().slice("/team".length).trim();
      if (!message) throw new Error("/team requires a message after it");
      targetExec.context.add({
        id: `team-mode:${targetExec.context.journalStatus().journalOffset}`,
        role: "system",
        content: activeTeamBehavior.directive(),
      });
      text = message;
    }
    const attachments = input.attachments?.length
      ? await attachmentService.store(input.attachments)
      : [];
    if (isDisposed()) throw new Error("runtime disposed");
    const id = input.id ?? `turn_${crypto.randomUUID().replace(/-/gu, "")}`;
    // The runtime API defaults to a separate turn; only the Composer opts into
    // mid-turn injection with an explicit `next-step`.
    const delivery = input.delivery ?? "next-turn";
    const submitted: SubmittedTurn = buildSubmittedTurn({
      id,
      text,
      attachments,
      resources: input.resources,
      agents: input.agents,
      internal: input.internal,
    });
    if (attachments.length)
      targetExec?.attachmentReferences.set(`${id}:user`, attachments);
    if (!targetSession)
      throw new Error("session initialization did not complete");
    const existing = admittedInputs(targetSession).find(
      (item) => item.id === id,
    );
    const admitted = admitInput(targetSession, {
      id,
      text,
      delivery,
      attachments,
      resources: input.resources,
      agents: input.agents,
      internal: input.internal,
    });
    const targetCoordinator = () => sessionRunCoordinator(targetSessionID);
    if (existing) {
      if (!existing.promotedAt && delivery === "next-step")
        void targetCoordinator().wake(drainSessionFor(targetSessionID));
      return submitted;
    }
    // A `next-step` admitted while a provider turn is running is claimed by
    // that turn's provider loop and published as `turn.input`. `coordinator
    // .active` alone is not enough: initialization and command drains are
    // active too, and a command turn has no provider step to claim the input.
    const injectable =
      delivery === "next-step" &&
      targetCoordinator().active &&
      Boolean(targetExec?.activeTurnID);
    targetExec.lastSubmitted = submitted;
    if (targetExec === getActiveExec()) setLastSubmitted(submitted);
    turnSession.set(id, targetSessionID);
    // Admission is durable and observable whether the input will be injected
    // or start its own turn; `turn.submitted` is published when a turn begins.
    publishForSession(
      targetExec,
      buildInputAdmission({
        id,
        text,
        attachments,
        resources: input.resources,
        agents: input.agents,
        internal: input.internal,
        delivery,
        admittedAt: admitted.admittedAt,
        admittedSeq: admitted.admittedSeq,
      }),
    );
    // One Work Graph node per turn. An injected input never starts a turn, so
    // it gets no node of its own.
    if (!injectable)
      publishForSession(
        targetExec,
        workLedger.agentActionNode({
          turnID: id,
          sessionID: targetSessionID,
          agent: targetExec?.selectedAgent?.name,
        }),
      );
    if (!input.internal) {
      rememberTitleInput(targetSessionID, text);
      ctx.state.initialize?.scheduleTitleGeneration?.(targetSessionID);
    }
    void targetCoordinator().wake(drainSessionFor(targetSessionID));
    return submitted;
  }
}
