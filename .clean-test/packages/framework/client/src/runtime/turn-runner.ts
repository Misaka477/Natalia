/**
 * Turn runner input — runtime/turn-runner.ts.
 *
 * `providerRunnerInput` builds the TurnRunner input object for a session: the
 * provider/session/context/tools bindings, the model capability gates, the
 * collaboration surfaces (mailbox, Navi suggestions/answers/chats), the active
 * plan projection, and the runtime seams (approval, policy, persistence,
 * checkpoint, tool execution). Reads host state through `RuntimeContext` at
 * call time.
 */
import { providerForModel } from "@anthelia/runtime";
import { foldProviderCacheUsage } from "@anthelia/rina";
import { staticSystemPrompt } from "@natalia/agent-prompts";
import {
  claimNextSteps,
  projectedCollabMessages,
  sessionFactCollabMessages,
} from "@anthelia/session";
import type { ProviderRunnerInput } from "@anthelia/runtime-services";
import { statusSnapshotController } from "@anthelia/runtime-status";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import { retryService } from "@anthelia/retry";
import { compactionService } from "@anthelia/compaction";
import { mcpService } from "@anthelia/runtime-services";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { activePlanForExec } from "@natalia/collab";
import { loadProjectDocumentsSync } from "@natalia/engineering-intelligence";
import { compositionProfile } from "@anthelia/composition";
import { effectiveConfinementMode } from "./tool-execution/execute-context";
import { logOf } from "@anthelia/operation-log";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
import type { AttachmentService } from "@anthelia/runtime";

function collabMessagesForExec(
  exec: SessionExecutionState,
): ReturnType<typeof projectedCollabMessages> {
  // The hot state holds the complete collab slice even when session.events is a
  // fast-attach tail; prefer it over the (possibly tail-based) snapshot.
  if (exec.factStateComplete === true && exec.factState)
    return sessionFactCollabMessages(exec.factState);
  const snapshot = exec.collabSnapshot;
  if (snapshot && snapshot.eventCount === exec.session.events.length)
    return snapshot.collabMessages;
  return projectedCollabMessages(exec.session.events);
}

export function createTurnRunner(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  return {
    providerRunnerInput,
  };

  function providerRunnerInput(
    sessionID: import("@anthelia/contracts").SessionID,
  ): ProviderRunnerInput {
    const {
      getAgentRegistry,
      getActiveExec,
      getWorkspaceRoot,
      getTsRuntimeConfig,
      publishForSession,
      modelCapabilitiesForExecution,
      refreshExecutionContextConfig,
      skillsList,
      skillService,
      applyAgentPolicy,
      applyAgentProvider,
      persistInboxPromotion,
      initializeCheckpointController,
      isToolAllowed,
      setInFlightOperationFor,
      executeToolCalls,
      reloadConfigFromDisk,
      effectiveMaxSteps,
      waitIfPaused,
      setActiveAbort,
      setActiveTurnID,
      setSelectedAgent,
      setPendingAgent,
    } = ctx.ports;
    const { executionBySession, tools } = ctx.state;
    const exec = executionBySession.get(sessionID);
    if (!exec) throw new Error(`no execution state for session ${sessionID}`);
    const compaction = ctx.state.serviceDirectory.get(compactionService);
    const attachmentService = ctx.state.serviceDirectory.get(
      attachmentServiceToken,
    );
    const statusController = ctx.state.serviceDirectory.get(
      statusSnapshotController,
    );
    if (!statusController)
      throw new Error(
        "status snapshot controller unavailable (natalia-runtime-ui)",
      );
    const retry = ctx.state.serviceDirectory.get(retryService);
    const activeExec = getActiveExec();
    return {
      staticSystemPrompt,
      provider: () => {
        if (exec.provider) return exec.provider;
        const config = ctx.ports.getTsRuntimeConfig();
        const fallback = config?.defaultModel
          ? providerForModel(config, config.defaultModel, undefined, {
              // T3: the adapter's diagnostics ride the operation log.
              log: logOf(ctx.state.serviceDirectory),
            })
          : undefined;
        if (fallback) exec.provider = fallback;
        return exec.provider;
      },
      session: () => exec.session,
      context: () => exec.context,
      tokenMeter: () => exec.tokenMeter,
      tools: () => tools,
      attachmentReferences: () => exec.attachmentReferences,
      attachments: attachmentService,
      compaction: compaction,
      mcp: () => ctx.state.serviceDirectory.getOptional(mcpService),
      agentRegistry: () => getAgentRegistry(),
      activeAbort: () => exec.activeAbort,
      setActiveAbort: (controller) => {
        exec.activeAbort = controller;
        if (exec === activeExec) setActiveAbort(controller);
      },
      activeTurnID: () => exec.activeTurnID,
      setActiveTurnID: (id) => {
        exec.activeTurnID = id;
        if (exec === activeExec) setActiveTurnID(id);
      },
      selectedAgent: () => exec.selectedAgent,
      setSelectedAgent: (agent) => {
        exec.selectedAgent = agent;
        if (exec === activeExec) setSelectedAgent(agent);
      },
      // The session's date, snapshotted when its execution state was built and
      // rolled forward only by appending a notice — never by rewriting history.
      sessionStartedAt: () => exec.sessionStartedAt,
      sessionCurrentDate: () => exec.currentDate,
      recordSessionDate: (date) => {
        exec.currentDate = date;
      },
      pendingAgent: () => exec.pendingAgent,
      setPendingAgent: (agent) => {
        exec.pendingAgent = agent;
        if (exec === activeExec) setPendingAgent(agent);
      },
      selectedModel: () => exec.selectedModel,
      modelCapabilities: () => modelCapabilitiesForExecution(exec),
      setActiveModelCapabilities: (capabilities) => {
        exec.activeModelCapabilities = capabilities;
      },
      refreshContextConfig: () => refreshExecutionContextConfig(exec),
      permissionMode: () => exec.permissionMode,
      workspaceRoot: () => getWorkspaceRoot(),
      tsRuntimeConfig: () => getTsRuntimeConfig(),
      runtimeContextConfig: () => exec.runtimeContextConfig,
      activeSkill: () => exec.activeSkill,
      skillsList,
      skillService,
      naviSuggestions: () =>
        collabMessagesForExec(exec)
          .filter(
            (message): message is typeof message & { kind: "suggestion" } =>
              message.kind === "suggestion" && message.status === "pending",
          )
          .map((message) => ({
            id: message.id,
            suggestion: message.text,
            priority: message.priority ?? "normal",
          })),
      naviAnswers: () =>
        collabMessagesForExec(exec)
          .filter((message) => message.kind === "answer")
          .map((message) => ({
            questionID: message.questionID ?? "",
            answer: message.text,
          })),
      naviChats: () =>
        collabMessagesForExec(exec).flatMap((message) =>
          message.kind === "chat" &&
          (message.from === "main_agent" || message.to === "main_agent") &&
          (message.from === "live_chat" || message.to === "live_chat")
            ? [
                {
                  id: message.id,
                  threadID: message.threadID ?? "",
                  from: message.from,
                  to: message.to,
                  text: message.text,
                  round: message.round ?? 1,
                  expectsReply: message.expectsReply ?? false,
                  status: message.status,
                },
              ]
            : [],
        ),
      naviIntro: () =>
        collabMessagesForExec(exec).some(
          (message) =>
            (message.from === "main_agent" || message.to === "main_agent") &&
            (message.from === "live_chat" || message.to === "live_chat"),
        ),
      niaChats: () =>
        collabMessagesForExec(exec).flatMap((message) =>
          message.kind === "chat" &&
          (message.from === "nia" || message.to === "nia")
            ? [
                {
                  id: message.id,
                  threadID: message.threadID ?? "",
                  from: message.from,
                  to: message.to,
                  text: message.text,
                  round: message.round ?? 1,
                  expectsReply: message.expectsReply ?? false,
                  status: message.status,
                },
              ]
            : [],
        ),
      niaIntro: () =>
        collabMessagesForExec(exec).some(
          (message) => message.from === "nia" || message.to === "nia",
        ),
      activePlan: () => {
        const plan = activePlanForExec(ctx, exec);
        if (!plan) return undefined;
        return {
          planID: plan.planID,
          version: 1,
          title: plan.title,
          objective: plan.documentPath,
          steps: [],
          constraints: [],
          verification: [],
          riskNotes: [],
        };
      },
      // ADR D2 / EI §8.5: the project documents (AGENTS.md and
      // .natalia/constitution.md) load per turn and carry a content hash; a
      // document edit changes the hash, the rendered block changes, and the
      // runtime re-appends on change instead of mutating earlier messages.
      projectDocuments: () => {
        const snapshot = loadProjectDocumentsSync(getWorkspaceRoot());
        return snapshot?.documents.length ? snapshot : undefined;
      },
      // The agent layer of the danger design (sandbox study §6b①): the
      // session's CURRENT confinement mode, stated per turn in the
      // environment block — the tool schema advertises the escalation
      // targets, this says where the agent IS. The dynamic layer, so the
      // cached prefix stays stable.
      confinementMode: () =>
        effectiveConfinementMode({
          profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
          configMode: getTsRuntimeConfig()?.confinement?.mode,
        }),
      // T3: the turn's telemetry rides the operation log, not the console.
      // The ALS scope the runtime zone wraps the turn body in carries the
      // correlation, so the kit's records need no call-site discipline.
      log: logOf(ctx.state.serviceDirectory),
      retry: retry,
      lastProviderUsage: () => exec.lastProviderUsage,
      setLastProviderUsage: (usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
      }) => {
        exec.lastProviderUsage = usage;
        // The provider prefix-cache tier's session total (RINA Phase 5):
        // every step adds to the accumulator. Separate from
        // lastProviderUsage, which stays per-step by design — the ledger
        // checkpoint reads it, and a summed value once made small turns
        // look like 1M+ prompts.
        if (usage) {
          exec.providerCacheUsage = foldProviderCacheUsage(
            exec.providerCacheUsage ?? {
              steps: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
            },
            usage,
          );
        }
      },
      publish: (event) => publishForSession(exec, event),
      applyAgentPolicy: () => {
        if (exec === activeExec) applyAgentPolicy();
      },
      applyAgentProvider: () => applyAgentProvider(exec),
      persistInboxPromotion: () => persistInboxPromotion(exec.session.id),
      createTurnCheckpoint: async (input) => {
        const controller = await initializeCheckpointController(exec);
        if (controller?.isEnabled()) await controller.createCheckpoint(input);
      },
      isToolAllowed: (toolName) => isToolAllowed(toolName, exec),
      setInFlightOperation: (operation) =>
        setInFlightOperationFor(exec, operation),
      executeToolCalls,
      takeLiveUserMessages: () => ctx.ports.takeLiveUserMessages(exec),
      takeStepInputs: (step) => {
        const claimed = claimNextSteps(
          exec.session,
          exec.activeTurnID ?? "",
          step,
        );
        if (!claimed.length) return [];
        for (const item of claimed)
          publishForSession(exec, {
            type: "turn.input",
            turnID: exec.activeTurnID ?? item.id,
            inputID: item.id,
            text: item.text,
            delivery: "next-step",
            ...(item.internal ? { internal: true } : {}),
          });
        void persistInboxPromotion(exec.session.id);
        return claimed.map((item) => ({ id: item.id, text: item.text }));
      },
      hasPendingStepInputs: () =>
        exec.session.inbox?.some(
          (item) => !item.promotedAt && item.delivery === "next-step",
        ) ?? false,
      isTurnAnnounced: (id) => exec.announcedTurnIDs.has(id),
      markTurnAnnounced: (id) => {
        exec.announcedTurnIDs.add(id);
      },
      reloadConfig: async () => {
        const result = await reloadConfigFromDisk();
        if (result.providerReconfigured) applyAgentProvider(exec);
        return result;
      },
      runtimeStatusSnapshot: () =>
        statusController.snapshotFor({
          provider: exec.provider,
          context: exec.context,
          permissionMode: exec.permissionMode,
        }),
      effectiveMaxSteps: () => effectiveMaxSteps(exec),
      waitIfPaused: () => waitIfPaused(exec),
      waitingHuman: () => exec.endTurnWaitingHuman,
    };
  }
}
