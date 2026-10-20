import { statusSnapshotController } from "@anthelia/runtime-status";
import { compositionProfile } from "@anthelia/composition";
import { dirname } from "node:path";
import { operationLog, readOperationRecords } from "@anthelia/operation-log";
import { logService, parseLogSpec } from "@anthelia/logging";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import { effectiveConfinementMode } from "../tool-execution/execute-context";
import type { ClientSurfaceOptions } from "./types";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
type Surface = Pick<
  RuntimeServiceClient,
  | "runtimeStatus"
  | "diagnostics"
  | "sessionSnapshot"
  | "operationRecords"
  | "setLogVerbosity"
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
          // BOTH axes, and the sandbox half is THIS session's.
          //
          // Omitting it was measured: the controller's own `confinement` input
          // resolves through `getActiveExec()`, which is the wrong session the
          // moment a caller names one — and a front end that cannot pair the
          // rung drops to a fallback that names no rung at all (the permission
          // selector rendered its 「选择权限」 placeholder over a session
          // standing on `auto`, because `read_only + workspace-write` is not
          // one of the four rungs and the trigger then held the raw
          // agent-mode string). `runtime.status` is the one read a front end
          // makes on every attach, so it is the one place the pair has to
          // arrive complete.
          confinement:
            exec.sandboxModeOverride ??
            effectiveConfinementMode({
              profile:
                ctx.state.serviceDirectory.getOptional(compositionProfile),
              configMode: ctx.ports.getTsRuntimeConfig()?.confinement?.mode,
            }),
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
    async setLogVerbosity(spec: string) {
      // The live valve (audit 缺口 6): `NATALIA_LOG` is read once at boot,
      // so raising verbosity on a session that is already misbehaving used
      // to mean a restart — which destroys the state being diagnosed. The
      // spec is the boot spelling (`debug`, `name=debug,other=warn`); the
      // service's own parser keeps the two paths identical, and the answer
      // is the table that took effect so the caller can see what it got.
      await ctx.ports.ensureReady();
      const trimmed = spec?.trim();
      if (!trimmed)
        return { ok: false as const, reason: "a log spec is required" };
      const levels = parseLogSpec(trimmed);
      logService.setLevels(levels);
      return {
        ok: true as const,
        levels,
        // What a reader should expect: the boot spec's own semantics — an
        // unnamed level is the default, and a restart would have re-read
        // the env over this. Say so rather than letting the caller assume.
        note: "applied to the live process; a restart re-reads NATALIA_LOG",
      };
    },
  };
}
