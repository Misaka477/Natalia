import type { ConfigV4 } from "@anthelia/contracts";
import type {
  SecondaryWorkerRequest,
  SecondaryWorkerResponse,
} from "./secondary.worker";
import { locateRuntimeWorker } from "@anthelia/platform";
import {
  createRuntimeWorkerPool,
  defaultRuntimeWorkerPoolSize,
  runtimeWorkerTaskTimeoutMs,
} from "@anthelia/substrate";

let nextID = 1;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

function onMessage(event: MessageEvent<SecondaryWorkerResponse>) {
  const response = event.data;
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  if (response.ok) entry.resolve(response.result);
  else entry.reject(new Error(response.error));
}

function onWorkerError() {
  for (const { reject } of pending.values())
    reject(new Error("secondary worker failed"));
  pending.clear();
}

const pool = createRuntimeWorkerPool(() => {
  // The staged bundle when the runtime is packaged, the source module when it
  // is a checkout — see packages/hosts/platform/src/runtime-worker.ts.
  const instance = new Worker(
    locateRuntimeWorker(new URL("./secondary.worker.ts", import.meta.url)).url,
    { type: "module" },
  );
  instance.addEventListener("message", onMessage);
  instance.addEventListener("error", onWorkerError);
  return instance;
}, defaultRuntimeWorkerPoolSize());

type SecondaryWorkerTask =
  | { op: "configClone"; config: ConfigV4 }
  | { op: "pluginList"; plugins: unknown[] }
  | {
      op: "subagentList";
      records: Array<{ record: unknown; health: unknown }>;
    };

async function run<T>(request: SecondaryWorkerTask): Promise<T> {
  const id = nextID++;
  // Bounded, for the reason the session-project pool's run() is: a worker
  // that never comes up left this promise pending forever. This one is on the
  // critical path — `config.get` waits on `cloneConfigInWorker` before it
  // answers anything, so an unbounded worker here is why the window spun on
  // its loading surface with the runtime answering every other request
  // correctly. The deadline is the shared one, so one number governs both
  // pools.
  const instance = (() => {
    try {
      return pool.worker();
    } catch (error) {
      // The pool knows why no worker came up, and it is not going to change.
      // Waiting the deadline out would only make every caller pay 15 seconds
      // for an answer that can never arrive.
      throw new Error(
        `secondary worker unavailable for ${request.op}: ${
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
          `secondary worker did not answer ${request.op} within ${timeoutMs}ms`,
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
    instance.postMessage({ ...request, id } as SecondaryWorkerRequest);
  });
}

export function cloneConfigInWorker(config: ConfigV4): Promise<ConfigV4> {
  return run<ConfigV4>({ op: "configClone", config });
}

export function projectPluginsInWorker(plugins: unknown[]): Promise<
  Array<{
    id: string;
    version: string;
    name: string;
    description: string;
    capabilities: string[];
  }>
> {
  return run({
    op: "pluginList",
    plugins,
  });
}

export function projectSubagentsInWorker(
  records: Array<{ record: unknown; health: unknown }>,
): Promise<import("@anthelia/contracts").RuntimeSubagentView[]> {
  return run({
    op: "subagentList",
    records,
  });
}
