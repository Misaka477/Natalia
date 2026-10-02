import { randomUUID } from "node:crypto";
import { ensureSessionFullEvents } from "@anthelia/substrate";
import { createEventSink } from "../event-sink";
import type { SessionID } from "@anthelia/contracts";
import type { ProductRuntimeContext } from "@natalia/collab";
import { createProviderSelection } from "../provider-selection";
import { createTurnRunner } from "../turn-runner";
import { createExecuteCalls } from "../tool-execution/execute-calls";
import { createExecuteOne } from "../tool-execution/execute-one";
import { createCheckpointRuntime } from "../checkpoint-runtime";
import { createTitleGeneration } from "../title-generation";
import { createSelfReview } from "@natalia/engineering-intelligence";
import { skillService } from "@anthelia/runtime-services";
import { withProviderConcurrency } from "@anthelia/runtime";
import { createSessionAdmission } from "../session-admission";
import { createCommands } from "../commands";
import { discoverDesiredPluginEntries } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

export function wireExecution(
  ctx: ProductRuntimeContext,
  options: RealRuntimeClientOptions,
) {
  const { state, ports } = ctx;
  const eventSink = createEventSink(ctx, options);
  ports.publish = eventSink.publish;
  ports.publishForSession = eventSink.publishForSession;
  const providerSelection = createProviderSelection(ctx, options);
  ports.clientModelCatalog = providerSelection.clientModelCatalog;
  ports.effectiveMaxSteps = providerSelection.effectiveMaxSteps;
  ports.modelCapabilitiesForExecution =
    providerSelection.modelCapabilitiesForExecution;
  ports.providerRunnerInput = createTurnRunner(
    ctx,
    options,
  ).providerRunnerInput;
  ports.selectRuntimeModel = providerSelection.selectRuntimeModel;
  ports.applyAgentProvider = providerSelection.applyAgentProvider;
  ports.refreshExecutionContextConfig =
    providerSelection.refreshExecutionContextConfig;
  ports.currentModelImageInput = providerSelection.currentModelImageInput;
  ports.mediaTypeForImage = providerSelection.mediaTypeForImage;
  ports.redactToolOutputEnabled = providerSelection.redactToolOutputEnabled;
  ports.resolveContextStatusConfig =
    providerSelection.resolveContextStatusConfig;
  ports.modelRefKeyForSelection = providerSelection.modelRefKeyForSelection;
  ports.selectedModelRefKey = providerSelection.selectedModelRefKey;

  const executeCalls = createExecuteCalls(ctx, options);
  ports.executeToolCalls = executeCalls.executeToolCalls;
  ports.toolResultContent = executeCalls.toolResultContent;
  ports.checkConstitutionForTool = executeCalls.checkConstitutionForTool;
  ports.executeOneTool = createExecuteOne(ctx, options).executeOneTool;
  const checkpoint = createCheckpointRuntime(ctx);
  ports.getCheckpointRuntime = () => checkpoint;
  ports.initializeCheckpointController =
    checkpoint.initializeCheckpointController;
  const title = createTitleGeneration(ctx);
  // Discovery D4: the side-channel self-review rides the same turn lifecycle
  // (scheduled at turn end, superseded by the next admission) with the
  // session's OWN provider — captured first, run under the live
  // concurrency limiter (title's stream-wrap pattern), written only through
  // the skills service's validated boundary.
  ctx.state.selfReview = createSelfReview({
    enabled: () =>
      ctx.ports.getTsRuntimeConfig?.()?.backgroundReview?.enabled ?? true,
    provider: (sessionID) =>
      ctx.ports.getExecutionBySession().get(sessionID as SessionID)?.provider,
    runStream: (provider, request) =>
      withProviderConcurrency(
        ctx.ports.getProviderConcurrencyLimiter(),
        provider.provider,
        () => provider.stream(request),
        request.signal,
      ),
    events: (sessionID) =>
      ctx.ports.getExecutionBySession().get(sessionID as SessionID)?.session
        .events ?? [],
    disposed: () => ctx.ports.isDisposed(),
    skills: async () => {
      const existing = ctx.state.serviceDirectory.getOptional(skillService);
      if (existing) return existing;
      // Lazy-fiber ensure: discovery -> load(entry) -> lookup. The fibers
      // activate per relevant event; a background review has no tool
      // dispatch to spawn it, so it mounts its own write surface first.
      try {
        const entries = await discoverDesiredPluginEntries({
          pluginStoreRoot: options.pluginStoreRoot,
          workspaceRoot: options.workspaceRoot,
          declaredIDs: [],
          onError: (id, error) =>
            ctx.ports.publish({
              type: "diagnostic",
              level: "warning",
              owner: id,
              message: `plugin ${id} discover failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        const entry = entries.find(
          (candidate) => candidate.id === "natalia-skills",
        );
        if (entry) await ctx.ports.getPluginsController().load(entry);
      } catch {
        /* the skip below reports an unmountable surface honestly */
      }
      return ctx.state.serviceDirectory.getOptional(skillService);
    },
    publish: (event) => {
      const exec = ctx.ports
        .getExecutionBySession()
        .get((event.sessionID ?? "") as SessionID);
      if (exec) ctx.ports.publishForSession(exec, event);
      else ctx.ports.publish(event);
    },
    // The violations' seam: D1/D2's live facts for this session. The
    // review's hardest evidence; a wiring that cannot name them leaves
    // the seam unset and the review reports from the transcript alone.
    violations: (sessionID) => {
      const exec = ctx.ports
        .getExecutionBySession()
        .get(sessionID as SessionID);
      if (!exec) return [];
      // The full-events discipline: ensure the session's events are
      // materialized before reading their content (the same sanctioned
      // face the subagent history uses — the guard names every
      // full-event read).
      void ensureSessionFullEvents(ctx, exec);
      return exec.session.events.filter(
        (event) => event.type === "invariant.violation",
      );
    },
    // The growth lane's write surface: the proposals as ONE growth.proposed
    // fact, published to the session's journal. A FACT — it applies
    // nothing; the proposal interface, the verification gate and the
    // human read it from there.
    publishGrowth: ({ sessionID, fact }) => {
      const exec = ctx.ports
        .getExecutionBySession()
        .get(sessionID as SessionID);
      ctx.ports.publish(
        exec
          ? ({
              type: "growth.proposed",
              id: `growth-${randomUUID()}`,
              at: new Date().toISOString(),
              sessionID: sessionID as never,
              suggestions: fact.suggestions,
              considered: fact.considered,
            } as never)
          : ({
              type: "growth.proposed",
              id: `growth-${randomUUID()}`,
              at: new Date().toISOString(),
              suggestions: fact.suggestions,
              considered: fact.considered,
            } as never),
      );
    },
  });
  ports.cancelTitleGeneration = title.cancelTitleGeneration;
  ports.rememberTitleInput = title.rememberTitleInput;
  ports.submitInput = createSessionAdmission(ctx, options).submitInput;
  const commands = createCommands(ctx);
  ports.commandCatalogEntries = commands.commandCatalogEntries;
  ports.isPendingInteractiveRequest = commands.isPendingInteractiveRequest;
  return { providerSelection, checkpoint, title, commands };
}
