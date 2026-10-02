import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { SessionID } from "@anthelia/contracts";
import { SqliteSessionStore } from "../src";

test("SQLite confirmed settlement survives child-process crash without close", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-sqlite-crash-"));
  const path = join(root, "sessions.db");
  const sessionID = "ses_child_crash" as SessionID;
  try {
    const worker = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "scripts/sqlite-barrier-crash-worker.ts"),
        path,
        sessionID,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await worker.exited).toBe(91);
    const reopened = new SqliteSessionStore(path);
    try {
      expect(reopened.loadEvents(sessionID).map((event) => event.type)).toEqual(
        ["turn.submitted", "turn.finished"],
      );
      expect(reopened.loadRecoveryProjection(sessionID).activeTurnIDs).toEqual(
        [],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
