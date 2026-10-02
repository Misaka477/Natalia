import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CapabilityRegistry } from "@anthelia/capability";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { ServiceDirectory } from "@anthelia/runtime-services";
import {
  ContextWindowResolver,
  ProviderConcurrencyLimiter,
} from "@anthelia/runtime";
import { createToolRegistry } from "@anthelia/tools";
import { RuntimePerformanceTrace } from "@anthelia/substrate";
import { createCapabilityServiceBindings } from "@anthelia/substrate";
import { defaultContextStatusConfig } from "../provider-selection";
import type { RuntimeContext, RuntimeState } from "@anthelia/substrate";
import type {
  ProductRuntimeContext,
  ProductRuntimeState,
} from "@natalia/collab";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";

type RuntimeDiagnostic = Extract<RuntimeEvent, { type: "diagnostic" }> & {
  at: string;
};

export function createCompositionContext(
  options: RealRuntimeClientOptions,
): ProductRuntimeContext {
  const permissionMode = options.permissionMode ?? "ask";
  const executionBySession = new Map<
    SessionID,
    import("@anthelia/substrate").SessionExecutionState
  >();
  const turnSession = new Map<string, SessionID>();
  const runtimeDiagnostics: RuntimeDiagnostic[] = [];
  const runtimeDiagnosticsBySession = new Map<SessionID, RuntimeDiagnostic[]>();
  const capabilityRegistry =
    options.capabilityRegistry ?? new CapabilityRegistry();
  const state = {
    runtimeDisposed: false,
    workspaceRoot: resolve(options.workspaceRoot ?? process.cwd()),
    pluginStoreRoot: options.pluginStoreRoot
      ? resolve(options.pluginStoreRoot)
      : undefined,
    provider: options.provider,
    chatDefaultProvider: options.provider,
    providerSource: options.provider ? "explicit" : "unconfigured",
    capabilityRegistry,
    serviceDirectory: new ServiceDirectory(
      createCapabilityServiceBindings(capabilityRegistry),
    ),
    capabilityHost: options.capabilityHost,
    workspaceCapabilityView: options.capabilityHost?.view,
    tools: options.tools ?? createToolRegistry([]),
    permissionMode,
    defaultPermissionMode: permissionMode,
    toolCalls: new Map<string, number[]>(),
    replayMode: "all",
    turnSession,
    liveMainOutputByTurn: new Map<string, string>(),
    turnAgent: new Map<string, string>(),
    executionBySession,
    paused: false,
    pauseWaiters: [],
    attachmentReferences: new Map(),
    runtimeDiagnosticsBySession,
    runtimeDiagnostics,
    sessionPersistence: Promise.resolve(),
    sessionPersistenceBySession: new Map(),
    nativeRuntimeID: randomUUID(),
    contextWindowResolver: new ContextWindowResolver({
      cacheFile: options.contextWindowCachePath,
    }),
    runtimeContextConfig: defaultContextStatusConfig(),
    providerConcurrencyLimiter: new ProviderConcurrencyLimiter({}),
    terminalStatusByID: new Map<string, string>(),
    performanceTrace: new RuntimePerformanceTrace(),
    sandboxResourcesByID: new Map<string, number>(),
    activeToolByTurn: new Map<string, string>(),
    sessionSnapshotSequence: 0,
    decisionSequence: 0,
    evidenceSequence: 0,
    mailboxSequence: 0,
    chatSequence: 0,
    collabSequence: 0,
    internalWakeTasks: new Set<Promise<unknown>>(),
    planSequence: 0,
    settlementSequence: 0,
    completionSequence: 0,
    titleGenerationTasks: new Map(),
  } as unknown as RuntimeState & ProductRuntimeState;
  return {
    state,
    ports: {} as RuntimeContext["ports"],
  } as ProductRuntimeContext;
}

export type CompositionState = RuntimeState & ProductRuntimeState;
export type PermissionProfile = import("@anthelia/contracts").PermissionProfile;
