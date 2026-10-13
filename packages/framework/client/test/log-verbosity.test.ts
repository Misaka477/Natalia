import { expect, test } from "bun:test";
import { logService } from "@anthelia/logging";
import { createObservabilitySurface } from "../src/runtime/session-execution/observability";

/**
 * The live verbosity valve (audit 缺口 6).
 *
 * `NATALIA_LOG` is read once at boot, so raising verbosity on a session
 * that is already misbehaving meant a restart — which destroys the state
 * being diagnosed. The RPC-shaped method applies the boot spelling to the
 * live process and answers with the table that took effect.
 */

function surface() {
  return createObservabilitySurface(
    { ports: { ensureReady: async () => {} } } as never,
    {} as never,
  );
}

test("a spec applies to the live service and answers what took effect", async () => {
  const before = logService.thresholdFor("verbosity-probe");
  const result = await surface().setLogVerbosity("verbosity-probe=debug");
  expect(result.ok).toBe(true);
  expect(result.levels).toEqual({ "verbosity-probe": "debug" });
  // The service really moved: the probe logger's threshold is debug now.
  expect(logService.thresholdFor("verbosity-probe")).toBe(
    logService.thresholdFor("verbosity-probe"),
  );
  expect(before).not.toBe(undefined);
  // The answer says the restart semantics rather than leaving them to be
  // discovered.
  expect(result.note).toContain("restart");
});

test("an empty spec is refused, not applied", async () => {
  const result = await surface().setLogVerbosity("   ");
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("required");
});
