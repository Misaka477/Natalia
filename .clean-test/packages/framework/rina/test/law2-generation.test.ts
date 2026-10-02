import { expect, test } from "bun:test";
import { createCacheFabric, type CacheKindDefinition } from "../src/cache";

/**
 * §6.6(b) / RINA law 2 — "组成换→缓存整体失效" made mechanical: every
 * entry carries the composition hash it was computed under; a switch
 * makes the old scope unable to answer (hit guard) AND sweeps it out
 * (no leak waiting for budget eviction), while in-flight computes keep
 * serving their original awaiters without storing into the new scope.
 */

const kind: CacheKindDefinition = {
  id: "test.probe",
  deterministic: true,
  invalidation: "tree",
};

const fabricWith = (generation?: string) => {
  const fabric = createCacheFabric(
    generation === undefined ? {} : { generation },
  );
  fabric.registerKind(kind);
  const calls = { count: 0 };
  const compute = async () => {
    calls.count += 1;
    return `value-${calls.count}`;
  };
  return { fabric, calls, compute };
};

test("law 2: a generation switch invalidates every old entry (hit guard + sweep)", async () => {
  const { fabric, calls, compute } = fabricWith("gen-a");
  expect(await fabric.compute("test.probe", "k", compute)).toBe("value-1");
  expect(await fabric.compute("test.probe", "k", compute)).toBe("value-1"); // hit
  expect(calls.count).toBe(1);

  const dropped = fabric.setGeneration("gen-b");
  expect(dropped).toBe(1); // the sweep REMOVED it (not just unreachable)

  expect(await fabric.compute("test.probe", "k", compute)).toBe("value-2"); // miss: recompute under gen-b
  expect(calls.count).toBe(2);
  expect(
    fabric.metrics("test.probe")["test.probe"]!.invalidations,
  ).toBeGreaterThanOrEqual(1);

  // and switching back cannot resurrect anything (the entry is gone)
  fabric.setGeneration("gen-a");
  expect(await fabric.compute("test.probe", "k", compute)).toBe("value-3");
  expect(calls.count).toBe(3);
});

test("genesis default then a first real hash behaves the same", async () => {
  const { fabric, calls, compute } = fabricWith(); // no option: the "0" epoch
  await fabric.compute("test.probe", "k", compute);
  expect(fabric.setGeneration("some-profile-hash")).toBe(1);
  await fabric.compute("test.probe", "k", compute);
  expect(calls.count).toBe(2);
});

test("an in-flight compute keeps its awaiter but never stores into the new scope", async () => {
  const { fabric, compute } = fabricWith("gen-a");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const gated = fabric.compute("test.probe", "k", async () => {
    calls += 1;
    await gate;
    return "slow";
  });
  // the switch lands while the compute is mid-flight
  fabric.setGeneration("gen-b");
  release();
  expect(await gated).toBe("slow"); // its ORIGINAL caller still gets its value
  // the fresh scope recomputes (the old value never stored)
  expect(await fabric.compute("test.probe", "k", compute)).toBe("value-1");
  expect(calls).toBe(1);
});
