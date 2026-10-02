import type { ConfigV3 } from "@anthelia/contracts";
import type {
  SecondaryWorkerRequest,
  SecondaryWorkerResponse,
} from "./secondary.worker";
import {
  createRuntimeWorkerPool,
  defaultRuntimeWorkerPoolSize,
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
  const instance = new Worker(
    new URL("./secondary.worker.ts", import.meta.url),
    { type: "module" },
  );
  instance.addEventListener("message", onMessage);
  instance.addEventListener("error", onWorkerError);
  return instance;
}, defaultRuntimeWorkerPoolSize());

type SecondaryWorkerTask =
  | { op: "configClone"; config: ConfigV3 }
  | { op: "pluginList"; plugins: unknown[] }
  | {
      op: "subagentList";
      records: Array<{ record: unknown; health: unknown }>;
    };

async function run<T>(request: SecondaryWorkerTask): Promise<T> {
  const id = nextID++;
  const instance = pool.worker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    instance.postMessage({ ...request, id } as SecondaryWorkerRequest);
  });
}

export function cloneConfigInWorker(config: ConfigV3): Promise<ConfigV3> {
  return run<ConfigV3>({ op: "configClone", config });
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
