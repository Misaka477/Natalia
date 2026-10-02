import { loadExternalTask, readExternalBenchmark } from "./eval-reader";

/**
 * G-c's outer half — the batch runner (the study's "先内后外" outer
 * side): the external benchmark's tasks, each submitted through OUR
 * harness as a turn, each recorded as the join fact. The submitter is
 * INJECTED (the CLI wires the daemon's `submit.andWait`; the tests wire
 * a fake) so this module stays a pure loop — the runtime boundary is a
 * seam, not a dependency.
 *
 * The honesty rules the loop enforces:
 *  - **a submit failure is a per-task answer, never a fake success** —
 *    nothing is recorded, the reason travels with the task;
 *  - **the turn's outcome is read from the journal** (the G-b scorer's
 *    fold — no new telemetry), and the join's id is
 *    taskID:turnID's hash so a repeat record is one join;
 *  - **the cap matches the index's own** (50) — a workspace-wide batch
 *    is the caller's `--limit` to narrow;
 *  - **no daemon / no provider is a named reason**, not a crash: the
 *    run answers what it could not do, per task.
 */

/** The turn runner the composition injects (the daemon's submitAndWait). */
export type BenchTurnSubmitter = (
  prompt: string,
  taskID: string,
) => Promise<{ ok: true; turnID: string } | { ok: false; reason: string }>;

/** The join recorder the composition injects (the runtime's face). */
export type BenchJoinRecorder = (input: {
  taskID: string;
  turnID: string;
}) => Promise<{ recorded: boolean; success?: boolean } | undefined>;

export type BenchTaskOutcome = {
  taskID: string;
  title: string;
  baselineSuccessRate: number;
  /** Whether this run recorded a join. */
  recorded: boolean;
  /** The scored outcome when a turn existed (undefined = not scored). */
  success?: boolean;
  /** Why nothing happened (the submit failure / no turn / no join). */
  reason?: string;
};

export type BenchRunResult = {
  benchmark: string;
  source: string;
  scanned: number;
  recorded: number;
  failed: number;
  outcomes: BenchTaskOutcome[];
};

export type BenchRunInput = {
  /** The frozen eval's directory. */
  dir: string;
  /** Restrict to these task ids (default: all, capped). */
  taskIDs?: string[];
  limit?: number;
  submitTurn: BenchTurnSubmitter;
  recordJoin: BenchJoinRecorder;
};

/**
 * One pass over the tasks: submit the instruction, record the join,
 * carry the honest answer for whatever did not happen. The loop is
 * SEQUENTIAL by construction — a concurrent batch would interleave
 * turns in one session, and the journal's turn attribution is the
 * join's whole basis.
 */
export async function runExternalBenchmark(
  input: BenchRunInput,
): Promise<BenchRunResult> {
  const benchmark = await readExternalBenchmark(input.dir);
  const wanted = input.taskIDs?.length
    ? benchmark.tasks.filter((task) => input.taskIDs!.includes(task.id))
    : benchmark.tasks;
  const tasks = wanted.slice(0, input.limit ?? 50);
  const outcomes: BenchTaskOutcome[] = [];
  let recorded = 0;
  let failed = 0;
  for (const task of tasks) {
    const detail = await loadExternalTask(input.dir, task.id);
    const instruction = detail?.instruction?.trim();
    if (!instruction) {
      outcomes.push({
        taskID: task.id,
        title: task.title,
        baselineSuccessRate: task.successRate,
        recorded: false,
        reason: "no_instruction",
      });
      failed += 1;
      continue;
    }
    const submitted = await input.submitTurn(instruction, task.id);
    if (!submitted.ok) {
      outcomes.push({
        taskID: task.id,
        title: task.title,
        baselineSuccessRate: task.successRate,
        recorded: false,
        reason: submitted.reason,
      });
      failed += 1;
      continue;
    }
    const joined = await input.recordJoin({
      taskID: task.id,
      turnID: submitted.turnID,
    });
    if (!joined?.recorded) {
      outcomes.push({
        taskID: task.id,
        title: task.title,
        baselineSuccessRate: task.successRate,
        recorded: false,
        reason: "join_not_recorded",
      });
      failed += 1;
      continue;
    }
    recorded += 1;
    outcomes.push({
      taskID: task.id,
      title: task.title,
      baselineSuccessRate: task.successRate,
      recorded: true,
      ...(joined.success === undefined ? {} : { success: joined.success }),
    });
  }
  return {
    benchmark: benchmark.name,
    source: benchmark.source,
    scanned: tasks.length,
    recorded,
    failed,
    outcomes,
  };
}
