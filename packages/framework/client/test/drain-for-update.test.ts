import { afterAll, expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { createScriptedProvider } from "./e2e-harness";
import { createRealRuntimeClient } from "../src/runtime/main";

/**
 * D3b step 1 (the wait itself): drainForUpdate waits for RUNNING turns
 * and nothing else — admitted-but-unstarted inputs are durable (the
 * inbox survives restarts) — and because it sets NO admission flag, a
 * timed-out drain cannot leave the runtime refusing later submits: the
 * follow-up turn after the timeout is the regression test.
 */

let scratch: string[] = [];
/**
 * Removes a temp tree, tolerating the handle Windows still holds on it.
 *
 * A runtime that has served a session leaves the workspace's object
 * library open until the OS reclaims it (measured: the same three
 * clients delete cleanly when each is removed right after its own
 * dispose, and cleanly again once the process exits). The wait is
 * bounded and the give-up is LOUD: a cleanup that silently leaves the
 * tree behind would hide exactly the leak that causes it.
 */
function removeTree(path: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      if (Date.now() >= deadline) {
        console.warn(
          `left ${path} in place: a handle is still open on it ` +
            "(the runtime's workspace object library)",
        );
        return;
      }
      Bun.sleepSync(100);
    }
  }
}
afterAll(() => {
  for (const dir of scratch) removeTree(dir);
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gatedClient() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blockedOnce = false;
  const events: RuntimeEvent[] = [];
  let calls = 0;
  // The root this helper made, recorded directly: reading it back off
  // the client answered undefined (the surface does not carry it), so
  // the cleanup used to remove "" — which on Windows is the current
  // directory and answers EBUSY.
  const workspaceRoot = mkdtempSync(join(tmpdir(), "drain-e2e-"));
  scratch.push(workspaceRoot);
  const client = createRealRuntimeClient({
    workspaceRoot,
    sessionID: "ses_drain" as SessionID,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        calls += 1;
        if (calls === 1 && !blockedOnce) {
          blockedOnce = true;
          await gate; // the turn STAYS active while gated
        }
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    } as never,
  });
  client.start((event) => events.push(event));
  return { client, events, release, gate };
}

const waitForStarted = async (events: RuntimeEvent[]) => {
  for (let i = 0; i < 400; i += 1) {
    if (events.some((event) => event.type === "turn.started")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("turn never started");
};

test("a trivially quiet runtime drains immediately (no unnecessary wait)", async () => {
  const { client } = gatedClient();
  await client.sessionAttach!("ses_drain" as SessionID);
  const result = await client.drainForUpdate!({ timeoutMs: 2_000 });
  expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  expect(result.waitedMs).toBeLessThan(2_000);
  await client.dispose?.();
});

test("drain waits out an active turn, resolving only once it finishes", async () => {
  const { client, events, release, gate } = gatedClient();
  await client.sessionAttach!("ses_drain" as SessionID);
  const turn = client.submitAndWait!("gated turn");
  await waitForStarted(events);

  let drained = false;
  const pending = client.drainForUpdate!({ timeoutMs: 10_000 }).then(
    (result) => {
      drained = true;
      return result;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(drained).toBe(false); // still active: the gate holds the turn

  release();
  await gate;
  await turn;
  const result = await pending;
  expect(result.waitedMs).toBeGreaterThanOrEqual(250);
  await client.dispose?.();
});

test("a timed-out drain throws with the count and leaves NO sticky refusal", async () => {
  const { client, events, release, gate } = gatedClient();
  await client.sessionAttach!("ses_drain" as SessionID);
  const blocked = client.submitAndWait!("will outlive the drain timeout");
  await waitForStarted(events);

  await expect(client.drainForUpdate!({ timeoutMs: 250 })).rejects.toThrow(
    /1 turn\(s\) still active after \d+ms/u,
  );

  // release the original turn: it completes normally
  release();
  await gate;
  await blocked;

  // THE ANTI-STICKY PROOF: the runtime still accepts a new turn (a
  // locking implementation would refuse right here).
  await client.submitAndWait!("a turn after the timed-out drain");
  await client.dispose?.();
});
