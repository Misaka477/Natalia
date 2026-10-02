import type {
  CheckpointResourcePolicy,
  ConfigV3,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import {
  CheckpointStore,
  type DurableContextCheckpoint,
} from "@anthelia/runtime";
import type { CheckpointWorkLedger } from "./contracts";
import type { CheckpointSubagents } from "./contracts";
import type { CheckpointController } from "./contracts";

/** Owns one session's durable checkpoint store and rollback policy. */
export function createCheckpointController(input: {
  sessionID(): SessionID;
  workspaceRoot: string;
  storeDir?: string;
  checkpoint(): ConfigV3["checkpoint"] | undefined;
  workspace(): ConfigV3["workspace"] | undefined;
  publish(event: RuntimeEvent): void;
  context(): import("@anthelia/runtime").ContextLedger;
  subagents(): CheckpointSubagents | undefined;
  activeAbort(): AbortController | undefined;
  workLedger(): CheckpointWorkLedger;
}): CheckpointController {
  let store: CheckpointStore | undefined;
  let initPromise: Promise<void> | undefined;

  async function init() {
    initPromise ??= (async () => {
      const checkpoint = input.checkpoint();
      store = await CheckpointStore.open({
        sessionID: input.sessionID(),
        workspaceRoot: input.workspaceRoot,
        storeDir: input.storeDir,
        enabled: checkpoint?.enabled,
        maxFiles: checkpoint?.maxFiles,
        maxBytes: checkpoint?.maxBytes,
        ignore: checkpoint?.ignore,
        additionalDirs: [
          ...(checkpoint?.additionalDirs ?? []),
          ...(input.workspace()?.additionalDirs ?? []),
        ],
        onEvent: (event) => {
          if (
            event.type === "rollback.begin" ||
            event.type === "rollback.end" ||
            event.type === "rollback.failed"
          )
            event = { ...event, sessionID: input.sessionID() };
          input.publish(event);
          if (event.type === "checkpoint.created")
            input.publish(
              input.workLedger().checkpointNode({
                checkpointID: event.id,
                reason: event.reason,
                sessionID: input.sessionID(),
                turnID: event.turnID,
              }),
            );
          if (event.type === "rollback.end")
            input.publish(
              input.workLedger().rollbackCheckpointEdge({
                checkpointID: event.checkpointID,
                safetyCheckpointID: event.safetyCheckpointID,
                sessionID: input.sessionID(),
              }),
            );
        },
      });
      if (store.isEnabled()) await store.ensureBaseline(input.context(), 0);
    })();
    await initPromise;
  }

  function get(): CheckpointStore {
    if (!store) throw new Error("checkpoint store is not initialized");
    return store;
  }

  function isEnabled() {
    return store?.isEnabled() ?? false;
  }

  async function list() {
    return await get().list();
  }

  async function preview(id: string) {
    return await get().previewRollback(id, input.context(), resources(), true);
  }

  async function rollback(id: string, options: { dryRun?: boolean }) {
    return await get().rollbackTo(id, {
      context: input.context(),
      dryRun: options.dryRun,
      ...rollbackOptions(),
    });
  }

  async function createCheckpoint(
    checkpoint: import("@anthelia/runtime").CreateCheckpointInput,
  ) {
    return await get().createCheckpoint(checkpoint);
  }

  async function rename(id: string, name: string) {
    return await get().rename(id, name);
  }

  async function workspaceDiff() {
    return await get().workspaceDiff();
  }

  async function listCheckpointsByKind(
    kind?: import("@anthelia/contracts").CheckpointKind,
  ) {
    return await get().listCheckpointsByKind(kind);
  }

  async function listAuditRounds(planID?: string) {
    return await get().listAuditRounds(planID);
  }

  async function createAuditRoundCheckpoint(
    input: Parameters<CheckpointStore["createAuditRoundCheckpoint"]>[0],
  ) {
    return await get().createAuditRoundCheckpoint(input);
  }

  async function diffCheckpoints(
    from: import("@anthelia/contracts").CheckpointRef,
    to: import("@anthelia/contracts").CheckpointRef,
    options?: import("@anthelia/contracts").DiffCheckpointsOptions,
  ) {
    return await get().diffCheckpoints(from, to, options);
  }

  function resources(): Array<{
    kind: "subagent" | "tool";
    id: string;
    status: "running" | "waiting" | "stopped";
    summary: string;
  }> {
    return [
      ...(input
        .subagents()
        ?.list()
        .map((agent) => ({
          kind: "subagent" as const,
          id: agent.id,
          status:
            agent.status === "running"
              ? ("running" as const)
              : agent.status === "paused"
                ? ("waiting" as const)
                : ("stopped" as const),
          summary: agent.task,
        })) ?? []),
      ...(input.activeAbort()
        ? [
            {
              kind: "tool" as const,
              id: "active_turn",
              status: "running" as const,
              summary: "active provider turn",
            },
          ]
        : []),
    ];
  }

  function rollbackOptions() {
    return {
      resources: resources(),
      onResourcePolicy: async (policy: CheckpointResourcePolicy) => {
        if (policy.action !== "stop" && policy.action !== "cancel") return;
        if (policy.kind === "subagent")
          await input.subagents()?.stop(policy.id);
        if (policy.kind === "tool")
          input.activeAbort()?.abort(new Error("checkpoint rollback"));
      },
      onContextRestored: async (snapshot: DurableContextCheckpoint) =>
        input.publish({
          type: "context.checkpoint",
          id: `rollback:${snapshot.journalOffset}`,
          snapshot,
        }),
    };
  }

  return {
    init,
    get,
    list,
    preview,
    rollback,
    createCheckpoint,
    rename,
    workspaceDiff,
    listCheckpointsByKind,
    listAuditRounds,
    createAuditRoundCheckpoint,
    diffCheckpoints,
    isEnabled,
    resources,
    rollbackOptions,
  };
}
