import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { JsonSessionStore } from "@anthelia/session";

/**
 * `natalia consults` (the Navi advisor plan's block D): the consult
 * ledger's offline replay over the workspace journal — the main agent's
 * questions to Navi and her answers — plus the usage gate and the
 * honest empty.
 */

let base = "";

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function seed(root: string) {
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const id = "ses_consult_seed" as SessionID;
  const session = await store.loadOrCreate(id, "consults");
  session.events.push(
    {
      type: "natalia.collab.message",
      message: {
        id: "collab:q:1",
        threadID: "thread_1",
        from: "main_agent",
        to: "live_chat",
        kind: "question",
        text: "Should I save the regex to /app?",
        expectsReply: true,
        at: "2026-09-26T10:00:00.000Z",
      },
    } as unknown as RuntimeEvent,
    {
      type: "navi.collab.message",
      message: {
        id: "collab:a:1",
        threadID: "thread_1",
        from: "live_chat",
        to: "main_agent",
        kind: "answer",
        replyToID: "collab:q:1",
        text: "/app needs root; use the workspace root.",
        expectsReply: false,
        at: "2026-09-26T10:00:12.000Z",
      },
    } as unknown as RuntimeEvent,
    {
      type: "natalia.collab.message",
      message: {
        id: "collab:q:2",
        threadID: "thread_2",
        from: "main_agent",
        to: "live_chat",
        kind: "question",
        text: "commit now?",
        expectsReply: true,
        at: "2026-09-26T10:01:00.000Z",
      },
    } as unknown as RuntimeEvent,
  );
  await store.save(session);
  return id;
}

function run(args: string[], cwd: string) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
}

test("consults reports the ask/answer distribution as JSON and as a table", async () => {
  base = mkdtempSync(join(tmpdir(), "consults-cmd-"));
  await seed(base);
  const jsonChild = run(["consults", "--workspace", base, "--json"], base);
  expect(jsonChild.exitCode).toBe(0);
  const payload = JSON.parse(new TextDecoder().decode(jsonChild.stdout)) as {
    summary: {
      asked: number;
      answered: number;
      declined: number;
      open: number;
      avgLatencyMs?: number;
    };
    records: Array<{ outcome: string; latencyMs?: number }>;
  };
  expect(payload.summary).toMatchObject({
    asked: 2,
    answered: 1,
    declined: 0,
    open: 1,
    avgLatencyMs: 12_000,
  });
  expect(payload.records.map((record) => record.outcome)).toEqual([
    "answered",
    "open",
  ]);

  const table = run(["consults", "--workspace", base], base);
  expect(table.exitCode).toBe(0);
  const out = new TextDecoder().decode(table.stdout);
  expect(out).toContain("ASKED");
  expect(out).toContain("Should I save the regex to /app?");
  expect(out).toContain("open");
});

test("consults refuses positionals with usage and reports empties honestly", () => {
  base = mkdtempSync(join(tmpdir(), "consults-gate-"));
  const bad = run(["consults", "export", "--workspace", base], base);
  expect(bad.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(bad.stderr)).toContain(
    "usage: natalia consults",
  );
  const empty = run(["consults", "--workspace", base], base);
  expect(empty.exitCode).toBe(0);
  expect(new TextDecoder().decode(empty.stdout)).toContain("no consults found");
});
