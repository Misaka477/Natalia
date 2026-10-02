import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { checkpointFactory } from "@anthelia/checkpoint";
import {
  sandboxService,
  terminalController,
  type SandboxService,
  type TerminalController,
} from "@anthelia/runtime-services";
import { updateConfigAtScope } from "@anthelia/config";
import { cloneConfigInWorker } from "../secondary-worker-client";
import { sessionRunCoordinator } from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
import type { CheckpointFactory } from "@anthelia/checkpoint";
import type { SessionStoreController } from "@anthelia/session-store";
import { logOf, type OperationLog } from "@anthelia/operation-log";
type Surface = Pick<
  RuntimeServiceClient,
  | "dispose"
  | "shutdown"
  | "canReloadConfig"
  | "reloadConfig"
  | "updateConfig"
  | "configGet"
  | "drainForUpdate"
>;
/** How long one dispose sub-step may take before the next one runs. */
const DISPOSE_STEP_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.NATALIA_DISPOSE_STEP_TIMEOUT_MS ?? 2_000),
);

/**
 * Runs one dispose sub-step under a timeout and logs its duration. A hung
 * sub-step must not stop the ones that follow it — the durable session flush in
 * particular has to run even if an earlier worker/wake never settles.
 */
async function shutdownStep(
  label: string,
  work: () => Promise<unknown> | unknown,
  log: OperationLog,
): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(work),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.debug(
            "shutdown",
            `dispose.${label} stuck >${DISPOSE_STEP_TIMEOUT_MS}ms; continuing`,
          );
          resolve();
        }, DISPOSE_STEP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    log.debug(
      "shutdown",
      `dispose.${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    log.debug("shutdown", `dispose.${label} +${Date.now() - started}ms`);
  }
}

export function createLifecycleSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  const log = logOf(ctx.state.serviceDirectory);
  /** The surface under construction, so `shutdown` can delegate to `dispose`. */
  let disposeRuntime: () => Promise<void> = async () => undefined;
  const surface: Surface = {
    async configGet() {
      await ctx.ports.getReady();
      const config = ctx.ports.getTsRuntimeConfig();
      if (!config) throw new Error("runtime configuration is not initialized");
      try {
        return await cloneConfigInWorker(config);
      } catch {
        return structuredClone(config);
      }
    },
    /**
     * D3b step 1: wait until no execution carries an active turn. The
     * marker is cleared by the runner itself on finish (its own-id
     * guard at provider-runner), so a finished turn always unblocks
     * this loop; nothing is SET here, so a timeout leaves no sticky
     * state behind — the follow-up submit after a timed-out drain is
     * the regression test for that.
     */
    async drainForUpdate(input?: { timeoutMs?: number }): Promise<{
      waitedMs: number;
    }> {
      const timeoutMs = Math.max(
        200,
        Math.min(Math.round(input?.timeoutMs ?? 120_000), 600_000),
      );
      const started = Date.now();
      const deadline = started + timeoutMs;
      for (;;) {
        let active = 0;
        for (const exec of ctx.ports.getExecutionBySession().values())
          if (exec.activeTurnID) active += 1;
        if (active === 0) return { waitedMs: Date.now() - started };
        if (Date.now() >= deadline)
          throw new Error(
            `drainForUpdate: ${active} turn(s) still active after ${Date.now() - started}ms — a restart would drop them; retry when quiet`,
          );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          timer.unref?.();
        });
      }
    },
    async dispose() {
      const flushStart = Date.now();
      ctx.ports.setDisposed(true);
      await shutdownStep(
        "titleGeneration",
        () =>
          Promise.all(
            [...ctx.state.titleGenerationTasks.keys()].map(
              ctx.ports.cancelTitleGeneration,
            ),
          ),
        log,
      );
      ctx.ports.getTerminalCommandBuffer().clearAll();
      for (const exec of ctx.ports.getExecutionBySession().values()) {
        exec.activeAbort?.abort(new Error("runtime disposed"));
        exec.paused = false;
        for (const resolveWaiter of exec.pauseWaiters) resolveWaiter();
        exec.pauseWaiters = [];
      }
      // Persist the last <1s of streamed text before the store flushes/closes.
      ctx.ports.flushPendingPartialOutput?.();
      await shutdownStep(
        "runCoordinator",
        () =>
          Promise.all(
            [...ctx.ports.getExecutionBySession().keys()].map((id) =>
              sessionRunCoordinator(id).interrupt(),
            ),
          ),
        log,
      );
      await shutdownStep(
        "internalWakeTasks",
        () => Promise.allSettled([...ctx.ports.getInternalWakeTasks()]),
        log,
      );
      // A committed selection and other durable controls must reach disk before
      // a caller opens the same session in a replacement runtime. These three
      // run even if an earlier step timed out, so durable state is not lost.
      await shutdownStep(
        "sessionPersistence",
        () => ctx.ports.getSessionPersistence(),
        log,
      );
      const sessionStore = ctx.state.serviceDirectory.getOptional(
        sessionStoreController,
      );
      await shutdownStep(
        "sessionStoreFlush",
        () =>
          sessionStore
            ? Promise.all(
                [...ctx.ports.getExecutionBySession().keys()].map((id) =>
                  sessionStore.flush(id),
                ),
              )
            : undefined,
        log,
      );
      await shutdownStep(
        "sandboxClose",
        () => ctx.state.serviceDirectory.getOptional(sandboxService)?.close(),
        log,
      );
      await shutdownStep(
        "terminalClose",
        () =>
          ctx.state.serviceDirectory.getOptional(terminalController)?.close(),
        log,
      );
      const checkpointClose = ctx.state.serviceDirectory.getOptional(
        checkpointFactory,
      ) as (CheckpointFactory & { close?(): void }) | undefined;
      checkpointClose?.close?.();
      await shutdownStep(
        "pluginsClose",
        () => ctx.ports.getPluginsController().close(),
        log,
      );
      ctx.state.frameworkServices?.close();
      await shutdownStep(
        "performanceTrace",
        () => ctx.ports.getPerformanceTrace().stop(),
        log,
      );
      logOf(ctx.state.serviceDirectory).debug(
        "shutdown",
        `dispose total +${Date.now() - flushStart}ms`,
      );
    },
    // The explicit exit path (`session.shutdown` over RPC). A window that hides
    // on close leaves the process alive, so something has to be able to end it
    // that is not a signal or a task manager. It IS dispose rather than a second
    // teardown: the graceful shutdown already does everything needed (flush,
    // interrupt, close), and one implementation is why the RPC path and the
    // host's own lifecycle cannot drift apart.
    async shutdown() {
      await disposeRuntime();
    },
    async canReloadConfig() {
      await ctx.ports.getReady();
      const blocked = ctx.ports.configReloadBlockedReason();
      return blocked ? { allowed: false, reason: blocked } : { allowed: true };
    },
    async reloadConfig() {
      await ctx.ports.getReady();
      // Re-checked here rather than trusting `canReloadConfig`: a turn can start
      // between the two calls, and applying new policy underneath a running turn
      // would change the rules it started under.
      return await ctx.ports.applyConfigFromDisk();
    },
    async updateConfig(input) {
      await ctx.ports.getReady();
      const patch = normalizeProviderRenamePatch(
        input.patch as never,
        ctx.ports.getTsRuntimeConfig(),
        log,
      ) as never;
      logOf(ctx.state.serviceDirectory).info("updateConfig", "begin", {
        args: [
          input.scope,
          "globalPath",
          options.globalConfigPath,
          JSON.stringify(patch, null, 2).slice(0, 4000),
        ],
      });
      // The TUI settings menu path, now a public surface: merge the patch onto
      // disk, then apply. The file is written either way; whether it takes
      // effect under a running turn is an ordinary answer, not an exception.
      // Idempotent by patch: the same patch merged twice produces the same
      // merged config.
      try {
        await updateConfigAtScope(
          ctx.ports.getWorkspaceRoot(),
          patch,
          input.scope ?? "project",
          { globalPath: options.globalConfigPath },
        );
        logOf(ctx.state.serviceDirectory).info("updateConfig", "file written");
      } catch (error) {
        logOf(ctx.state.serviceDirectory).error(
          "updateConfig",
          "write failed",
          { error },
        );
        throw error;
      }
      // Applying is the same operation as a reload, with the same value-type
      // refusal; share it so the two paths cannot drift.
      const outcome = await ctx.ports.applyConfigFromDisk();
      logOf(ctx.state.serviceDirectory).info("updateConfig", "applied", {
        args: [outcome.applied, outcome.reason],
      });
      return outcome;
    },
  };
  // `shutdown` delegates to `dispose` by reference, so the pair cannot drift.
  disposeRuntime = async () => {
    await surface.dispose?.();
  };
  return surface;
}

function normalizeProviderRenamePatch(
  patch: Record<string, unknown>,
  currentConfig: import("@anthelia/contracts").ConfigV3 | undefined,
  log: OperationLog,
): Record<string, unknown> {
  const providersPatch = patch.providers as Record<string, unknown> | undefined;
  if (!providersPatch) return patch;
  const currentProviders = currentConfig?.providers ?? {};
  const result: Record<string, unknown> = {
    ...patch,
    providers: { ...providersPatch },
  };
  const catalogPatch = patch.catalog as
    | { providers?: Record<string, unknown> }
    | undefined;
  const nextCatalog: { providers: Record<string, unknown> } | undefined =
    catalogPatch
      ? { providers: { ...(catalogPatch.providers ?? {}) } }
      : undefined;
  for (const [key, value] of Object.entries(providersPatch)) {
    if (value === undefined) continue;
    const provider = value as {
      name?: string;
      connection?: { baseURL?: string; apiKey?: string };
    };
    const match = Object.keys(currentProviders).find(
      (oldKey) =>
        oldKey !== key &&
        (currentProviders[oldKey]?.name === provider.name ||
          (currentProviders[oldKey]?.connection?.baseURL ===
            provider.connection?.baseURL &&
            currentProviders[oldKey]?.connection?.apiKey ===
              provider.connection?.apiKey)),
    );
    if (match) {
      (result.providers as Record<string, unknown>)[match] = undefined;
      if (nextCatalog) {
        if (nextCatalog.providers[key])
          nextCatalog.providers[match] = undefined;
        result.catalog = nextCatalog;
      }
      log.info("updateConfig", "provider rename inferred", {
        args: [match, "->", key],
      });
    }
  }
  return result;
}
