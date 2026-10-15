import type { SessionProjection } from "@anthelia/session";
import type { CollabSnapshot } from "./session-execution-state";
import type { RuntimeEvent, RuntimeMessagePage } from "@anthelia/contracts";
import type {
  SessionProjectWorkerRequest,
  SessionProjectWorkerResponse,
} from "./session-project.worker";
import { locateRuntimeWorker } from "@anthelia/platform";
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
      config: import("@anthelia/contracts").ConfigV4;
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

/**
 * How long one worker task may take before its caller is told the worker never
 * answered.
 *
 * 15s, the same number the connection layer uses for a generation's readiness
 * deadline: a task that has not settled by then is not slow, it is stuck, and
 * the caller has to be able to tell the difference. Override with
 * NATALIA_WORKER_TASK_TIMEOUT_MS for a machine that genuinely needs more.
 */
export function runtimeWorkerTaskTimeoutMs(): number {
  const raw = Number(process.env.NATALIA_WORKER_TASK_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw >= 250 ? raw : 15_000;
}

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
  // The staged bundle when the runtime is packaged, the source module when it
  // is a checkout — see packages/hosts/platform/src/runtime-worker.ts for why a
  // compiled executable cannot load a worker through `import.meta.url`.
  const instance = new Worker(
    locateRuntimeWorker(
      new URL("./session-project.worker.ts", import.meta.url),
    ).url,
    { type: "module" },
  );
  instance.addEventListener("message", onMessage);
  instance.addEventListener("error", onWorkerError);
  return instance;
}, defaultRuntimeWorkerPoolSize());

async function run<T>(request: SessionProjectTask): Promise<T> {
  const id = nextID++;
  // Bounded, and the deadline is the worker's, not the RPC's. A worker that
  // never comes up — a spawn that failed, a pool that starved, a module the
  // bundle could not resolve — used to leave this promise pending forever, and
  // the caller had no way to tell "slow" from "never". The frontend's startup
  // waits on the first of these, so an unbounded one is what turned a broken
  // worker into a window that spun forever with no error anywhere. The
  // connection layer answers the same question with a 15s readiness deadline
  // (dsh's generationReadyTimeoutMs); this is the same rule one layer down.
  const instance = (() => {
    try {
      return pool.worker();
    } catch (error) {
      // The pool knows why no worker came up, and it is not going to change:
      // either the staged bundle is missing (the resolver names every path it
      // tried) or the constructor failed outright. Waiting the deadline out
      // would only make every caller pay 15 seconds for an answer that can
      // never arrive.
      throw new Error(
        `session-project worker unavailable for ${request.op}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  })();
  return new Promise<T>((resolve, reject) => {
    const timeoutMs = runtimeWorkerTaskTimeoutMs();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `session-project worker did not answer ${request.op} within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
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
  config: import("@anthelia/contracts").ConfigV4,
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
