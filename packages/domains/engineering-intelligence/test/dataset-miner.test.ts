import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { samplesFromPairs } from "../src/evaluation";
import {
  DATASET_RESPONSE_LIMIT,
  DATASET_TASK_LIMIT,
  datasetDir,
  datasetSplitLines,
  findSecrets,
  isTrivialAnswer,
  looksSecret,
  mineSessionPairs,
  readDataset,
  readDatasetSplit,
  redactSecrets,
  splitDataset,
  splitForPair,
  writeDataset,
  type DatasetPair,
} from "../src/dataset-miner";

/**
 * L2's dataset miner: the entry's secret filter, the journal fold, the
 * deterministic split, and the on-disk round trip.
 *
 * The secret tests are deliberately two-sided (detection AND
 * false-positives). A filter that only proves it catches keys is half a
 * filter: the other half is that ordinary conversations — the ones that
 * make the dataset worth mining — survive it.
 */

const turn = (
  sessionID: string,
  turnID: string,
  task: string,
  response: string,
  options: { internal?: boolean; noResponse?: boolean } = {},
): RuntimeEvent[] =>
  [
    {
      type: "turn.submitted",
      id: `${turnID}:submit`,
      text: task,
      byteLength: task.length,
      lineCount: 1,
      sha256: `sha-${turnID}`,
      ...(options.internal ? { internal: true } : {}),
    },
    { type: "turn.started", id: turnID },
    ...(options.noResponse
      ? []
      : [
          { type: "content.delta", id: `${turnID}:d1`, text: response },
          { type: "content.done", id: `${turnID}:done`, text: response },
        ]),
    {
      type: "turn.finished",
      id: turnID,
      stopReason: options.noResponse ? "error" : "done",
    },
  ] as unknown as RuntimeEvent[];

// --- the entry's secret filter: detection ---------------------------------

test("the secret filter catches every vendor key shape it claims to", () => {
  const positives = [
    "sk-ant-api03-abcdefghijklmnop1234567890",
    "sk-or-v1-abcdefghijklmnop1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "ghp_abcdefghijklmnop1234",
    "gho_abcdefghijklmnop1234",
    "github_pat_11ABCDEFG0abcdefghijkl_1234567890abcdefghijklmnopqrstuvwxyz",
    "xoxb-1234567890-abcdefghij",
    "xoxp-1234567890-abcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
    "ASIAIOSFODNN7EXAMPLE",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
    'api_key: "abcdefghijklmnop123456"',
    "password=hunter2hunter2hunter2",
    "my_secret = a-very-long-token-value-1234",
    "credentials: 0123456789abcdefghij",
  ];
  for (const text of positives) expect(looksSecret(text)).toBe(true);
});

test("the secret filter leaves ordinary prose alone (the false-positive half)", () => {
  // The eight shapes that must SURVIVE: prose that mentions key-ish words,
  // short placeholder values, code that discusses tokens, and the words
  // that merely contain a vendor substring.
  const negatives = [
    "the api key is in the settings panel",
    "how do I ask the model to use a shorter key?",
    "token: ok",
    "password: 12345",
    "secret = short",
    "we should rotate the bearer token every quarter",
    "the sk- prefix is how you recognize an OpenAI-style key",
    "the token bucket refills every hour, so retry after a pause",
  ];
  for (const text of negatives) expect(looksSecret(text)).toBe(false);
});

test("findSecrets names the family, and redactSecrets replaces the span", () => {
  const text = "use sk-ant-api03-abcdefghijklmnop here";
  const matches = findSecrets(text);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.family).toBe("anthropic_key");
  expect(redactSecrets(text)).toBe("use [anthropic_key] here");
  // No match, nothing replaced.
  expect(redactSecrets("nothing to see")).toBe("nothing to see");
});

// --- the journal fold --------------------------------------------------------

test("mining pairs each task with its assistant text and counts what it dropped", () => {
  const events = [
    ...turn(
      "s1",
      "t1",
      "fix the flaky test",
      "I pinned the clock in the retry helper so the test passed on every run of the suite.",
    ),
    ...turn("s1", "t2", "add a retry", "", { noResponse: true }),
    ...turn("s1", "t3", "internal wake", "should not be mined", {
      internal: true,
    }),
  ];
  const { pairs, dropped } = mineSessionPairs("s1", events);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]).toMatchObject({
    sessionID: "s1",
    turnID: "t1",
    task: "fix the flaky test",
    response:
      "I pinned the clock in the retry helper so the test passed on every run of the suite.",
  });
  expect(dropped).toEqual({
    secrets: 0,
    empty: 1,
    internal: 1,
    trivial: 0,
  });
});

test("a pair whose task or response carries a secret is dropped, never kept", () => {
  const events = [
    ...turn(
      "s1",
      "t1",
      "why does this fail",
      "the retry swallows the timeout because the clock is not pinned in the test harness",
    ),
    ...turn(
      "s1",
      "t2",
      "use this key sk-ant-api03-abcdefghijklmnop",
      "sure, the key is loaded into the environment for the provider runner",
    ),
    ...turn(
      "s1",
      "t3",
      "summarize the config",
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij",
    ),
  ];
  const { pairs, dropped } = mineSessionPairs("s1", events);
  expect(pairs.map((pair) => pair.turnID)).toEqual(["t1"]);
  expect(dropped.secrets).toBe(2);
});

test("the fold is bounded: a huge task and a huge response are capped, not dropped", () => {
  const events = [...turn("s1", "t1", "x".repeat(9_000), "y".repeat(20_000))];
  const { pairs } = mineSessionPairs("s1", events);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]!.task.length).toBe(DATASET_TASK_LIMIT);
  expect(pairs[0]!.response.length).toBe(DATASET_RESPONSE_LIMIT);
});

// --- the split -----------------------------------------------------------------

test("the split is deterministic: the same pair always lands in the same split", () => {
  const pairs: DatasetPair[] = Array.from({ length: 40 }, (_, index) => ({
    sessionID: `s${index % 4}`,
    turnID: `t${index}`,
    task: `task ${index}`,
    response: `response ${index}`,
  }));
  const first = splitDataset(pairs);
  const second = splitDataset(pairs);
  expect(first).toEqual(second);
  // Every pair lands exactly once, and all three splits are populated at
  // this size (a split function that starves one bucket is a bug).
  const total = first.train.length + first.val.length + first.holdout.length;
  expect(total).toBe(pairs.length);
  expect(first.train.length).toBeGreaterThan(0);
  expect(first.val.length).toBeGreaterThan(0);
  expect(first.holdout.length).toBeGreaterThan(0);
  // The holdout is keyed by identity, so re-mining the same journal does
  // not shuffle yesterday's holdout into today's training set.
  for (const pair of pairs)
    expect(splitForPair(pair)).toBe(splitForPair({ ...pair }));
});

// --- the on-disk round trip ------------------------------------------------------

test("writeDataset lands three JSONL files under the workspace, and reads back", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-dataset-"));
  try {
    const pairs: DatasetPair[] = Array.from({ length: 12 }, (_, index) => ({
      sessionID: "s1",
      turnID: `t${index}`,
      task: `task ${index}`,
      response: `response ${index}`,
    }));
    const written = await writeDataset({
      workspaceRoot: root,
      target: "release-skill",
      pairs,
    });
    expect(written.dir).toBe(datasetDir(root, "release-skill"));
    expect(written.train + written.val + written.holdout).toBe(12);
    // The files are JSONL: one pair per line, parsed back identically.
    for (const split of ["train", "val", "holdout"] as const) {
      const body = await readFile(join(written.dir, `${split}.jsonl`), "utf8");
      if (!body.trim()) continue;
      for (const line of body.trim().split("\n")) {
        const parsed = JSON.parse(line) as DatasetPair;
        expect(parsed).toMatchObject({
          sessionID: "s1",
          task: expect.any(String),
          response: expect.any(String),
        });
      }
    }
    const train = await readDatasetSplit(root, "release-skill", "train");
    expect(train.length).toBe(written.train);
    expect(train[0]).toMatchObject({
      sessionID: "s1",
      turnID: expect.any(String),
    });
    // The dataset lines carry no split field: the FILE is the split.
    expect(Object.keys(train[0]!).sort()).toEqual([
      "response",
      "sessionID",
      "task",
      "turnID",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid target is refused before anything is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-dataset-"));
  try {
    expect(() => datasetDir(root, "../escape")).toThrow(
      /invalid dataset target/u,
    );
    expect(() => datasetDir(root, "Upper_Case")).toThrow(
      /invalid dataset target/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty dataset still writes its three files (an empty holdout is a fact)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-dataset-"));
  try {
    const written = await writeDataset({
      workspaceRoot: root,
      target: "empty-target",
      pairs: [],
    });
    expect(written).toMatchObject({ train: 0, val: 0, holdout: 0 });
    expect(datasetSplitLines([])).toBe("");
    for (const split of ["train", "val", "holdout"] as const)
      expect(await readFile(join(written.dir, `${split}.jsonl`), "utf8")).toBe(
        "",
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a human rating rides its own turn's pair; a retraction takes it back", () => {
  // S1: the feedback entry's left half (events, fold, UI, vault) and right
  // half (the reflection dataset's Feedback field) both existed; the join
  // was the missing wire. The human's words about THIS answer are what the
  // mutator reads for direction.
  const events = [
    ...turn(
      "s1",
      "turn_a",
      "why is the build red",
      "the guard counts a new module and the import graph has one more edge than yesterday",
    ),
    ...turn(
      "s1",
      "turn_b",
      "rotate the key",
      "done — the key is rotated and the unit now answers with the new credential every time",
    ),
    {
      type: "feedback.recorded",
      id: "fb_1",
      at: "2026-10-12T00:00:00.000Z",
      scope: "message",
      messageID: "turn_a:assistant",
      verdict: "down",
      note: "you skipped the rollback step",
    } as unknown as RuntimeEvent,
  ];
  const { pairs } = mineSessionPairs("s1", events);
  expect(pairs.find((pair) => pair.turnID === "turn_a")!.feedback).toBe(
    "then: rotate the key | user: down: you skipped the rollback step",
  );
  // An unrated turn stays absent (the common case).
  expect(
    pairs.find((pair) => pair.turnID === "turn_b")!.feedback,
  ).toBeUndefined();

  // A retraction removes it — the index follows the journal, not the UI.
  const withdrawn = mineSessionPairs("s1", [
    ...events,
    {
      type: "feedback.retracted",
      id: "fbr_1",
      at: "2026-10-12T00:01:00.000Z",
      recordID: "fb_1",
      scope: "message",
      messageID: "turn_a:assistant",
      verdict: "down",
    } as unknown as RuntimeEvent,
  ]);
  // The retraction withdraws the EXPLICIT rating (the `user:` part goes);
  // what the user did next is a separate, always-present signal and stays
  // as context.
  expect(
    withdrawn.pairs.find((pair) => pair.turnID === "turn_a")!.feedback,
  ).toBe("then: rotate the key");
});

test("a rating on another message never rides this turn's pair", () => {
  const { pairs } = mineSessionPairs("s1", [
    ...turn(
      "s1",
      "turn_a",
      "why is the build red",
      "the guard counts a new module and the import graph has one more edge than yesterday",
    ),
    {
      type: "feedback.recorded",
      id: "fb_1",
      at: "2026-10-12T00:00:00.000Z",
      scope: "session",
      verdict: "up",
      note: "session was fine",
    } as unknown as RuntimeEvent,
  ]);
  expect(pairs[0]!.feedback).toBeUndefined();
});

test("the round trip keeps the feedback (a dataset read back still steers)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-dataset-feedback-"));
  try {
    await writeDataset({
      workspaceRoot: root,
      target: "feedback-rt",
      pairs: [
        {
          // turn_2 hashes to the train split (the split is identity-keyed,
          // so the round trip reads back from the split it landed in).
          sessionID: "s1",
          turnID: "turn_2",
          task: "t",
          response: "r",
          feedback: "down: skipped the rollback",
        },
      ],
    });
    // The split is hash-decided, so read the one that holds it.
    const split = splitForPair({
      sessionID: "s1",
      turnID: "turn_2",
      task: "t",
      response: "r",
    });
    const back = await readDatasetSplit(root, "feedback-rt", split);
    const all = await readDataset(root, "feedback-rt");
    expect(back[0]!.feedback).toBe("down: skipped the rollback");
    expect(all!.visible[0]!.feedback).toBe("down: skipped the rollback");
    // And it reaches the sample the mutator reads.
    const [sample] = samplesFromPairs(all!.visible, () => "train" as const);
    expect(sample!.feedback).toBe("down: skipped the rollback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a trivial answer is counted, not mined — the low-entropy end of the density filter", () => {
  // W3: the reference design's information-density filter prunes BOTH
  // ends. The high-noise end is the response cap; the low-entropy end is
  // here — a one-word confirmation teaches nothing, and a sample every
  // candidate trivially matches flattens the score's dynamic range for
  // everybody. Counted, not silently dropped: a journal whose turns are
  // mostly trivial is the wrong source, which is information.
  const { pairs, dropped } = mineSessionPairs("s1", [
    ...turn(
      "s1",
      "t1",
      "fix the flaky test",
      "I pinned the clock in the retry helper so the test passed on every run of the suite.",
    ),
    ...turn("s1", "t2", "rotate the key", "done"),
    ...turn("s1", "t3", "ship the packer", "ok"),
  ]);
  expect(pairs.map((pair) => pair.turnID)).toEqual(["t1"]);
  expect(dropped.trivial).toBe(2);

  // An echo of the task is trivial however long it is.
  expect(
    isTrivialAnswer(
      "please run the full test suite now",
      "please run the full test suite now — that is the whole task, verbatim, echoed back to you",
    ),
  ).toBe(true);
  // A real answer about the same task is not.
  expect(
    isTrivialAnswer(
      "please run the full test suite now",
      "the suite ran and two tests failed inside the retry helper, both of them timing related failures",
    ),
  ).toBe(false);
});

test("a secret in a short answer is counted as the secret it is", () => {
  // The density filter runs AFTER the secret filter: a key pasted into a
  // two-word reply is still a key, and counting it as noise would hide
  // the one fact the operator needs.
  const { dropped } = mineSessionPairs("s1", [
    ...turn("s1", "t1", "use this", "sk-ant-api03-abcdefghijklmnop"),
  ]);
  expect(dropped.secrets).toBe(1);
  expect(dropped.trivial).toBe(0);
});

test("the rubric rides the JSONL round-trip and reaches the sample", () => {
  // W2(a)'s acceptance: the rubric field enters the JSONL AND the judge
  // uses it. A field that is written but never read back is a field that
  // only ever worked in the writer's own test.
  const pairs: DatasetPair[] = [
    {
      sessionID: "ses_1",
      turnID: "turn_1",
      task: "record the rollback step",
      response: "Record it first.",
      expected_behavior:
        "names the rollback step before the destructive action",
    },
  ];
  const lines = datasetSplitLines(pairs);
  expect(lines).toContain("expected_behavior");
  // And it survives the read back.
  const back = lines
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DatasetPair);
  expect(back[0]!.expected_behavior).toBe(
    "names the rollback step before the destructive action",
  );
  // And it reaches the sample the judge scores.
  const samples = samplesFromPairs(back, () => "train" as const);
  expect(samples[0]!.expected_behavior).toBe(
    "names the rollback step before the destructive action",
  );
});
