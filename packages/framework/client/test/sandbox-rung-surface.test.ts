/**
 * The four-rung ladder's door, through the client surface (audit: the rungs
 * existed but nothing could move them).
 *
 * `sandbox-rung.ts` knew how to move a session's rung and had NO caller: the
 * only way up the ladder was a session-scoped approval on an escalation, so the
 * permission control could not offer the rung at all — it listed the config's
 * three agent modes and wrote only the approval half. This pins the door the
 * control now uses, including the two answers that matter: the ladder MOVED,
 * and the model was told through the durable channel.
 *
 * A switch to the rung the session is already on answers `changed: false`: that
 * is a real answer, not a failure, and a notice for it would be noise.
 */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";

test("the session's rung moves through the surface, and the model is told", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sandbox-rung-"));
  const sessionID = "ses_sandbox_rung" as SessionID;
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
  });
  client.start((event) => events.push(event));
  try {
    await client.sessionAttach!(sessionID);

    const up = await client.setSandboxRung!({ mode: "danger-full-access" });
    expect(up).toMatchObject({ changed: true, mode: "danger-full-access" });

    // The model is told through the same durable `context.instructions`
    // channel a generation switch rides: a model handed a wider sandbox that
    // does not know it keeps apologising for writes it may now make.
    const notice = events.find(
      (event) =>
        event.type === "context.instructions" &&
        (event as { kind?: string }).kind === "sandbox_rung",
    );
    expect(notice).toBeDefined();
    expect(String((notice as { summary?: string }).summary)).toContain(
      "sandbox rung",
    );
    expect(String((notice as { detail?: string[] }).detail?.[0])).toContain(
      "danger-full-access",
    );

    // Same rung: not news, and the answer says so rather than pretending.
    const again = await client.setSandboxRung!({ mode: "danger-full-access" });
    expect(again.changed).toBe(false);

    // And back down the ladder is a change again.
    const down = await client.setSandboxRung!({ mode: "read-only" });
    expect(down).toMatchObject({ changed: true, mode: "read-only" });
  } finally {
    await client.dispose?.();
  }
}, 60_000);
