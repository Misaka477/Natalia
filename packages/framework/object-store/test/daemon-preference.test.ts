import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ObjectStore, rustCas } from "../src";
import { NativePackIndex, nativePackIndexAvailable } from "../src/native-index";
import { openPackDaemon } from "../src/daemon-client";
import type { PackDaemon } from "../src/daemon-client";

/**
 * The Phase B preference ("TS ObjectStore 优先连 daemon，失败回退本地
 * FS"): the daemon is an INDEX server — a hit short-circuits the store's
 * own index load, and a miss or any failure falls through identically.
 * A daemon-less runtime is a slower store, never a wrong one.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rm(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

test("the client speaks the daemon's protocol and survives its death", async () => {
  if (!nativePackIndexAvailable()) return; // the .so is a build artifact
  const root = await mkdtemp(join(tmpdir(), "daemon-pref-"));
  dirs.push(root);
  const packDir = join(root, "packs");
  await mkdir(packDir, { recursive: true });
  const payload = Buffer.from("a packed object");
  const id = sha256(payload);
  const frame = rustCas.compactFrame([{ id, data: payload }]);
  await writeFile(join(packDir, "pack-a.idx"), frame.idx);
  await writeFile(join(packDir, "pack-a.pack"), frame.pack);

  const daemon = await openPackDaemon({ packsDir: packDir });
  expect(daemon).toBeDefined();
  const hit = await daemon!.find(id);
  expect(hit).toMatchObject({ pack: 0, kind: 0 });
  // A miss is a value, not a failure.
  expect(await daemon!.find(sha256(Buffer.from("absent")))).toBeUndefined();
  expect(await daemon!.count()).toBe(1);
  daemon!.close();

  // A dead daemon: the client answers absent (the fallback's business),
  // it never throws.
  expect(await daemon!.find(id)).toBeUndefined();
  expect(await daemon!.count()).toBe(0);
}, 30_000);

test("the store asks the daemon first when one is injected, and its own index otherwise", async () => {
  if (!nativePackIndexAvailable()) return;
  const root = await mkdtemp(join(tmpdir(), "daemon-store-"));
  dirs.push(root);
  const packDir = join(root, "packs");
  await mkdir(packDir, { recursive: true });
  // An object that lives ONLY in a pack (no loose copy): the read goes
  // through the pack path, which is the daemon's lane.
  const payload = Buffer.from("pack-only bytes ".repeat(32));
  const id = sha256(payload);
  const frame = rustCas.compactFrame([{ id, data: payload }]);
  await writeFile(join(packDir, "pack-a.idx"), frame.idx);
  await writeFile(join(packDir, "pack-a.pack"), frame.pack);

  // The recording double: it answers the real location (the pack the
  // frame writer produced) and records that it was asked. A hit-through
  // is the whole contract; the bytes still come from the local file.
  const asked: string[] = [];
  // The real entry (what a REAL daemon answers — the table is the same
  // code): the double transports it, so the read path under test is the
  // preference, not the entry's arithmetic.
  const realIndex = new NativePackIndex(join(packDir, "pack-a.idx"));
  const realEntry = realIndex.find(id)!;
  realIndex.free();
  const recordingDaemon = {
    find: async (objectID: string) => {
      asked.push(objectID);
      return realEntry;
    },
    count: async () => 1,
    close: () => {},
  } as unknown as PackDaemon;
  const store = new ObjectStore(root, {
    daemonFactory: async () => recordingDaemon,
  });
  expect((await store.get(id)).equals(payload)).toBe(true);
  // The preference PROVEN: the store asked the daemon, and the daemon's
  // location answer drove the local pack read.
  expect(asked).toEqual([id]);

  // Without a daemon the store answers the same bytes through its own
  // index load — the preference changes speed, never the answer (and
  // nothing was asked because no daemon exists).
  asked.length = 0;
  const plain = new ObjectStore(root);
  expect((await plain.get(id)).equals(payload)).toBe(true);
  expect(asked).toEqual([]);

  // A daemon that MISSES (or dies) falls through to the store's own
  // index — a read must not fail because the index server said nothing.
  const missing = new ObjectStore(root, {
    daemonFactory: async () => ({
      find: async () => undefined,
      count: async () => 1,
      close: () => {},
    }),
  });
  expect((await missing.get(id)).equals(payload)).toBe(true);
}, 30_000);
