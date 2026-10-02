import { parentPort } from "node:worker_threads";
import { buildModelCatalog } from "@anthelia/config";
import {
  modelVisibleEvents,
  projectSession,
  projectSessionMessages,
  projectedCanonicalTools,
  projectedPlanDocs,
  projectedEvidenceRecords,
  projectedConstitutionRules,
  projectedDecisionRecords,
  projectedWorkGraphNodes,
  projectedWorkGraphEdges,
  projectedMailboxMessages,
  projectedCollabMessages,
  projectedRuntimeNotices,
} from "@anthelia/session";

export type SessionProjectWorkerRequest =
  | {
      id: number;
      op: "project";
      session: import("@anthelia/session").SessionRecord;
    }
  | {
      id: number;
      op: "messages";
      session: import("@anthelia/session").SessionRecord;
      options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
    }
  | {
      id: number;
      op: "canonicalTools";
      events: import("@anthelia/contracts").RuntimeEvent[];
    }
  | {
      id: number;
      op: "recoveryPrepare";
      events: import("@anthelia/contracts").RuntimeEvent[];
    }
  | {
      id: number;
      op: "collabSnapshot";
      events: import("@anthelia/contracts").RuntimeEvent[];
    }
  | {
      id: number;
      op: "subagentHistory";
      events: import("@anthelia/contracts").RuntimeEvent[];
    }
  | {
      id: number;
      op: "modelCatalog";
      config: import("@anthelia/contracts").ConfigV3;
    }
  | {
      id: number;
      op: "projection";
      name:
        | "planDocs"
        | "evidenceRecords"
        | "constitutionRules"
        | "decisionRecords"
        | "workGraphNodes"
        | "workGraphEdges"
        | "mailboxMessages"
        | "collabMessages"
        | "notices";
      events: import("@anthelia/contracts").RuntimeEvent[];
    };

export type SessionProjectWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

function prepareRecoveryContext(
  events: import("@anthelia/contracts").RuntimeEvent[],
) {
  let latestContextCheckpoint:
    | Extract<
        import("@anthelia/contracts").RuntimeEvent,
        { type: "context.checkpoint" }
      >
    | undefined;
  let checkpointHasSummary = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "context.checkpoint") {
      latestContextCheckpoint = event;
      checkpointHasSummary = event.snapshot.entries.some(
        (entry) => entry.role === "summary",
      );
      break;
    }
  }
  return {
    latestContextCheckpoint,
    checkpointHasSummary,
    restoreEvents:
      checkpointHasSummary && latestContextCheckpoint
        ? modelVisibleEvents(events)
        : events,
  };
}

const port = parentPort;
if (!port) throw new Error("session-project worker requires parentPort");

port.on("message", (request: SessionProjectWorkerRequest) => {
  try {
    let result: unknown;
    if (request.op === "project") {
      result = projectSession(request.session);
    } else if (request.op === "messages") {
      result = projectSessionMessages(request.session, request.options);
    } else if (request.op === "canonicalTools") {
      result = projectedCanonicalTools(request.events);
    } else if (request.op === "recoveryPrepare") {
      result = prepareRecoveryContext(request.events);
    } else if (request.op === "collabSnapshot") {
      result = {
        collabMessages: projectedCollabMessages(request.events),
        planDocs: projectedPlanDocs(request.events),
        mailboxMessages: projectedMailboxMessages(request.events),
        revision: 0,
        eventCount: request.events.length,
      };
    } else if (request.op === "subagentHistory") {
      result = request.events.filter(
        (event) => event.type === "subagent.update",
      );
    } else if (request.op === "modelCatalog") {
      result = buildModelCatalog(request.config);
    } else {
      switch (request.name) {
        case "planDocs":
          result = projectedPlanDocs(request.events);
          break;
        case "evidenceRecords":
          result = projectedEvidenceRecords(request.events);
          break;
        case "constitutionRules":
          result = projectedConstitutionRules(request.events);
          break;
        case "decisionRecords":
          result = projectedDecisionRecords(request.events);
          break;
        case "workGraphNodes":
          result = projectedWorkGraphNodes(request.events);
          break;
        case "workGraphEdges":
          result = projectedWorkGraphEdges(request.events);
          break;
        case "mailboxMessages":
          result = projectedMailboxMessages(request.events);
          break;
        case "collabMessages":
          result = projectedCollabMessages(request.events);
          break;
        case "notices":
          result = projectedRuntimeNotices(request.events);
          break;
      }
    }
    const response: SessionProjectWorkerResponse = {
      id: request.id,
      ok: true,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: SessionProjectWorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

export {};
