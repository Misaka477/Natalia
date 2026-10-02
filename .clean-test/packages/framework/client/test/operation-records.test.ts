import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestContext } from "@anthelia/runtime-services";
import {
  createOperationLog,
  operationLog,
  type OperationLog,
} from "@anthelia/operation-log";
import type { RuntimeContext } from "@anthelia/substrate";
import { createObservabilitySurface } from "../src/runtime/session-execution/observability";

/**
 * The telemetry zone's read face (T3/T4): the surface answers the
 * operation log's records through the runtime's own service — the same
 * records the CLI's debug bundle reads, over the same query shape. A
 * runtime without the service answers empty (no path is ever guessed).
 */

let dir = "";
let service: OperationLog | undefined;

function ctxWith(input?: { log?: boolean }): RuntimeContext {
  return {
    ports: {
      ensureReady: async () => {},
      getReady: async () => {},
    },
    state: {
      serviceDirectory: createTestContext(
        input?.log && service ? [operationLog.mock(service)] : [],
      ),
    },
  } as unknown as RuntimeContext;
}

test("a runtime with the log answers its records; a bare one answers empty", async () => {
  dir = mkdtempSync(join(tmpdir(), "operation-records-"));
  service = createOperationLog({ dir });
  const surface = createObservabilitySurface(ctxWith({ log: true }), {});
  // The records the turn telemetry would write — the level gate is the
  // service's; debug drops at the default, so this one is info.
  service.info("[natalia-turn]", "start", { sessionID: "ses_a" });
  service.error("[provider]", "boom", { id: "turn_1" });
  await service.flush();
  const all = await surface.operationRecords!({});
  expect(all).toHaveLength(2);
  expect(all.map((record) => record.level)).toEqual(["info", "error"]);
  // The filter shape is the query's: level narrows, component exact-matches.
  expect(
    (await surface.operationRecords!({ level: "error" })).map(
      (r) => r.component,
    ),
  ).toEqual(["[provider]"]);
  expect(
    (await surface.operationRecords!({ component: "[natalia-turn]" })).map(
      (r) => r.message,
    ),
  ).toEqual(["start"]);
  // No service: empty, never a guessed path.
  expect(
    await createObservabilitySurface(ctxWith(), {}).operationRecords!({}),
  ).toEqual([]);
  await service.close();
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
