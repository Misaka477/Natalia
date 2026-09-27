import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "../src";

/**
 * Phase D's dual-run comparison (acceptance 1: "ObjectStore 读写结果与
 * 当前 TS 版一致"). The suite's parity tests cover facets one at a time
 * (the hash, the chunked manifest, the corrupt contract); this is the
 * SYSTEMATIC form — one scripted op sequence, two stores, every answer
 * compared including the error shapes. The oracle is the TS
 * implementation: the runner asserts the Rust-mode store answers
 * byte-for-byte what the TS store answers.
 */

const roots: string[] = [];
// The maintenance WORKER disabled for this comparison: it is a perf
// shim (the same store on another thread), and its backend is fixed at
// its spawn — the TS run below would spawn a ts-mode worker and the
// Rust run would then ride IT, comparing the worker's ts answer against
// itself. The dual-run compares the two IN-PROCESS implementations.
(
  globalThis as unknown as { __NATALIA_OBJECT_STORE_NO_WORKER?: boolean }
).__NATALIA_OBJECT_STORE_NO_WORKER = true;
afterAll(() => {
  for (const root of roots) rm(root, { recursive: true, force: true });
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
});

/** One op's answer: the value, or the normalized error text. */
type Answer = { ok: true; value: unknown } | { ok: false; error: string };

async function run(
  store: ObjectStore,
  op: { kind: string; [key: string]: unknown },
): Promise<Answer> {
  try {
    switch (op.kind) {
      case "put": {
        const id = await store.put(op.data as Buffer | string);
        return { ok: true, value: id };
      }
      case "has":
        return { ok: true, value: await store.has(op.id as string) };
      case "get":
        return {
          ok: true,
          value: (await store.get(op.id as string)).toString("base64"),
        };
      case "stream": {
        const chunks: string[] = [];
        for await (const chunk of store.getStream(op.id as string))
          chunks.push(chunk.toString("base64"));
        return { ok: true, value: chunks };
      }
      case "compact": {
        const answer = await store.compact();
        // The pack FILE's name is a timestamp (the two runs stamp their
        // own), so the comparison carries the shape, not the name.
        return {
          ok: true,
          value: { packed: answer.packed, bytes: answer.bytes },
        };
      }
      case "gc": {
        const answer = await store.collectGarbage(
          new Set((op.keep as string[]) ?? []),
        );
        return { ok: true, value: answer };
      }
      case "list":
        return { ok: true, value: (await store.list()).sort() };
      case "fsck": {
        const answer = await store.fsck();
        return { ok: true, value: answer };
      }
      default:
        throw new Error(`unknown op ${op.kind}`);
    }
  } catch (error) {
    // The message with the store-specific root carved out, so the two
    // runs can be compared (the roots differ, the contract must not).
    return {
      ok: false,
      error: (error as Error).message.replace(/\/tmp\/[^\s:]+/gu, "<root>"),
    };
  }
}

test("Phase D metrics: the store's counters answer for the ops it actually served", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-d-metrics-"));
  roots.push(root);
  const store = new ObjectStore(join(root, "objects"));
  const a = await store.put("metric-object-a");
  const b = await store.put("metric-object-b");
  await store.get(a);
  await store.get(a);
  await store.get(b);
  // Three gets, and the SPLIT between the lru and the loose lane is
  // mode-shaped (the rust path returns before the cache is filled — a
  // hole recorded for its own block): the TS mode answers two loose and
  // one lru, the rust mode three loose. The invariant both modes keep:
  // every read is counted exactly once.
  const afterReads = await store.stats();
  expect(afterReads.writes).toBe(2);
  expect(
    afterReads.hits.loose + afterReads.hits.lru + afterReads.hits.pack,
  ).toBe(3);
  expect(afterReads.looseObjects).toBe(2);
  // The loose path, reached through the chunked read (which bypasses the
  // lru): a big object's manifest and chunks are read raw.
  const big = await store.put("0123456789abcdef".repeat(64 * 1024));
  for await (const chunk of store.getStream(big)) void chunk;
  const afterStream = await store.stats();
  expect(afterStream.hits.loose).toBeGreaterThan(afterReads.hits.loose);
  // A chunked object's put writes its manifest and every chunk as its own
  // object — the counter's growth is the honest assertion (the exact
  // count is the chunker's business, not the metrics' test's).
  expect(afterStream.writes).toBeGreaterThan(afterReads.writes);

  // The collection keeps `a` only: `b` and `big` (with its manifest and
  // every chunk — one object each) are the garbage.
  const gc = await store.collectGarbage(new Set([a]));
  expect(gc.unreachableObjects).toBeGreaterThanOrEqual(2);
  const afterGc = await store.stats();
  expect(afterGc.gc.runs).toBe(1);
  expect(afterGc.gc.freedObjects).toBe(gc.unreachableObjects);
  expect(afterGc.gc.freedBytes).toBe(gc.bytes);
  expect(afterGc.looseObjects).toBe(1);
  expect(afterGc.packedObjects).toBe(1); // the kept object was repacked
}, 30_000);

test("Phase D dual-run: the Rust-mode store answers byte-for-byte what the TS store answers", async () => {
  const payloads = {
    tiny: "hi",
    small: "a small object".repeat(20),
    // above the chunk threshold: the chunked path under both backends
    big: "0123456789abcdef".repeat(64 * 1024),
    extra: "the fourth object, kept by the second collection",
    // Written AFTER the compaction, so the collection meets a loose
    // object (the real-world shape: the pack holds the old ones, the
    // loose file holds this).
    late: "written late, still loose when the collector runs",
  };
  const script: Array<{ kind: string; [key: string]: unknown }> = [];
  const ids: Record<string, string> = {};
  for (const [name, data] of Object.entries(payloads)) {
    script.push({ kind: "put", data });
    void name;
    void data;
  }
  // The sequence continues after the ids are known (built below).
  const tsRoot = await mkdtemp(join(tmpdir(), "dualrun-ts-"));
  roots.push(tsRoot);
  const tsStore = new ObjectStore(join(tsRoot, "objects"));
  const putAnswers: Answer[] = [];
  for (const step of script) putAnswers.push(await run(tsStore, step));

  // The rest of the sequence, now that the ids exist: existence, reads,
  // a stream, a dedup put, a missing read, and the self-check.
  for (const [index, [name, data]] of Object.entries(payloads).entries()) {
    const answer = putAnswers[index]!;
    expect(answer.ok).toBe(true);
    ids[name] = answer.ok ? (answer.value as string) : "";
    script.push({ kind: "has", id: ids[name]! });
    script.push({ kind: "get", id: ids[name]! });
    script.push({ kind: "stream", id: ids[name]! });
    script.push({ kind: "put", data }); // dedup: same id, no second write
  }
  script.push({ kind: "get", id: "f".repeat(64) });
  script.push({ kind: "has", id: "f".repeat(64) });
  // The maintenance path: compact everything loose into packs, collect
  // the garbage, and compare the two runs' answers (the counts, the
  // surviving id space, the fsck's verdict) — the paths the earlier
  // dual-run did not reach.
  script.push({ kind: "compact" });
  // AFTER the compaction, so the collection meets a loose file (the
  // real-world shape: the pack holds the old ones, this one is loose).
  script.push({ kind: "put", data: payloads.late });
  script.push({ kind: "list" });
  script.push({ kind: "fsck" });
  // Everything kept: the freshly written pack survives whole (the
  // survivor rule), the loose `late` file is untouched, and both runs
  // answer the same counts.
  script.push({
    kind: "gc",
    keep: [ids.tiny, ids.small, ids.big, ids.extra, ids.late],
  });
  script.push({ kind: "list" });
  // THE OBSERVABLE GC SHAPE: keep three of four — the dropped one must
  // vanish (a mixed pack is rebuilt) and the survivors must still read.
  // The earlier shape (a GC right after a compact that keeps
  // everything) leaves a fully kept pack, which the survivor rule
  // short-circuits: correct, but silent.
  script.push({ kind: "gc", keep: [ids.tiny, ids.small, ids.extra, ids.late] });
  script.push({ kind: "list" });
  for (const name of ["tiny", "small", "extra", "late"] as const)
    script.push({ kind: "get", id: ids[name]! });
  script.push({ kind: "has", id: ids.big });
  script.push({ kind: "fsck" });
  script.push({ kind: "fsck" });
  for (const name of ["tiny", "small", "big"] as const) {
    script.push({ kind: "get", id: ids[name]! });
  }
  script.push({ kind: "fsck" });

  // The TS answers (the oracle) for the extended sequence.
  const tsAnswers: Answer[] = [];
  for (const step of script) tsAnswers.push(await run(tsStore, step));

  // The Rust-mode store, the identical sequence from an empty store.
  process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
  const rustRoot = await mkdtemp(join(tmpdir(), "dualrun-rs-"));
  roots.push(rustRoot);
  const rustStore = new ObjectStore(join(rustRoot, "objects"));
  for (const [index, step] of script.entries()) {
    const answer = await run(rustStore, step);
    // The WHOLE answer compared — including the fsck's orphan/corrupt
    // lists. Both stores wrote through the same frame writer, so an
    // orphan on one side is a divergence the comparison must see mask-
    // free (the first cut masked them and that masking was the hole).
    if (step.kind === "gc" || step.kind === "compact" || step.kind === "list")
      console.log(
        `STEP ${step.kind}: rust=${JSON.stringify(answer).slice(0, 90)} ts=${JSON.stringify(tsAnswers[index]).slice(0, 90)}`,
      );
    expect({ step: step.kind, ...answer }).toEqual({
      step: step.kind,
      ...tsAnswers[index]!,
    });
  }
  // Both stores end clean.
  expect((await tsStore.fsck()).ok).toBe(true);
  expect((await rustStore.fsck()).ok).toBe(true);
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
}, 60_000);
