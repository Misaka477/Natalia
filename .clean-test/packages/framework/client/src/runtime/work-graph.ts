import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import {
  projectedWorkGraphEdges,
  projectedWorkGraphNodes,
} from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  ensureSessionEventWindow,
  sessionWindowEvents,
} from "@anthelia/substrate";

type WorkGraphRuntime = Pick<
  RuntimeServiceClient,
  "workGraphNodes" | "workGraphEdges"
>;

async function graphProjectionWithFallback(
  name: "workGraphNodes" | "workGraphEdges",
  events: import("@anthelia/contracts").RuntimeEvent[],
) {
  try {
    const { runSessionProjectionInWorker } = await import(
      "@anthelia/substrate"
    );
    return await runSessionProjectionInWorker(name, events);
  } catch {
    return name === "workGraphNodes"
      ? projectedWorkGraphNodes(events)
      : projectedWorkGraphEdges(events);
  }
}

export function createWorkGraphRuntime(ctx: RuntimeContext): WorkGraphRuntime {
  return {
    async workGraphNodes() {
      const exec = ctx.ports.getActiveExec();
      const window = exec
        ? await ensureSessionEventWindow(ctx, exec)
        : undefined;
      const session = ctx.ports.getSession();
      if (!session) return [];
      const events = window
        ? sessionWindowEvents(exec!, window)
        : session.events;
      const nodes = (await graphProjectionWithFallback(
        "workGraphNodes",
        events,
      )) as ReturnType<typeof projectedWorkGraphNodes>;
      return nodes.map((record) => ({
        nodeID: record.nodeID,
        kind: record.kind,
        summary: record.summary,
        actor: record.actor,
        target: record.target,
        sessionID: record.sessionID,
        turnID: record.turnID,
        episodeID: record.episodeID,
      }));
    },
    async workGraphEdges() {
      const exec = ctx.ports.getActiveExec();
      const window = exec
        ? await ensureSessionEventWindow(ctx, exec)
        : undefined;
      const session = ctx.ports.getSession();
      if (!session) return [];
      const events = window
        ? sessionWindowEvents(exec!, window)
        : session.events;
      const edges = (await graphProjectionWithFallback(
        "workGraphEdges",
        events,
      )) as ReturnType<typeof projectedWorkGraphEdges>;
      return edges.map((record) => ({
        sourceID: record.sourceID,
        targetID: record.targetID,
        kind: record.kind,
        reason: record.reason,
        episodeID: record.episodeID,
      }));
    },
  };
}
