import type {
  RuntimeTeamPR,
  RuntimeWorkspaceDiffChange,
} from "@anthelia/contracts";
import {
  sandboxService,
  subagentsService,
  type SandboxService,
  type SubagentsService,
} from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SandboxChangeView } from "@anthelia/tools";

export function createTeamRuntime(ctx: RuntimeContext) {
  return {
    teamPRList,
  };

  async function teamPRList(sessionID?: string): Promise<RuntimeTeamPR[]> {
    await ctx.ports.getReady();
    const subagents = ctx.state.serviceDirectory.getOptional(subagentsService);
    const sandboxes = ctx.state.serviceDirectory.getOptional(sandboxService);
    const ownerSessionID = sessionID ?? ctx.ports.getActiveExec()?.session.id;
    if (!subagents?.enabled()) return [];
    const prs: RuntimeTeamPR[] = [];
    for (const record of subagents.list()) {
      if (record.mode !== "sandbox") continue;
      if (
        ownerSessionID &&
        record.parentSessionID &&
        record.parentSessionID !== ownerSessionID
      )
        continue;
      const diff =
        (await sandboxes?.previewMerge(record.id).catch(() => [])) ?? [];
      const buildCommand =
        ctx.ports.getTsRuntimeConfig()?.sandbox.promoteCommand;
      const buildEvidence = buildCommand
        ? await sandboxes?.validate(record.id, buildCommand).catch(() => ({
            ok: false,
            exitCode: -1,
            output: "validate failed",
          }))
        : undefined;
      prs.push({
        id: record.id,
        sandboxID: record.id,
        status: record.status as string,
        task: record.task,
        ...(record.outputs.length
          ? {
              result: record.outputs
                .map((entry) => entry.text)
                .filter(Boolean)
                .join("\n"),
            }
          : {}),
        ...(buildEvidence ? { buildEvidence } : {}),
        diff: diff.map((change) => toDiffChange(change)),
      });
    }
    return prs;
  }

  function toDiffChange(change: SandboxChangeView): RuntimeWorkspaceDiffChange {
    const operation =
      change.kind === "add"
        ? "added"
        : change.kind === "delete"
          ? "deleted"
          : change.kind === "rename"
            ? "renamed"
            : "modified";
    return {
      path: change.path,
      operation,
      ...(change.oldPath ? { oldPath: change.oldPath } : {}),
      additions: change.additions ?? 0,
      deletions: change.deletions ?? 0,
      ...(change.patch ? { patch: change.patch } : {}),
      ...(change.structured ? { structured: change.structured } : {}),
      ...(change.before ? { before: change.before } : {}),
      ...(change.after ? { after: change.after } : {}),
      ...(change.mode ? { mode: change.mode } : {}),
    };
  }
}
