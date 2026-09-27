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

test("Phase D dual-run: the Rust-mode store answers byte-for-byte what the TS store answers", async () => {
  const payloads = {
    tiny: "hi",
    small: "a small object".repeat(20),
    // above the chunk threshold: the chunked path under both backends
    big: "0123456789abcdef".repeat(64 * 1024),
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
