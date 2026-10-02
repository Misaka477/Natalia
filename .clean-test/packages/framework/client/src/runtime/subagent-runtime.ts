/**
 * Subagent read surface exposed over RuntimeClient.
 *
 * This is the framework-side lazy projection: subagent records are owned by
 * the durable subagent registry, not reconstructed from the transcript event
 * stream. Keeping it here (framework/runtime) means the web/TUI transport can
 * reuse the same RPC without a plugin depending on view-store internals.
 */
import type {
  RuntimeEvent,
  RuntimeSubagentView,
  SessionID,
} from "@anthelia/contracts";
import type { SubagentRecordView } from "@anthelia/tools";
import {
  subagentsService,
  type SubagentsService,
} from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { subagentHistoryInWorker } from "@anthelia/substrate";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import {
  ensureSessionEventWindow,
  sessionWindowEvents,
} from "@anthelia/substrate";
import { projectSubagentsInWorker } from "./secondary-worker-client";
import { paginateTranscript } from "@anthelia/substrate";
import { perfLog } from "@anthelia/runtime-services";

export function createSubagentRuntime(
  ctx: RuntimeContext,
): Pick<
  RuntimeServiceClient,
  "subagents" | "subagentHistory" | "subagentHistoryPage"
> {
  return {
    async subagents(sessionID?: string): Promise<RuntimeSubagentView[]> {
      await ctx.ports.getReady();
      const start = performance.now();
      const subagents =
        ctx.state.serviceDirectory.getOptional(subagentsService);
      if (!subagents?.enabled()) return [];
      const ownerSessionID = sessionID ?? ctx.ports.getActiveExec()?.session.id;
      const records = subagents
        .list()
        .filter(
          (record) =>
            !ownerSessionID ||
            !record.parentSessionID ||
            record.parentSessionID === ownerSessionID,
        );
      let result: RuntimeSubagentView[];
      try {
        result = await projectSubagentsInWorker(
          records.map((record) => ({
            record,
            health: subagents.health(record.id),
          })),
        );
      } catch {
        result = records.map((record) => toSubagentView(record, subagents));
      }
      perfLog(
        `[perf] subagents done count=${result.length} +${(performance.now() - start).toFixed(1)}ms`,
      );
      return result;
    },
    async subagentHistory(
      sessionID?: SessionID,
    ): Promise<RuntimeSubagentView[]> {
      await ctx.ports.getReady();
      const start = performance.now();
      const exec = sessionID
        ? ctx.ports.getExecutionBySession().get(sessionID)
        : ctx.ports.getActiveExec();
      if (!exec) return [];
      // Sub-agent history reads the shared window. Full history is a
      // deliberate escape hatch for inspector/search paths, not startup.
      const window = await ensureSessionEventWindow(ctx, exec);
      const events = window
        ? sessionWindowEvents(exec, window)
        : exec.session.events;
      let result: RuntimeSubagentView[];
      try {
        result = await subagentHistoryInWorker(events);
      } catch {
        result = events.filter(
          (
            event,
          ): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
            event.type === "subagent.update",
        );
      }
      perfLog(
        `[perf] subagentHistory done count=${result.length} +${(performance.now() - start).toFixed(1)}ms`,
      );
      return result;
    },
    async subagentHistoryPage(input) {
      await ctx.ports.getReady();
      const exec = input.sessionID
        ? ctx.ports.getExecutionBySession().get(input.sessionID as SessionID)
        : ctx.ports.getActiveExec();
      if (!exec) return { data: [], cursor: {} };
      // Pages are projected from the durable log; the legacy array surface
      // remains the bounded tail caller for non-inspector consumers.
      await ensureSessionFullEvents(ctx, exec);
      let result: RuntimeSubagentView[];
      try {
        result = await subagentHistoryInWorker(exec.session.events);
      } catch {
        result = exec.session.events.filter(
          (
            event,
          ): event is Extract<RuntimeEvent, { type: "subagent.update" }> =>
            event.type === "subagent.update",
        );
      }
      return paginateTranscript(
        input.subagentID
          ? result.filter((event) => event.id === input.subagentID)
          : result,
        input.cursor,
        input.limit,
        "subagent",
      );
    },
  };
}

function toSubagentView(
  record: SubagentRecordView,
  subagents: SubagentsService,
): RuntimeSubagentView {
  return {
    type: "subagent.update",
    id: record.id,
    status: record.status,
    attached: record.attached,
    event: "status",
    task: record.task,
    ...(record.parentSessionID !== undefined
      ? { parentSessionID: record.parentSessionID }
      : {}),
    ...(record.parentAgentID !== undefined
      ? { parentAgentID: record.parentAgentID }
      : {}),
    ...(record.continuation !== undefined
      ? { continuation: record.continuation }
      : {}),
    phase: record.phase,
    activityDetail: record.activityDetail,
    health: subagents.health(record.id),
    lastActivityAt: record.lastActivityAt,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
  };
}
