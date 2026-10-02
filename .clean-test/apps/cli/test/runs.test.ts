import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { JsonSessionStore } from "@anthelia/session";

/**
 * `natalia runs` (D5 / G-b): the same-prompt distribution, scored
 * offline from the workspace journal — plus the claims drill (usage
 * gate rejects positionals before touching the filesystem).
 */

let base = "";

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function seed(root: string) {
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const id = "ses_runs_seed" as SessionID;
  const session = await store.loadOrCreate(id, "runs");
  const turn = (
    sha: string,
    turnID: string,
    stopReason: string,
    input: number,
  ): RuntimeEvent[] =>
    [
      {
        type: "turn.submitted",
        id: `${turnID}_adm`,
        text: `prompt ${sha}`,
        byteLength: 10,
        lineCount: 1,
        sha256: sha,
      },
      { type: "turn.started", id: turnID },
      {
        type: "runtime.step_usage",
        id: `${turnID}_u`,
        inputTokens: input,
        outputTokens: 5,
      },
      { type: "turn.finished", id: turnID, stopReason, durationMs: 500 },
    ] as unknown as RuntimeEvent[];
  session.events.push(
    ...turn("sha_dup", "turn_a", "done", 100),
    ...turn("sha_dup", "turn_b", "error", 300),
    ...turn("sha_solo", "turn_c", "done", 40),
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

test("runs reports the same-prompt distribution as a table and as JSON", async () => {
  base = mkdtempSync(join(tmpdir(), "runs-cmd-"));
  await seed(base);
  const jsonChild = run(["runs", "--workspace", base, "--json"], base);
  expect(jsonChild.exitCode).toBe(0);
  const payload = JSON.parse(new TextDecoder().decode(jsonChild.stdout)) as {
    runs: number;
    groups: Array<{
      promptKey: string;
      runs: number;
      successRate: number;
      avgInputTokens: number;
    }>;
  };
  expect(payload.runs).toBe(3);
  const dup = payload.groups.find((g) => g.promptKey === "sha_dup");
  expect(dup).toMatchObject({ runs: 2, successRate: 50, avgInputTokens: 200 });
  expect(payload.groups.find((g) => g.promptKey === "sha_solo")).toMatchObject({
    runs: 1,
    successRate: 100,
  });

  const table = run(["runs", "--workspace", base], base);
  expect(table.exitCode).toBe(0);
  const out = new TextDecoder().decode(table.stdout);
  expect(out).toContain("PROMPT");
  expect(out).toContain("sha_dup");
  expect(out).toContain("50%");

  // Prompt filter narrows without breaking.
  const filtered = run(
    ["runs", "--workspace", base, "--prompt", "sha_solo", "--json"],
    base,
  );
  const only = JSON.parse(new TextDecoder().decode(filtered.stdout)) as {
    groups: unknown[];
  };
  expect(only.groups).toHaveLength(1);
});

test("runs refuses positionals with usage (claims drill) and reports empties honestly", () => {
  base = mkdtempSync(join(tmpdir(), "runs-gate-"));
  const bad = run(["runs", "export", "--workspace", base], base);
  expect(bad.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(bad.stderr)).toContain("usage: natalia runs");
  const empty = run(["runs", "--workspace", base], base);
  expect(empty.exitCode).toBe(0);
  expect(new TextDecoder().decode(empty.stdout)).toContain("no turns found");
});
