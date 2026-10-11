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
  // Realistic answer lengths: the density filter (W3) drops one-word
  // confirmations, so a seeded journal that wants to be mined has to look
  // like a real session.
  session.events.push(
    ...turn(
      "turn_a",
      "why is the build red",
      "the guard counts a new module and the import graph has one more edge than yesterday",
    ),
    ...turn(
      "turn_b",
      "rotate the key",
      "use sk-ant-api03-abcdefghijklmnop1234 for the provider call",
    ),
    ...turn("turn_c", "wake", "internal work", { internal: true }),
    ...turn(
      "turn_d",
      "ship it",
      "all seven guards pass and the distribution build came out green on the first try",
    ),
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
    dropped: {
      secrets: number;
      empty: number;
      internal: number;
      trivial: number;
    };
  };
  // Two human turns with a response; the secret pair and the internal wake
  // are dropped, and the counts say so.
  expect(report.pairs).toBe(2);
  expect(report.dropped).toEqual({
    secrets: 1,
    empty: 0,
    internal: 1,
    trivial: 0,
  });
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

test("evolution evaluate reports the dataset shape and the baseline floor", async () => {
  base = mkdtempSync(join(tmpdir(), "evolution-eval-"));
  await seed(base);
  const mined = run(
    ["evolution", "mine", "--target", "release-skill", "--workspace", base],
    base,
  );
  expect(mined.exitCode).toBe(0);
  const child = run(
    [
      "evolution",
      "evaluate",
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
    samples: { train: number; val: number; holdout: number };
    baseline: {
      score: number;
      holdoutScore: number;
      unjudgedDimensions: string[];
    };
  };
  expect(report.samples.train + report.samples.val).toBe(2);
  // The cheap judge scores the recorded responses against themselves, so
  // the floor is a real 1.0 — and the report says which dimensions were
  // never measured instead of pretending it scored them.
  expect(report.baseline.score).toBe(1);
  expect(report.baseline.unjudgedDimensions).toEqual([
    "procedureFollowing",
    "conciseness",
  ]);
  const human = run(
    ["evolution", "evaluate", "--target", "release-skill", "--workspace", base],
    base,
  );
  const out = new TextDecoder().decode(human.stdout);
  expect(out).toContain("UNJUDGED");
  expect(out).toContain("holdout (sealed)");
});

test("evolution evaluate on an unmined target says what to run", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-eval-missing-"));
  const child = run(
    ["evolution", "evaluate", "--target", "nope", "--workspace", base],
    base,
  );
  expect(child.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toContain(
    "natalia evolution mine --target nope",
  );
});

test("evolution optimize reports per-attempt failures when no daemon answers", async () => {
  base = mkdtempSync(join(tmpdir(), "evolution-optimize-"));
  await seed(base);
  const mined = run(
    ["evolution", "mine", "--target", "release-skill", "--workspace", base],
    base,
  );
  expect(mined.exitCode).toBe(0);
  const child = run(
    [
      "evolution",
      "optimize",
      "--target",
      "release-skill",
      "--engine",
      "best-of-n",
      "--n",
      "2",
      "--workspace",
      base,
      "--json",
    ],
    base,
  );
  expect(child.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(child.stdout)) as {
    engine: string;
    best: unknown;
    beatBaseline: boolean;
    failures: Array<{ attempt: number; reason: string }>;
  };
  expect(report.engine).toBe("best-of-n");
  // No daemon is a per-attempt answer, never a fake success: every attempt
  // failed, there is no best, and nothing claims to have beaten anything.
  expect(report.best).toBeNull();
  expect(report.beatBaseline).toBe(false);
  expect(report.failures).toHaveLength(2);
  expect(report.failures[0]!.reason).toContain("no_daemon");
});

test("evolution optimize refuses a bad engine and a bad attempt count", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-optimize-gate-"));
  // `reflective` used to be the unknown-engine probe; it is a real engine
  // now (the loop turns through the daemon), so the probe is a genuinely
  // unknown name.
  const badEngine = run(
    [
      "evolution",
      "optimize",
      "--target",
      "x",
      "--engine",
      "chaos",
      "--n",
      "2",
      "--workspace",
      base,
    ],
    base,
  );
  expect(badEngine.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(badEngine.stderr)).toContain(
    "--engine best-of-n|reflective",
  );
  const badN = run(
    [
      "evolution",
      "optimize",
      "--target",
      "x",
      "--engine",
      "best-of-n",
      "--n",
      "0",
      "--workspace",
      base,
    ],
    base,
  );
  expect(badN.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(badN.stderr)).toContain("--n");
});

test("evolution optimize --engine reflective refuses a bad engine and reports a dead daemon honestly", async () => {
  base = mkdtempSync(join(tmpdir(), "evolution-reflective-"));
  await seed(base);
  const mined = run(
    ["evolution", "mine", "--target", "release-skill", "--workspace", base],
    base,
  );
  expect(mined.exitCode).toBe(0);

  // The engine gate names the two engines.
  const badEngine = run(
    [
      "evolution",
      "optimize",
      "--target",
      "release-skill",
      "--engine",
      "chaos",
      "--n",
      "1",
      "--workspace",
      base,
    ],
    base,
  );
  expect(badEngine.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(badEngine.stderr)).toContain(
    "--engine best-of-n|reflective",
  );

  // No daemon: the baseline turn cannot run, and the run says so instead
  // of crashing with a stack trace. (The loop's first cost IS a turn per
  // sample — an honest price, honestly reported when it cannot be paid.)
  const noDaemon = run(
    [
      "evolution",
      "optimize",
      "--target",
      "release-skill",
      "--engine",
      "reflective",
      "--n",
      "1",
      "--rounds",
      "1",
      "--samples",
      "1",
      "--workspace",
      base,
      "--json",
    ],
    base,
  );
  expect(noDaemon.exitCode).not.toBe(0);
  const report = JSON.parse(new TextDecoder().decode(noDaemon.stdout)) as {
    engine: string;
    failed: string;
  };
  expect(report.engine).toBe("reflective");
  expect(report.failed).toContain("no_daemon");
});

test("evolution benchmark --generate refuses without --generate, and the domain filter is the guard", () => {
  base = mkdtempSync(join(tmpdir(), "evolution-bench-gate-"));
  try {
    const noGenerate = run(["evolution", "benchmark", "--target", "x"], base);
    expect(noGenerate.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noGenerate.stderr)).toContain("--generate");
    // No daemon: the synthesis runs a real turn, so it says which command
    // starts one instead of failing somewhere confusing.
    const noDaemon = run(
      [
        "evolution",
        "benchmark",
        "--generate",
        "--target",
        "x",
        "--workspace",
        base,
      ],
      base,
    );
    expect(noDaemon.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(noDaemon.stderr)).toContain(
      "natalia daemon",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
