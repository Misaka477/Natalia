import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSandboxManager, type SandboxLog } from "../src";

/**
 * The sandbox family's first log points (audit 缺口 4).
 *
 * A promotion that failed its gate, a rollback that refused, a delete that
 * discarded unmerged work — none of it reached the operations log, so "why
 * did my merge not land" had no durable answer. The manager takes a
 * structural logger; these tests record what it would have said.
 */

function recordingLog(): {
  log: SandboxLog;
  lines: Array<[string, Record<string, unknown> | undefined]>;
} {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const log: SandboxLog = {
    info: (message, fields) => lines.push([message, fields]),
    warn: (message, fields) => lines.push([message, fields]),
    error: (message, fields) => lines.push([message, fields]),
  };
  return { log, lines };
}

async function tempRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

test("a promotion logs its start and its gate refusal", async () => {
  const { log, lines } = recordingLog();
  const manager = new WorkspaceSandboxManager(await tempRoot("sbx-log-"), {
    log,
  });
  await manager.create("sb1");
  // The gate refusal is the outcome that used to leave no durable trace:
  // the validation command runs inside the candidate and exits non-zero.
  const failure = await manager
    .promoteWithValidation("sb1", {
      command: "exit 1",
      hostRoot: await tempRoot("sbx-host-"),
    })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(
    lines.some(
      ([message, fields]) =>
        message === "promote.start" && fields?.id === "sb1",
    ),
  ).toBe(true);
  expect(
    lines.some(
      ([message, fields]) =>
        message === "promote.validation_failed" &&
        fields?.id === "sb1" &&
        fields?.exitCode !== 0,
    ),
  ).toBe(true);
  // No merge was claimed — the log must not say one happened.
  expect(lines.some(([message]) => message === "promote.merged")).toBe(false);
});

test("a rollback refusal is logged, not mute", async () => {
  const { log, lines } = recordingLog();
  const manager = new WorkspaceSandboxManager(await tempRoot("sbx-rb-"), {
    log,
  });
  const result = await manager.rollback("sb_none");
  expect(result.restored).toBe(false);
  expect(
    lines.some(
      ([message, fields]) =>
        message === "rollback.unsupported" && fields?.id === "sb_none",
    ),
  ).toBe(true);
});

test("a manager without a logger stays silent", async () => {
  // The seam's historical behaviour: silence, not a crash.
  const manager = new WorkspaceSandboxManager(await tempRoot("sbx-quiet-"));
  await manager.create("sb_quiet");
  expect((await manager.rollback("sb_quiet")).restored).toBe(false);
});
