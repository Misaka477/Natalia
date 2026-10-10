import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { JsonSessionStore } from "@anthelia/session";

/**
 * `natalia evolution mine` (L2): the dataset miner's CLI face — the
 * workspace journal replayed into (task, response) pairs, secret-filtered
 * at the entry, split deterministically, written as three JSONL files.
 *
 * The byte-level assertion is the point of the whole feature: a key that
 * reached a chat must not reach the dataset, and "it was dropped" is only
 * believable if the file itself is clean.
 */

let base = "";

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function seed(root: string) {
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  const id = "ses_mine_seed" as SessionID;
  const session = await store.loadOrCreate(id, "mine");
  const turn = (
    turnID: string,
    task: string,
    response: string,
    options: { internal?: boolean; secret?: boolean } = {},
  ): RuntimeEvent[] =>
    [
      {
        type: "turn.submitted",
        id: `${turnID}_adm`,
        text: task,
        byteLength: task.length,
        lineCount: 1,
        sha256: `sha-${turnID}`,
        ...(options.internal ? { internal: true } : {}),
      },
      { type: "turn.started", id: turnID },
      { type: "content.delta", id: `${turnID}_d`, text: response },
      {
        type: "turn.finished",
        id: turnID,
        stopReason: "done",
        durationMs: 10,
      },
    ] as unknown as RuntimeEvent[];
  session.events.push(
    ...turn("turn_a", "why is the build red", "the guard counts a new module"),
    ...turn(
      "turn_b",
      "rotate the key",
      "use sk-ant-api03-abcdefghijklmnop1234",
    ),
    ...turn("turn_c", "wake", "internal work", { internal: true }),
    ...turn("turn_d", "ship it", "all seven guards pass"),
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

test("evolution mine writes the three splits and drops the secret pair", async () => {
  base = mkdtempSync(join(tmpdir(), "evolution-mine-"));
  await seed(base);
  const child = run(
    [
      "evolution",
      "mine",
      "--target",
      "release-skill",
      "--workspace",
      base,
      "--json",
    ],
    base,
  );
  expect(child.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(child.stdout)) as {
    target: string;
    dir: string;
    sessions: number;
    pairs: number;
    train: number;
    val: number;
    holdout: number;
    dropped: { secrets: number; empty: number; internal: number };
  };
  // Two human turns with a response; the secret pair and the internal wake
  // are dropped, and the counts say so.
  expect(report.pairs).toBe(2);
  expect(report.dropped).toEqual({ secrets: 1, empty: 0, internal: 1 });
  expect(report.train + report.val + report.holdout).toBe(2);
  expect(report.dir).toContain(".natalia/evolution/datasets/release-skill");

  for (const split of ["train", "val", "holdout"] as const) {
    const path = join(report.dir, `${split}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    // The byte-level claim: the secret is nowhere in any split file.
    expect(body).not.toContain("sk-ant-api03");
    expect(body).not.toContain("abcdefghijklmnop1234");
    for (const line of body.trim().split("\n").filter(Boolean)) {
      const pair = JSON.parse(line) as { task: string; response: string };
      expect(pair.task.length).toBeGreaterThan(0);
      expect(pair.response.length).toBeGreaterThan(0);
    }
  }
  // The internal wake's text never lands either.
  const all = ["train", "val", "holdout"]
    .map((split) => readFileSync(join(report.dir, `${split}.jsonl`), "utf8"))
    .join("\n");
  expect(all).not.toContain("internal work");
  expect(all).toContain("all seven guards pass");
});

test("evolution mine refuses a missing target and an unknown action with usage", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-mine-gate-"));
  const noTarget = run(["evolution", "mine", "--workspace", base], base);
  expect(noTarget.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(noTarget.stderr)).toContain(
    "usage: natalia evolution mine",
  );
  const badAction = run(["evolution", "sweep", "--workspace", base], base);
  expect(badAction.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(badAction.stderr)).toContain(
    "usage: natalia evolution mine",
  );
});

test("evolution mine on an empty workspace writes three empty splits and says so", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-mine-empty-"));
  const child = run(
    ["evolution", "mine", "--target", "empty", "--workspace", base, "--json"],
    base,
  );
  expect(child.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(child.stdout)) as {
    pairs: number;
    train: number;
    dir: string;
  };
  expect(report.pairs).toBe(0);
  expect(report.train).toBe(0);
  for (const split of ["train", "val", "holdout"] as const)
    expect(readFileSync(join(report.dir, `${split}.jsonl`), "utf8")).toBe("");
});
