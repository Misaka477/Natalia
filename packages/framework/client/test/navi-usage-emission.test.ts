// Does a REAL Navi/Nia turn emit its own step_usage?
//
// #5's last unexamined link. The durable fold, the store round-trip, the
// durability classification and the restore are all proven innocent (see
// usage-channels-fold.test.ts and usage-channels-restart.test.ts). What has
// never been measured is whether the navi/nia chat turn EMITS the event at all —
// packages/domains/collab/src/chat-turn-navi.ts:474 and chat-turn-nia.ts:495
// publish it, but nothing asserted that a real turn reaches that line.
//
// So: drive a real navi turn and a real nia turn through the real runtime and
// assert the namespaced events are in the session's event stream. If they are
// absent here, the bar reads 0 for a reason upstream of everything checked so
// far; if they are present, the gap is on the UI side and not in the runtime.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";

test("a real navi turn emits its own step_usage, not just the main one", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-navi-usage-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    provider: {
      provider: "test",
      model: "test",
      // Both channels' providers: the navi/nia chat turns call the provider
      // directly, so a navi turn needs its own stream to sample usage from.
      async *stream() {
        yield { type: "content" as const, text: "navi answer" };
        yield { type: "usage" as const, inputTokens: 40, outputTokens: 6 };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event), { replay: "none" });
  try {
    await waitForAsync(async () =>
      events.some((event) => event.type === "session.ready"),
    );

    // A real navi turn: the same entry point the collaboration layer uses.
    await client.naviChat!.submit({ text: "ping for usage" });
    await waitForAsync(async () =>
      events.some(
        (event) =>
          event.type === "navi.chat.turn.finished" ||
          event.type === "navi.runtime.step_usage",
      ),
    );

    const naviUsage = events.filter(
      (event) => event.type === "navi.runtime.step_usage",
    );
    // Print what came, so a failure says what was there instead of "undefined".
    if (naviUsage.length === 0) {
      const kinds = new Set(events.map((event) => event.type));
      console.error(
        "NAVI_USAGE_ABSENT event kinds seen:\n  " +
          [...kinds].sort().join("\n  "),
      );
    }
    expect(naviUsage.length).toBeGreaterThan(0);

    const first = naviUsage[0] as Extract<
      RuntimeEvent,
      { type: "navi.runtime.step_usage" }
    >;
    expect(first.inputTokens).toBeGreaterThan(0);
    // The channel is carried by the EVENT TYPE's namespace
    // (navi.runtime.step_usage), not by a `channel` field — the un-namespaced
    // runtime.step_usage is the form that carries an explicit one, and that is
    // the shape the subagent runner emits. Both are attributed by
    // usageChannelOf in packages/framework/session/src/projector.ts.
    expect(first.type).toBe("navi.runtime.step_usage");
  } finally {
    await client.dispose?.();
  }
});

test("a real chat turn's step_usage carries the wall clock, not just tokens", async () => {
  // G2-7: the bar's `LLM` / `首 token` / `tok/s` segments were permanently
  // blank for Navi and Nia, because the chat turns call the provider directly
  // and emitted the token four-tuple with no timing — the main runner
  // measures and emits those, and the chat turns had no equivalent. The
  // contract has carried the fields the whole time; nothing filled them.
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-timing-"));
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        yield { type: "content" as const, text: "timed answer" };
        yield { type: "usage" as const, inputTokens: 40, outputTokens: 6 };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event), { replay: "none" });
  try {
    await waitForAsync(async () =>
      events.some((event) => event.type === "session.ready"),
    );
    await client.naviChat!.submit({ text: "ping for timing" });
    await client.niaChat!.submit({ text: "ping for timing" });
    await waitForAsync(async () =>
      events.some(
        (event) =>
          (event.type === "navi.runtime.step_usage" &&
            (event as { llmMs?: number }).llmMs !== undefined) ||
          (event.type === "nia.runtime.step_usage" &&
            (event as { llmMs?: number }).llmMs !== undefined),
      ),
    );

    for (const type of [
      "navi.runtime.step_usage",
      "nia.runtime.step_usage",
    ] as const) {
      const usage = events.find(
        (event): event is Extract<RuntimeEvent, { type: typeof type }> =>
          event.type === type,
      );
      expect(usage, `${type} was emitted`).toBeDefined();
      // Model wall time and first-token latency are measured, not derived.
      expect(usage!.llmMs).toBeGreaterThanOrEqual(0);
      expect(usage!.ttftMs).toBeGreaterThanOrEqual(0);
      // The throughput denominator, without which tok/s cannot be computed.
      expect(usage!.decodeMs).toBeGreaterThanOrEqual(0);
    }
  } finally {
    await client.dispose?.();
  }
});
