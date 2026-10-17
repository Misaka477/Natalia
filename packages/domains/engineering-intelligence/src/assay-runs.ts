/**
 * Assay runs, projected the way a CI page reads.
 *
 * The user's ask, twice: the evidence should be legible like GitHub Actions — a
 * run, what it checked, each step with its own status and duration, and a verdict
 * — instead of one flat row per tool call. That page needs data in that shape, and
 * this is the pure projection behind it: no UI, no I/O, just the tree.
 *
 * The mapping, deliberately one-to-one with what already exists:
 *
 *   workflow  → the session's evidence for one task (the run)
 *   job       → the task (`taskID`): the plan step whose claim is being backed
 *   step      → one recorded validation (command + verdict + duration + log)
 *   summary   → what the run covered, what it did NOT cover, and who ran it
 *
 * Nothing here invents a fact: `checked` comes from the evidence classes the run
 * satisfied, `notChecked` from the completion card's `missing`, and the role from
 * `assayRole` — recording absent as the weaker of the two.
 */

/** One recorded validation, as a step. */
export type AssayStep = {
  command: string;
  /** The step's own verdict, in the closed vocabulary. */
  result: "passed" | "failed" | "skipped" | "timed_out" | "not_run" | "unknown";
  durationMs?: number;
  /** Who ran it: absent reads as the weaker of the two, never authoritative. */
  role: "self-reported" | "authoritative";
  /** The bounded output summary the step's log starts with. */
  summary: string;
  /** Where the complete output lives, when it was kept. */
  logRef?: string;
};

/** One task's run: its evidence grouped as steps. */
export type AssayRun = {
  /** The evidence id — the run's identity, what a completion cites. */
  id: string;
  /** The task (the plan step) this run is about: the CI "job". */
  taskID: string;
  objective: string;
  recordedAt?: string;
  /** The environment the run happened in, when it was recorded. */
  environment?: string;
  steps: AssayStep[];
  /** Evidence classes this run establishes. */
  checked: string[];
  /** Required classes the completion says are still open. */
  notChecked: string[];
  /** `warranted` needs at least one passing AUTHORITATIVE step and nothing open. */
  warrant: "warranted" | "unwarranted";
  /** Why, in one sentence — the only prose the page needs. */
  note: string;
  totalDurationMs: number;
};

/** The evidence record shape this projection reads (a subset). */
export type AssayEvidenceInput = {
  id: string;
  taskID: string;
  objective: string;
  validations?: Array<{
    command: string;
    result: string;
    safeSummary: string;
    artifactRef?: string;
    durationMs?: number;
    assayRole?: "self-reported" | "authoritative";
  }>;
  knownGaps?: string[];
  recordedAt?: string;
  environment?: string;
};

/** The completion's verdict for a task, when one was recorded. */
export type AssayCompletionInput = {
  taskID: string;
  missing?: string[];
  /** Classes the cited evidence resolved to. */
  resolvedClasses?: string[];
};

const CLOSED_RESULTS: ReadonlyArray<AssayStep["result"]> = [
  "passed",
  "failed",
  "skipped",
  "timed_out",
  "not_run",
];

function stepOf(
  validation: NonNullable<AssayEvidenceInput["validations"]>[number],
): AssayStep {
  const result = (CLOSED_RESULTS as readonly string[]).includes(
    validation.result,
  )
    ? (validation.result as AssayStep["result"])
    : "unknown";
  return {
    command: validation.command,
    result,
    ...(validation.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.round(validation.durationMs)) }),
    role:
      validation.assayRole === "authoritative"
        ? "authoritative"
        : "self-reported",
    summary: validation.safeSummary,
    ...(validation.artifactRef ? { logRef: validation.artifactRef } : {}),
  };
}

/**
 * Project one task's evidence as a run.
 *
 * `checked` is the union of what the steps passed for; `notChecked` is what the
 * completion still lists as missing. The warrant is the second ruler applied to
 * the run as a whole: a run whose every passing step was the author's own is
 * `unwarranted`, and the note names that rather than the failure count.
 */
export function assayRunFor(input: {
  evidence: readonly AssayEvidenceInput[];
  /** The task whose run this is. Absent falls back to the completion's taskID. */
  taskID?: string;
  completion?: AssayCompletionInput;
  /** Classes a passing step of this command establishes. */
  classesFor: (command: string, passed: boolean) => readonly string[];
}): AssayRun | undefined {
  const task = input.taskID ?? input.completion?.taskID;
  const matching = input.evidence.filter(
    (record) => task === undefined || record.taskID === task,
  );
  if (matching.length === 0) return undefined;
  const steps: AssayStep[] = [];
  const checked = new Set<string>();
  for (const record of matching) {
    for (const validation of record.validations ?? []) {
      const step = stepOf(validation);
      steps.push(step);
      for (const cls of input.classesFor(
        step.command,
        step.result === "passed",
      ))
        checked.add(cls);
    }
  }
  const latest = matching[matching.length - 1]!;
  const notChecked = [...(input.completion?.missing ?? [])];
  const passingAuthoritative = steps.some(
    (step) => step.result === "passed" && step.role === "authoritative",
  );
  const anyPass = steps.some((step) => step.result === "passed");
  const warrant =
    passingAuthoritative && notChecked.length === 0
      ? "warranted"
      : "unwarranted";
  const note =
    warrant === "warranted"
      ? `an independent re-run passed and nothing is open`
      : notChecked.length > 0
        ? `still open: ${notChecked.join(", ")}`
        : anyPass
          ? "every passing step was the author's own run — nobody independent measured it"
          : steps.length === 0
            ? "no step was recorded"
            : "no step passed";
  return {
    id: matching.map((record) => record.id).join(","),
    taskID: latest.taskID,
    objective: latest.objective,
    ...(latest.recordedAt ? { recordedAt: latest.recordedAt } : {}),
    ...(latest.environment ? { environment: latest.environment } : {}),
    steps,
    checked: [...checked],
    notChecked,
    warrant,
    note,
    totalDurationMs: steps.reduce(
      (sum, step) => sum + (step.durationMs ?? 0),
      0,
    ),
  };
}

/**
 * Every run the session holds, newest first — the CI "runs list".
 *
 * One run per task, so a page shows a job once with all its steps rather than one
 * row per tool call.
 */
export function assayRuns(input: {
  evidence: readonly AssayEvidenceInput[];
  completions?: readonly AssayCompletionInput[];
  classesFor: (command: string, passed: boolean) => readonly string[];
}): AssayRun[] {
  const tasks = [...new Set(input.evidence.map((record) => record.taskID))];
  const runs: AssayRun[] = [];
  for (const taskID of tasks) {
    const completion = input.completions?.find(
      (entry) => entry.taskID === taskID,
    );
    const run = assayRunFor({
      evidence: input.evidence,
      taskID,
      ...(completion ? { completion } : {}),
      classesFor: input.classesFor,
    });
    if (run) runs.push(run);
  }
  // Newest first. `recordedAt` is an ISO stamp, so a plain string compare orders
  // it; the step count breaks ties so the order does not depend on the input.
  return runs.sort((left, right) => {
    const byTime = (right.recordedAt ?? "").localeCompare(
      left.recordedAt ?? "",
    );
    return byTime !== 0 ? byTime : right.steps.length - left.steps.length;
  });
}
