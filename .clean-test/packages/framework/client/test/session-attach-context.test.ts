import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, createSessionRecord } from "@anthelia/session";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src/runtime/main";

const provider: StreamingProvider = {
  provider: "context-seed-test",
  model: "context-seed-test-model",
  async *stream(_request: ProviderStreamRequest) {
    yield { type: "done" as const };
  },
};

test("same-id attach restores stream context snapshots without full event replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-context-seed-"));
  const session = createSessionRecord("ses_context_seed", "Context seed");
  session.events.push(
    {
      type: "navi.chat.message.added",
      id: "navi_seed",
      messageID: "navi_msg",
      role: "chat",
      text: "hello navi",
      at: "2026-01-01T00:00:00Z",
    },
    {
      type: "context.snapshot",
      channel: "navi",
      usedTokens: 42,
      pressureTokens: 42,
      projectedTokens: 42,
      contextWindow: 1000,
      source: "provider_usage",
      at: "2026-01-01T00:00:00Z",
    },
    {
      type: "nia.chat.message.added",
      id: "nia_seed",
      messageID: "nia_msg",
      role: "chat",
      text: "hello nia",
      at: "2026-01-01T00:00:00Z",
    },
  );
  const store = new JsonSessionStore(join(root, ".natalia", "sessions"));
  await store.save(session);

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: session.id as SessionID,
    provider,
  });
  try {
    client.start((event) => events.push(event));
    await client.sessionAttach?.(session.id);

    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      !(
        events.some((event) => event.type === "navi.context.snapshot") &&
        events.some((event) => event.type === "nia.context.snapshot")
      )
    )
      await Bun.sleep(20);

    // Existing durable snapshot: republished to the live sink as a Navi-owned
    // event, no shared channel identity.
    expect(
      events.find((event) => event.type === "navi.context.snapshot"),
    ).toMatchObject({
      type: "navi.context.snapshot",
      usedTokens: 42,
      pressureTokens: 42,
      projectedTokens: 42,
      contextWindow: 1000,
    });
    // Legacy stream with no durable snapshot: seeded from projected history.
    expect(
      events.find((event) => event.type === "nia.context.snapshot"),
    ).toMatchObject({
      type: "nia.context.snapshot",
    });
    expect(events.some((event) => event.type === "nia.context.snapshot")).toBe(
      true,
    );
  } finally {
    await client.dispose?.();
  }
});
