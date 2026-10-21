/**
 * 自动 as a wire value clears the config, so the reload cannot re-pin it.
 *
 * The settings row's 自动 used to send `executable: undefined`. This patch
 * crosses the RPC as JSON, and `JSON.stringify` DROPS a key whose value is
 * undefined — so the runtime merged `{shell:{}}`, deleted nothing, and the
 * reload that follows the write re-pinned the PREVIOUS choice onto the slot.
 * Measured end to end: the row said 自动, the config still said bash, the
 * pane still said PS, and the whole thing needed a restart to change.
 *
 * The row now sends `null` (the only spelling that survives JSON) and the
 * runtime normalizes it to the delete the merge understands. This pins the
 * whole path: the write lands, the key is gone, and a later read reports no
 * executable — which is what makes the executor fall back to the platform
 * default instead of to whatever the human last picked.
 */
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";

test("自动 as a wire value clears the config, so the reload cannot re-pin it", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-shell-auto-wire-"));
  const sessionID = "ses_shell_auto_wire" as SessionID;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
  });
  client.start(() => undefined);
  try {
    await client.sessionAttach!(sessionID);

    // The row's explicit choice first — a real value survives the wire as is.
    await client.updateConfig!({
      patch: { runtime: { shell: { executable: "bash" } } },
      scope: "project",
    });
    const chosen = await client.configGet!();
    expect(chosen.runtime?.shell?.executable).toBe("bash");

    // The row's 自动: `null` on the wire (undefined would be dropped by the
    // JSON transport and the merge would delete nothing).
    await client.updateConfig!({
      patch: { runtime: { shell: { executable: null } } },
      scope: "project",
    });
    const cleared = await client.configGet!();
    expect(cleared.runtime?.shell?.executable).toBeUndefined();
  } finally {
    await client.dispose?.();
  }
}, 60_000);
