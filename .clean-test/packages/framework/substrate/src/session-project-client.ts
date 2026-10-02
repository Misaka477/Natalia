import type { SessionProjection } from "@anthelia/session";
import type { CollabSnapshot } from "./session-execution-state";
import type { RuntimeEvent, RuntimeMessagePage } from "@anthelia/contracts";
import type {
  SessionProjectWorkerRequest,
  SessionProjectWorkerResponse,
} from "./session-project.worker";
import {
  createRuntimeWorkerPool,
  defaultRuntimeWorkerPoolSize,
} from "./worker-pool";

type SessionProjectTask =
  | {
      op: "project";
      session: import("@anthelia/session").SessionRecord;
    }
  | {
      op: "messages";
      session: import("@anthelia/session").SessionRecord;
      options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
    }
  | {
      op: "canonicalTools";
      events: RuntimeEvent[];
    }
  | {
      op: "recoveryPrepare";
      events: RuntimeEvent[];
    }
  | {
      op: "collabSnapshot";
      events: RuntimeEvent[];
    }
  | {
      op: "subagentHistory";
      events: RuntimeEvent[];
    }
  | {
      op: "modelCatalog";
      config: import("@anthelia/contracts").ConfigV3;
    }
  | {
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
      events: RuntimeEvent[];
    };

export type RecoveryContextPlan = {
  latestContextCheckpoint?: Extract<
    RuntimeEvent,
    { type: "context.checkpoint" }
  >;
  checkpointHasSummary: boolean;
  restoreEvents: RuntimeEvent[];
};

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

function onMessage(event: MessageEvent<SessionProjectWorkerResponse>) {
  const response = event.data;
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.ok) entry.resolve(response.result);
  else entry.reject(new Error(response.error));
}

function onWorkerError() {
  for (const { reject } of pending.values())
    reject(new Error("session-project worker failed"));
  pending.clear();
}

const pool = createRuntimeWorkerPool(() => {
  const instance = new Worker(
    new URL("./session-project.worker.ts", import.meta.url),
    { type: "module" },
  );
  instance.addEventListener("message", onMessage);
  instance.addEventListener("error", onWorkerError);
  return instance;
}, defaultRuntimeWorkerPoolSize());

async function run<T>(request: SessionProjectTask): Promise<T> {
  const id = nextID++;
  const instance = pool.worker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    instance.postMessage({ ...request, id } as SessionProjectWorkerRequest);
  });
}

export function projectSessionInWorker(
  session: import("@anthelia/session").SessionRecord,
): Promise<SessionProjection> {
  return run<SessionProjection>({ op: "project", session });
}

export function projectSessionMessagesInWorker(
  session: import("@anthelia/session").SessionRecord,
  options: { limit?: number; order?: "asc" | "desc"; cursor?: string },
): Promise<RuntimeMessagePage> {
  return run<RuntimeMessagePage>({ op: "messages", session, options });
}

export function projectedCanonicalToolsInWorker(
  events: RuntimeEvent[],
): Promise<unknown> {
  return run<unknown>({ op: "canonicalTools", events });
}

export function prepareSessionRecoveryContextInWorker(
  events: RuntimeEvent[],
): Promise<RecoveryContextPlan> {
  return run<RecoveryContextPlan>({ op: "recoveryPrepare", events });
}

export function computeCollabSnapshotInWorker(
  events: RuntimeEvent[],
): Promise<CollabSnapshot> {
  return run<CollabSnapshot>({
    op: "collabSnapshot",
    events,
  });
}

export function subagentHistoryInWorker(
  events: RuntimeEvent[],
): Promise<Extract<RuntimeEvent, { type: "subagent.update" }>[]> {
  return run<Extract<RuntimeEvent, { type: "subagent.update" }>[]>({
    op: "subagentHistory",
    events,
  });
}

export function modelCatalogInWorker(
  config: import("@anthelia/contracts").ConfigV3,
): Promise<ReturnType<typeof import("@anthelia/config").buildModelCatalog>> {
  return run<ReturnType<typeof import("@anthelia/config").buildModelCatalog>>({
    op: "modelCatalog",
    config,
  });
}

export function runSessionProjectionInWorker(
  name:
    | "planDocs"
    | "evidenceRecords"
    | "constitutionRules"
    | "decisionRecords"
    | "workGraphNodes"
    | "workGraphEdges"
    | "mailboxMessages"
    | "collabMessages"
    | "notices",
  events: RuntimeEvent[],
): Promise<unknown> {
  return run<unknown>({ op: "projection", name, events });
}
