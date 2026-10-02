import { expect, test } from "bun:test";
import { wireProcessSettledNotices } from "../src/runtime/initialize/process-settled-notices";
import type { RuntimeContext } from "@anthelia/substrate";

/** A fake ledger that records what was appended. */
function ledger() {
  const entries: Array<{ id: string; role: string; content: string }> = [];
  return {
    entries,
    snapshot: () => ({ entries }),
    add: (entry: { id: string; role: "dynamic"; content: string }) => {
      entries.push(entry);
    },
  };
}

function harness(input: {
  /** sessionID -> ledger, the sessions a notice could land in. */
  sessions: Record<string, ReturnType<typeof ledger>>;
}) {
  const executions = new Map<string, { context: ReturnType<typeof ledger> }>();
  for (const [id, ledgerFor] of Object.entries(input.sessions))
    executions.set(id, { context: ledgerFor });
  const ctx = {
    ports: { getExecutionBySession: () => executions },
  } as unknown as RuntimeContext;
  return ctx;
}

/** A capability registry whose observer can be swapped in late. */
function capabilityRegistry() {
  let observer:
    | { subscribe(fn: (notice: unknown) => void): () => void }
    | undefined;
  const updates: Array<() => void> = [];
  return {
    setObserver(next: typeof observer) {
      observer = next;
      for (const listener of [...updates]) listener();
    },
    api: {
      service: <T>(_name: string) => observer as T | undefined,
      onServiceUpdate: (listener: () => void) => {
        updates.push(listener);
        return () => {
          const at = updates.indexOf(listener);
          if (at >= 0) updates.splice(at, 1);
        };
      },
    },
  };
}

const notice = (input: {
  id: string;
  sessionID?: string;
  status?: string;
  exitCode?: number;
}) => ({
  id: input.id,
  command: "sleep 30",
  status: input.status ?? "exited",
  workspaceRoot: "/ws",
  ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:30.000Z",
  ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
});

test("a process exit lands in the session that started it", async () => {
  const starter = ledger();
  const other = ledger();
  const ctx = harness({ sessions: { ses_a: starter, ses_b: other } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);
  let emit: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
  });

  emit(notice({ id: "proc_1", sessionID: "ses_a", exitCode: 3 }));

  // Only the starter is told: a notice in every session of a workspace would
  // tell agents about work they never did.
  expect(starter.entries).toHaveLength(1);
  expect(other.entries).toHaveLength(0);
  expect(starter.entries[0]!.role).toBe("dynamic");
  expect(starter.entries[0]!.id).toBe("process_settled:proc_1");
  expect(starter.entries[0]!.content).toContain('source="process_settled"');
  expect(starter.entries[0]!.content).toContain("exit code 3");
  expect(starter.entries[0]!.content).toContain("sleep 30");
  expect(starter.entries[0]!.content).toContain(
    "This is the runtime reporting the outcome",
  );
  wire();
});

test("the same process is noticed once", async () => {
  const starter = ledger();
  const ctx = harness({ sessions: { ses_a: starter } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);
  let emit: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
  });

  emit(notice({ id: "proc_1", sessionID: "ses_a" }));
  emit(notice({ id: "proc_1", sessionID: "ses_a" }));

  // A second entry would read as a second process having finished.
  expect(starter.entries).toHaveLength(1);
  wire();
});

test("a notice with no starting session is dropped", async () => {
  // A process started outside any session has nobody to tell.
  const starter = ledger();
  const ctx = harness({ sessions: { ses_a: starter } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);
  let emit: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
  });

  emit(notice({ id: "proc_1" }));

  expect(starter.entries).toHaveLength(0);
  wire();
});

test("a notice for an unknown session is dropped", async () => {
  const starter = ledger();
  const ctx = harness({ sessions: { ses_a: starter } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);
  let emit: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
  });

  emit(notice({ id: "proc_1", sessionID: "ses_gone" }));

  expect(starter.entries).toHaveLength(0);
  wire();
});

test("an observer arriving late is still subscribed", async () => {
  // The plugin providing it loads asynchronously, so a one-shot lookup during
  // composition would find nothing and never receive a notice.
  const starter = ledger();
  const ctx = harness({ sessions: { ses_a: starter } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);

  // No observer yet; the wire must have survived and be waiting.
  let emit: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      emit = fn;
      return () => {};
    },
  });
  emit(notice({ id: "proc_1", sessionID: "ses_a" }));

  expect(starter.entries).toHaveLength(1);
  wire();
});

test("a swapped observer replaces the subscription instead of stacking one", async () => {
  // Two live subscriptions would deliver every notice twice.
  const starter = ledger();
  const ctx = harness({ sessions: { ses_a: starter } });
  const registry = capabilityRegistry();
  const wire = wireProcessSettledNotices(ctx, registry.api);

  registry.setObserver({
    subscribe: (fn) => {
      return () => {};
    },
  });
  let second: (n: unknown) => void = () => {};
  registry.setObserver({
    subscribe: (fn) => {
      second = fn;
      return () => {};
    },
  });

  // Only the second is live, so only it can deliver.
  second(notice({ id: "proc_1", sessionID: "ses_a" }));

  expect(starter.entries).toHaveLength(1);
  wire();
});
