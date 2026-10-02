import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { FakeCompactor } from "./fixtures";
import {
  assertContextBudgetInvariants,
  compactContext,
  contextEntriesToProviderMessages,
  compactionTrigger,
  contextThresholdTokens,
  DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  decideCompaction,
  selectCompactableRange,
  ContextLedger,
  largeToolResultContext,
  preserveRecentTail,
  preserveRecentWithToolPairs,
  preserveRecentWithToolPairsByTokens,
  MIN_SUMMARY_CHARS,
  SUMMARY_ATTEMPTS,
  missingSummarySections,
  providerCompactor,
  pruneToolResultEntry,
  providerError,
  recoverContextLimitOnce,
  resolveReservedOutputTokens,
  type Compactor,
  type ContextEntry,
  type ProviderStreamRequest,
  type StreamingProvider,
} from "../src";

test("context accounting combines provider exact checkpoint with pending estimate", () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "sys",
    role: "system",
    content: "system prompt",
    tokens: 10,
  });
  ledger.add({
    id: "tool",
    role: "tool_result",
    content: "tool output",
    tokens: 20,
  });
  ledger.recordProviderUsage(100, 25);
  expect(
    ledger.status({
      max: 200,
      thresholdPercent: 85,
      reserved: 50,
    }).source,
  ).toBe("exact_checkpoint");
  ledger.add({
    id: "dyn",
    role: "dynamic",
    content: "dynamic injection",
    tokens: 7,
  });
  ledger.addResource({
    kind: "agent",
    id: "agent-1",
    summary: "running subagent",
  });

  const status = ledger.status({
    max: 200,
    thresholdPercent: 85,
    reserved: 50,
  });
  expect(status.used).toBeGreaterThanOrEqual(132);
  expect(status.source).toBe("pending_estimate");
  expect(status.trigger).toBeUndefined();
  expect(ledger.snapshot().entries.map((entry) => entry.role)).toContain(
    "resource",
  );
});

test("reserved output resolver prioritizes provider, explicit, catalog and fallback formula", () => {
  expect(
    resolveReservedOutputTokens({
      contextWindow: 32000,
      configuredReserved: 1234,
    }).source,
  ).toBe("config");
  expect(
    resolveReservedOutputTokens({
      contextWindow: 32000,
      configuredReserved: "auto",
      providerOutputLimit: 4096,
    }).tokens,
  ).toBe(4096);
  expect(
    resolveReservedOutputTokens({
      contextWindow: 32000,
      configuredReserved: "auto",
      explicitMaxOutputTokens: 2048,
    }).source,
  ).toBe("explicit_output");
  expect(
    resolveReservedOutputTokens({
      contextWindow: 32000,
      configuredReserved: "auto",
      catalogOutputLimit: 8192,
    }).source,
  ).toBe("catalog");
  expect(
    resolveReservedOutputTokens({
      contextWindow: 32000,
      configuredReserved: "auto",
    }).tokens,
  ).toBe(4096);
  expect(
    resolveReservedOutputTokens({
      contextWindow: 200000,
      configuredReserved: "auto",
    }).tokens,
  ).toBe(20000);
});

test("compaction trigger uses ratio or reserved budget and respects disabled config", async () => {
  expect(
    compactionTrigger({
      used: 86,
      max: 100,
      thresholdPercent: 85,
      reserved: 1,
    }),
  ).toBe("ratio");
  expect(
    compactionTrigger({
      used: 70,
      max: 100,
      thresholdPercent: 85,
      reserved: 31,
    }),
  ).toBe("reserved");

  const ledger = ledgerWithMessages(10);
  const before = ledger.snapshot();
  const result = await compactContext(ledger, new FakeCompactor(), {
    id: "cmp_disabled",
    trigger: "ratio",
    enabled: false,
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 2,
  });
  expect(result).toEqual({ compacted: false, skipped: "disabled" });
  expect(ledger.snapshot()).toEqual(before);
});

test("manual compaction works while disabled and preserves tool-call/result pairing", async () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "u1", role: "user", content: "old", tokens: 10 });
  ledger.add({
    id: "call",
    role: "tool_call",
    content: "call",
    pairID: "p1",
    tokens: 10,
  });
  ledger.add({
    id: "result",
    role: "tool_result",
    content: "result",
    pairID: "p1",
    tokens: 10,
  });
  ledger.add({ id: "a1", role: "assistant", content: "recent", tokens: 10 });
  const events: string[] = [];

  const result = await compactContext(
    ledger,
    new FakeCompactor([{ summary: "manual summary", tokens: 4 }]),
    {
      id: "cmp_manual",
      trigger: "manual",
      enabled: false,
      maxTokens: 1000,
      thresholdPercent: 85,
      reservedTokens: 100,
      preservedRecentMessages: 2,
      instruction: "keep tool evidence",
      onEvent: (event) => events.push(event.type),
    },
  );

  expect(result.compacted).toBe(true);
  expect(events).toContain("compaction.begin");
  expect(events).toContain("compaction.end");
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "cmp_manual:summary",
    "call",
    "result",
    "a1",
  ]);
});

test("compaction summarizes only entries older than the preserved tail", async () => {
  const ledger = ledgerWithMessages(4);
  let compactedIDs: string[] = [];
  const compactor: Compactor = {
    async compact(input) {
      // The span arrives as provider messages, so identify it by content.
      compactedIDs = input.messages.map((message) => message.content);
      return { summary: "old context" };
    },
  };
  await compactContext(ledger, compactor, {
    id: "cmp_head_only",
    trigger: "ratio",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 2,
  });
  expect(compactedIDs).toEqual(["message 0", "message 1"]);
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "cmp_head_only:summary",
    "m2",
    "m3",
  ]);
  expect(
    ledger.status({ max: 100, thresholdPercent: 85, reserved: 10 }).source,
  ).toBe("pending_estimate");
});

/** A summary that satisfies the compaction contract, for stub providers. */
const CONFORMING_SUMMARY = [
  "## Objective",
  "- Keep the tests honest.",
  "",
  "## Important Details",
  "- The contract is enforced now.",
  "",
  "## Work State",
  "### Completed",
  "- (none)",
  "",
  "### Active",
  "- Verifying the prompt shape.",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. Assert the prompt.",
  "",
  "## Relevant Files",
  "- packages/framework/runtime/src/compaction.ts: the contract.",
].join("\n");

test("provider compaction requests a structured, updateable work-state summary", async () => {
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [
      { role: "user", content: "Earlier state" },
      { role: "user", content: "New requirement" },
    ],
    resources: [],
  });

  // The span is replayed as messages, not flattened into the prompt, so the
  // instruction carries only the directive and the template.
  const prompt = request?.messages.at(-1)?.content ?? "";
  expect(prompt).toContain("update that anchor");
  expect(prompt).toContain("## Objective");
  expect(prompt).toContain("### Completed");
  expect(prompt).not.toContain("Earlier state");
  expect(prompt).not.toContain("New requirement");
  // The replayed span leads, one message per entry, in order.
  expect(request?.messages.slice(0, 2)).toEqual([
    { role: "user", content: "Earlier state" },
    { role: "user", content: "New requirement" },
  ]);
  expect(prompt).toContain("### Active");
  expect(prompt).toContain("### Blocked");
  expect(prompt).toContain("## Next Move");
  expect(prompt).toContain("## Relevant Files");
  // The span's own text never enters the instruction: it is replayed as
  // messages ahead of it, which is what lets the prefix cache cover it.
  expect(prompt).not.toContain("summary: Earlier state");
  expect(prompt).not.toContain("user: New requirement");
});

test("provider compaction reuses the routed system prefix", async () => {
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };
  await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "New requirement" }],
    resources: [],
    prefixMessages: [
      { role: "system", content: "Original routed system prompt" },
    ],
  });
  // The routed system prompt leads, the span is replayed verbatim, and the
  // instruction closes the request — so the span's bytes match what the routed
  // request carried and the prefix cache can cover them.
  expect(request?.messages[0]).toMatchObject({
    role: "system",
    content: "Original routed system prompt",
  });
  expect(request?.messages[1]).toMatchObject({
    role: "user",
    content: "New requirement",
  });
  expect(request?.messages.at(-1)?.content).toContain(
    "Summarize this Natalia agent session",
  );
});

test("compaction skips when every entry belongs to the preserved tail", async () => {
  const ledger = ledgerWithMessages(2);
  let called = false;
  const result = await compactContext(
    ledger,
    {
      async compact() {
        called = true;
        return { summary: "unused" };
      },
    },
    {
      id: "cmp_nothing",
      trigger: "ratio",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 2,
    },
  );
  expect(result).toEqual({
    compacted: false,
    skipped: "nothing_to_compact",
  });
  expect(called).toBe(false);
});

test("compaction does not repeatedly summarize an existing summary", async () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "summary",
    role: "summary",
    content: "already compacted",
    tokens: 10,
  });
  let called = false;
  const result = await compactContext(
    ledger,
    {
      async compact() {
        called = true;
        return { summary: "nested summary" };
      },
    },
    {
      id: "cmp_summary_only",
      trigger: "ratio",
      maxTokens: 10,
      thresholdPercent: 50,
      reservedTokens: 1,
      preservedRecentMessages: 0,
    },
  );
  expect(result).toEqual({
    compacted: false,
    skipped: "nothing_to_compact",
  });
  expect(called).toBe(false);
});

test("compaction estimates retained context instead of compactor API usage", async () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "old", role: "user", content: "x".repeat(400_000) });
  ledger.add({ id: "recent", role: "user", content: "recent", tokens: 2 });
  await compactContext(
    ledger,
    new FakeCompactor([{ summary: "small summary" }]),
    {
      id: "cmp_usage",
      trigger: "manual",
      maxTokens: 10_000,
      thresholdPercent: 85,
      reservedTokens: 1_000,
      preservedRecentMessages: 1,
    },
  );
  expect(ledger.effectiveTokens()).toBeLessThan(200);
  expect(
    ledger.status({ max: 10_000, thresholdPercent: 85, reserved: 1_000 })
      .trigger,
  ).toBeUndefined();
});

test("compaction retains attachment metadata only for preserved user entries", async () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "old-user",
    role: "user",
    content: "old image",
    attachments: [
      {
        id: "att_old",
        path: ".natalia/attachments/att_old-image.png",
        filename: "old.png",
        mediaType: "image/png",
        byteLength: 8,
        sha256: "old",
      },
    ],
  });
  ledger.add({
    id: "recent-user",
    role: "user",
    content: "recent image",
    attachments: [
      {
        id: "att_recent",
        path: ".natalia/attachments/att_recent-image.png",
        filename: "recent.png",
        mediaType: "image/png",
        byteLength: 8,
        sha256: "recent",
      },
    ],
  });
  await compactContext(
    ledger,
    new FakeCompactor([{ summary: "summary", tokens: 2 }]),
    {
      id: "cmp_attachment",
      trigger: "manual",
      maxTokens: 1000,
      thresholdPercent: 85,
      reservedTokens: 100,
      preservedRecentMessages: 1,
    },
  );
  expect(
    ledger
      .snapshot()
      .entries.flatMap((entry) => entry.attachments ?? [])
      .map((attachment) => attachment.id),
  ).toEqual(["att_recent"]);
});

test("compaction failure is atomic and retry events use M9 policy", async () => {
  const ledger = ledgerWithMessages(5);
  const before = ledger.snapshot();
  const events: string[] = [];
  const compactor: Compactor = {
    async compact() {
      throw providerError({ kind: "timeout", message: "compaction timeout" });
    },
  };
  await expect(
    compactContext(ledger, compactor, {
      id: "cmp_fail",
      trigger: "ratio",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 2,
      retry: {
        policy: { maxAttemptsPerStep: 3 },
        timer: async () => undefined,
        random: () => 0,
      },
      onEvent: (event) => events.push(event.type),
    }),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(ledger.snapshot()).toEqual(before);
  expect(events.filter((type) => type === "step.retry")).toHaveLength(2);
  expect(events).toContain("compaction.end");
});

test("context-limit recovery compacts once then retries original step without loop", async () => {
  const ledger = ledgerWithMessages(8);
  let calls = 0;
  const events: string[] = [];
  const value = await recoverContextLimitOnce({
    id: "turn_ctx",
    step: 2,
    ledger,
    compactor: new FakeCompactor([{ summary: "recovered", tokens: 50 }]),
    compact: {
      id: "cmp_ctx",
      maxTokens: 1000,
      thresholdPercent: 85,
      reservedTokens: 100,
      preservedRecentMessages: 2,
      retry: { timer: async () => undefined, random: () => 0 },
    },
    onEvent: (event) => events.push(event.type),
    async runStep() {
      calls += 1;
      if (calls === 1)
        throw providerError({ kind: "context_limit", message: "too long" });
      return "ok";
    },
  });
  expect(value).toBe("ok");
  expect(calls).toBe(2);
  expect(events).toContain("context.limit.recovery");
  expect(events).toContain("compaction.begin");
  expect(events).toContain("compaction.end");
});

test("context-limit recovery reports when no old context can be compacted", async () => {
  const ledger = ledgerWithMessages(1);
  const recoveries: boolean[] = [];
  let calls = 0;
  const value = await recoverContextLimitOnce({
    id: "turn_no_head",
    step: 1,
    ledger,
    compactor: new FakeCompactor(),
    compact: {
      id: "cmp_no_head",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 2,
    },
    async runStep() {
      calls += 1;
      if (calls === 1)
        throw providerError({ kind: "context_limit", message: "too long" });
      return "retried";
    },
    onEvent(event) {
      if (event.type === "context.limit.recovery")
        recoveries.push(event.compacted);
    },
  });
  expect(value).toBe("retried");
  expect(recoveries).toEqual([false, false]);
});

test("resource reinjection, session restore and event replay remain deterministic", async () => {
  const ledger = ledgerWithMessages(4);
  ledger.addResource({
    kind: "workflow",
    id: "wf-1",
    summary: "pending workflow",
  });
  const restored = new ContextLedger();
  restored.restore(ledger.snapshot());
  await compactContext(
    restored,
    new FakeCompactor([{ summary: "with resources", tokens: 4 }]),
    {
      id: "cmp_restore",
      trigger: "manual",
      maxTokens: 1000,
      thresholdPercent: 85,
      reservedTokens: 100,
      preservedRecentMessages: 1,
    },
  );
  expect(
    restored
      .snapshot()
      .entries.filter((entry) => entry.content.includes("workflow:wf-1")),
  ).toHaveLength(1);
});

test("large tool result context representation separates artifact from UI text", () => {
  const entry = largeToolResultContext({
    id: "tool_big",
    role: "tool_result",
    content: "x".repeat(5000),
    artifactRef: "artifact://tool_big",
  });
  expect(entry.content.length).toBeLessThan(2500);
  expect(entry.content).toContain("artifact://tool_big");
  expect(entry.content).toContain("totalChars=5000");
});

function ledgerWithMessages(count: number) {
  const ledger = new ContextLedger();
  for (let index = 0; index < count; index++) {
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
      tokens: 10,
    });
  }
  return ledger;
}

test("preserveRecentWithToolPairs restores missing paired call", () => {
  const entries: ContextEntry[] = [
    { id: "call", role: "tool_call", content: "call", pairID: "p" },
    { id: "middle", role: "assistant", content: "middle" },
    { id: "result", role: "tool_result", content: "result", pairID: "p" },
  ];
  expect(
    preserveRecentWithToolPairs(entries, 1).map((entry) => entry.id),
  ).toEqual(["call", "result"]);
});

test("preserveRecentWithToolPairsByTokens keeps the newest suffix and closes tool pairs", () => {
  const entries: ContextEntry[] = [
    { id: "call", role: "tool_call", content: "call", pairID: "p", tokens: 10 },
    {
      id: "middle",
      role: "assistant",
      content: "middle",
      tokens: 10,
    },
    {
      id: "result",
      role: "tool_result",
      content: "result",
      pairID: "p",
      tokens: 10,
    },
    { id: "newest", role: "assistant", content: "newest", tokens: 10 },
  ];
  expect(
    preserveRecentWithToolPairsByTokens(entries, 20).map((entry) => entry.id),
  ).toEqual(["call", "result", "newest"]);
  expect(
    preserveRecentWithToolPairsByTokens(entries, 5).map((entry) => entry.id),
  ).toEqual(["newest"]);
  expect(preserveRecentWithToolPairsByTokens(entries, 0)).toEqual([]);
});

test("compaction keeps whichever of the message count and token budget reaches further back", async () => {
  // The two constraints are floors, not alternatives: a count cannot say how
  // much context a turn holds, and a token budget cannot say "always keep the
  // last few exchanges". Here the count of 2 reaches further back than 15
  // tokens' worth, so the count wins and the extra entry is kept.
  const ledger = ledgerWithMessages(4);
  let compactedIDs: string[] = [];
  const compactor: Compactor = {
    async compact(input) {
      compactedIDs = input.messages.map((message) => message.content);
      return { summary: "budgeted summary" };
    },
  };
  await compactContext(ledger, compactor, {
    id: "cmp_budget",
    trigger: "ratio",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 2,
    preservedRecentTokens: 15,
  });
  expect(compactedIDs).toEqual(["message 0", "message 1"]);
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "cmp_budget:summary",
    "m2",
    "m3",
  ]);
});

test("compaction lets a generous token budget keep more than the message count", async () => {
  // The other direction: enough tokens to hold the whole ledger, so the token
  // budget is the binding constraint and the count is a floor below it.
  const ledger = ledgerWithMessages(4);
  let compactedIDs: string[] = [];
  const compactor: Compactor = {
    async compact(input) {
      compactedIDs = input.messages.map((message) => message.content);
      return { summary: "budgeted summary" };
    },
  };
  await compactContext(ledger, compactor, {
    id: "cmp_budget_tokens",
    trigger: "ratio",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 1,
    preservedRecentTokens: 10_000,
  });
  // Nothing is compactable once the whole ledger fits the tail.
  expect(compactedIDs).toEqual([]);
});

test("pruneToolResultEntry shrinks old oversized tool output and is idempotent", () => {
  const entry: ContextEntry = {
    id: "big",
    role: "tool_result",
    content: "x".repeat(9_000),
    tokens: 2_250,
  };
  const pruned = pruneToolResultEntry(entry);
  expect(pruned).not.toBe(entry);
  expect(pruned.content.length).toBeLessThan(entry.content.length);
  expect(pruned.content).toContain("tool result truncated for context");
  expect(pruned.content).toContain("originalChars=9000");
  expect(pruneToolResultEntry(pruned)).toBe(pruned);

  const small: ContextEntry = {
    id: "small",
    role: "tool_result",
    content: "short output",
  };
  expect(pruneToolResultEntry(small)).toBe(small);
});

test("ContextLedger pruneToolResults protects the newest entry and lowers effectiveTokens", () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "old-big",
    role: "tool_result",
    content: "x".repeat(9_000),
    tokens: 2_250,
  });
  ledger.add({
    id: "newest",
    role: "assistant",
    content: "newest turn",
    tokens: 10,
  });
  const before = ledger.effectiveTokens();
  const outcome = ledger.pruneToolResults();
  expect(outcome.pruned).toBe(1);
  expect(outcome.afterTokens).toBeLessThan(before);
  expect(ledger.snapshot().entries[0]?.content).toContain(
    "tool result truncated for context",
  );
  expect(ledger.snapshot().entries[1]?.content).toBe("newest turn");
  expect(
    ledger.status({ max: 1000, thresholdPercent: 85, reserved: 10 }).source,
  ).toBe("pending_estimate");
});

test("ContextLedger pruneToolResults is idempotent: a second pass rewrites nothing", () => {
  // Pruning rewrites live entries, and every provider request writes a
  // prefix-cache breakpoint at the end of its stable region. A second prune
  // that changed already-pruned bytes would invalidate the prefix the request
  // just cached, so idempotence is what limits the rewrite to one event/entry.
  const ledger = new ContextLedger();
  ledger.add({
    id: "old-big",
    role: "tool_result",
    content: "x".repeat(9_000),
    tokens: 2_250,
  });
  ledger.add({ id: "newest", role: "assistant", content: "newest", tokens: 4 });

  const first = ledger.pruneToolResults();
  const afterFirst = ledger.snapshot().entries.map((entry) => entry.content);
  const second = ledger.pruneToolResults();
  const afterSecond = ledger.snapshot().entries.map((entry) => entry.content);

  expect(first.pruned).toBe(1);
  expect(second.pruned).toBe(0);
  expect(afterSecond).toEqual(afterFirst);
});

test("ContextLedger pruneToolResults leaves the protected newest entry alone on every pass", () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "old-big",
    role: "tool_result",
    content: "x".repeat(9_000),
    tokens: 2_250,
  });
  ledger.add({
    id: "newest-big",
    role: "tool_result",
    content: "y".repeat(9_000),
    tokens: 2_250,
  });

  ledger.pruneToolResults();

  expect(ledger.snapshot().entries[0]?.content).toContain(
    "tool result truncated for context",
  );
  expect(ledger.snapshot().entries[1]?.content).toBe("y".repeat(9_000));
});

test("compaction aborts when the ledger surface changes during summarization", async () => {
  const ledger = ledgerWithMessages(4);
  const events: RuntimeEvent[] = [];
  const compactor: Compactor = {
    async compact() {
      ledger.add({
        id: "late-arrival",
        role: "user",
        content: "arrived while the summary ran",
        tokens: 5,
      });
      return { summary: "stale summary" };
    },
  };
  const result = await compactContext(ledger, compactor, {
    id: "cmp_surface_changed",
    trigger: "manual",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 2,
    onEvent: (event) => events.push(event),
  });
  expect(result).toEqual({ compacted: false, skipped: "surface_changed" });
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "m0",
    "m1",
    "m2",
    "m3",
    "late-arrival",
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "compaction.end",
      success: false,
      error: "surface_changed",
    }),
  );
});

test("recoverContextLimitOnce bounds overflow retries and reports exhaustion", async () => {
  let calls = 0;
  await expect(
    recoverContextLimitOnce({
      id: "turn_overflow_exhausted",
      step: 1,
      ledger: ledgerWithMessages(2),
      compactor: new FakeCompactor([{ summary: "summary" }]),
      compact: {
        id: "cmp_overflow_exhausted",
        maxTokens: 100,
        thresholdPercent: 85,
        reservedTokens: 10,
        preservedRecentMessages: 0,
      },
      maxOverflowRetries: 0,
      async runStep() {
        calls += 1;
        throw providerError({
          kind: "context_limit",
          message: "too long",
        });
      },
    }),
  ).rejects.toMatchObject({
    kind: "context_limit",
    message: expect.stringContaining("retries exhausted (0)"),
  });
  expect(calls).toBe(1);
});

test("decideCompaction returns none below both thresholds", () => {
  expect(
    decideCompaction({
      requestTokens: 1000,
      headerTokens: 200,
      surfaceTokens: 800,
      max: 100_000,
      reserved: 4096,
      thresholdPercent: 85,
      hasCompactableRange: true,
    }),
  ).toBe("none");
});

test("decideCompaction returns ratio on full-request pressure", () => {
  expect(
    decideCompaction({
      requestTokens: 90_000,
      headerTokens: 10_000,
      surfaceTokens: 80_000,
      max: 100_000,
      reserved: 4096,
      thresholdPercent: 85,
      hasCompactableRange: true,
    }),
  ).toBe("ratio");
});

test("decideCompaction returns reserved when request plus output would not fit", () => {
  // Below the 85% ratio threshold (85000) but request + reserved (20000) would
  // exceed the 100k window, so the hard capacity guard fires instead.
  expect(
    decideCompaction({
      requestTokens: 84_000,
      headerTokens: 5_000,
      surfaceTokens: 79_000,
      max: 100_000,
      reserved: 20_000,
      thresholdPercent: 85,
      hasCompactableRange: true,
    }),
  ).toBe("reserved");
});

test("decideCompaction refuses to summarize without a compactable range", () => {
  // Over pressure, but the only foldable content is already a summary.
  expect(
    decideCompaction({
      requestTokens: 90_000,
      headerTokens: 10_000,
      surfaceTokens: 80_000,
      max: 100_000,
      reserved: 4096,
      thresholdPercent: 85,
      hasCompactableRange: false,
    }),
  ).toBe("nothing_to_compact");
});

test("decideCompaction uses the conservative 32k reserve instead of a flat 20k", () => {
  // A 32k window reserves 4096, so a ~28k request is under the reserved guard
  // and only trips at the ratio threshold; a flat 20k reserve would wrongly fire.
  expect(
    decideCompaction({
      requestTokens: 20_000,
      headerTokens: 4_096,
      surfaceTokens: 15_904,
      max: 32_000,
      reserved: 4096,
      thresholdPercent: 85,
      hasCompactableRange: true,
    }),
  ).toBe("none");
});

test("selectCompactableRange splits preserved suffix from compactable prefix", () => {
  const ledger = new ContextLedger();
  for (let index = 0; index < 6; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
    });
  const range = selectCompactableRange(ledger.snapshot().entries, {
    recentMessages: 2,
  });
  expect(range.preserved.map((entry) => entry.id)).toEqual(["m4", "m5"]);
  expect(range.compactable.map((entry) => entry.id)).toEqual([
    "m0",
    "m1",
    "m2",
    "m3",
  ]);
  expect(range.hasRange).toBe(true);
});

test("selectCompactableRange reports no range when only a summary remains", () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "s", role: "summary", content: "prior summary" });
  ledger.add({ id: "u", role: "user", content: "latest" });
  const range = selectCompactableRange(ledger.snapshot().entries, {
    recentMessages: 5,
  });
  expect(range.compactable).toEqual([]);
  expect(range.hasRange).toBe(false);
});

test("contextThresholdTokens derives the compaction boundary from the budget", () => {
  expect(contextThresholdTokens({ max: 100_000, thresholdPercent: 85 })).toBe(
    85_000,
  );
  expect(contextThresholdTokens({ max: 99, thresholdPercent: 90 })).toBe(89);
});

test("assertContextBudgetInvariants rejects a preserved tail above the threshold", () => {
  const base = {
    max: 10_000,
    reserved: 1_000,
    reservedSource: "fallback_formula" as const,
    thresholdPercent: 80,
    preservedRecentMessages: 10,
    maxOverflowRetries: 1,
    prune: DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  };
  // 8_000 is the threshold: a preserved tail at or above it can never trigger.
  expect(() =>
    assertContextBudgetInvariants({ ...base, preservedRecentTokens: 8_000 }),
  ).toThrow(/preservedRecentTokens/);
  // Below the threshold is the valid configuration.
  expect(() =>
    assertContextBudgetInvariants({ ...base, preservedRecentTokens: 2_000 }),
  ).not.toThrow();
  // 0 disables the absolute tail budget and is always valid.
  expect(() =>
    assertContextBudgetInvariants({ ...base, preservedRecentTokens: 0 }),
  ).not.toThrow();
});

test("compaction keeps the ledger's leading system entry", async () => {
  // The main runner keeps its system prompt outside the ledger and re-unshifts
  // it after every rebuild (provider-runner.ts:1356,1386). The subagent runner
  // does not: it writes the system prompt as ledger entry 0
  // (subagent-support.ts:155) and rebuilds straight from the ledger. So a
  // compaction that treats that entry as ordinary history would leave the
  // subagent sending requests with no system prompt at all.
  const ledger = new ContextLedger();
  ledger.add({
    id: "system",
    role: "system",
    content: "subagent system prompt",
    tokens: 10,
  });
  ledger.add({
    id: "task",
    role: "user",
    content: "the delegated task",
    tokens: 10,
  });
  for (let index = 0; index < 12; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
      tokens: 10,
    });

  const result = await compactContext(ledger, new FakeCompactor(), {
    id: "cmp_system_head",
    trigger: "manual",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 4,
    onEvent: () => {},
  });

  expect(result.compacted).toBe(true);
  const entries = ledger.snapshot().entries;
  expect(entries[0]?.role).toBe("system");
  expect(entries[0]?.content).toBe("subagent system prompt");
  // Retaining it must not duplicate it when the preserved tail already covers
  // the whole ledger, which is the only case where preserved[0] is that entry.
  expect(entries.filter((entry) => entry.id === "system")).toHaveLength(1);
});

test("compaction settles after one pass even with a leading system entry", async () => {
  // `selectCompactableRange` excludes the system head so `hasRange` goes false
  // once only a summary remains. Without that exclusion the retained head would
  // be re-selected on every later preflight and the session would summarize
  // forever.
  const ledger = new ContextLedger();
  ledger.add({
    id: "system",
    role: "system",
    content: "system prompt",
    tokens: 10,
  });
  ledger.add({ id: "u1", role: "user", content: "the task", tokens: 10 });
  for (let index = 0; index < 12; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index}`,
      tokens: 10,
    });

  const first = await compactContext(ledger, new FakeCompactor(), {
    id: "cmp_settle",
    trigger: "manual",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    preservedRecentMessages: 4,
    onEvent: () => {},
  });
  const rangeAfter = selectCompactableRange(ledger.snapshot().entries, {
    recentMessages: 4,
  });

  expect(first.compacted).toBe(true);
  expect(rangeAfter.hasRange).toBe(false);
  expect(
    rangeAfter.compactable.every((entry) => entry.role === "summary"),
  ).toBe(true);
});

test("preserveRecentTail unions the count and token constraints", () => {
  // Ten entries of 10 tokens each. A count of 3 reaches back 30 tokens' worth;
  // a budget of 60 reaches back 6 entries. The union keeps the further one.
  const ledger = new ContextLedger();
  for (let index = 0; index < 10; index++)
    ledger.add({
      id: `m${index}`,
      role: "user",
      content: "x".repeat(40),
      tokens: 10,
    });

  const byCount = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 3,
  });
  const byTokens = preserveRecentTail(ledger.snapshot().entries, {
    recentTokens: 60,
  });
  const both = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 3,
    recentTokens: 60,
  });

  expect(byCount.map((e) => e.id)).toEqual(["m7", "m8", "m9"]);
  expect(byTokens.map((e) => e.id)).toEqual([
    "m4",
    "m5",
    "m6",
    "m7",
    "m8",
    "m9",
  ]);
  // The union is the longer of the two, not one of them.
  expect(both.map((e) => e.id)).toEqual(byTokens.map((e) => e.id));
});

test("preserveRecentTail reaches back for a user message the tail would lack", () => {
  // A tail of replies and tool exchanges says nothing about what the user wants.
  // The last user message is deliberately not the first entry, so reaching it
  // still leaves something to compact — which is what makes the reach
  // worthwhile rather than self-defeating.
  const ledger = new ContextLedger();
  ledger.add({ id: "m0", role: "assistant", content: "earlier", tokens: 5 });
  ledger.add({ id: "u", role: "user", content: "do the thing", tokens: 5 });
  ledger.add({
    id: "c",
    role: "tool_call",
    content: "call",
    pairID: "p",
    tokens: 5,
  });
  ledger.add({
    id: "r",
    role: "tool_result",
    content: "res",
    pairID: "p",
    tokens: 5,
  });
  ledger.add({ id: "a", role: "assistant", content: "done", tokens: 5 });

  const tail = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 2,
  });

  // The count alone would keep only the result and the reply.
  expect(tail.map((e) => e.id)).toEqual(["u", "c", "r", "a"]);
  expect(tail.some((e) => e.role === "user")).toBe(true);
});

test("preserveRecentTail never lets the user-message rule swallow the compactable range", () => {
  // Reaching back to the only user message would leave nothing to compact, and
  // compaction that never fires grows the context without bound.
  const ledger = new ContextLedger();
  ledger.add({ id: "u", role: "user", content: "the only message", tokens: 5 });
  ledger.add({
    id: "c",
    role: "tool_call",
    content: "call",
    pairID: "p",
    tokens: 5,
  });
  ledger.add({
    id: "r",
    role: "tool_result",
    content: "res",
    pairID: "p",
    tokens: 5,
  });
  ledger.add({ id: "a", role: "assistant", content: "done", tokens: 5 });

  const tail = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 2,
  });

  // The count's own tail stands, so the user message stays compactable. The
  // tool call joins it because closing the pair is not optional.
  expect(tail.map((e) => e.id)).toEqual(["c", "r", "a"]);
});

test("preserveRecentTail keeps a tail that already holds a user message exactly as constrained", () => {
  const ledger = new ContextLedger();
  for (let index = 0; index < 6; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: "x",
      tokens: 1,
    });

  const tail = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 2,
  });

  // m4 is a user message, so the guarantee adds nothing and the count decides.
  expect(tail.map((e) => e.id)).toEqual(["m4", "m5"]);
});

test("a disabled token budget leaves the count as the only constraint", () => {
  const ledger = new ContextLedger();
  for (let index = 0; index < 6; index++)
    ledger.add({ id: `m${index}`, role: "user", content: "x", tokens: 1 });

  const tail = preserveRecentTail(ledger.snapshot().entries, {
    recentMessages: 2,
    recentTokens: 0,
  });

  expect(tail.map((e) => e.id)).toEqual(["m4", "m5"]);
});

test("missingSummarySections names every absent heading in template order", () => {
  expect(missingSummarySections(CONFORMING_SUMMARY)).toEqual([]);
  expect(
    missingSummarySections("## Objective\n- x\n## Next Move\n1. y"),
  ).toEqual([
    "## Important Details",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Relevant Files",
  ]);
});

test("a compactor regenerates a summary that drops a required section", async () => {
  // A summary missing `Next Move` still parses as markdown and still commits,
  // and the work then resumes with no statement of what was in progress.
  let attempts = 0;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream() {
      attempts += 1;
      yield {
        type: "content",
        text:
          attempts === 1
            ? "## Objective\n- only the objective, nothing else"
            : CONFORMING_SUMMARY,
      };
    },
  };

  const result = await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "work" }],
    resources: [],
  });

  expect(attempts).toBe(2);
  expect(result.summary).toBe(CONFORMING_SUMMARY);
});

test("a compactor regenerates a summary too short to carry the span", async () => {
  // A one-line summary of a hundred-thousand-token span throws away everything
  // compaction was meant to preserve, and nothing downstream can tell it apart
  // from a good one.
  let attempts = 0;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream() {
      attempts += 1;
      yield {
        type: "content",
        text: attempts === 1 ? "done." : CONFORMING_SUMMARY,
      };
    },
  };

  const result = await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "work" }],
    resources: [],
  });

  expect(attempts).toBe(2);
  expect(result.summary.length).toBeGreaterThan(MIN_SUMMARY_CHARS);
});

test("a compactor that never satisfies the contract fails instead of committing it", async () => {
  // The context a bad summary replaces cannot be recovered, so a summary that
  // cannot be made valid has to fail the compaction rather than land.
  let attempts = 0;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream() {
      attempts += 1;
      yield { type: "content", text: "still too short" };
    },
  };

  // A stub this short fails both checks; the section check runs first, so the
  // message names whichever contract it broke rather than the last one tried.
  await expect(
    providerCompactor(provider).compact({
      messages: [{ role: "user", content: "work" }],
      resources: [],
    }),
  ).rejects.toThrow(/missing required sections|too short/);
  // Bounded: a summary that cannot be made valid costs this many calls and then
  // fails, rather than retrying until the request times out.
  expect(attempts).toBe(SUMMARY_ATTEMPTS);
});

test("the compaction prompt spells out how to merge a prior summary", async () => {
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [
      { role: "user", content: "Earlier state" },
      { role: "user", content: "New requirement" },
    ],
    resources: [],
  });

  const prompt = request?.messages.at(-1)?.content ?? "";
  // The prior summary is discarded by the merge, so what must survive has to be
  // carried deliberately — and a conflict resolves toward the newer entries.
  expect(prompt).toContain("update that anchor");
  expect(prompt).toContain("the newer entries win");
  expect(prompt).toContain("Move completed work from Active to Completed");
});

test("a compaction that would not shrink anything is rejected", async () => {
  // A compaction that does not shrink has spent a provider call to arrive where
  // it started, and the failure is silent from there: the context is unchanged,
  // the threshold is still exceeded, and the next step compacts again.
  const ledger = new ContextLedger();
  ledger.add({ id: "u1", role: "user", content: "old", tokens: 50 });
  ledger.add({ id: "a1", role: "assistant", content: "newer", tokens: 50 });
  const events: string[] = [];
  const result = await compactContext(
    ledger,
    new FakeCompactor([{ summary: "a very long summary indeed", tokens: 500 }]),
    {
      id: "cmp_no_shrink",
      trigger: "manual",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 1,
      onEvent: (event) => events.push(event.type),
    },
  );

  expect(result.compacted).toBe(false);
  // The failure is reported rather than swallowed, and the ledger is untouched.
  expect(events).toContain("compaction.end");
  expect(ledger.snapshot().entries.map((entry) => entry.id)).toEqual([
    "u1",
    "a1",
  ]);
});

test("a compaction whose summary is smaller than the span commits", async () => {
  const ledger = new ContextLedger();
  ledger.add({
    id: "u1",
    role: "user",
    content: "x".repeat(4000),
    tokens: 1000,
  });
  ledger.add({ id: "a1", role: "assistant", content: "newer", tokens: 10 });

  const result = await compactContext(
    ledger,
    new FakeCompactor([{ summary: "short", tokens: 20 }]),
    {
      id: "cmp_shrinks",
      trigger: "manual",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 1,
      onEvent: () => {},
    },
  );

  expect(result.compacted).toBe(true);
  expect(ledger.snapshot().entries[0]!.role).toBe("summary");
});

test("the shrink check compares against the replaced span, not the whole ledger", async () => {
  // The preserved tail is untouched by a compaction, so counting it would
  // reject compactions that do reduce what they replace.
  const ledger = new ContextLedger();
  ledger.add({ id: "u1", role: "user", content: "x".repeat(400), tokens: 100 });
  ledger.add({
    id: "keep",
    role: "assistant",
    content: "y".repeat(4000),
    tokens: 1000,
  });
  ledger.add({
    id: "u2",
    role: "user",
    content: "z".repeat(4000),
    tokens: 1000,
  });

  const result = await compactContext(
    ledger,
    new FakeCompactor([{ summary: "small", tokens: 50 }]),
    {
      id: "cmp_span",
      trigger: "manual",
      maxTokens: 100,
      thresholdPercent: 85,
      reservedTokens: 10,
      preservedRecentMessages: 2,
      onEvent: () => {},
    },
  );

  // The tail alone is far larger than the summary, yet the compaction stands
  // because only u1 was replaced.
  expect(result.compacted).toBe(true);
});

test("the summarization call replays the span so its prefix matches the routed request", async () => {
  // The reason the span is sent as messages rather than a flattened dump: the
  // routed request carried these exact bytes, so the provider's warm prefix
  // cache covers them and the auxiliary call reads it instead of re-billing the
  // whole span. A text dump cannot match anything.
  const ledger = new ContextLedger();
  ledger.add({ id: "u1", role: "user", content: "first request", tokens: 10 });
  ledger.add({
    id: "c1",
    role: "tool_call",
    content: 'read_file {"p":"a"}',
    pairID: "p1",
    tokens: 10,
  });
  ledger.add({
    id: "r1",
    role: "tool_result",
    content: "file body",
    pairID: "p1",
    tokens: 10,
  });
  ledger.add({ id: "a1", role: "assistant", content: "read it", tokens: 10 });
  ledger.add({ id: "u2", role: "user", content: "second request", tokens: 10 });

  const routedMessages = contextEntriesToProviderMessages(
    ledger.snapshot().entries,
  );
  let compactedMessages: ProviderStreamRequest["messages"] = [];
  const compactor: Compactor = {
    async compact(input) {
      compactedMessages = input.messages;
      return { summary: CONFORMING_SUMMARY, tokens: 4 };
    },
  };

  await compactContext(ledger, compactor, {
    id: "cmp_prefix",
    trigger: "manual",
    maxTokens: 100,
    thresholdPercent: 85,
    reservedTokens: 10,
    // Preserve only the last message, so the span is the first four.
    preservedRecentMessages: 1,
    onEvent: () => {},
  });

  // Every summarised message is byte-identical to what the routed request sent,
  // in the same order, with nothing added ahead of them.
  expect(compactedMessages.length).toBeGreaterThan(1);
  expect(compactedMessages).toEqual(
    routedMessages.slice(0, compactedMessages.length),
  );
});

test("the summarization instruction is the last message of its own request", async () => {
  // Appending after the span is what keeps the span's bytes a prefix of the
  // routed request; putting the instruction first would shift everything.
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [
      { role: "user", content: "older turn" },
      { role: "assistant", content: "reply" },
    ],
    resources: [],
  });

  const messages = request?.messages ?? [];
  expect(messages).toHaveLength(3);
  expect(messages[0]).toEqual({ role: "user", content: "older turn" });
  expect(messages[1]).toEqual({ role: "assistant", content: "reply" });
  expect(messages[2]!.content).toContain(
    "Summarize this Natalia agent session",
  );
});

test("the summarization call reuses the routed system prompt as its own system message", async () => {
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "older turn" }],
    resources: [],
    prefixMessages: [{ role: "system", content: "the routed system prompt" }],
  });

  // Same system bytes, same position: the cacheable prefix starts identically.
  expect(request?.messages[0]).toEqual({
    role: "system",
    content: "the routed system prompt",
  });
});

test("the user's instruction is layered onto the compaction prompt", async () => {
  // A workspace often knows what a summary must keep that a generic one would
  // drop. Without this there is nowhere to say so.
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "work" }],
    resources: [],
    instruction: "Compact the older chat history.",
    userInstruction: "Always preserve changelog dates and ticket ids.",
  });

  const prompt = request?.messages.at(-1)?.content ?? "";
  expect(prompt).toContain("Compact the older chat history.");
  // Layered alongside the caller's direction rather than replacing it.
  expect(prompt).toContain(
    "The user of this workspace also requires: Always preserve changelog dates and ticket ids.",
  );
});

test("with no user instruction the prompt is unchanged", async () => {
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "work" }],
    resources: [],
  });

  expect(request?.messages.at(-1)?.content).not.toContain(
    "The user of this workspace also requires",
  );
});

test("the user instruction rides before the span, so it qualifies what to keep", async () => {
  // Position matters only for the model's reading order; the property worth
  // pinning is that it is not buried inside the span it is meant to shape.
  let request: ProviderStreamRequest | undefined;
  const provider: StreamingProvider = {
    provider: "test",
    model: "test",
    async *stream(input) {
      request = input;
      yield { type: "content", text: CONFORMING_SUMMARY };
    },
  };

  await providerCompactor(provider).compact({
    messages: [{ role: "user", content: "the span content" }],
    resources: [],
    userInstruction: "keep the ticket ids",
  });

  const messages = request?.messages ?? [];
  const instructionIndex = messages.findLastIndex((m) =>
    m.content.includes("keep the ticket ids"),
  );
  const spanIndex = messages.findLastIndex((m) =>
    m.content.includes("the span content"),
  );
  expect(instructionIndex).toBeGreaterThan(spanIndex);
});
