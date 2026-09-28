// The context ring across a restart. The ring reads the main channel's
// `context.status`, whose only data source is a live publish: `context.status`
// carries no `id`, so it never enters the message-page projection and a
// replayed journal never carries it. A restarting UI therefore depends on two
// things both holding: the restored ledger reporting the session's real usage
// (not a tiny entry estimate), and attach republishing that status.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";

const SESSION = "ses_ring_restart" as SessionID;
const CONTEXT_BUDGET = { max: 32_000, thresholdPercent: 85, reserved: 4_096 };

function usageProvider(label: string) {
  return {
    provider: "test",
    model: "test",
    async *stream() {
      yield { type: "content" as const, text: `${label} answer` };
      // A separate usage chunk is what the provider adapter samples; the
      // ledger's exact checkpoint is anchored to it.
      yield {
        type: "usage" as const,
        inputTokens: 1_200,
        outputTokens: 300,
      };
      yield { type: "done" as const };
    },
  };
}

type ContextStatusEvent = Extract<RuntimeEvent, { type: "context.status" }>;

function lastContextStatus(events: RuntimeEvent[]): ContextStatusEvent {
  const statuses = events.filter(
    (event): event is ContextStatusEvent => event.type === "context.status",
  );
  const last = statuses.at(-1);
  if (!last) throw new Error("no context.status event was published");
  return last;
}

for (const useSqliteStore of [false, true]) {
  test(`a restart restores the context ring's usage from the durable checkpoint (${useSqliteStore ? "sqlite" : "json"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-ring-restore-"));
    const sessionDir = join(root, ".natalia", "sessions");
    const firstEvents: RuntimeEvent[] = [];
    const first = createRealRuntimeClient({
      workspaceRoot: root,
      sessionDir,
      sessionID: SESSION,
      useSqliteStore,
      provider: usageProvider("first"),
    });
    first.start((event) => firstEvents.push(event), { replay: "none" });
    await first.submitAndWait!("first question");
    // The turn's durable anchor: the checkpoint event the runtime persists at
    // the end of every turn (JSON stores keep the event, SQLite keeps it in
    // `context_epochs`), carrying the provider's 1,200 + 300 tokens.
    await waitForAsync(async () =>
      firstEvents.some(
        (event) =>
          event.type === "context.checkpoint" &&
          event.snapshot.checkpoint?.tokens === 1_500,
      ),
    );
    await first.dispose?.();

    // A second runtime over the same durable session: the restart. The UI's
    // ring reads what attach publishes, so collect exactly what the runtime
    // republishes for the already-active session.
    const second = createRealRuntimeClient({
      workspaceRoot: root,
      sessionDir,
      sessionID: SESSION,
      useSqliteStore,
      provider: usageProvider("second"),
    });
    const events: RuntimeEvent[] = [];
    second.start((event) => events.push(event), { replay: "none" });
    await waitForAsync(async () =>
      events.some((event) => event.type === "session.ready"),
    );
    await waitForAsync(async () =>
      events.some((event) => event.type === "context.status"),
    );

    // 1) The ledger's own accounting after the restore. The durable checkpoint
    //    anchors it to the provider's 1,200 + 300 tokens; the entry estimate
    //    alone is 7 tokens, which against a 32k window rounds the ring to 0%.
    const restored = lastContextStatus(events);
    expect(restored.used).toBe(1_500);
    expect(restored.source).toBe("exact_checkpoint");
    expect(restored.max).toBe(CONTEXT_BUDGET.max);

    // 2) The attach the UI performs on boot republishes it. A same-session
    //    attach used to return before the publish, so a restarting UI never
    //    received a ring value at all.
    const beforeAttach = events.length;
    await second.sessionAttach!(SESSION);
    await waitForAsync(async () =>
      events
        .slice(beforeAttach)
        .some((event) => event.type === "context.status"),
    );
    const republished = lastContextStatus(events);
    expect(republished.used).toBe(1_500);
    expect(republished.source).toBe("exact_checkpoint");
    expect(republished.max).toBe(CONTEXT_BUDGET.max);

    // 3) The daemon/web path: the runtime is busy with another session and the
    //    UI attaches the user's last one. That goes through `ensureExecution`,
    //    whose restore is a separate code path from the startup recovery above.
    const third = createRealRuntimeClient({
      workspaceRoot: root,
      sessionDir,
      sessionID: "ses_ring_other" as SessionID,
      useSqliteStore,
      provider: usageProvider("third"),
    });
    const thirdEvents: RuntimeEvent[] = [];
    third.start((event) => thirdEvents.push(event), { replay: "none" });
    await waitForAsync(async () =>
      thirdEvents.some((event) => event.type === "session.ready"),
    );
    const beforeForeignAttach = thirdEvents.length;
    await third.sessionAttach!(SESSION);
    await waitForAsync(async () =>
      thirdEvents
        .slice(beforeForeignAttach)
        .some((event) => event.type === "context.status"),
    );
    const foreign = lastContextStatus(thirdEvents);
    expect(foreign.used).toBe(1_500);
    expect(foreign.source).toBe("exact_checkpoint");
    expect(foreign.max).toBe(CONTEXT_BUDGET.max);

    await second.dispose?.();
    await third.dispose?.();
  });
}
