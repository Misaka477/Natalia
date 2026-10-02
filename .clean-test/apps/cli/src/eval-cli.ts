import { readExternalBenchmark } from "@natalia/engineering-intelligence";
import { runExternalBenchmark } from "@natalia/engineering-intelligence";
import { callRuntimeRPC } from "@natalia/transport";
import {
  createRuntimeDaemonStore,
  daemonToken,
  readRuntimeDaemonRegistration,
} from "@natalia/transport/host";
import { createLocalSessionService } from "@anthelia/session-store";
import type { RuntimeEvent } from "@anthelia/contracts";
import { daemonDir } from "./command-helpers";

/**
 * G-c's outer half at the CLI: the frozen benchmark's tasks, listed
 * offline, and RUN through the daemon's live turn machinery — each
 * task's instruction submitted as a turn, each outcome recorded as the
 * join fact (the study's "先内后外"). Two commands:
 *
 *   natalia bench list [--dir <path>] [--json]   — tasks, baselines, joins
 *   natalia bench run  [--dir <path>] [--task <id>]... [--limit N] [--json]
 *
 * (`bench`, not `eval`: `eval` is the runtime's own REPL face.)
 *
 * The run's honesty is structural: **no daemon answers no_daemon per
 * task, nothing is recorded, and no success is faked.** The daemon is
 * where a live provider and the runtime live; the CLI only drives it.
 */

/** How long one task's submit may wait before the batch moves on. */
const SUBMIT_TIMEOUT_MS = 45_000;

/**
 * The submit's failure named for an operator: the timeout (no provider
 * answering?), the unparseable answer, or the message as it stands.
 * Pure — the CLI's wiring names, the loop carries.
 */
export function submitFailureReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason.includes("timed out") || reason.includes("aborted"))
    return `submit timed out after ${SUBMIT_TIMEOUT_MS}ms (no provider answering?)`;
  if (reason.includes("null is not an object"))
    return "the daemon answered nothing that could be parsed";
  return `submit failed: ${reason}`;
}

/** The eval dir: the flag, the env, or the repo's own devref checkout. */
function evalDir(argv: string[]): string {
  const flag = valueOf(argv, "--dir");
  if (flag) return flag;
  return process.env.NATALIA_EVAL_DIR ?? "devref/eval";
}

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** The joins the workspace's sessions recorded (offline journal read). */
async function recordedJoins(workspaceRoot: string): Promise<
  Array<{
    externalTaskID: string;
    success?: boolean;
    turnID: string;
    at: string;
  }>
> {
  const service = createLocalSessionService(workspaceRoot);
  const rows = await service.list();
  const joins: Array<{
    externalTaskID: string;
    success?: boolean;
    turnID: string;
    at: string;
  }> = [];
  for (const row of rows) {
    const events = (await service
      .events(row.id)
      .catch(() => [])) as RuntimeEvent[];
    for (const event of events) {
      if (event.type !== "external_run.recorded") continue;
      joins.push({
        externalTaskID: event.externalTaskID,
        ...(event.success === undefined ? {} : { success: event.success }),
        turnID: event.turnID,
        at: event.at,
      });
    }
  }
  return joins;
}

export async function evalListLines(argv: string[]): Promise<string[]> {
  const workspaceRoot = valueOf(argv, "--workspace") ?? process.cwd();
  const [benchmark, joins] = await Promise.all([
    readExternalBenchmark(evalDir(argv)),
    recordedJoins(workspaceRoot),
  ]);
  const byTask = new Map(joins.map((join) => [join.externalTaskID, join]));
  const lines = [
    `${benchmark.name} — ${benchmark.taskCount} tasks × ${benchmark.harnessCount} harnesses × ${benchmark.configurationCount} configurations`,
    `source: ${benchmark.source}`,
    ...benchmark.tasks.map((task) => {
      const join = byTask.get(task.id);
      const joinText = join
        ? ` | join: ${join.success === undefined ? "unscored" : join.success ? "success" : "failed"} (${join.turnID})`
        : "";
      return `${task.id} — ${(task.successRate * 100).toFixed(1)}% baseline (${task.successful}/${task.expected})${joinText}`;
    }),
  ];
  return lines;
}

/**
 * The batch run: the daemon's submit.andWait per task, the daemon's
 * eval.external_run per join. The loop itself lives in the EI package
 * (tested against the real eval); this is the LIVE wiring — the CLI
 * side of the injected seams.
 */
export async function evalRun(argv: string[]): Promise<{
  scanned: number;
  recorded: number;
  failed: number;
  outcomes: unknown[];
}> {
  const store = createRuntimeDaemonStore({ dir: daemonDir() });
  const registration = await readRuntimeDaemonRegistration(store);
  const taskIDs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--task") {
      const value = argv[index + 1];
      if (value) taskIDs.push(value);
      index += 1;
    }
  }
  const limitRaw = valueOf(argv, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const token = registration ? await daemonToken(store) : undefined;
  const result = await runExternalBenchmark({
    dir: evalDir(argv),
    ...(taskIDs.length ? { taskIDs } : {}),
    ...(limit === undefined || Number.isNaN(limit) ? {} : { limit }),
    submitTurn: async (prompt) => {
      if (!registration)
        return {
          ok: false as const,
          reason: "no_daemon: start one with `natalia daemon`",
        };
      try {
        // A bounded wait: without a provider configured the daemon's
        // submitAndWait waits for a turn that can never finish, and an
        // unbounded wait would hang the batch. The timeout is the honest
        // bound — the task's reason says exactly that.
        const turn = await callRuntimeRPC<{ turnID?: string }>({
          url: registration.url,
          token,
          method: "submit.andWait",
          params: { text: prompt },
          signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
        return turn.turnID
          ? { ok: true as const, turnID: turn.turnID }
          : { ok: false as const, reason: "submit returned no turn" };
      } catch (error) {
        return { ok: false as const, reason: submitFailureReason(error) };
      }
    },
    recordJoin: async ({ taskID, turnID }) => {
      if (!registration) return undefined;
      try {
        const answer = await callRuntimeRPC<{
          recorded?: boolean;
          success?: boolean;
        }>({
          url: registration.url,
          token,
          method: "eval.external_run",
          params: { taskID, turnID },
        });
        if (answer.recorded !== true) return { recorded: false };
        return {
          recorded: true,
          ...(answer.success === undefined ? {} : { success: answer.success }),
        };
      } catch {
        return { recorded: false };
      }
    },
  });
  return {
    scanned: result.scanned,
    recorded: result.recorded,
    failed: result.failed,
    outcomes: result.outcomes,
  };
}
