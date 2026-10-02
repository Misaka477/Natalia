import type { InitializeOptions, RuntimeContext } from "@anthelia/substrate";
import { configureCatalog } from "./config-catalog";
import { configureRuntime } from "./config-runtime";
import { resolveServices } from "./services";
import { createSubagentSupport } from "./subagent-support";
import { createSubagentTools } from "./subagent-tools";
import { installSubagents } from "./subagent-runner";
import { recoverSession } from "./session-recovery";
import { finalizeInitialize } from "./finalize";
import { perfLog } from "@anthelia/runtime-services";
import {
  reloadProviderAdapterModules,
  providerAdapterModuleRequests,
} from "@anthelia/runtime";

export function createInitialize(
  ctx: RuntimeContext,
  options: InitializeOptions,
) {
  async function initialize() {
    const initStart = performance.now();
    const mark = (name: string) =>
      perfLog(
        `[perf] initialize ${name} +${(performance.now() - initStart).toFixed(1)}ms`,
      );
    mark("start");
    try {
      const config = await configureCatalog(ctx, options);
      mark("configureCatalog");
      // Custom provider adapters load once, here, before any dispatch: dynamic
      // import is asynchronous and `providerFromKind` is not, so registering
      // eagerly is what keeps the request path synchronous. A module that fails
      // is reported rather than thrown, so one broken adapter does not stop the
      // session from starting.
      const adapterResults = await reloadProviderAdapterModules({
        workspaceRoot: ctx.ports.getWorkspaceRoot(),
        requests: providerAdapterModuleRequests(config.runtimeConfig.providers),
      });
      for (const result of adapterResults) {
        if (!result.ok)
          ctx.ports.publish({
            type: "diagnostic",
            level: "warning",
            message:
              `provider adapter module for "${result.providerID}" did not ` +
              `load (${result.module}): ${result.error}`,
          });
      }
      mark("providerAdapterModules");
      await configureRuntime(ctx, options, config);
      mark("configureRuntime");
    } catch (error) {
      ctx.ports.publish({
        type: "diagnostic",
        level: "warning",
        message: `TS config was not used: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (options.permissionProfile) throw error;
    }
    await resolveServices(ctx, options);
    mark("resolveServices");
    const support = await createSubagentSupport(ctx, options);
    const toolSupport = await createSubagentTools(ctx, options, support);
    mark("subagentSupport");
    await installSubagents(ctx, options, { ...support, ...toolSupport });
    mark("installSubagents");
    const recovery = await recoverSession(ctx, options);
    mark("recoverSession");
    await finalizeInitialize(ctx, options, recovery);
    mark("finalizeInitialize");
  }

  return { initialize };
}
