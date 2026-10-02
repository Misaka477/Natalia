import type {
  CheckpointResourcePolicy,
  ConfigV3,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type {
  CheckpointStore,
  ContextLedger,
  CreateCheckpointInput,
  DurableContextCheckpoint,
} from "@anthelia/runtime";
import type { WorkLedgerController } from "@anthelia/runtime-services";
import type { SubagentsService } from "@anthelia/runtime-services";

/**
 * Checkpoint mechanism contracts, moved from runtime-services as the token
 * migration completed: the package that implements the mechanism declares
 * its face.
 */

export type CheckpointSubagents = {
  list(): Array<{ id: string; task: string; status: string }>;
  stop(id: string): unknown;
};

export type CheckpointWorkLedger = {
  checkpointNode(input: {
    checkpointID: string;
    reason: string;
    sessionID: SessionID;
    turnID?: string;
  }): RuntimeEvent;
  rollbackCheckpointEdge(input: {
    checkpointID: string;
    safetyCheckpointID: string;
    sessionID: SessionID;
  }): RuntimeEvent;
};

export interface CheckpointController {
  init(): Promise<void>;
  get(): CheckpointStore;
  list(): ReturnType<CheckpointStore["list"]>;
  preview(id: string): ReturnType<CheckpointStore["previewRollback"]>;
  rollback(
    id: string,
    options: { dryRun?: boolean },
  ): ReturnType<CheckpointStore["rollbackTo"]>;
  createCheckpoint(
    input: import("@anthelia/runtime").CreateCheckpointInput,
  ): ReturnType<CheckpointStore["createCheckpoint"]>;
  rename(id: string, name: string): ReturnType<CheckpointStore["rename"]>;
  workspaceDiff(): ReturnType<CheckpointStore["workspaceDiff"]>;
  listCheckpointsByKind(
    kind?: import("@anthelia/contracts").CheckpointKind,
  ): ReturnType<CheckpointStore["listCheckpointsByKind"]>;
  listAuditRounds(
    planID?: string,
  ): ReturnType<CheckpointStore["listAuditRounds"]>;
  createAuditRoundCheckpoint(
    input: Parameters<CheckpointStore["createAuditRoundCheckpoint"]>[0],
  ): ReturnType<CheckpointStore["createAuditRoundCheckpoint"]>;
  diffCheckpoints(
    from: import("@anthelia/contracts").CheckpointRef,
    to: import("@anthelia/contracts").CheckpointRef,
    options?: import("@anthelia/contracts").DiffCheckpointsOptions,
  ): ReturnType<CheckpointStore["diffCheckpoints"]>;
  isEnabled(): boolean;
  resources(): Array<{
    kind: "subagent" | "tool";
    id: string;
    status: "running" | "waiting" | "stopped";
    summary: string;
  }>;
  rollbackOptions(): {
    resources: ReturnType<CheckpointController["resources"]>;
    onResourcePolicy(policy: CheckpointResourcePolicy): Promise<void>;
    onContextRestored(snapshot: DurableContextCheckpoint): Promise<void>;
  };
}

export type CheckpointControllerAccessors = {
  sessionID(): SessionID;
  checkpoint(): ConfigV3["checkpoint"] | undefined;
  workspace(): ConfigV3["workspace"] | undefined;
  publish(event: RuntimeEvent): void;
  context(): ContextLedger;
  subagents(): CheckpointSubagents | undefined;
  activeAbort(): AbortController | undefined;
  workLedger(): CheckpointWorkLedger;
};

export type CheckpointFactory = (
  accessors: CheckpointControllerAccessors,
) => CheckpointController;
