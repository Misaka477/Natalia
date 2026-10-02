import type {
  RuntimeEvent,
  SettlementNotice,
  SettlementNoticeEventData,
  SettlementReason,
} from "@anthelia/contracts";
import type { ServiceDirectory } from "@anthelia/runtime-services";
import { logOf } from "@anthelia/operation-log";

/**
 * The settlement seam: the only shape the spine needs of an execution.
 * This package sits BELOW the substrate in the build graph (the substrate
 * references it), so the real type arrives at the instantiation site —
 * the house pattern the interactive waiter already uses (narrow
 * structural dependencies, not the runtime's concrete state).
 */
export type SettlementExec = { session: { id: string } };

/**
 * The settlement spine (the Natalia settlement plan's block 1): a
 * long-running thing — a managed process, a terminal pane, a subagent, a
 * team PR — reaches a boundary, and the main agent is TOLD instead of
 * left polling. The plan's study (dsh-settlement-study.zh-CN.md) proved
 * the shape against DeepSeek's harness: settle -> notice -> steer/queue,
 * with a closed reason taxonomy and the discipline written into the
 * tools ("you are told when one finishes").
 *
 * Three disciplines hold here:
 * 1. A notice is an INPUT, not a command — the model decides when to
 *    read it (the advisor contract's discipline, one layer up).
 * 2. Every notice is a durable fact — replay and audit see what the
 *    model was told, and the delivery itself journals the admitted input.
 * 3. A notice's failure degrades: a failed delivery warns and moves on,
 *    never failing the thing that settled (a crashed process must not
 *    become a failed process report because a notice could not fly).
 */

export type { SettlementNotice, SettlementReason } from "@anthelia/contracts";

/**
 * The model-facing internal message for a child's mid-run report. The
 * same notice-is-an-input shape as a settlement: it says who spoke and
 * what, and reading it is the model's choice. It never orders an action.
 */
export function subagentMessageText(agentId: string, text: string): string {
  return `(internal subagent message: ${agentId} reported mid-run. ${text} Read it with the matching tool when you choose; this is not a user message and needs no acknowledgement.)`;
}

/** The registry token for the settlement service (adapters resolve it). */
export const SETTLEMENT_SERVICE = "natalia.settlement.service";

/**
 * The service adapters (plugins) resolve: a session-scoped delivery that
 * finds the live execution and publishes+steers the notice. Plugins cannot
 * reach the runtime's ports directly — the boundary is this handle, bound
 * by the composition and looked up by name, exactly like the collaboration
 * service the Live Work Chat already resolves.
 */
export type SettlementService = {
  deliverForSession(sessionID: string, notice: SettlementNotice): boolean;
};

/** The producer kinds, named once so adopters share one vocabulary. */
export const SETTLEMENT_SOURCE_KINDS = {
  processExited: "process-exited",
  processReady: "process-ready",
  terminalSettled: "terminal-settled",
  terminalScrolled: "terminal-scrolled",
  subagentSettled: "subagent-settled",
  teamPr: "team-pr",
} as const;

/** The pure builder: the notice event, with the identity the id claims. */
export function buildSettlementNotice(input: {
  id: string;
  at: string;
  notice: SettlementNotice;
}): SettlementNoticeEventData {
  return {
    type: "settlement.notice",
    id: input.id,
    subject: input.notice.subject,
    reason: input.notice.reason,
    summary: input.notice.summary,
    ...(input.notice.detail === undefined
      ? {}
      : { detail: input.notice.detail }),
    sourceKind: input.notice.sourceKind,
    at: input.at,
  };
}

/**
 * The model-facing internal message for a notice. Kept deliberately in
 * the notice-is-an-input shape: it says what settled, why, and that the
 * model should read it when it chooses — it never orders an action.
 */
export function settlementNoticeText(notice: SettlementNotice): string {
  const detail = notice.detail ? ` ${notice.detail}` : "";
  return `(internal settlement notice: ${notice.subject} ${notice.reason}. ${notice.summary}${detail} Read it with the matching tool when you choose; this is not a user message and needs no acknowledgement.)`;
}

/**
 * The settlement surface bound to a runtime context: the adopters (the
 * process registry, the terminal controller, the subagent registry, the
 * team fan-out) call `deliver` at their boundaries; the spine owns the
 * event, the text and the degrade.
 */
/**
 * Publish a child's mid-run message and deliver it through the same
 * wake core the settlements use (a running turn steered at its next
 * step / an idle session a queued turn). A failed delivery degrades
 * like any notice's.
 */
export function deliverSubagentMessage<E extends SettlementExec>(
  ports: SettlementDeliveryPorts<E>,
  exec: E,
  message: { agentId: string; text: string },
): boolean {
  if (ports.isDisposed()) return false;
  try {
    const id = `submsg:${message.agentId}:${ports.nextSettlementSequence()}`;
    ports.publishForSession(exec, {
      type: "subagent.message",
      id,
      agentId: message.agentId,
      text: message.text,
      at: new Date().toISOString(),
    });
    ports.deliverInternalWake(
      exec,
      `turn_submsg_${id.replace(/[^a-zA-Z0-9]/gu, "_")}`,
      subagentMessageText(message.agentId, message.text),
    );
    return true;
  } catch (error) {
    logOf(ports.serviceDirectory).warn(
      "subagent-message",
      "delivery degraded",
      {
        sessionID: exec.session.id,
        agentId: message.agentId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return false;
  }
}

export function createSettlement<E extends SettlementExec>(input: {
  isDisposed(): boolean;
  publishForSession(exec: E, event: RuntimeEvent): void;
  deliverInternalWake(exec: E, id: string, text: string): string | undefined;
  nextSettlementSequence(): number;
  serviceDirectory: ServiceDirectory;
}) {
  return {
    deliver(
      exec: E,
      notice: SettlementNotice,
      options: { sessionID?: string } = {},
    ): boolean {
      return deliverSettlement(
        {
          isDisposed: input.isDisposed,
          publishForSession: input.publishForSession,
          deliverInternalWake: input.deliverInternalWake,
          nextSettlementSequence: input.nextSettlementSequence,
          serviceDirectory: input.serviceDirectory,
        },
        exec,
        notice,
        options,
      );
    },
    deliverChildMessage(
      exec: E,
      message: { agentId: string; text: string },
    ): boolean {
      return deliverSubagentMessage(
        {
          isDisposed: input.isDisposed,
          publishForSession: input.publishForSession,
          deliverInternalWake: input.deliverInternalWake,
          nextSettlementSequence: input.nextSettlementSequence,
          serviceDirectory: input.serviceDirectory,
        },
        exec,
        message,
      );
    },
    settlementNoticeText,
    buildSettlementNotice,
  };
}

export type SettlementDeliveryPorts<E extends SettlementExec> = {
  isDisposed(): boolean;
  publishForSession(exec: E, event: RuntimeEvent): void;
  /** The shared internal-wake delivery core (steer next step / queue a turn). */
  deliverInternalWake(exec: E, id: string, text: string): string | undefined;
  nextSettlementSequence(): number;
  serviceDirectory: ServiceDirectory;
};

/**
 * Publish the notice and deliver it: the durable fact first (replay and
 * audit), then the live delivery through the shared wake core — a running
 * turn is steered at its next step, an idle session gets a queued turn.
 * Returns whether the notice was delivered; a false is a degrade, not a
 * failure of the thing that settled.
 */
export function deliverSettlement<E extends SettlementExec>(
  ports: SettlementDeliveryPorts<E>,
  exec: E,
  notice: SettlementNotice,
  options: { sessionID?: string } = {},
): boolean {
  if (ports.isDisposed()) return false;
  const at = new Date().toISOString();
  const id = `settlement:${notice.sourceKind}:${notice.subject}:${ports.nextSettlementSequence()}`;
  try {
    ports.publishForSession(exec, buildSettlementNotice({ id, at, notice }));
    logOf(ports.serviceDirectory).info("settlement-notice", "delivered", {
      sessionID: exec.session.id,
      subject: notice.subject,
      reason: notice.reason,
      sourceKind: notice.sourceKind,
    });
    ports.deliverInternalWake(
      exec,
      `turn_settle_${id.replace(/[^a-zA-Z0-9]/gu, "_")}`,
      settlementNoticeText(notice),
    );
    return true;
  } catch (error) {
    // A notice that cannot fly is a warning, never a failure of the
    // thing that settled (the plan's third discipline).
    logOf(ports.serviceDirectory).warn(
      "settlement-notice",
      "delivery degraded",
      {
        sessionID: exec.session.id,
        subject: notice.subject,
        reason: notice.reason,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return false;
  }
}
