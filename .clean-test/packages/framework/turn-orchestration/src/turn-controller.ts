import type {
  LocalAttachment,
  PromptAgentMention,
  PromptResourceMention,
} from "@anthelia/contracts";
import {
  admissionCutoff,
  admittedInputs,
  promoteInputToStep,
  promoteNextSteps,
  promoteNextTurn,
  removeAdmittedInput,
  replaceAdmittedInput,
} from "@anthelia/session";
import type {
  TurnController,
  TurnControllerInput,
} from "@anthelia/turn-orchestration";
import type {} from "@anthelia/runtime-services";

export function createTurnController(
  input: TurnControllerInput,
): TurnController {
  let disposed = false;

  function assertActive() {
    if (disposed) throw new Error("turn orchestration controller disposed");
  }

  async function persistInboxPromotion(sessionID: string) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return;
    const snapshot = structuredClone(session);
    await input.persist(() => input.saveInbox(snapshot));
  }

  async function drain(signal: AbortSignal, sessionID: string) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return;
    const abort = () => input.activeAbortFor(sessionID)?.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      const inputs = promoteNextSteps(session, admissionCutoff(session));
      if (inputs.length) await persistInboxPromotion(sessionID);
      for (const item of inputs) {
        if (signal.aborted) throw signal.reason;
        await admit(
          sessionID,
          item.id,
          item.text,
          item.attachments,
          item.resources,
          item.agents,
          item.internal,
          signal,
        );
      }
      if (
        !admittedInputs(session).some(
          (entry) => !entry.promotedAt && entry.delivery === "next-step",
        )
      )
        await drainQueue(signal, sessionID);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async function drainQueue(
    signal: AbortSignal | undefined,
    sessionID: string,
  ) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return;
    // The claim space is the durable journal, not this controller's
    // memory alone: two live clients over one session each hold their own
    // record, and a claim made in the other one's memory (already
    // persisted) would be invisible here — both would claim, and the turn
    // would run twice. But a wholesale adopt would also erase THIS
    // controller's own claims: its persist is a deferred chain, so a
    // claim made one iteration ago may not be on disk yet, and the next
    // iteration would re-promote the same input forever. Merge instead —
    // a local claim is sticky, the durable one fills the rest.
    const durableInbox = await input.loadInbox?.(sessionID);
    if (durableInbox) {
      const claims = new Map(
        durableInbox.map((item) => [item.id, item.promotedAt]),
      );
      session.inbox = admittedInputs(session).map((item) => ({
        ...item,
        promotedAt: item.promotedAt ?? claims.get(item.id),
      }));
      // Inputs another client submitted that this record has not seen.
      const known = new Set(admittedInputs(session).map((item) => item.id));
      for (const item of durableInbox)
        if (!known.has(item.id)) session.inbox.push(item);
    }
    while (true) {
      if (signal?.aborted) throw signal.reason;
      if (
        admittedInputs(session).some(
          (entry) => !entry.promotedAt && entry.delivery === "next-step",
        )
      )
        return;
      const [next] = promoteNextTurn(session);
      if (!next) return;
      await persistInboxPromotion(sessionID);
      if (signal?.aborted) throw signal.reason;
      await admit(
        sessionID,
        next.id,
        next.text,
        next.attachments,
        next.resources,
        next.agents,
        next.internal,
        signal,
      );
    }
  }

  async function admit(
    sessionID: string,
    id: string,
    text: string,
    attachments: LocalAttachment[] = [],
    resources: PromptResourceMention[] = [],
    agents: PromptAgentMention[] = [],
    internal?: boolean,
    signal?: AbortSignal,
  ) {
    assertActive();
    if (await input.runCommand(id, text, signal, sessionID)) {
      await input.flush();
      return;
    }
    await input.runTurn({
      id,
      text,
      sessionID,
      attachments,
      resources,
      agents,
      internal,
    });
  }

  async function persistPromotion(sessionID = input.session()?.id ?? "") {
    await persistInboxPromotion(sessionID);
  }

  async function removeInput(sessionID: string, id: string) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return undefined;
    const removed = removeAdmittedInput(session, id);
    if (!removed) return undefined;
    await persistInboxPromotion(sessionID);
    return removed;
  }

  async function replaceInput(sessionID: string, id: string, text: string) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return undefined;
    const replaced = replaceAdmittedInput(session, id, text);
    if (!replaced) return undefined;
    await persistInboxPromotion(sessionID);
    return replaced;
  }

  async function promoteInput(sessionID: string, id: string) {
    assertActive();
    const session = input.sessionFor(sessionID);
    if (!session) return undefined;
    const promoted = promoteInputToStep(session, id);
    if (!promoted) return undefined;
    await persistInboxPromotion(sessionID);
    return promoted;
  }

  function dispose() {
    disposed = true;
  }

  return {
    drain,
    drainQueue,
    admit,
    persistPromotion,
    removeInput,
    replaceInput,
    promoteInput,
    dispose,
  };
}
