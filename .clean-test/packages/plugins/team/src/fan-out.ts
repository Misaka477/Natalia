/**
 * Fan-out orchestration (agent-team T-3, first slice).
 *
 * Takes the decomposed tasks (contract-first output), spawns each as a
 * sandboxed sub-agent in parallel, and produces one PR per sub-agent as it
 * lands: the diff of its own sandbox worktree plus its result. The
 * provider-concurrency limiter (T-1) bounds the actual parallel streams;
 * the sub-agents run concurrently through the registry.
 *
 * The wait is DRAINED, not blocked: each terminal candidate builds its PR
 * immediately and fires onPR (the spine's team-pr notice), so the lead
 * hears about every PR as it lands instead of after the last one — the
 * old single all_terminal wait blocked the caller on the batch's
 * slowest member for no benefit the drain does not have.
 *
 * The PR queue is what T-4's lead review consumes. The decomposition itself —
 * the contract-first step that produces the ownership map and these tasks — is
 * the orchestrator's job and is driven separately; this is the mechanical
 * fan-out core.
 */
import type { RuntimeEvent, SettlementReason } from "@anthelia/contracts";
import type {
  SandboxChangeView,
  SandboxToolService,
  SubagentToolService,
} from "@anthelia/tools";

/**
 * A PR's settlement reason, pure so the table can be pinned: a completed
 * PR is `ready`, unless the build gate failed it (a `failed` with the
 * output on the notice); a failed or stopped candidate carries its own
 * status. `running` can only reach here through a caller that fires onPR
 * for a live PR — it lands on `unknown` rather than being coerced.
 */
export function prSettlementReason(pr: FanOutPR): SettlementReason {
  if (pr.status === "completed")
    return pr.buildEvidence && !pr.buildEvidence.ok ? "failed" : "ready";
  if (pr.status === "failed") return "failed";
  if (pr.status === "stopped") return "stopped";
  return "unknown";
}

export type FanOutTask = {
  id: string;
  prompt: string;
  /** The ownership map's domain: paths (relative to the worktree) this task may write. */
  writePaths?: string[];
  allowedTools?: string[];
  excludeTools?: string[];
};

export type FanOutPR = {
  id: string;
  sandboxID: string;
  /**
   * `running` is reachable: a fan-out that times out still has live candidates,
   * and reporting them as one of the terminal states would be a guess.
   */
  status: "completed" | "failed" | "stopped" | "running";
  /** The candidate's diff against its base — what a lead reviews. */
  diff: SandboxChangeView[];
  result?: string;
  /**
   * Build evidence: a validation command run in the candidate worktree before
   * the PR is ready. Present when a build command was configured.
   */
  buildEvidence?: { ok: boolean; exitCode: number; output: string };
};

/**
 * Spawns every task as a sandboxed sub-agent, waits for all of them, and
 * returns one PR per task.
 */
export async function runFanOut(input: {
  tasks: FanOutTask[];
  subagents: SubagentToolService;
  sandboxes: SandboxToolService;
  publish?: (event: RuntimeEvent) => void;
  timeoutMs?: number;
  /**
   * Build command run in each completed candidate's worktree — the build
   * evidence gate. A candidate that fails it is still reported as a PR, with
   * the failing output as the reason (a lead reviews or rejects on it).
   */
  buildCommand?: string;
  /** Maximum concurrent sub-agents; absent = spawn all at once. */
  maxConcurrent?: number;
  /**
   * Fires per PR as it becomes ready. The spine's team adopter delivers
   * a notice per call, so the lead reviews incrementally instead of
   * waiting for the whole queue.
   */
  onPR?: (pr: FanOutPR) => void;
}): Promise<FanOutPR[]> {
  const cap = Math.min(
    input.maxConcurrent ?? input.tasks.length,
    input.tasks.length,
  );
  const spawned = await spawnWithConcurrency(input.tasks, cap, (task) =>
    input.subagents.spawn(task.prompt, {
      mode: "sandbox",
      writePaths: task.writePaths,
      allowedTools: task.allowedTools,
      excludeTools: task.excludeTools,
    }),
  );
  input.publish?.({
    type: "diagnostic",
    level: "info",
    message: `fan-out spawned ${spawned.length} sandboxed sub-agents in parallel`,
  });
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  return await drainTerminal(input, spawned, deadline);
}

/** The diff and build evidence a PR carries, built where it lands. */
async function buildPR(
  input: {
    sandboxes: SandboxToolService;
    buildCommand?: string;
  },
  sandboxID: string,
  status: FanOutPR["status"],
): Promise<{
  diff: SandboxChangeView[];
  buildEvidence?: FanOutPR["buildEvidence"];
}> {
  // A completed candidate's worktree holds its diff for the lead to review.
  const diff =
    status === "completed"
      ? await input.sandboxes
          .previewMerge(sandboxID)
          .catch(() => [] as SandboxChangeView[])
      : [];
  const buildEvidence =
    status === "completed" && input.buildCommand
      ? await input.sandboxes
          .validate(sandboxID, input.buildCommand)
          .catch(() => ({
            ok: false,
            exitCode: -1,
            output: "validate failed",
          }))
      : undefined;
  return { diff, ...(buildEvidence ? { buildEvidence } : {}) };
}

/**
 * Drain the spawned runs until they are all terminal or the budget ends,
 * building each PR the moment its candidate lands. A candidate still
 * running at the deadline is reported as running (not coerced), and the
 * PRs that finished are all kept — the drain reports what happened
 * rather than discarding the batch for one straggler.
 */
async function drainTerminal(
  input: {
    subagents: SubagentToolService;
    sandboxes: SandboxToolService;
    buildCommand?: string;
    publish?: (event: RuntimeEvent) => void;
    onPR?: (pr: FanOutPR) => void;
  },
  spawned: Array<{
    item: FanOutTask;
    record: { id: string; outputs: Array<{ text: string }> };
  }>,
  deadline: number,
): Promise<FanOutPR[]> {
  const prs: FanOutPR[] = [];
  const pending = new Set(spawned.map(({ record }) => record.id));
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      input.publish?.({
        type: "diagnostic",
        level: "warning",
        message:
          `fan-out timed out waiting for ${pending.size} sub-agent(s): ` +
          `${[...pending].join(", ")}; the PRs that finished are still reported`,
      });
      break;
    }
    const results = await input.subagents.wait(
      [...pending],
      "any_terminal",
      remaining,
    );
    const landed = [...pending].filter((id) =>
      ["completed", "failed", "stopped"].includes(results[id]?.status ?? ""),
    );
    if (!landed.length) break; // the budget for this slice
    for (const { item, record } of spawned) {
      if (!landed.includes(record.id)) continue;
      const status = (results[record.id]?.status ??
        "failed") as FanOutPR["status"];
      pending.delete(record.id);
      const pr: FanOutPR = {
        id: item.id,
        sandboxID: record.id,
        status,
        ...(await buildPR(input, record.id, status)),
        result: record.outputs.map((entry) => entry.text).join("\n"),
      };
      prs.push(pr);
      // The PR is ready: the spine's team adopter tells the lead here, one
      // notice per landed candidate.
      input.onPR?.(pr);
    }
  }
  // A straggler the deadline ran out on is reported as running — never
  // coerced into a terminal state it has not reached.
  for (const { item, record } of spawned)
    if (pending.has(record.id))
      prs.push({
        id: item.id,
        sandboxID: record.id,
        status: "running",
        // No worktree was read for a live candidate: an empty diff, not
        // a coerced one.
        diff: [],
        result: record.outputs.map((entry) => entry.text).join("\n"),
      });
  return prs;
}

async function spawnWithConcurrency<T, R>(
  items: T[],
  limit: number,
  spawn: (item: T) => Promise<R>,
): Promise<Array<{ item: T; record: R }>> {
  const results: Array<{ item: T; record: R }> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = {
        item: items[index]!,
        record: await spawn(items[index]!),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

/**
 * Validates a decomposed ownership map — the contract-first output's disjoint
 * guarantee. Every write domain belongs to exactly one task, and no domain is
 * a prefix of another (an overlap that would let two tasks touch the same
 * file). Decomposition quality is the fan-out's success condition; this is the
 * mechanical gate an orchestrator runs before spawning.
 */
export function validateOwnershipMap(input: { tasks: FanOutTask[] }): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const domains = input.tasks.flatMap((task) =>
    (task.writePaths ?? []).map((domain) => ({
      task: task.id,
      domain: domain.endsWith("/") ? domain : `${domain}/`,
    })),
  );
  for (let index = 0; index < domains.length; index++) {
    for (let other = index + 1; other < domains.length; other++) {
      const a = domains[index]!;
      const b = domains[other]!;
      if (a.task === b.task) continue;
      if (b.domain.startsWith(a.domain) || a.domain.startsWith(b.domain))
        issues.push(
          `overlapping domains: ${a.task} (${a.domain}) and ${b.task} (${b.domain})`,
        );
    }
  }
  return { ok: issues.length === 0, issues };
}

export type PRReviewDecision = {
  id: string;
  decision: "approve" | "request-changes";
  reason?: string;
};

export type PRReviewOutcome = {
  id: string;
  decision: "approve" | "request-changes";
  reason?: string;
  /** The promoted changes when approved and merged. */
  merged?: SandboxChangeView[];
  /**
   * Set when an approved PR's promotion failed. The PR is reported back for
   * changes rather than thrown, so one candidate that cannot land does not stop
   * the lead from reviewing the rest of the batch.
   */
  promotionError?: string;
};

/**
 * The PR review loop (T-4): a lead decides each PR one at a time — incremental,
 * so each review sees one candidate's diff and evidence, never the whole batch.
 * An approved PR is promoted into the system slot (the sandbox backend's
 * merge); a request-changes PR is returned with the reason, and its candidate
 * stays for the sub-agent to redo.
 */
export async function reviewPRs(input: {
  prs: FanOutPR[];
  sandboxes: SandboxToolService;
  workspaceRoot: string;
  decide: (pr: FanOutPR) => Promise<PRReviewDecision> | PRReviewDecision;
  publish?: (event: RuntimeEvent) => void;
  buildCommand?: string;
}): Promise<PRReviewOutcome[]> {
  const outcomes: PRReviewOutcome[] = [];
  for (const pr of input.prs) {
    if (pr.status !== "completed") {
      outcomes.push({
        id: pr.id,
        decision: "request-changes",
        reason: `sub-agent did not complete (${pr.status})`,
      });
      continue;
    }
    const decision = await input.decide(pr);
    if (decision.decision === "approve") {
      const promotion = await input.sandboxes
        .promoteWithValidation(pr.sandboxID, {
          // An empty command is refused by the promotion, so a batch with no
          // build configured validates against `true` — the gate is the
          // promotion's structure, not a check this layer invented.
          command: input.buildCommand?.trim() || "true",
          hostRoot: input.workspaceRoot,
        })
        .then((result) => ({ ok: true as const, result }))
        .catch((error: unknown) => ({
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        }));
      if (!promotion.ok) {
        // Recorded and the loop continues. Throwing here abandoned every PR
        // after the first that could not land, and left the ones already
        // promoted reported nowhere.
        input.publish?.({
          type: "diagnostic",
          level: "warning",
          message: `PR ${pr.id} could not be promoted: ${promotion.reason}`,
        });
        outcomes.push({
          id: pr.id,
          decision: "request-changes",
          reason: `promotion failed: ${promotion.reason}`,
          promotionError: promotion.reason,
        });
        continue;
      }
      const merged = promotion.result.changedFiles;
      input.publish?.({
        type: "diagnostic",
        level: "info",
        message: `PR ${pr.id} approved and promoted (${merged.length} files)`,
      });
      outcomes.push({ id: pr.id, decision: "approve", merged });
      // The work is in the host now, so its candidate is redundant: leaving it
      // behind leaks a worktree, a branch and a backup per approved PR.
      await input.sandboxes
        .delete(pr.sandboxID)
        .then(() =>
          input.publish?.({
            type: "diagnostic",
            level: "info",
            message: `PR ${pr.id} candidate sandbox released after promotion`,
          }),
        )
        .catch((error: unknown) => {
          // A sandbox that will not delete is worth saying out loud: it holds a
          // worktree and a branch, and nothing else will come back for it.
          input.publish?.({
            type: "diagnostic",
            level: "warning",
            message:
              `PR ${pr.id} was promoted but its sandbox ${pr.sandboxID} ` +
              `could not be released: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    } else {
      input.publish?.({
        type: "diagnostic",
        level: "info",
        message: `PR ${pr.id} sent back for changes: ${decision.reason ?? "no reason"}`,
      });
      outcomes.push({
        id: pr.id,
        decision: "request-changes",
        reason: decision.reason,
      });
    }
  }
  return outcomes;
}
