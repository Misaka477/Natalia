/**
 * Delivering a managed process's exit to the session that started it.
 *
 * The process plugin owns the registry and the observer that watches it, but a
 * plugin cannot write into a session: the tool context has no publishing surface,
 * and that boundary is deliberate. So the plugin publishes the observer under a
 * service name and this module — which does own sessions — subscribes to it.
 *
 * The notice lands in the ledger as a `role:"dynamic"` entry, the same shape the
 * plan pointer and the subagent settled notice use: it renders as a user message
 * rather than a system one, so appending it after the conversation does not hoist
 * anything to the top and reset the stable prefix.
 */

import {
  PROCESS_OBSERVER_SERVICE,
  type ProcessObserverService,
} from "@anthelia/tools";
import type { SessionID } from "@anthelia/contracts";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";

/** Entry id for one process's terminal notice. */
function noticeEntryID(processID: string) {
  return `process_settled:${processID}`;
}

/** The model-visible content of one notice. */
function noticeContent(input: {
  processID: string;
  command: string;
  status: string;
  exitCode?: number;
}): string {
  const ending =
    input.exitCode === undefined
      ? input.status
      : `${input.status} (exit code ${input.exitCode})`;
  return [
    `<runtime_context source="process_settled" trust="runtime" process_id="${input.processID}">`,
    `The background process you started has finished: ${ending}.`,
    `Command: ${input.command}`,
    "This is the runtime reporting the outcome. Use process_output to read its " +
      "log, or process_start to run it again.",
    `</runtime_context>`,
  ].join("\n");
}

/**
 * Subscribe to process exits and write each into its starting session.
 *
 * Subscribed through `onServiceUpdate` rather than a one-shot lookup because the
 * plugin providing the observer loads asynchronously: a direct `service()` call
 * during composition would find nothing and silently never receive a notice.
 */
export function wireProcessSettledNotices(
  ctx: RuntimeContext,
  capabilityRegistry: {
    service<T>(name: string): T | undefined;
    onServiceUpdate(listener: () => void): () => void;
  },
): () => void {
  const seen = new Set<string>();
  let unsubscribe: (() => void) | undefined;

  const attach = (observer: ProcessObserverService | undefined) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (!observer) return;
    unsubscribe = observer.subscribe((notice) => {
      // One notice per process: a process settles once, and a second entry would
      // read as a second process having finished.
      if (seen.has(notice.id)) return;
      seen.add(notice.id);
      if (!notice.sessionID) return;
      const exec = ctx.ports
        .getExecutionBySession()
        .get(notice.sessionID as SessionID) as
        | SessionExecutionState
        | undefined;
      if (!exec) return;
      exec.context.add({
        id: noticeEntryID(notice.id),
        role: "dynamic",
        content: noticeContent({
          processID: notice.id,
          command: notice.command,
          status: notice.status,
          ...(notice.exitCode === undefined
            ? {}
            : { exitCode: notice.exitCode }),
        }),
      });
    });
  };

  // The update carries no value — only that something changed — so the observer
  // is re-read rather than taken from the notification. A re-read is also what
  // makes a provider swap correct: the new observer replaces the old subscription
  // instead of stacking a second one beside it.
  const offUpdate = capabilityRegistry.onServiceUpdate(() => {
    attach(
      capabilityRegistry.service<ProcessObserverService>(
        PROCESS_OBSERVER_SERVICE,
      ),
    );
  });
  // The plugin may already be loaded, in which case no update will arrive.
  attach(
    capabilityRegistry.service<ProcessObserverService>(
      PROCESS_OBSERVER_SERVICE,
    ),
  );

  return () => {
    offUpdate();
    unsubscribe?.();
  };
}
