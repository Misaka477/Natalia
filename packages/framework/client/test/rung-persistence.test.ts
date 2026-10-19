/**
 * The session's chosen rung survives another client and another process.
 *
 * The report (2026-10-18): a session moved to `auto` comes back as the
 * deployment default. The mechanism this pins is the one a second frontend sees:
 * the choice is a DURABLE fact (`session.permission.mode`), so a client that
 * attaches after the change must read it, and a client that attaches after the
 * writer is gone must read it too.
 */
import { expect, test } from "bun:test";
import { createRealRuntimeClient } from "../src";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";

useWorkspaceCleanup();

const sessionID = "ses_rung_persist" as SessionID;

function lastMode(events: readonly RuntimeEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "session.permission.mode") return event.mode;
  }
  return undefined;
}

async function attach(root: string) {
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "ask",
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(sessionID);
  return { client, events };
}

test("a rung another client chose is read by the next client, and by a fresh process", async () => {
  const root = await officialPluginWorkspace("rung-persist");
  // Client A is the frontend that moves the rung.
  const a = await attach(root);
  const rung = await a.client.setSandboxRung?.({
    sessionID,
    mode: "workspace-write",
    approval: "auto",
  });
  expect(rung).toBeDefined();
  await a.client.submitAndWait?.("noop").catch(() => undefined);
  expect(lastMode(a.events)).toBe("auto");

  // Client B is the OTHER frontend: it must see what A chose.
  const b = await attach(root);
  expect(lastMode(b.events)).toBe("auto");
  await b.client.dispose?.();

  // Client C is a restart: A is gone, so the only carrier is the journal.
  await a.client.dispose?.();
  const c = await attach(root);
  expect(lastMode(c.events)).toBe("auto");
  await c.client.dispose?.();
}, 120_000);
