/**
 * Checkpoint controllers per session — runtime/checkpoint-runtime module.
 *
 * Resolves the checkpoint plugin service at call time. The plugin owns the
 * per-session controller lifecycle; this runtime module never retains a
 * concrete plugin controller.
 */
import {
  subagentsService,
  type RuntimeServiceClient,
  type SubagentsService,
} from "@anthelia/runtime-services";
import { workLedgerController } from "@natalia/work-ledger";
import { statusSnapshotController } from "@anthelia/runtime-status";
import { checkpointFactory } from "@anthelia/checkpoint";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { StatusSnapshotController } from "@anthelia/runtime-status";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { logOf } from "@anthelia/operation-log";
import type {
  CheckpointController,
  CheckpointFactory,
} from "@anthelia/checkpoint";

async function appendCheckpointMutation(
  ctx: RuntimeContext,
  sessionID: string,
  path: string,
  operation: "add" | "modify" | "delete" | "rename",
) {
  try {
    const logPath = resolve(
      ctx.ports.getWorkspaceRoot(),
      ".natalia",
      "workspace-mutations.json",
    );
    await mkdir(dirname(logPath), { recursive: true });
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = JSON.parse(await readFile(logPath, "utf8")) as Array<
        Record<string, unknown>
      >;
    } catch {
      rows = [];
    }
    rows.push({
      id: `mut_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      workspaceRoot: ctx.ports.getWorkspaceRoot(),
      sessionID,
      path,
      operation,
      origin: "checkpoint_rollback",
    });
    await writeFile(logPath, JSON.stringify(rows, null, 2));
  } catch {
    // best-effort
  }
}

export function createCheckpointRuntime(ctx: RuntimeContext) {
  return {
    checkpointControllerFor,
    initializeCheckpointController,
    checkpointList,
    checkpointListByKind,
    auditRounds,
    roundDiff,
    checkpointPreview,
    checkpointRollback,
    checkpointRename,
    createSafetyCheckpoint,
    workspaceDiff,
  };

  async function requireInitializedController(sessionID?: string) {
    await ctx.ports.getReady();
    const owner = sessionID
      ? (ctx.ports.getExecutionBySession().get(sessionID as SessionID) ??
        (await ctx.ports.ensureExecution(sessionID as SessionID)))
      : ctx.ports.getActiveExec();
    if (!owner) throw new Error("session is not initialized");
    const controller = await initializeCheckpointController(owner);
    if (!controller)
      throw new Error("checkpoint controller unavailable (natalia-checkpoint)");
    return { controller, owner };
  }

  async function checkpointList(
    sessionID?: string,
  ): Promise<
    Awaited<ReturnType<NonNullable<RuntimeServiceClient["checkpointList"]>>>
  > {
    const { controller } = await requireInitializedController(sessionID);
    return (await controller.list()).map(toRuntimeCheckpoint);
  }

  async function checkpointListByKind(
    kind?: import("@anthelia/contracts").CheckpointKind,
    sessionID?: string,
  ) {
    const { controller } = await requireInitializedController(sessionID);
    return (await controller.listCheckpointsByKind(kind)).map(
      toRuntimeCheckpoint,
    );
  }

  async function auditRounds(planID?: string) {
    const { controller } = await requireInitializedController();
    return await controller.listAuditRounds(planID);
  }

  async function roundDiff(input: {
    from: import("@anthelia/contracts").CheckpointRef;
    to: import("@anthelia/contracts").CheckpointRef;
    paths?: string[];
    includePatch?: boolean;
    includeContent?: boolean;
    maxFiles?: number;
    maxPatchChars?: number;
  }) {
    const { controller } = await requireInitializedController();
    return await controller.diffCheckpoints(input.from, input.to, {
      paths: input.paths,
      includePatch: input.includePatch,
      includeContent: input.includeContent,
      maxFiles: input.maxFiles,
      maxPatchChars: input.maxPatchChars,
    });
  }

  async function checkpointPreview(
    id: string,
    sessionID?: string,
    options?: { includePatch?: boolean },
  ) {
    const { controller } = await requireInitializedController(sessionID);
    const preview = await controller.preview(id);
    if (options?.includePatch === false) {
      return {
        ...preview,
        changes: preview.changes.map((change) => ({
          kind: change.kind,
          path: change.path,
          ...(change.oldPath ? { oldPath: change.oldPath } : {}),
          ...(change.mode ? { mode: change.mode } : {}),
          additions: change.additions ?? 0,
          deletions: change.deletions ?? 0,
          ...(change.structured ? { structured: change.structured } : {}),
        })),
      };
    }
    return preview;
  }

  async function workspaceDiff(input?: {
    includePatch?: boolean;
  }): Promise<
    Awaited<ReturnType<NonNullable<RuntimeServiceClient["workspaceDiff"]>>>
  > {
    const { controller } = await requireInitializedController();
    const changes = await controller.workspaceDiff();
    if (input?.includePatch === false) {
      return changes.map((change) => ({
        path: change.path,
        operation: change.operation,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        additions: 0,
        deletions: 0,
        ...(change.structured ? { structured: change.structured } : {}),
      }));
    }
    return changes;
  }

  async function checkpointRollback(input: {
    id: string;
    dryRun?: boolean;
    sessionID?: string;
  }) {
    const { controller, owner } = await requireInitializedController(
      input.sessionID,
    );
    const preview = await controller.rollback(input.id, {
      dryRun: input.dryRun,
    });
    if (!input.dryRun) {
      for (const change of preview.changes) {
        void appendCheckpointMutation(
          ctx,
          owner.session.id,
          change.path,
          change.kind === "add"
            ? "add"
            : change.kind === "delete"
              ? "delete"
              : change.kind === "rename"
                ? "rename"
                : "modify",
        );
      }
    }
    const status = ctx.state.serviceDirectory.get(statusSnapshotController);
    ctx.ports.publishForSession(
      owner,
      await status.snapshotFor({
        provider: owner.provider,
        context: owner.context,
        permissionMode: owner.permissionMode,
      }),
    );
    return preview;
  }

  async function checkpointRename(input: {
    id: string;
    name: string;
    sessionID?: string;
  }) {
    const { controller } = await requireInitializedController(input.sessionID);
    return toRuntimeCheckpoint(await controller.rename(input.id, input.name));
  }

  async function createSafetyCheckpoint() {
    const { controller, owner } = await requireInitializedController();
    if (!controller.isEnabled()) return undefined;
    const record = await controller.createCheckpoint({
      reason: "rollback_safety",
      context: owner.context,
      step: owner.context.journalStatus().messageCount,
      status: "rollback_safety",
    });
    if (!record.complete)
      throw new Error(
        "rollback safety checkpoint is incomplete; refusing message rollback",
      );
    return record.id;
  }

  function toRuntimeCheckpoint(
    record: Awaited<ReturnType<CheckpointController["list"]>>[number],
  ): Awaited<
    ReturnType<NonNullable<RuntimeServiceClient["checkpointList"]>>
  >[number] {
    return {
      id: record.id,
      sequence: record.sequence,
      turnID: record.turnID,
      stepID: record.stepID,
      step: record.step,
      reason: record.reason,
      ...(record.name ? { name: record.name } : {}),
      createdAt: record.createdAt,
      complete: record.complete,
      errors: record.errors,
      files: record.manifestMeta.entryCount,
      changes: record.changes.length,
      // `list()` omits the ledger entries; the scalar header carries the token
      // estimate so the list surface stays cheap.
      tokenEstimate: record.contextMeta.tokenEstimate,
      diskUsageBytes: record.diskUsageBytes,
    };
  }

  function checkpointControllerFor(exec: SessionExecutionState) {
    const { getTsRuntimeConfig, publishForSession } = ctx.ports;
    const id = exec.session.id;
    const factory = ctx.state.serviceDirectory.getOptional(checkpointFactory);
    if (!factory) return undefined;
    ctx.state.serviceDirectory.get(workLedgerController);
    return factory({
      sessionID: () => id,
      checkpoint: () => getTsRuntimeConfig()?.checkpoint,
      workspace: () => getTsRuntimeConfig()?.workspace,
      publish: (event) => publishForSession(exec, event),
      context: () => exec.context,
      subagents: () => {
        const subagents =
          ctx.state.serviceDirectory.getOptional(subagentsService);
        return subagents?.enabled() ? subagents : undefined;
      },
      activeAbort: () => exec.activeAbort,
      workLedger: () => ctx.state.serviceDirectory.get(workLedgerController),
    });
  }

  async function initializeCheckpointController(exec: SessionExecutionState) {
    const controller = checkpointControllerFor(exec);
    if (!controller) return undefined;
    try {
      await controller.init();
    } catch (error) {
      // A missing or corrupt checkpoint chunk must not take the whole runtime
      // ready path down: transcript, model selection, session attach and the
      // UI do not depend on checkpointing. Keep the session usable and surface
      // the checkpoint failure instead of failing every RPC.
      logOf(ctx.state.serviceDirectory).warn(
        "checkpoint",
        "controller init failed; continuing without checkpoints",
        { detail: error instanceof Error ? error.message : String(error) },
      );
      return undefined;
    }
    return controller;
  }
}
