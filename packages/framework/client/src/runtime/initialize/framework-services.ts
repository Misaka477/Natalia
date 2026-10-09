/**
 * Framework subsystem composition — runtime/initialize/framework-services.ts.
 *
 * Sandbox, checkpoint, runtime config, retry, context ledger, attachments,
 * workspace, tool policy, compaction, session store, provider/model execution,
 * turn orchestration, runtime status, work ledger and governance ledger are
 * framework-internal subsystems, not plugins. This module is the one direct
 * composition seam: it constructs their controllers/services from the framework
 * packages and registers the same service contracts the plugin wrappers used to
 * provide, so every runtime consumer keeps resolving the kernel services
 * unchanged. The host owns close and reload (config refresh) through the
 * returned handle.
 */
import { createAttachmentService } from "@anthelia/attachments";
import { applyCompositionObjectStoreBackend } from "./object-store-backend";
import { configureBashExecutable } from "@anthelia/platform";
import {
  compositionProfile,
  compositionRowRegistrations,
  createCompositionRowRegistry,
  findBaseProfileFile,
  loadCompositionProfile,
  profileSearchCandidates,
  requireBaseProfileFile,
} from "@anthelia/composition";
import type { ProductRuntimeContext } from "@natalia/collab";
import { createCheckpointFactory } from "@anthelia/checkpoint";
import { createCompactionService } from "@anthelia/compaction";
import { createContextLedgerFactory } from "@natalia/context-ledger";
import { RUNTIME_CONFIG_SERVICE } from "@anthelia/runtime-config";
import { runCheckpointCommand } from "@anthelia/runtime";
import { createRetryService, retryService } from "@anthelia/retry";
import { compactionService } from "@anthelia/compaction";
import { checkpointFactory } from "@anthelia/checkpoint";
import { contextLedgerFactory as contextLedgerFactoryToken } from "@natalia/context-ledger";
import { createSandboxController, sandboxTools } from "@anthelia/sandbox";
import { effectiveConfinementMode } from "../tool-execution/execute-context";
import {
  agentTools,
  createSubagentsController,
  subagentSettlementReason,
} from "@anthelia/subagents";
import { createToolPolicyService, toolPolicy } from "@natalia/tool-policy";
import {
  COLLABORATION_SERVICE,
  SETTLEMENT_SERVICE,
  SETTLEMENT_SOURCE_KINDS,
  collaborationTools,
  collaborationWaiter,
  createCollaborationService,
  createInteractiveWaiter,
  type SettlementService,
} from "@natalia/collaboration";
import type { ServiceToken } from "@anthelia/runtime-services";
import {
  createCacheFabric,
  createContextVault,
  createUnavailableVault,
  L1_CACHE_KINDS,
  rinaCache,
  rinaVault,
  createRinaMemory,
  rinaMemory,
  createUnavailableRinaMemory,
} from "@anthelia/rina";
import { objectStoreVaultBlobStore } from "./rina-blob-store";
import { resolveWorkspaceObjectsRoot } from "@anthelia/platform";
import { join } from "node:path";
import { createOperationLog, operationLog } from "@anthelia/operation-log";
import { createRuntimeDiagnostics } from "@anthelia/runtime-diagnostics";
import { runtimeDiagnostics } from "@anthelia/runtime-services";
import { sessionInvariants } from "@anthelia/session";
import { constitutionInvariants } from "@natalia/governance-ledger";
import { workLedgerInvariants } from "@natalia/work-ledger";
import {
  findWorkspaceFiles,
  listWorkspaceFilePaths,
  migrateLegacyWorkspaceStore,
  operationLogsDir,
  contextVaultDir,
  searchWorkspaceFiles,
} from "@anthelia/platform";
import { isSnapshotIgnored, loadNataliaIgnore } from "@anthelia/platform";
import { createSessionHistoryTool } from "../session-history-tool";
import { createRinaContextTools } from "../context-tools";
import {
  createPlanDocListTool,
  createPlanDocReadTool,
  createPlanDocTickTool,
  createPlanPauseTool,
} from "../plan-doc-tools";
import {
  createConstitutionProposeTool,
  createConstitutionRuleReadTool,
  createConstitutionRuleRevokeTool,
  createPlanProposeTool,
  createWorkContractReadTool,
  createDetourDeclareTool,
} from "@natalia/collab";
import { createWorkGraphQueryTool } from "../work-graph-tools";
import {
  createApplyGenerationTool,
  createProposeGenerationTool,
  createRollbackGenerationTool,
  createCancelGenerationTool,
  createListGenerationCandidatesTool,
} from "../generation-tools";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import {
  createDriftAcknowledgeTool,
  createRecordCompletionTool,
  createRecordDecisionTool,
  createRecordValidationTool,
} from "../record-tools";
import {
  createMutationRegistry,
  createWorkspaceFilesController,
  createWorkspaceWriteLock,
  workspaceFiles,
  workspaceMutations,
  workspaceWriteLock,
  type WorkspaceMutationIdentity,
} from "@anthelia/workspace";
import type {
  RuntimeEvent,
  SessionID,
  SettlementNotice,
} from "@anthelia/contracts";
import type { PluginCommandInvocation } from "@anthelia/plugin";
import {
  localToolsInput,
  mcpInput,
  sandboxService,
  skillsInput,
  subagentsService,
  terminalInput,
  type SandboxService,
  type TerminalInput,
} from "@anthelia/runtime-services";
import type {
  FrameworkServices,
  InitializeOptions,
  RuntimeContext,
} from "@anthelia/substrate";
import { wireGovernanceLedger } from "./framework-governance-ledger";
import { wireProviderModel } from "./framework-provider-model";
import { wireRuntimeStatus } from "./framework-runtime-status";
import { wireSessionStore } from "./framework-session-store";
import { wireTurnOrchestration } from "./framework-turn-orchestration";
import { wireWorkLedger } from "./framework-work-ledger";
import type {
  AttachmentService,
  CompactionService,
  RetryService,
} from "@anthelia/runtime";

export type { FrameworkServices } from "@anthelia/substrate";
import type { ContextLedgerFactory } from "@natalia/context-ledger";

export async function wireFrameworkServices(
  ctx: RuntimeContext,
  options: InitializeOptions,
): Promise<FrameworkServices> {
  const registry = ctx.state.capabilityRegistry;
  const workspaceRoot = ctx.ports.getWorkspaceRoot();
  // §1.6: before anything opens a store, move a legacy workspace-local
  // store (checkpoints/objects/chunks) outside the workspace. Idempotent
  // and gated on the opt-in: an explicit checkpointDir means the user chose
  // the portable layout, and their data stays put.
  if (options.checkpointDir === undefined && options.sessionDir === undefined) {
    try {
      const moved = await migrateLegacyWorkspaceStore(workspaceRoot);
      if (moved > 0)
        ctx.ports.publish({
          type: "diagnostic",
          level: "info",
          message: `checkpoint store migrated to the external store (${moved} moved)`,
        });
    } catch (error) {
      // An unwritable home must not stop the boot and must not pretend:
      // the store resolves workspace-local (every path resolver degrades the
      // same way) and this line is the visible record that the rescue ring
      // is tied to this workspace for now.
      ctx.ports.publish({
        type: "diagnostic",
        level: "warning",
        message: `external store unavailable (${error instanceof Error ? error.message : String(error)}); checkpoint store runs workspace-local — the rescue ring is tied to this workspace`,
      });
    }
  }
  const closeHandles: Array<() => void> = [];
  const dispose = () => {
    for (const handle of closeHandles.reverse()) handle();
  };

  const sandboxOwner = registry.registerOwner({
    id: "natalia-sandbox",
    name: "Sandbox",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "tools"],
  });
  const sandbox = createSandboxController({
    workspaceRoot,
    backend: () => ctx.ports.getTsRuntimeConfig()?.sandbox.backend,
    // The dependency supply: the candidate is a checkout of the tracked
    // tree, so without the host's installed roots the promotion gate's
    // command (`npm run typecheck`) fails before it tests anything.
    dependencyRoots: () =>
      ctx.ports.getTsRuntimeConfig()?.sandbox.dependencyRoots,
    // The confinement floor for candidate commands, resolved the same way
    // the tool layer resolves it for every other command surface —
    // composition default, config fallback, schema default — and then gated
    // to what this host can actually enforce. One resolution, shared.
    confinement: () =>
      effectiveConfinementMode({
        profile: ctx.state.serviceDirectory.getOptional(compositionProfile),
        configMode: ctx.ports.getTsRuntimeConfig()?.confinement?.mode,
      }),
  });
  // The service binds through the directory; the owner stays for the tools
  // contribution below.
  ctx.state.serviceDirectory.provide(sandboxService, sandbox);
  for (const tool of sandboxTools()) {
    sandboxOwner.contribute("tools", tool.name, tool);
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }

  const subagentsOwner = registry.registerOwner({
    id: "natalia-subagents",
    name: "Subagents",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "tools"],
  });
  // The settlement spine's subagent adopter: a terminal transition tells
  // the session that spawned the child, instead of leaving the parent to
  // poll `agent_wait`. The record carries the parent session and its
  // closing text; the reason is the record's own status, mapped pure.
  const deliverSettlementToSession = (
    sessionID: string,
    notice: SettlementNotice,
  ): boolean => {
    const exec = ctx.ports
      .getExecutionBySession()
      .get(sessionID as import("@anthelia/contracts").SessionID);
    if (!exec) return false;
    return ctx.ports.deliverSettlement(exec, notice);
  };
  const subagents = createSubagentsController({
    workDir: workspaceRoot,
    sessionID: ctx.ports.getSessionID,
    // Bounds a run that is stuck rather than merely slow: without it such a run
    // continues until the session ends, paying for every step it takes.
    wallClockBudgetMs:
      ctx.ports.getTsRuntimeConfig()?.runtime.subagentWallClockMs,
    onSettled: (record) => {
      const sessionID = record.parentSessionID ?? ctx.ports.getSessionID();
      if (!sessionID) return;
      const closing = record.outputs.at(-1)?.text ?? "";
      deliverSettlementToSession(sessionID, {
        subject: record.id,
        reason: subagentSettlementReason(record.status),
        summary: `subagent ${record.id} ${record.status}: ${record.task.slice(0, 80)}`,
        ...(closing.trim()
          ? { detail: `its closing message: ${closing.slice(0, 400)}` }
          : {}),
        sourceKind: SETTLEMENT_SOURCE_KINDS.subagentSettled,
      });
    },
    // The child's mid-run channel (send_result, built on
    // Natalia's spine): a finding reaches the parent live, and the
    // terminal settlement still fires at the end.
    onChildMessage: (message) => {
      const sessionID = ctx.ports.getSessionID();
      if (!sessionID) return;
      const exec = ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID);
      if (!exec) return;
      ctx.ports.deliverSubagentMessage(exec, message);
    },
  });
  ctx.state.serviceDirectory.provide(subagentsService, subagents);
  // The configured subagent-mode agents are the spawnable types. Advertising
  // them without saying what tools each one has leaves the model guessing, which
  // is the one distinction the choice turns on.
  const agentTypeViews = (ctx.ports.getAgentRegistry()?.list() ?? []).map(
    (agent) => ({
      name: agent.name,
      description: agent.description,
      mode: agent.mode,
      allowedTools: agent.allowedTools,
      excludedTools: agent.excludedTools,
    }),
  );
  for (const tool of agentTools(agentTypeViews)) {
    subagentsOwner.contribute("tools", tool.name, tool);
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }

  const collaborationOwner = registry.registerOwner({
    id: "natalia-collaboration",
    name: "Collaboration",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "tools"],
  });
  // The waiter binds through the service directory: the token's id is the
  // wire name this contribution always used, and the channel gives it the same
  // per-owner disposal and update semantics the registry provides directly.
  ctx.state.serviceDirectory.provide(
    collaborationWaiter,
    createInteractiveWaiter(ctx.state.waiterDeps),
  );
  // Collaboration tools/services must see the whole collab+mailbox slice even
  // when the execution keeps only its fast-attach tail; the hot state carries
  // that slice once completed (tool pre-stage + the snapshot scheduler do so).
  const collaborationEventsFor = (
    sessionID: SessionID,
  ): RuntimeEvent[] | undefined => {
    const exec = ctx.ports.getExecutionBySession().get(sessionID);
    if (!exec) return undefined;
    return exec.factStateComplete === true && exec.factState
      ? exec.factState.collaborationEvents
      : exec.session.events;
  };
  const collaborationService = createCollaborationService({
    events: collaborationEventsFor,
    publish: (sessionID, event) => {
      const exec = ctx.ports.getExecutionBySession().get(sessionID);
      if (exec) ctx.ports.publishForSession(exec, event);
    },
    nextSequence: ctx.ports.nextCollabSequence,
    maxAutoRounds: () =>
      ctx.ports.getTsRuntimeConfig()?.runtime.collaboration.maxAutoRounds ?? 3,
  });
  collaborationOwner.contribute(
    "services",
    COLLABORATION_SERVICE,
    collaborationService,
  );
  // The settlement service: adapters (the process plugin today, the
  // terminal/subagents/team next) resolve it by name and deliver their
  // boundary notices through it — the plugin sandbox cannot reach these
  // ports directly, and this handle is the one sanctioned bridge (the
  // collaboration service's pattern).
  const settlementOwner = registry.registerOwner({
    id: "natalia-settlement",
    name: "Settlement",
    version: "1.0.0",
    scope: "process",
    grants: ["services"],
  });
  settlementOwner.contribute("services", SETTLEMENT_SERVICE, {
    deliverForSession: (sessionID: string, notice: SettlementNotice) => {
      const exec = ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID);
      if (!exec) return false;
      return ctx.ports.deliverSettlement(exec, notice);
    },
  } satisfies SettlementService);
  for (const tool of collaborationTools({
    events: collaborationEventsFor,
    publish: (sessionID, event) => {
      const exec = ctx.ports.getExecutionBySession().get(sessionID);
      if (exec) ctx.ports.publishForSession(exec, event);
    },
    redact: (text) => ctx.ports.redactToolOutput(text, true),
    nextMailboxSequence: ctx.ports.nextMailboxSequence,
    requestWake: (sessionID, request) => {
      const exec = ctx.ports.getExecutionBySession().get(sessionID);
      if (!exec) return;
      const recipient = request?.recipient ?? "live_chat";
      if (recipient === "live_chat") {
        // The advisor path's missing writer (the Navi advisor plan's block
        // C): the wake branch has read `advisorPending` since it was
        // written and NOTHING ever set it — the expert profile, the
        // advisor-request message and the advisor model route were all
        // unreachable. A question from the main agent is a consult; mark
        // it, and the wake routes through the advisor path.
        if (request?.kind === "question" && request?.source === "main_agent")
          exec.advisorPending = true;
        ctx.ports.requestNaviWake(exec);
      } else if (recipient === "nia") {
        ctx.ports.requestNiaWake(exec);
      } else {
        ctx.ports.wakeMainForCollaboration(
          exec,
          request?.messageID ?? "collab-wake",
          request?.kind ?? "chat message",
          request?.source === "nia" ? "Nia" : "Navi",
        );
      }
    },
    maxAutoRounds: () =>
      ctx.ports.getTsRuntimeConfig()?.runtime.collaboration.maxAutoRounds ?? 3,
    service: collaborationService,
  })) {
    collaborationOwner.contribute("tools", tool.name, tool);
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }

  // Model-facing transcript paging: the model can turn through older history
  // with the returned cursor instead of the runtime pre-loading the journal.
  const sessionHistoryTool = createSessionHistoryTool(ctx);
  if (ctx.state.tools.get(sessionHistoryTool.name))
    throw new Error(
      `framework tool already registered: ${sessionHistoryTool.name}`,
    );
  ctx.state.tools.set(sessionHistoryTool.name, sessionHistoryTool);

  // The RINA study's Agent Tools (Phase2b-1): five read-only faces over
  // the cold vault, session-scoped at the edge. The consumer switch to
  // THEM (dropping ensureSessionFullEvents from prompts) = Phase2b-2,
  // with the prompt tests as its net.
  for (const tool of createRinaContextTools(ctx)) {
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }

  // ADR D4/B3: the main agent reads the plan document itself — the plan正文
  // is never injected into any prompt. Register the plan read tools so the
  // main agent has the same plan-document access Navi and Nia have, plus the
  // WorkContract proposal/read tools (EI §8.4).
  for (const tool of [
    createPlanDocListTool(ctx),
    createPlanDocReadTool(ctx),
    createPlanDocTickTool(ctx),
    createPlanPauseTool(ctx),
    createPlanProposeTool(ctx),
    createWorkContractReadTool(ctx),
    createDetourDeclareTool(ctx),
    createWorkGraphQueryTool(ctx),
    // EI §8.4: model-facing journal record tools.
    createRecordValidationTool(ctx),
    createRecordCompletionTool(ctx),
    createRecordDecisionTool(ctx),
    createConstitutionProposeTool(ctx),
    createConstitutionRuleReadTool(ctx),
    createConstitutionRuleRevokeTool(ctx),
    createDriftAcknowledgeTool(ctx),
    // NGM §4.4: the L2 generation tools (propose -> apply through the
    // four-face gate -> rollback, always allowed).
    createProposeGenerationTool(ctx),
    createApplyGenerationTool(ctx),
    createRollbackGenerationTool(ctx),
    createCancelGenerationTool(ctx),
    createListGenerationCandidatesTool(ctx),
  ]) {
    if (ctx.state.tools.get(tool.name))
      throw new Error(`framework tool already registered: ${tool.name}`);
    ctx.state.tools.set(tool.name, tool);
  }

  const checkpointOwner = registry.registerOwner({
    id: "natalia-checkpoint",
    name: "Checkpoint",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const factory = createCheckpointFactory({
    workspaceRoot,
    checkpointDir: options.checkpointDir,
  });
  ctx.state.serviceDirectory.provide(checkpointFactory, factory);
  for (const name of ["checkpoint", "checkpoints", "rollback"])
    checkpointOwner.contribute("commands", name, {
      name,
      title: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      async run(invocation: PluginCommandInvocation) {
        if (!invocation?.sessionID)
          throw new Error("checkpoint command requires a session");
        const sessionID = invocation.sessionID as SessionID;
        const exec = await ctx.ports.ensureExecution(sessionID);
        const controller = await ctx.ports.initializeCheckpointController(exec);
        if (!controller)
          throw new Error(
            "checkpoint controller unavailable (natalia-checkpoint)",
          );
        if (!controller.isEnabled())
          throw new Error("checkpoint store is not initialized");
        const sandboxes =
          ctx.state.serviceDirectory.getOptional(sandboxService);
        const result = await runCheckpointCommand(
          controller.get(),
          exec.context,
          invocation.raw,
          controller.rollbackOptions(),
          async () => {
            if (!sandboxes) throw new Error("sandbox controller unavailable");
            return (await sandboxes.referencedObjectIDs()) ?? new Set();
          },
        );
        return result.output;
      },
    });

  // Runtime config: contributed by name so tool families and plugins resolve
  // the resolved config and subscribe to its updates. Reload re-contributes it
  // (dispose-then-provide) so subscribers observe the replacement.
  let runtimeConfigDispose: (() => void) | undefined;
  const runtimeConfigOwner = registry.registerOwner({
    id: "natalia-runtime-config",
    name: "Runtime Config",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  function refreshRuntimeConfig() {
    const config = ctx.ports.getTsRuntimeConfig();
    runtimeConfigDispose?.();
    runtimeConfigDispose = config
      ? runtimeConfigOwner.contribute(
          "services",
          RUNTIME_CONFIG_SERVICE,
          config,
        )
      : undefined;
  }
  refreshRuntimeConfig();

  let pluginInputDisposers: Array<() => void> = [];
  async function refreshPluginInputs() {
    for (const disposeInput of pluginInputDisposers.splice(0).reverse())
      disposeInput();
    const config = ctx.ports.getTsRuntimeConfig();
    if (!config) return;
    // Host inputs bind through the service directory: one owner per binding
    // with the same dispose-then-provide reload semantics the owner channel
    // had, and the wire name is the token's id on both sides of the boundary.
    const provide = <T>(token: ServiceToken<T>, value: T | undefined) => {
      if (value !== undefined)
        pluginInputDisposers.push(
          ctx.state.serviceDirectory.provide(token, value),
        );
    };
    provide(
      localToolsInput,
      ctx.state.initialize.localToolsPluginInput(config),
    );
    provide(mcpInput, ctx.state.initialize.mcpPluginInput(config));
    provide(skillsInput, ctx.state.initialize.skillsPluginInput(config));

    // P3 "base profile 随包机制" (interface spec §6.3): the shipped
    // read-only base, then user and workspace drop-ins (lexicographic
    // within a layer, same-id whole-field override, per-row origin).
    // Re-provided on every config wire above, so a drop-in edit lands on
    // reload — and activation fails fast with the file and every legal
    // value named (§6.4) rather than booting a composition nobody can
    // read. The ONE registered row is the one with a consumer today
    // (§6.7.2: no consumerless rows); its impl set is empty on purpose —
    // the confinement backend is discovered at runtime, not selected.
    const profileRegistry = createCompositionRowRegistry(
      compositionRowRegistrations,
    );
    const baseFile = requireBaseProfileFile(
      profileSearchCandidates({
        explicitFile: process.env.NATALIA_BASE_PROFILE,
        sourceDir: import.meta.dir,
        execPath: process.execPath,
        argvScript: process.argv[1],
      }),
    );
    const profileHome = ctx.ports.getUserRuntimeHome();
    const activeProfile = await loadCompositionProfile({
      baseFile,
      globalDir: profileHome
        ? join(profileHome, ".natalia", "composition.d")
        : undefined,
      workspaceDir: join(workspaceRoot, ".natalia", "composition.d"),
      registry: profileRegistry,
    });
    provide(compositionProfile, activeProfile);
    // Decision17: the store backend follows the same breath as the
    // profile (absence = TypeScript, so nothing changes until a row
    // says otherwise).
    applyCompositionObjectStoreBackend(activeProfile);
    // The Git Bash setting follows the same breath: the user's configured
    // path (Windows-only — POSIX needs no setting) applies at boot and at
    // every reload, so editing the settings takes effect on the next
    // profile load rather than a restart. Read through a named shape:
    // the schema (contracts/src/schema-foundation.ts) declares the shell
    // section, while the port's config type in this checkout's built
    // declarations lags it, and the shape keeps the compile honest
    // without touching the cache (a stale .d.ts revives on a clean
    // build — restore the direct read then).
    const shellConfig = ctx.ports.getTsRuntimeConfig() as
      | { shell?: { bashPath?: string } }
      | undefined;
    configureBashExecutable(shellConfig?.shell?.bashPath);
    // Law 2: a reload is exactly when the composition can change (drop-in
    // edits land with the profile above) — re-point every cached entry's
    // scope so no old-composition value can answer a new one.
    ctx.state.serviceDirectory
      .getOptional(rinaCache)
      ?.setGeneration(activeProfile.hash);
    const terminal: TerminalInput = {
      workspaceRoot,
      publish: (event) =>
        ctx.ports.publishForSession(
          event.sessionID
            ? ctx.ports
                .getExecutionBySession()
                .get(event.sessionID as SessionID)
            : undefined,
          event,
        ),
      onPerformance: (name, durationMs) =>
        ctx.ports.getPerformanceTrace().mark(name, durationMs),
      runtimeID: ctx.ports.getNativeRuntimeID,
      userRuntimeHome: ctx.ports.getUserRuntimeHome,
      windowMode: () =>
        ctx.ports.getTsRuntimeConfig()?.runtime.terminal.windowMode ?? "auto",
    };
    provide(terminalInput, terminal);
  }
  await refreshPluginInputs();

  const retry: RetryService = createRetryService({
    policy: () => ctx.ports.getRetryPolicy(),
  });
  ctx.state.serviceDirectory.provide(retryService, retry);

  const contextLedgerOwner = registry.registerOwner({
    id: "natalia-context-ledger",
    name: "Context Ledger",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  const contextLedgerFactory: ContextLedgerFactory =
    createContextLedgerFactory();
  ctx.state.serviceDirectory.provide(
    contextLedgerFactoryToken,
    contextLedgerFactory,
  );

  const attachmentOwner = registry.registerOwner({
    id: "natalia-attachment",
    name: "Attachment",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const attachments: AttachmentService = createAttachmentService(workspaceRoot);
  // The service binds through the directory; the owner stays for the attach
  // command below.
  ctx.state.serviceDirectory.provide(attachmentServiceToken, attachments);
  attachmentOwner.contribute("commands", "attach", {
    name: "attach",
    title: "Attach",
    async run(invocation: PluginCommandInvocation) {
      if (!invocation?.sessionID)
        throw new Error("attachment command requires a session");
      const [path, ...prompt] = invocation.args;
      if (!path || !prompt.length)
        throw new Error("usage: /attach <workspace-relative-image> <prompt>");
      await ctx.ports.submitInput(
        { text: prompt.join(" "), attachments: [path] },
        invocation.sessionID as SessionID,
      );
    },
  });

  const workspaceOwner = registry.registerOwner({
    id: "natalia-workspace",
    name: "Workspace",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const mutations = createMutationRegistry();
  // Observation's current path set: a complete, ignore-aware walk — NOT the
  // fuzzy-finder catalog (ignore-free, 200 results, 1s cache). A bounded set
  // here turns every hinted path past the bound into a fabricated deletion.
  const ignoreRules = await loadNataliaIgnore(workspaceRoot);
  const files = createWorkspaceFilesController({
    workspaceRoot,
    listPaths: async () => listWorkspaceFilePaths({ workspaceRoot }),
    isExcludedPath: (path) =>
      isSnapshotIgnored(path, false, ignoreRules.rules) ||
      isSnapshotIgnored(path, true, ignoreRules.rules),
    resolveMutation: (path) => {
      const mutation = mutations.match({ path, operation: "modified" });
      if (!mutation) return undefined;
      const identity: WorkspaceMutationIdentity = {
        origin: mutation.operationID ? "sandbox_merge" : "tool",
      };
      if (mutation.turnID) identity.turnID = mutation.turnID;
      if (mutation.callID) identity.callID = mutation.callID;
      if (mutation.operationID) identity.operationID = mutation.operationID;
      if (mutation.sessionID) identity.sessionID = mutation.sessionID;
      if (mutation.episodeID) identity.episodeID = mutation.episodeID;
      return identity;
    },
  });
  try {
    await files.init();
  } catch (error) {
    files.close();
    throw error;
  }
  ctx.state.serviceDirectory.provide(
    workspaceWriteLock,
    createWorkspaceWriteLock(),
  );
  ctx.state.serviceDirectory.provide(workspaceMutations, mutations);
  // The cache fabric: one per runtime, kind registry preloaded with the
  // classified L1 kinds (RINA study — mechanism first, plugins consume it
  // through the port when their first consumer lands). compute() refuses
  // unregistered kinds, so this list and READ_CACHE_TOOL_KINDS are only
  // safe together: forgetting the loop breaks every classified tool — which
  // is exactly the loudness the registry exists for.
  // Law 2 (§6.6(b)): entries are scoped to the composition they were
  // computed under — the profile's hash at boot, re-pointed in
  // refreshPluginInputs on every reload (a drop-in edit lands with the
  // profile).
  const cacheFabric = createCacheFabric({
    generation:
      ctx.state.serviceDirectory.getOptional(compositionProfile)?.hash,
  });
  for (const kind of L1_CACHE_KINDS) cacheFabric.registerKind(kind);
  ctx.state.serviceDirectory.provide(rinaCache, cacheFabric);
  // The telemetry zone (decisions §5): the runtime's own operation log,
  // home-level like the install layout, overridable for isolated hosts
  // and tests — and closed with the runtime, so records drain on
  // shutdown instead of dying with the process.
  const telemetry = createOperationLog({
    dir:
      options.operationLogsDir ??
      (process.env.NATALIA_HOME
        ? join(process.env.NATALIA_HOME, "logs")
        : operationLogsDir()),
  });
  ctx.state.serviceDirectory.provide(operationLog, telemetry);
  closeHandles.push(() => telemetry.close());
  // RINA Phase1: the Cold Vault rides the SAME home-conditional shape
  // as the operation log (an injected dir wins, NATALIA_HOME redirects
  // isolated runs, the .natalia family is the real-home default) and
  // closes with the runtime exactly like it.
  // Fail-soft, honestly: a store that cannot open (a read-only home
  // under a sandbox, a locked dir in the field) degrades to an
  // unavailable vault that says WHY — the boot continues, writes fail
  // loud at their call site, and a diagnostic lands in the journal so
  // the loss is observable. Telemetry must never be able to kill the
  // runtime; silence would be the other dishonest direction.
  // One durable-knowledge root: the vault and the memory store (Phase 7)
  // are siblings under it, so a runtime's knowledge lives in one place.
  const vaultDir =
    options.vaultDir ??
    (process.env.NATALIA_HOME
      ? join(process.env.NATALIA_HOME, "vault")
      : contextVaultDir());
  // The object-store study's acceptance 5: the vault's blob storage OPTION
  // (the study's "RINA ContextVault 的 blob 存储可选使用 ObjectStore").
  // Off by default (the inline behaviour byte-identical); the operator's
  // env switches the semantic lane's vectors to the content-addressed
  // store through rustCas's SYNC faces (the recall path's shape — an
  // async blob store could never serve it).
  const blobStore =
    process.env.NATALIA_RINA_BLOB_STORE === "1"
      ? objectStoreVaultBlobStore(
          resolveWorkspaceObjectsRoot(ctx.ports.getWorkspaceRoot()),
        )
      : undefined;
  let vault: import("@anthelia/rina").RinaVaultService;
  try {
    vault = createContextVault({
      dir: vaultDir,
      ...(blobStore ? { blobStore } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // NO boot-time diagnostic, deliberately: any read-only home would
    // warn on EVERY boot (a flood by construction) — and worse, the
    // diagnostics channel is DURABLE, so the spam would be restored on
    // every reopen (the channel's own tests drew this boundary). The
    // honesty lives ON DEMAND instead: rina.vault.state() says exactly
    // why the vault is unavailable and remember() fails loud at its
    // call site — availability is queried, not announced at birth.
    vault = createUnavailableVault(`vault store will not open: ${message}`);
  }
  ctx.state.serviceDirectory.provide(rinaVault, vault);
  closeHandles.push(() => vault.close());
  // RINA Memory (Phase 7): the durable reusable knowledge, one SQLite
  // beside the vault's own (the study's 复用冷档存储). The same honest
  // degrade as the vault: an unopenable store becomes an unavailable
  // service that says WHY on demand — telemetry must never kill the boot,
  // and silence would be the other dishonest direction.
  let memory: import("@anthelia/rina").RinaMemoryService;
  try {
    memory = createRinaMemory({ dir: join(vaultDir, "memory") });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    memory = createUnavailableRinaMemory(
      `memory store will not open: ${message}`,
    );
  }
  ctx.state.serviceDirectory.provide(rinaMemory, memory);
  closeHandles.push(() => memory.close());
  // The domain-invariant layer (Discovery D1): domains declare their data
  // relations, this ticks them live over the running sessions' event
  // windows — findings report to the operation log with owner attribution
  // (a finding that cannot cite events is a guess; these cite windows).
  //
  // D2's journal seam: session-scoped findings ride their session's stream
  // (correlation survives replay), workspace-level ones publish plainly.
  const publishFinding = (event: RuntimeEvent) => {
    const exec =
      "sessionID" in event && event.sessionID
        ? ctx.ports.getExecutionBySession().get(event.sessionID)
        : undefined;
    if (exec) ctx.ports.publishForSession(exec, event);
    else ctx.ports.publish(event);
  };
  const diagnostics = createRuntimeDiagnostics({
    sets: [
      { owner: "session", invariants: sessionInvariants },
      { owner: "governance-ledger", invariants: constitutionInvariants },
      { owner: "work-ledger", invariants: workLedgerInvariants },
    ],
    log: telemetry,
    publish: publishFinding,
  });
  ctx.state.serviceDirectory.provide(runtimeDiagnostics, diagnostics);
  diagnostics.start(30_000, () => ({
    sessions: [...ctx.ports.getExecutionBySession().values()].map((exec) => ({
      sessionID: exec.session.id,
      events: exec.session.events,
      factStateComplete: exec.factStateComplete === true,
    })),
  }));
  closeHandles.push(() => diagnostics.stop());
  ctx.state.serviceDirectory.provide(workspaceFiles, files);
  workspaceOwner.contribute("commands", "files", {
    name: "files",
    title: "Find workspace files",
    async run(invocation: PluginCommandInvocation) {
      const query = invocation?.args.join(" ").trim();
      const found = await findWorkspaceFiles({
        workspaceRoot,
        query: query || undefined,
        limit: 50,
      });
      return found.length
        ? found.map((file) => file.path).join("\n")
        : "no workspace files found";
    },
  });
  workspaceOwner.contribute("commands", "search", {
    name: "search",
    title: "Search workspace files",
    async run(invocation: PluginCommandInvocation) {
      const query = invocation?.args.join(" ").trim();
      if (!query) throw new Error("/search requires a query");
      const matches = await searchWorkspaceFiles({
        workspaceRoot,
        query,
        limit: 50,
      });
      return matches.length
        ? matches
            .map((match) => `${match.path}:${match.line}:${match.text}`)
            .join("\n")
        : "no workspace matches found";
    },
  });

  const toolPolicyOwner = registry.registerOwner({
    id: "natalia-tool-pipeline",
    name: "Tool Pipeline",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  ctx.state.serviceDirectory.provide(toolPolicy, createToolPolicyService());

  // Compaction: depends on the retry and context-ledger subsystems wired above.
  const compactionOwner = registry.registerOwner({
    id: "natalia-compaction",
    name: "Compaction",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  const compaction: CompactionService = createCompactionService({ retry });
  ctx.state.serviceDirectory.provide(compactionService, compaction);

  // Remaining framework subsystems are wired in dependency order:
  // session store (attachments) -> work ledger -> governance ledger (work
  // ledger) -> provider/model execution -> turn orchestration (session store)
  // -> runtime status.
  const sessionStore = wireSessionStore(ctx, options, attachments);
  closeHandles.push(sessionStore.close);
  wireWorkLedger(ctx);
  wireGovernanceLedger(ctx);
  const providerModel = wireProviderModel(ctx);
  closeHandles.push(providerModel.close);
  // Product widening at the substrate-shaped boundary: the initialize
  // deps type declares RuntimeContext (engine vocabulary); this client
  // module KNOWS the context carries the product state, so the cast is
  // the honest line rather than teaching substrate about policy.
  const turnOrchestration = wireTurnOrchestration(ctx as ProductRuntimeContext);
  closeHandles.push(turnOrchestration.close);
  const runtimeStatus = wireRuntimeStatus(ctx);
  closeHandles.push(runtimeStatus.close);

  return {
    async refreshRuntimeConfig() {
      refreshRuntimeConfig();
      await refreshPluginInputs();
    },
    close() {
      dispose();
      files.close();
      for (const disposeInput of pluginInputDisposers.splice(0).reverse())
        disposeInput();
      runtimeConfigDispose?.();
      runtimeConfigDispose = undefined;
    },
  };
}
