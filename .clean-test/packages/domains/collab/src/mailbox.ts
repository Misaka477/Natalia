import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import {
  projectedMailboxMessages,
  sessionFactMailboxMessages,
  type ProjectedMailboxMessage,
} from "@anthelia/session";
import { buildMailboxStatus } from "@anthelia/runtime-services";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { ensureCompleteSessionFactState } from "@anthelia/substrate";
import { scanSessionWindowNewestFirst } from "@anthelia/substrate";
type Surface = Pick<
  RuntimeServiceClient,
  | "mailboxList"
  | "mailboxSend"
  | "mailboxDeliver"
  | "mailboxAcknowledge"
  | "mailboxDefer"
  | "mailboxSupersede"
>;
function redactToolOutput(output: string, redact: boolean | undefined) {
  if (!redact) return output;
  return output.replace(
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu,
    (match) =>
      `${match.slice(0, match.indexOf("=") >= 0 ? match.indexOf("=") + 1 : match.indexOf(":") + 1)}[REDACTED]`,
  );
}

async function mailboxExec(ctx: RuntimeContext, sessionID?: string) {
  if (sessionID)
    return (
      ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID) ??
      (await ctx.ports.ensureExecution(
        sessionID as import("@anthelia/contracts").SessionID,
      ))
    );
  return ctx.ports.getActiveExec();
}
async function mailboxesWithWorkerFallback(
  events: import("@anthelia/contracts").RuntimeEvent[],
) {
  try {
    const { runSessionProjectionInWorker } = await import(
      "@anthelia/substrate"
    );
    const result = await runSessionProjectionInWorker(
      "mailboxMessages",
      events,
    );
    return result as ReturnType<typeof projectedMailboxMessages>;
  } catch {
    return projectedMailboxMessages(events);
  }
}

/**
 * The full mailbox projection for a read surface. When the execution's
 * incremental hot state was seeded from the full log it already holds the whole
 * mailbox lifecycle, so the read never forces the journal; only a fast-attach
 * tail falls back to the explicit full load (which also completes the state).
 */
async function mailboxMessagesForRead(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
): Promise<ProjectedMailboxMessage[]> {
  if (exec.factStateComplete === true && exec.factState)
    return sessionFactMailboxMessages(exec.factState);
  await ensureCompleteSessionFactState(ctx, exec);
  return exec.factStateComplete === true && exec.factState
    ? sessionFactMailboxMessages(exec.factState)
    : await mailboxesWithWorkerFallback(exec.session.events);
}

/**
 * Whether a mailbox message matching `match` exists. Mailbox status is derived
 * from the whole lifecycle, so a still-open message is normally near the tail;
 * we only fall back to the full journal when an older window page cannot be
 * stitched.
 */
export async function findMailboxMessage(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  match: (message: ProjectedMailboxMessage) => boolean,
): Promise<ProjectedMailboxMessage | undefined> {
  const scan = await scanSessionWindowNewestFirst(
    ctx,
    exec,
    projectedMailboxMessages,
    match,
  );
  if (scan.kind === "found") return scan.item;
  if (scan.kind === "exhausted") return undefined;
  const messages = await mailboxMessagesForRead(ctx, exec);
  return messages.find(match);
}

export function createMailboxSurface(ctx: RuntimeContext): Surface {
  return {
    async mailboxList(sessionID?: string) {
      const exec = await mailboxExec(ctx, sessionID);
      if (!exec) return [];
      const messages = await mailboxMessagesForRead(ctx, exec);
      return messages.map((m) => ({
        messageID: m.messageID,
        source: m.source,
        priority: m.priority,
        intent: m.intent,
        text: m.text,
        safeSummary: m.safeSummary,
        ...(m.relatedPlanID ? { relatedPlanID: m.relatedPlanID } : {}),
        deliveryPolicy: m.deliveryPolicy,
        createdAt: m.createdAt,
        status: m.status,
        ...(m.reason ? { reason: m.reason } : {}),
      }));
    },
    async mailboxSend(input: {
      source?: "user_via_live_chat" | "system";
      priority?: "normal" | "high" | "urgent";
      intent: string;
      text: string;
      safeSummary?: string;
      relatedPlanID?: string;
      deliveryPolicy?: string;
      sessionID?: string;
    }) {
      return ctx.ports.enqueueMailboxForClient(input);
    },
    async mailboxDeliver(messageID: string, sessionID?: string) {
      const exec = await mailboxExec(ctx, sessionID);
      if (!exec || typeof messageID !== "string" || !messageID)
        return { delivered: false as const };
      const message = await findMailboxMessage(
        ctx,
        exec,
        (m) => m.messageID === messageID && m.status === "queued",
      );
      if (!message) return { delivered: false as const };
      ctx.ports.publishForSession(
        exec,
        buildMailboxStatus({
          id: `${messageID}:delivered:${ctx.ports.nextMailboxSequence()}`,
          messageID,
          status: "delivered",
          at: new Date().toISOString(),
        }),
      );
      return { delivered: true as const };
    },
    async mailboxAcknowledge(messageID: string, sessionID?: string) {
      const exec = await mailboxExec(ctx, sessionID);
      if (!exec || typeof messageID !== "string" || !messageID)
        return { acknowledged: false as const };
      const message = await findMailboxMessage(
        ctx,
        exec,
        (m) => m.messageID === messageID && m.status === "delivered",
      );
      if (!message) return { acknowledged: false as const };
      ctx.ports.publishForSession(
        exec,
        buildMailboxStatus({
          id: `${messageID}:acknowledged:${ctx.ports.nextMailboxSequence()}`,
          messageID,
          status: "acknowledged",
          at: new Date().toISOString(),
        }),
      );
      return { acknowledged: true as const };
    },
    async mailboxDefer(messageID: string, reason?: string, sessionID?: string) {
      const exec = await mailboxExec(ctx, sessionID);
      if (!exec || typeof messageID !== "string" || !messageID)
        return { deferred: false as const };
      const message = await findMailboxMessage(
        ctx,
        exec,
        (m) => m.messageID === messageID && m.status === "queued",
      );
      if (!message) return { deferred: false as const };
      ctx.ports.publishForSession(
        exec,
        buildMailboxStatus({
          id: `${messageID}:deferred:${ctx.ports.nextMailboxSequence()}`,
          messageID,
          status: "deferred",
          at: new Date().toISOString(),
          reason:
            redactToolOutput(reason ?? "", true).slice(0, 500) || undefined,
        }),
      );
      return { deferred: true as const };
    },
    async mailboxSupersede(
      messageID: string,
      reason?: string,
      sessionID?: string,
    ) {
      const exec = await mailboxExec(ctx, sessionID);
      if (!exec || typeof messageID !== "string" || !messageID)
        return { superseded: false as const };
      const message = await findMailboxMessage(
        ctx,
        exec,
        (m) => m.messageID === messageID && m.status === "queued",
      );
      if (!message) return { superseded: false as const };
      ctx.ports.publishForSession(
        exec,
        buildMailboxStatus({
          id: `${messageID}:superseded:${ctx.ports.nextMailboxSequence()}`,
          messageID,
          status: "superseded",
          at: new Date().toISOString(),
          reason:
            redactToolOutput(reason ?? "", true).slice(0, 500) || undefined,
        }),
      );
      return { superseded: true as const };
    },
  };
}
