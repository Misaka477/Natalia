import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  ContextLedger,
  DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
  TokenMeter,
  contextEntriesToProviderMessages,
  type ContextEntry,
  type ProviderMessage,
  type StreamingProvider,
} from "@anthelia/runtime";
import { prepareContextRequest } from "../src";

const TRUNCATION_MARKER = "tool result truncated for context";

/** A summary satisfying the compaction contract, for stub providers. */
const CONFORMING_SUMMARY = [
  "## Objective",
  "- Keep the request honest.",
  "",
  "## Important Details",
  "- The contract is enforced now.",
  "",
  "## Work State",
  "### Completed",
  "- (none)",
  "",
  "### Active",
  "- Compacting the request.",
  "",
  "### Blocked",
  "- (none)",
  "",
  "## Next Move",
  "1. Rebuild the outbound.",
  "",
  "## Relevant Files",
  "- packages/framework/runtime/src/compaction.ts: the contract.",
].join("\n");

function scriptedProvider(
  counter: { calls: number },
  summary = CONFORMING_SUMMARY,
): StreamingProvider {
  return {
    provider: "scripted",
    model: "scripted",
    async *stream() {
      counter.calls += 1;
      yield { type: "content", text: summary };
      yield { type: "done" };
    },
  };
}

function makeLedger(): ContextLedger {
  const ledger = new ContextLedger();
  ledger.add({ id: "sys", role: "system", content: "system prompt" });
  return ledger;
}

function rebuild(entries: ContextEntry[]): ProviderMessage[] {
  return contextEntriesToProviderMessages(entries);
}

function collectEvents(sink: RuntimeEvent[]) {
  return {
    emitStatus: (measured: { totalTokens: number }) => {
      sink.push({
        type: "context.status",
        used: measured.totalTokens,
        max: 0,
        source: "pending_estimate",
        thresholdPercent: 0,
        reserved: 0,
      } as unknown as RuntimeEvent);
    },
    emitSnapshot: (measured: { totalTokens: number }) => {
      sink.push({
        type: "context.snapshot",
        usedTokens: measured.totalTokens,
        source: "estimate",
        at: new Date().toISOString(),
      } as RuntimeEvent);
    },
  };
}

const baseInput = (overrides: Record<string, unknown>) => ({
  id: "turn-1",
  scope: "main",
  system: "system prompt",
  tools: undefined as unknown,
  contextWindow: 100_000,
  budget: { max: 100_000, thresholdPercent: 85, reserved: 4096 },
  // Every scenario here is a turn's first provider request, which is the only
  // request allowed to rewrite the ledger. `prune: false` tests the opposite.
  prune: true,
  preserve: { recentMessages: 1 },
  rebuildOutbound: rebuild,
  ...overrides,
});

test("prepareContextRequest leaves an under-threshold request untouched and never calls the LLM", async () => {
  const ledger = makeLedger();
  ledger.add({ id: "u1", role: "user", content: "hi" });
  const meter = new TokenMeter();
  const provider = scriptedProvider({ calls: 0 });
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);
  const outbound = rebuild(ledger.snapshot().entries);

  const result = await prepareContextRequest(
    baseInput({
      ledger,
      meter,
      outbound,
      provider,
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never,
  );

  expect(result.decision).toBe("none");
  expect(result.compacted).toBe(false);
  expect(result.pruned).toBe(0);
  expect(provider.stream).toBeDefined();
  // No compaction events emitted.
  expect(events.some((event) => event.type === "compaction.begin")).toBe(false);
  // A context surface was still published for the UI.
  expect(events.some((event) => event.type === "context.status")).toBe(true);
  expect(events.some((event) => event.type === "context.snapshot")).toBe(true);
});

test("prepareContextRequest prunes model-free before summarizing and rebuilds the truncated outbound", async () => {
  const ledger = makeLedger();
  // A large old tool result big enough to cross the 85% threshold (~340k chars)
  // so the prune path runs; pruning collapses it far below the threshold.
  ledger.add({
    id: "c1",
    role: "tool_call",
    content: "shell x",
    pairID: "c1",
  });
  ledger.add({
    id: "r1",
    role: "tool_result",
    content: "x".repeat(400_000),
    pairID: "c1",
  });
  ledger.add({ id: "u1", role: "user", content: "latest question" });
  const meter = new TokenMeter();
  const provider = scriptedProvider({ calls: 0 });
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);
  const outbound = rebuild(ledger.snapshot().entries);

  const result = await prepareContextRequest(
    baseInput({
      ledger,
      meter,
      outbound,
      provider,
      pruneOptions: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never,
  );

  // The oversized tool result was pruned, which drops the request below the
  // threshold, so the summarizer is never reached.
  expect(result.pruned).toBeGreaterThan(0);
  expect(result.compacted).toBe(false);
  const rebuiltText = result.outbound
    .map((message) => message.content)
    .join("\n");
  expect(rebuiltText).toContain(TRUNCATION_MARKER);
});

test("prepareContextRequest refuses to prune a later request of the same turn", async () => {
  // Every provider request writes a prefix-cache breakpoint at the end of its
  // stable region. Pruning rewrites live ledger entries, so a prune on the
  // turn's second request would invalidate the prefix the first request just
  // cached and re-bill the whole tail. Only `prune: true` may rewrite.
  const ledger = makeLedger();
  ledger.add({ id: "c1", role: "tool_call", content: "shell x", pairID: "c1" });
  ledger.add({
    id: "r1",
    role: "tool_result",
    content: "x".repeat(400_000),
    pairID: "c1",
  });
  ledger.add({ id: "u1", role: "user", content: "latest question" });
  const meter = new TokenMeter();
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);

  const result = await prepareContextRequest(
    baseInput({
      ledger,
      meter,
      outbound: rebuild(ledger.snapshot().entries),
      provider: scriptedProvider({ calls: 0 }),
      prune: false,
      pruneOptions: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never,
  );

  expect(result.pruned).toBe(0);
  expect(
    result.outbound.map((message) => message.content).join("\n"),
  ).not.toContain(TRUNCATION_MARKER);
});

test("prepareContextRequest summarizes when pressure survives pruning", async () => {
  const ledger = makeLedger();
  // No tool results to prune; the pressure is genuine message surface that
  // exceeds the 85% threshold (~340k chars).
  for (let index = 0; index < 60; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index} ${"y".repeat(8000)}`,
    });
  const meter = new TokenMeter();
  const counter = { calls: 0 };
  const provider = scriptedProvider(counter);
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);
  const outbound = rebuild(ledger.snapshot().entries);

  const result = await prepareContextRequest(
    baseInput({
      ledger,
      meter,
      outbound,
      provider,
      pruneOptions: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never,
  );

  expect(counter.calls).toBe(1);
  expect(result.compacted).toBe(true);
  expect(["ratio", "reserved"]).toContain(result.decision);
  // The rebuilt outbound now carries the summary entry.
  const hasSummary = result.outbound.some((message) =>
    message.content.includes(CONFORMING_SUMMARY),
  );
  expect(hasSummary).toBe(true);
  expect(events.some((event) => event.type === "compaction.begin")).toBe(true);
  expect(events.some((event) => event.type === "compaction.end")).toBe(true);
});

test("prepareContextRequest does not call the LLM when only a summary remains", async () => {
  const ledger = makeLedger();
  ledger.add({ id: "s", role: "summary", content: "prior summary" });
  ledger.add({ id: "u1", role: "user", content: "z".repeat(400_000) });
  const meter = new TokenMeter();
  const counter = { calls: 0 };
  const provider = scriptedProvider(counter);
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);
  const outbound = rebuild(ledger.snapshot().entries);

  const result = await prepareContextRequest(
    baseInput({
      ledger,
      meter,
      outbound,
      provider,
      // Preserve everything except the summary, so the only foldable content is
      // the summary itself -> nothing to compact.
      preserve: { recentMessages: 100 },
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never,
  );

  expect(counter.calls).toBe(0);
  expect(result.decision).toBe("nothing_to_compact");
  expect(result.compacted).toBe(false);
});

test("prepareContextRequest does not re-summarize when a prior compaction left only a summary", async () => {
  const ledger = makeLedger();
  for (let index = 0; index < 60; index++)
    ledger.add({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `message ${index} ${"y".repeat(8000)}`,
    });
  const meter = new TokenMeter();
  const counter = { calls: 0 };
  // A deliberately large summary keeps the post-compaction request over the
  // threshold, so the second preflight must stop at nothing_to_compact rather
  // than summarize the lone summary again.
  // Large enough to keep the post-compaction request over the threshold, and
  // shaped to satisfy the summary contract so the size is what is under test
  // rather than the structure.
  const provider = scriptedProvider(
    counter,
    CONFORMING_SUMMARY.replace(
      "- The contract is enforced now.",
      `- ${"z".repeat(400_000)}`,
    ),
  );
  const events: RuntimeEvent[] = [];
  const { emitStatus, emitSnapshot } = collectEvents(events);
  const build = () =>
    baseInput({
      ledger,
      meter,
      provider,
      // Preserve nothing, so the compactable range is the whole surface; after
      // one compaction it collapses to a lone summary.
      preserve: { recentMessages: 0 },
      outbound: rebuild(ledger.snapshot().entries),
      publish: (event: RuntimeEvent) => events.push(event),
      emitStatus,
      emitSnapshot,
    }) as never;

  const first = await prepareContextRequest(build());
  expect(first.compacted).toBe(true);
  expect(counter.calls).toBe(1);

  // A second preflight over the same (now summarized) ledger must not call the
  // LLM again: the only foldable content is the summary itself.
  const second = await prepareContextRequest(build());
  expect(second.compacted).toBe(false);
  expect(second.decision).toBe("nothing_to_compact");
  expect(counter.calls).toBe(1);
});

test("prepareContextRequest derives the preserved tail and prune options from the budget", async () => {
  // No explicit `preserve`/`pruneOptions`: the budget policy must apply, so the
  // preserved tail is honoured (nothing compactable when every entry falls in
  // it) instead of the pipeline silently using its own default.
  const big = "x".repeat(400);
  const ledger = new ContextLedger();
  ledger.add({ id: "u1", role: "user", content: big, tokens: 120 });
  const meter = new TokenMeter();
  const events: RuntimeEvent[] = [];
  const result = await prepareContextRequest({
    id: "budget-policy",
    step: 0,
    ledger,
    meter,
    scope: "main",
    system: undefined,
    tools: undefined,
    contextWindow: 100,
    budget: {
      max: 100,
      thresholdPercent: 50,
      reserved: 10,
      preservedRecentMessages: 5,
      preservedRecentTokens: 0,
      prune: DEFAULT_TOOL_RESULT_PRUNE_OPTIONS,
    },
    prune: true,
    outbound: [{ role: "user", content: big }],
    rebuildOutbound: () => [{ role: "user", content: big }],
    provider: {
      provider: "scripted",
      model: "m1",
      async *stream() {
        yield { type: "content" as const, text: "summary" };
      },
    },
    publish: (event) => events.push(event),
    emitStatus: () => {},
    emitSnapshot: () => {},
  });
  // The single entry sits inside the preserved tail, so there is nothing to
  // compact and no summarizer round trip happens.
  expect(result.decision).toBe("nothing_to_compact");
  expect(result.compacted).toBe(false);
});
