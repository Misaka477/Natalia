import { expect, test } from "bun:test";
import { pickBest, runBestOfN, type Sampler } from "../src/best-of-n";

/**
 * L4a's floor engine: the properties that make it a floor.
 *
 * The independence test is the load-bearing one: if an attempt could see
 * another attempt, this would not be a floor — it would be a one-round
 * evolutionary loop, and every later engine's "improvement" would be
 * measured against a moving baseline.
 */

/** A sampler that records every input it was handed (the independence probe). */
function recordingSampler(replies: string[]): {
  sampler: Sampler;
  inputs: Array<{ prompt: string; attempt: number }>;
} {
  const inputs: Array<{ prompt: string; attempt: number }> = [];
  let index = 0;
  return {
    inputs,
    sampler: async (input) => {
      inputs.push({ ...input });
      const reply = replies[index] ?? `fallback ${index}`;
      index += 1;
      return reply;
    },
  };
}

test("every attempt is an independent call that sees only the base prompt", async () => {
  const { sampler, inputs } = recordingSampler(["first", "second", "third"]);
  const result = await runBestOfN({
    prompt: "write the release checklist",
    n: 3,
    sampler,
    score: (text) => text.length,
    baselineScore: 0,
  });
  expect(result.attempts).toHaveLength(3);
  // Three calls, and every one of them saw the SAME prompt and only its own
  // attempt number — no previous text, no score, no feedback rode along.
  expect(inputs).toEqual([
    { prompt: "write the release checklist", attempt: 1 },
    { prompt: "write the release checklist", attempt: 2 },
    { prompt: "write the release checklist", attempt: 3 },
  ]);
  expect(result.attempts.map((attempt) => attempt.text)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

test("the best attempt wins, and a tie goes to the shorter text", async () => {
  const { sampler } = recordingSampler([
    "a long rambling answer that scores the same",
    "tight",
    "the highest scoring answer of all",
  ]);
  const result = await runBestOfN({
    prompt: "p",
    n: 3,
    sampler,
    // The first two tie at 5; the third wins outright.
    score: (text) => (text.startsWith("the highest") ? 9 : 5),
    baselineScore: 0,
  });
  expect(result.best?.text).toBe("the highest scoring answer of all");

  const tied = await runBestOfN({
    prompt: "p",
    n: 2,
    sampler: recordingSampler(["a long rambling answer", "tight"]).sampler,
    score: () => 5,
    baselineScore: 0,
  });
  expect(tied.best?.text).toBe("tight");
  expect(tied.best?.chars).toBe(5);
});

test("a failed sample is a per-attempt answer, and the loop continues", async () => {
  let call = 0;
  const result = await runBestOfN({
    prompt: "p",
    n: 3,
    sampler: async () => {
      call += 1;
      if (call === 2) throw new Error("provider timed out");
      return `answer ${call}`;
    },
    score: (text) => text.length,
    baselineScore: 0,
  });
  expect(result.attempts).toHaveLength(2);
  expect(result.failures).toEqual([
    { attempt: 2, reason: "provider timed out" },
  ]);
  // Both survivors score identically (same length), so the EARLIER
  // attempt wins — a full tie is settled by position, which keeps the
  // result stable across runs.
  expect(result.best?.text).toBe("answer 1");
});

test("every attempt failing leaves no best and beats no baseline", async () => {
  const result = await runBestOfN({
    prompt: "p",
    n: 2,
    sampler: async () => {
      throw new Error("no provider");
    },
    score: () => 1,
    baselineScore: 0,
  });
  expect(result.best).toBeUndefined();
  expect(result.failures).toHaveLength(2);
  expect(result.beatBaseline).toBe(false);
});

test("beating the baseline is strict improvement — a tie is not a win", async () => {
  const { sampler } = recordingSampler(["exactly as good as the baseline"]);
  const result = await runBestOfN({
    prompt: "p",
    n: 1,
    sampler,
    score: () => 0.5,
    baselineScore: 0.5,
  });
  expect(result.beatBaseline).toBe(false);
  const better = await runBestOfN({
    prompt: "p",
    n: 1,
    sampler: recordingSampler(["better"]).sampler,
    score: () => 0.6,
    baselineScore: 0.5,
  });
  expect(better.beatBaseline).toBe(true);
});

test("the attempt count is a caller contract, not a runtime condition", async () => {
  await expect(
    runBestOfN({
      prompt: "p",
      n: 0,
      sampler: async () => "x",
      score: () => 1,
      baselineScore: 0,
    }),
  ).rejects.toThrow(/positive attempt count/u);
});

test("pickBest is pure: same attempts in, same winner out", () => {
  const attempts = [
    { attempt: 1, text: "aa", score: 0.5, chars: 2 },
    { attempt: 2, text: "bbbb", score: 0.5, chars: 4 },
    { attempt: 3, text: "ccc", score: 0.4, chars: 3 },
  ];
  expect(pickBest(attempts)).toBe(attempts[0]);
  expect(pickBest([])).toBeUndefined();
  // A reordered list picks the same artifact (the tie-break is by content,
  // not by position).
  expect(pickBest([...attempts].reverse())?.text).toBe("aa");
});
