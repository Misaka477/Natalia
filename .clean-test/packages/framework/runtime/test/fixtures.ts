import type { ErrorKind } from "@anthelia/contracts";

type CompactionInput = {
  instruction?: string;
  resources: string[];
};

type CompactionResult = {
  summary: string;
  tokens?: number;
};

export class FakeCompactor {
  attempts = 0;
  constructor(
    private readonly outcomes: Array<
      CompactionResult | "timeout" | "failure"
    > = [{ summary: "compact summary", tokens: 4 }],
  ) {}

  async compact(input: CompactionInput) {
    const outcome =
      this.outcomes[Math.min(this.attempts, this.outcomes.length - 1)];
    this.attempts += 1;
    if (outcome === "timeout") throw new Error("compaction timeout");
    if (outcome === "failure") throw new Error("compaction failed");
    return {
      summary: [
        outcome?.summary ?? "compact summary",
        input.instruction,
        input.resources.join("\n"),
      ]
        .filter(Boolean)
        .join("\n"),
      // Small by default: a compaction whose summary is not smaller than the
      // span it replaces is rejected, and a fixture claiming a large summary
      // for a small span would be asserting an impossible compaction.
      tokens: outcome?.tokens ?? 4,
    };
  }
}

export type FakeRetryOutcome =
  | {
      type: "error";
      kind: ErrorKind;
      statusCode?: number;
      retryAfterMs?: number;
      message?: string;
    }
  | { type: "think-only"; chunks: string[] }
  | { type: "success"; chunks: string[] };

export class FakeRetryProvider {
  attempts = 0;
  constructor(private readonly outcomes: FakeRetryOutcome[]) {}

  async complete(emitTransient?: (chunk: string) => void) {
    const outcome =
      this.outcomes[Math.min(this.attempts, this.outcomes.length - 1)];
    this.attempts += 1;
    if (!outcome)
      return { type: "success", chunks: ["ok"] } satisfies FakeRetryOutcome;
    if (outcome.type === "think-only") {
      for (const chunk of outcome.chunks) emitTransient?.(chunk);
    }
    return outcome;
  }
}

export const retryScenarios = {
  timeoutThenSuccess: [
    { type: "error", kind: "timeout" },
    { type: "error", kind: "timeout" },
    { type: "success", chunks: ["final"] },
  ],
  connectionThenSuccess: [
    { type: "error", kind: "connection" },
    { type: "success", chunks: ["connected"] },
  ],
  rateLimitRetryAfter: [
    { type: "error", kind: "rate_limit", statusCode: 429, retryAfterMs: 1200 },
    { type: "success", chunks: ["limited-ok"] },
  ],
  server503ThenSuccess: [
    { type: "error", kind: "server", statusCode: 503 },
    { type: "success", chunks: ["server-ok"] },
  ],
  emptyThenSuccess: [
    { type: "error", kind: "empty_response" },
    { type: "success", chunks: ["non-empty"] },
  ],
  thinkOnlyThenSuccess: [
    { type: "think-only", chunks: ["hidden failed thought"] },
    { type: "success", chunks: ["clean final"] },
  ],
  cancel: [{ type: "error", kind: "cancel" }],
  exhausted: [
    { type: "error", kind: "timeout" },
    { type: "error", kind: "timeout" },
    { type: "error", kind: "timeout" },
  ],
} satisfies Record<string, FakeRetryOutcome[]>;
