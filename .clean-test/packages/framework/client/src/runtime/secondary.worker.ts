import { parentPort } from "node:worker_threads";
import { manifestIntegrationPoints } from "@anthelia/plugin";

export type SecondaryWorkerRequest =
  | {
      id: number;
      op: "configClone";
      config: import("@anthelia/contracts").ConfigV3;
    }
  | {
      id: number;
      op: "pluginList";
      plugins: unknown[];
    }
  | {
      id: number;
      op: "subagentList";
      records: Array<{
        record: unknown;
        health: unknown;
      }>;
    };

export type SecondaryWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (!port) throw new Error("secondary worker requires parentPort");

port.on("message", (request: SecondaryWorkerRequest) => {
  try {
    let result: unknown;
    if (request.op === "configClone") {
      result = structuredClone(request.config);
    } else if (request.op === "subagentList") {
      result = request.records.map(({ record, health }) => {
        const value = record as {
          id: string;
          status: string;
          attached: boolean;
          task: string;
          parentSessionID?: string;
          parentAgentID?: string;
          continuation?: number;
          phase?: string;
          activityDetail?: string;
          lastActivityAt?: string;
          startedAt?: string;
          endedAt?: string;
        };
        return {
          type: "subagent.update",
          id: value.id,
          status: value.status,
          attached: value.attached,
          event: "status",
          task: value.task,
          ...(value.parentSessionID !== undefined
            ? { parentSessionID: value.parentSessionID }
            : {}),
          ...(value.parentAgentID !== undefined
            ? { parentAgentID: value.parentAgentID }
            : {}),
          ...(value.continuation !== undefined
            ? { continuation: value.continuation }
            : {}),
          phase: value.phase,
          activityDetail: value.activityDetail,
          health,
          lastActivityAt: value.lastActivityAt,
          startedAt: value.startedAt,
          ...(value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
        };
      });
    } else {
      result = request.plugins.map((plugin) => {
        const value = plugin as {
          id: string;
          version: string;
          name: string;
          description: string;
        };
        return {
          id: value.id,
          version: value.version,
          name: value.name,
          description: value.description,
          capabilities: manifestIntegrationPoints(plugin as never),
        };
      });
    }
    const response: SecondaryWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: SecondaryWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

export {};
