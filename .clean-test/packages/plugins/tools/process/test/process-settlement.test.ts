import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettlementNotice } from "@anthelia/contracts";
import {
  ManagedProcessRegistry,
  settlementReasonFor,
} from "../src/process-tools";
import type { ToolExecutionContext } from "@anthelia/tools";

/**
 * The settlement spine's process adopter (the Natalia settlement plan's
 * block 2): a terminal transition and a readiness flip each produce ONE
 * notice through the spine, and the wait for readiness stops polling.
 */

function fakeSettlement() {
  const notices: Array<{ sessionID: string; notice: SettlementNotice }> = [];
  return {
    notices,
    service: {
      deliverForSession(sessionID: string, notice: SettlementNotice) {
        notices.push({ sessionID, notice });
        return true;
      },
    },
  };
}

function contextFor(root: string): ToolExecutionContext {
  return { workspaceRoot: root } as unknown as ToolExecutionContext;
}

async function seed(root: string, id: string, pid = 0x7fffffff) {
  const dir = join(root, ".natalia", "processes");
  await mkdir(dir, { recursive: true });
  // The registry loads from disk; seed a running record whose pid is
  // already dead (the sweep's kill(pid, 0) fails for an unused pid).
  await writeFile(
    join(dir, "processes.json"),
    JSON.stringify({
      processes: [
        {
          id,
          command: "sleep 999",
          cwd: root,
          status: "running",
          pid,
          persistent: false,
          startedBySessionID: "ses_proc_notice",
          startedAt: "2026-09-25T00:00:00.000Z",
          outputPath: join(dir, `${id}.out`),
          readyPattern: "READY",
          ready: false,
        },
      ],
    }),
  );
}

test("the reason mapping follows the record, never assuming success", () => {
  // The pure table: our stop is stopped, a non-zero code is failed, an
  // exit with no readable code (or zero) stays exited.
  expect(settlementReasonFor("stopped", undefined)).toBe("stopped");
  expect(settlementReasonFor("failed", undefined)).toBe("failed");
  expect(settlementReasonFor("exited", 3)).toBe("failed");
  expect(settlementReasonFor("exited", 0)).toBe("exited");
  expect(settlementReasonFor("exited", undefined)).toBe("exited");
});

test("a sweep-detected exit delivers one exit notice through the spine", async () => {
  const root = await mkdtemp(join(tmpdir(), "settle-exit-"));
  try {
    await seed(root, "proc_exit");
    const settlement = fakeSettlement();
    const registry = new ManagedProcessRegistry(settlement.service);
    // The real path: the first observation (a list's re-check) finds the
    // dead pid, marks and notifies; the sweep then adds nothing.
    await registry.list(contextFor(root));
    registry.observer.sync();
    await registry.observer.sweep();
    expect(settlement.notices).toHaveLength(1);
    expect(settlement.notices[0]!.sessionID).toBe("ses_proc_notice");
    expect(settlement.notices[0]!.notice).toMatchObject({
      subject: "proc_exit",
      reason: "exited",
      sourceKind: "process-exited",
    });
    expect(settlement.notices[0]!.notice.summary).toContain("sleep 999");
    // The record is settled, so a second sweep adds nothing.
    await registry.observer.sweep();
    expect(settlement.notices).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sweep-detected readiness delivers one ready notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "settle-ready-"));
  // A REAL live process the test owns: a foreign pid (even init) answers
  // EPERM to a non-root signal-0, which the sweep would read as dead.
  const child = Bun.spawn(["sleep", "30"]);
  try {
    await seed(root, "proc_ready", child.pid);
    const settlement = fakeSettlement();
    const registry = new ManagedProcessRegistry(settlement.service);
    // The pid is alive, so only the readiness probe fires; the pattern
    // matches now.
    await writeFile(
      join(root, ".natalia", "processes", "proc_ready.out"),
      "boot...\nREADY on 5178\n",
    );
    // Load first (a live pid survives the list's re-check), then the
    // sweep's ready probe fires.
    await registry.list(contextFor(root));
    registry.observer.sync();
    await registry.observer.sweep();
    expect(settlement.notices).toHaveLength(1);
    expect(settlement.notices[0]!.notice).toMatchObject({
      subject: "proc_ready",
      reason: "ready",
      sourceKind: "process-ready",
    });
    // The second sweep: the flip already happened, no second notice.
    await registry.observer.sweep();
    expect(settlement.notices).toHaveLength(1);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a registry without the spine reports no notices and no crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "settle-bare-"));
  try {
    await seed(root, "proc_bare");
    // The bare construction is the pre-spine shape (the unit tests): no
    // service, no notices, everything else works.
    const registry = new ManagedProcessRegistry();
    await registry.list(contextFor(root));
    registry.observer.sync();
    await registry.observer.sweep();
    // No notices anywhere to observe; the sweep itself is the assertion.
    expect(registry.observer.armed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
