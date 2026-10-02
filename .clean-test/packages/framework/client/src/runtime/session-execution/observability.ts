import { statusSnapshotController } from "@anthelia/runtime-status";
import { dirname } from "node:path";
import { operationLog, readOperationRecords } from "@anthelia/operation-log";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
type Surface = Pick<
  RuntimeServiceClient,
  "runtimeStatus" | "diagnostics" | "sessionSnapshot" | "operationRecords"
>;
async function observabilityExec(ctx: RuntimeContext, sessionID?: string) {
  // Session snapshots may be the first routed call on a workspace proxy.
  await ctx.ports.ensureReady();
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

export function createObservabilitySurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async runtimeStatus(sessionID?: string) {
      await ctx.ports.ensureReady();
      const exec = await observabilityExec(ctx, sessionID);
      if (!exec) return await ctx.ports.runtimeStatusSnapshot();
      const status = ctx.state.serviceDirectory.get(statusSnapshotController);
      return {
        ...(await status.snapshotFor({
          provider: exec.provider,
          context: exec.context,
          permissionMode: exec.permissionMode,
        })),
        sessionID: exec.session.id,
      };
    },
    async diagnostics(limit = 100, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = await observabilityExec(ctx, sessionID);
      const entries = exec
        ? [
            ...ctx.ports.getRuntimeDiagnostics(),
            ...(ctx.ports
              .getRuntimeDiagnosticsBySession()
              .get(exec.session.id) ?? []),
          ]
        : ctx.ports.getRuntimeDiagnostics();
      return entries.slice(-Math.min(500, Math.max(1, limit)));
    },
    async operationRecords(input?: {
      level?: "error" | "warn" | "info" | "debug" | "trace";
      component?: string;
      contains?: string;
      since?: string;
      limit?: number;
    }) {
      // T3/T4: the telemetry zone's read face for a host. The operation log
      // owns its directory; an absent service (a bare runtime) answers
      // empty rather than guessing a path.
      const log = ctx.state.serviceDirectory.getOptional(operationLog);
      const path = log?.stats().path;
      if (!path) return [];
      return readOperationRecords(dirname(path), {
        ...(input?.level ? { level: input.level } : {}),
        ...(input?.component ? { component: input.component } : {}),
        ...(input?.contains ? { contains: input.contains } : {}),
        ...(input?.since ? { since: input.since } : {}),
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      });
    },
    async sessionSnapshot(sessionID) {
      const exec = await observabilityExec(ctx, sessionID);
      if (!exec) return undefined;
      return ctx.ports.currentSessionSnapshot(
        exec,
        `snapshot:live:${exec.session.id}`,
      );
    },
  };
}
