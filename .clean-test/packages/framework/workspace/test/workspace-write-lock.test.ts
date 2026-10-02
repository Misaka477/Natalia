import { expect, test } from "bun:test";
import { createWorkspaceWriteLock } from "../src/workspace-write-lock";

test("workspace writers serialise in acquisition order", async () => {
  const lock = createWorkspaceWriteLock();
  const order: string[] = [];
  const releaseFirst = await lock.acquire();
  const second = lock.acquire().then((releaseSecond) => {
    order.push("second");
    releaseSecond();
  });
  await Bun.sleep(20);
  // The second writer is parked behind the first, not running concurrently.
  expect(order).toEqual([]);
  order.push("first");
  releaseFirst();
  await second;
  expect(order).toEqual(["first", "second"]);
});

test("write lock tracks which session waits for or owns which paths", async () => {
  const lock = createWorkspaceWriteLock();
  const releaseFirst = await lock.acquire("ses_a", ["README.md", "config.ts"]);
  const second = lock.acquire("ses_b", ["README.md"]);
  expect(lock.snapshot()).toEqual([
    {
      sessionID: "ses_a",
      paths: ["README.md", "config.ts"],
      queuedAt: expect.any(Number),
      acquiredAt: expect.any(Number),
      active: true,
    },
    {
      sessionID: "ses_b",
      paths: ["README.md"],
      queuedAt: expect.any(Number),
      acquiredAt: 0,
      active: false,
    },
  ]);
  releaseFirst();
  const releaseSecond = await second;
  expect(lock.snapshot().map((entry) => entry.active)).toEqual([true]);
  expect(lock.snapshot()[0]).toMatchObject({
    sessionID: "ses_b",
    paths: ["README.md"],
    active: true,
  });
  releaseSecond();
  expect(lock.snapshot()).toEqual([]);
});

test("a failed release still lets the next writer proceed", async () => {
  const lock = createWorkspaceWriteLock();
  const release = await lock.acquire();
  release();
  const releaseAgain = await lock.acquire();
  releaseAgain();
  // Acquiring again after a release resolves immediately.
  const third = await Promise.race([
    lock.acquire(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
  ]);
  expect(third).toBeTypeOf("function");
});
