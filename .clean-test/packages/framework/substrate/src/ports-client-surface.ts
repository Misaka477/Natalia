import type { AgentDefinition } from "@anthelia/agent";
import type { ConfigV3, RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { SessionRecord } from "@anthelia/session";
import type { SessionExecutionState } from "./session-execution-state";

export type RuntimeClientSurfacePorts = {
  setSink: (sink: ((event: RuntimeEvent) => void) | undefined) => void;
  setReplayMode: (mode: "all" | "none") => void;
  setDisposed: (disposed: boolean) => void;
  getSession: () => SessionRecord | undefined;
  getReplayMode: () => "all" | "none";
  getSessionPersistence: () => Promise<void>;
  getExecutionBySession: () => Map<SessionID, SessionExecutionState>;
  getTurnSession: () => Map<string, SessionID>;
  getActiveExec: () => SessionExecutionState | undefined;
  getPauseWaiters: () => Array<() => void>;
  setPauseWaiters: (waiters: Array<() => void>) => void;
  getReady: () => Promise<void> | undefined;
  getSessionID: () => SessionID;
  getTsRuntimeConfig: () => ConfigV3 | undefined;
  getSelectedAgent: () => AgentDefinition | undefined;
  setSelectedAgent: (agent: AgentDefinition | undefined) => void;
  setPendingAgent: (agent: AgentDefinition | undefined) => void;
  getSelectedModel: () => { modelID?: string; variant?: string } | undefined;
  getWorkspaceRoot: () => string;
  getRuntimeDiagnostics: () => Array<
    Extract<RuntimeEvent, { type: "diagnostic" }> & { at: string }
  >;
  getRuntimeDiagnosticsBySession: () => Map<
    SessionID,
    Array<Extract<RuntimeEvent, { type: "diagnostic" }> & { at: string }>
  >;
  nextDecisionSequence: () => number;
  nextEvidenceSequence: () => number;
  nextCompletionSequence: () => number;
  nextMailboxSequence: () => number;
  nextChatSequence: () => number;
  ensureReady: () => Promise<void>;
  selectedModelRefKey: () => string | undefined;
  applyConfigFromDisk: () => Promise<{ applied: boolean; reason?: string }>;
  attachSession: (id: string) => Promise<{ sessionID: string }>;
  cancelTitleGeneration: (id: SessionID) => Promise<void>;
  getInternalWakeTasks: () => Set<Promise<unknown>>;
  enqueueMailboxForClient: (
    input: Parameters<
      NonNullable<import("@anthelia/contracts").RuntimeClient["mailboxSend"]>
    >[0],
  ) => ReturnType<
    NonNullable<import("@anthelia/contracts").RuntimeClient["mailboxSend"]>
  >;
};
