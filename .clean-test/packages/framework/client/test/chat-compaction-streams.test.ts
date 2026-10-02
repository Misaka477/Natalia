import { expect, test } from "bun:test";
import { createTestContext } from "@anthelia/runtime-services";
import { compactionService } from "@anthelia/compaction";
import { ContextLedger, TokenMeter } from "@anthelia/runtime";
import type { ContextEntry, ProviderMessage } from "@anthelia/runtime";
import type { RuntimeEvent } from "@anthelia/contracts";
import { compactChatBeforeProviderStep } from "@natalia/collab";
import {
  projectedNaviChatMessages,
  projectedNiaChatMessages,
} from "@anthelia/session";

test("Navi and Nia compaction retain independent ledgers, providers, and durable boundaries", async () => {
  const calls: Array<{ ledger: ContextLedger; provider: unknown }> = [];
  const published: RuntimeEvent[] = [];
  const naviLedger = new ContextLedger();
  const niaLedger = new ContextLedger();
  const naviProvider = { provider: "navi", model: "navi-model" };
  const niaProvider = { provider: "nia", model: "nia-model" };
  const compaction = {
    async compactBeforeProviderStep() {
      return { compacted: false } as never;
    },
    async runWithContextLimitRecovery() {
      return { recovered: false } as never;
    },
    async prepareContextRequest(input: {
      ledger: ContextLedger;
      provider: unknown;
      rebuildOutbound: (
        entries: ContextEntry[],
        phase: "prune" | "compact",
      ) => ProviderMessage[];
      outbound: ProviderMessage[];
    }) {
      calls.push({ ledger: input.ledger, provider: input.provider });
      input.ledger.replaceAfterCompaction(
        { id: "summary", role: "summary", content: "summary" },
        [],
      );
      const rebuilt = input.rebuildOutbound(
        input.ledger.snapshot().entries,
        "compact",
      );
      return {
        outbound: rebuilt,
        decision: "ratio",
        compacted: true,
        pruned: 0,
        used: 0,
      };
    },
  };
  const ctx = {
    state: {
      serviceDirectory: createTestContext([compactionService.mock(compaction)]),
    },
    ports: {
      resolveService: () => compaction,
      getTsRuntimeConfig: () => ({ context: { compactionEnabled: true } }),
    },
  } as never;
  const exec = {
    session: { id: "ses_compaction", events: [] },
    runtimeContextConfig: { max: 1, thresholdPercent: 1, reserved: 0 },
  } as never;
  const messages = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "answer" },
  ];
  const run = (
    ledger: ContextLedger,
    provider: unknown,
    type: "navi" | "nia",
  ) =>
    compactChatBeforeProviderStep(
      ctx,
      exec,
      ledger,
      provider as never,
      messages,
      new AbortController().signal,
      {
        meter: new TokenMeter(),
        compactionID: `${type}:ses_compaction`,
        instruction: `${type} instruction`,
        prune: true,
        durableMessages: [
          { messageID: `${type}-1`, role: "user", text: "first" },
          { messageID: `${type}-2`, role: "chat", text: "answer" },
        ],
        publishCompacted: (summary, compactedThroughMessageID) =>
          published.push({
            type: `${type}.chat.compacted` as never,
            id: `${type}-compacted`,
            messageID: `${type}-summary`,
            summary,
            compactedThroughMessageID,
            at: "now",
          }),
        publishCompactionEvent: () => undefined,
      },
    );

  await run(naviLedger, naviProvider, "navi");
  await run(niaLedger, niaProvider, "nia");

  expect(calls).toEqual([
    { ledger: naviLedger, provider: naviProvider },
    { ledger: niaLedger, provider: niaProvider },
  ]);
  expect(naviLedger).not.toBe(niaLedger);
  expect(published).toEqual([
    expect.objectContaining({
      type: "navi.chat.compacted",
      compactedThroughMessageID: "navi-2",
    }),
    expect.objectContaining({
      type: "nia.chat.compacted",
      compactedThroughMessageID: "nia-2",
    }),
  ]);
});

test("a truncated stream history resets only its own compaction ledger", async () => {
  const ledger = new ContextLedger();
  const compaction = {
    async prepareContextRequest(input: { outbound: ProviderMessage[] }) {
      return {
        outbound: input.outbound,
        decision: "none",
        compacted: false,
        pruned: 0,
        used: 0,
      };
    },
  };
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        compactionService.mock({
          ...compaction,
          compactBeforeProviderStep: async () => ({ compacted: false }),
          runWithContextLimitRecovery: async () => ({ recovered: false }),
        }),
      ]),
    },
    ports: {
      resolveService: () => compaction,
      getTsRuntimeConfig: () => ({ context: { compactionEnabled: true } }),
    },
  } as never;
  const exec = {
    session: { id: "ses_rollback", events: [] },
    runtimeContextConfig: { max: 9999, thresholdPercent: 90, reserved: 0 },
  } as never;
  const stream = {
    meter: new TokenMeter(),
    compactionID: "navi:ses_rollback",
    instruction: "Navi instruction",
    durableMessages: [],
    prune: true,
    publishCompacted: () => undefined,
    publishCompactionEvent: () => undefined,
  };
  await compactChatBeforeProviderStep(
    ctx,
    exec,
    ledger,
    {} as never,
    [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ],
    new AbortController().signal,
    stream,
  );
  await compactChatBeforeProviderStep(
    ctx,
    exec,
    ledger,
    {} as never,
    [{ role: "user", content: "first" }],
    new AbortController().signal,
    stream,
  );
  expect(ledger.snapshot().entries.map((entry) => entry.content)).toEqual([
    "first",
  ]);
});

test("namespaced compaction boundaries replay independently and honor rollback", () => {
  const events: RuntimeEvent[] = [
    {
      type: "navi.chat.message.new",
      id: "navi-1",
      messageID: "navi-1",
      role: "user",
      text: "Navi original",
      at: "t1",
    },
    {
      type: "nia.chat.message.new",
      id: "nia-1",
      messageID: "nia-1",
      role: "user",
      text: "Nia original",
      at: "t2",
    },
    {
      type: "navi.chat.compacted",
      id: "navi-compact",
      messageID: "navi-summary",
      summary: "Navi summary",
      compactedThroughMessageID: "navi-1",
      at: "t3",
    },
    {
      type: "navi.chat.rollback",
      id: "navi-rollback",
      toMessageID: "navi-summary",
      removed: 0,
      at: "t4",
    },
  ];
  expect(
    projectedNaviChatMessages(events).map((message) => message.text),
  ).toEqual(["[已压缩的聊天历史]\nNavi summary"]);
  expect(
    projectedNiaChatMessages(events).map((message) => message.text),
  ).toEqual(["Nia original"]);
});
