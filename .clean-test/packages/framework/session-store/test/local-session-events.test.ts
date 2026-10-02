import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { JsonSessionStore } from "@anthelia/session";
import { createLocalSessionService } from "../src/local-session-service";

/**
 * Discovery D5's offline replay source: service.events(id) round-trips
 * through the JSON store (the store-first rule mirrors show()'s, so
 * scores and counts can never disagree about which files they read).
 */

let base = "";

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("events() reads back everything the store persisted", async () => {
  base = mkdtempSync(join(tmpdir(), "local-session-events-"));
  const store = new JsonSessionStore(join(base, ".natalia", "sessions"));
  const id = "ses_d5_read" as SessionID;
  const session = await store.loadOrCreate(id, "D5");
  const events = [
    {
      type: "turn.submitted",
      id: "adm_1",
      text: "score me",
      byteLength: 8,
      lineCount: 1,
      sha256: "abc",
    },
    { type: "turn.started", id: "turn_1" },
    { type: "turn.finished", id: "turn_1", stopReason: "done" },
  ] as unknown as RuntimeEvent[];
  session.events.push(...events);
  await store.save(session);

  const service = createLocalSessionService(base);
  const read = await service.events("ses_d5_read");
  expect(read.map((event) => event.type)).toEqual([
    "turn.submitted",
    "turn.started",
    "turn.finished",
  ]);

  // Unknown session: a real error, not an empty lie.
  await expect(service.events("ses_missing")).rejects.toThrow(/not found/u);
});
