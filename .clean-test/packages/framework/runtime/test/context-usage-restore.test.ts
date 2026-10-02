import { expect, test } from "bun:test";
import { ContextLedger } from "../src";

/**
 * The restart path for the context ring. A JSON store keeps the durable
 * `context.checkpoint` event (SQLite keeps it in `context_epochs` instead), and
 * the replayed event log rebuilds the entry surface — but before this restore
 * existed the exact provider-usage anchor was dropped unless the checkpoint
 * also carried a compaction summary, so `status()` fell back to the entry
 * estimate (a 7-token surface against a 32k window: the ring read 0%).
 */
test("restoreUsageCheckpoint anchors the replayed surface to the durable provider usage", () => {
  const ledger = new ContextLedger();
  // What the event replay produces: the conversation entries only.
  ledger.add({ id: "t1:user", role: "user", content: "first question" });
  ledger.add({
    id: "t1:assistant",
    role: "assistant",
    content: "first answer",
  });
  expect(
    ledger.status({ max: 32_000, thresholdPercent: 85, reserved: 4_096 })
      .source,
  ).toBe("pending_estimate");

  const applied = ledger.restoreUsageCheckpoint({
    messageCount: 2,
    tokens: 1_500,
    inputTokens: 1_200,
    outputTokens: 300,
    source: "provider_usage",
  });

  expect(applied).toBe(true);
  const status = ledger.status({
    max: 32_000,
    thresholdPercent: 85,
    reserved: 4_096,
  });
  expect(status.used).toBe(1_500);
  expect(status.source).toBe("exact_checkpoint");
});

test("restoreUsageCheckpoint still adds the entries appended after the checkpoint", () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "t1:user", role: "user", content: "first question" });
  ledger.add({
    id: "t1:assistant",
    role: "assistant",
    content: "first answer",
  });
  ledger.restoreUsageCheckpoint({
    messageCount: 2,
    tokens: 1_500,
    source: "provider_usage",
  });
  // An entry that arrived after the checkpoint (an unfinished step, a dynamic
  // injection) keeps the live semantics: exact anchor plus the pending tail.
  ledger.add({
    id: "dyn",
    role: "dynamic",
    content: "x".repeat(40),
    tokens: 10,
  });
  expect(
    ledger.status({ max: 32_000, thresholdPercent: 85, reserved: 4_096 }).used,
  ).toBe(1_510);
});

test("restoreUsageCheckpoint refuses a checkpoint describing a longer surface than was replayed", () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "t1:user", role: "user", content: "first question" });
  ledger.add({
    id: "t1:assistant",
    role: "assistant",
    content: "first answer",
  });

  // A rolled-back or truncated journal replays fewer entries than the durable
  // checkpoint covers. Applying it anyway would report a surface this ledger no
  // longer has, so the estimate must win instead of an inflated anchor.
  const applied = ledger.restoreUsageCheckpoint({
    messageCount: 5,
    tokens: 1_500,
    source: "provider_usage",
  });

  expect(applied).toBe(false);
  const status = ledger.status({
    max: 32_000,
    thresholdPercent: 85,
    reserved: 4_096,
  });
  expect(status.used).toBe(7);
  expect(status.source).toBe("pending_estimate");
});

test("restoreUsageCheckpoint refuses a surface compaction already rewrote", () => {
  const ledger = new ContextLedger();
  ledger.add({ id: "t1:user", role: "user", content: "first question" });
  ledger.add({
    id: "t1:assistant",
    role: "assistant",
    content: "first answer",
  });
  ledger.replaceAfterCompaction(
    { id: "t9:summary", role: "summary", content: "summary of everything" },
    [],
    1_200,
  );

  // The post-compaction surface is not the surface a pre-compaction usage
  // checkpoint describes, and the event replay cannot rebuild the compacted one
  // anyway. Refusing keeps the (compaction-set) estimate authoritative.
  const applied = ledger.restoreUsageCheckpoint({
    messageCount: 2,
    tokens: 1_500,
    source: "provider_usage",
  });

  expect(applied).toBe(false);
  expect(
    ledger.status({ max: 32_000, thresholdPercent: 85, reserved: 4_096 }).used,
  ).toBe(1_200);
});
