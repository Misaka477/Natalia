/**
 * Plan task state machine — work-ledger/plan-task-state.ts (EI §4 Phase 4).
 *
 * The plan document's markdown checkboxes are the **declaration source** (the
 * human ticks a step as done); the runtime's recorded evidence is the **fact
 * source** (what was actually verified). The state machine projects the two
 * into one judge-able state per task, evidence-first:
 *
 *   checked + evidence  -> verified   (declared and backed)
 *   checked + no evidence -> gap      (declared done but nothing backs it)
 *   open + evidence     -> in_progress (work has started, not declared done)
 *   open + no evidence  -> pending
 *   skipped             -> skipped    (explicitly not-done, still visible)
 *
 * A checked box is never `verified` without evidence (EI §2 principle 1:
 * evidence-backed, never text similarity). `gap` and `skipped` stay visible so
 * a plan cannot quietly claim completion it has not earned.
 */

/** A checkbox's declared state in the plan Markdown. */
export type PlanTaskDeclaration = "open" | "done" | "skipped";

/** One parsed checkbox task. */
export type PlanTask = {
  /** Stable id: `task:<ordinal>` (ordinal is the checkbox's document order). */
  id: string;
  /** The task text (the checkbox label, annotations trimmed). */
  text: string;
  /** The declaration the human wrote in the plan. */
  declaration: PlanTaskDeclaration;
  /** Indentation depth (0 = top-level), for nested task lists. */
  depth: number;
};

/** The projected state of a task (declaration × evidence). */
export type PlanTaskState =
  | "pending"
  | "in_progress"
  | "verified"
  | "gap"
  | "skipped";

// A markdown task list item: optional indent, a bullet or number, a checkbox
// marker, and the label. `x`/`X` = done, `-`/`~` = skipped, space = open.
const TASK_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~\-])\]\s+(.+?)\s*$/u;
/**
 * Parses a plan document's markdown checkboxes into tasks (EI §4 Phase 4).
 * Non-task lines are ignored; nested tasks keep their depth so a consumer can
 * render the hierarchy. The ordinal is document order, giving each task a
 * stable id for the document's lifetime.
 */
export function parsePlanTasks(content: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(TASK_LINE);
    if (!match) continue;
    const indent = match[1] ?? "";
    const marker = match[2] ?? " ";
    const text = (match[3] ?? "").trim();
    if (!text) continue;
    const depth = Math.floor(indent.replace(/\t/gu, "  ").length / 2);
    const declaration: PlanTaskDeclaration =
      marker === "x" || marker === "X"
        ? "done"
        : marker === "-" || marker === "~"
          ? "skipped"
          : "open";
    tasks.push({
      id: `task:${tasks.length + 1}`,
      text,
      declaration,
      depth,
    });
  }
  return tasks;
}

/**
 * Projects one task's state from its declaration and whether the runtime has
 * recorded evidence for it (EI §4 Phase 4, evidence-first). `hasEvidence` is
 * true when a completion/evidence fact references the task.
 */
export function evaluatePlanTaskState(input: {
  declaration: PlanTaskDeclaration;
  hasEvidence: boolean;
}): PlanTaskState {
  if (input.declaration === "skipped") return "skipped";
  if (input.declaration === "done")
    return input.hasEvidence ? "verified" : "gap";
  return input.hasEvidence ? "in_progress" : "pending";
}

/**
 * Projects a plan's tasks into states, matching each task against the runtime
 * evidence. A task has evidence when a recorded fact's `taskID` equals the
 * task id, or its objective / change paths reference the task text (the model
 * records evidence with a free-form taskID, so the text reference is the
 * fallback the plan's own wording provides). Returns the tasks with their
 * projected state, preserving document order.
 */
export function projectPlanTaskStates(
  tasks: PlanTask[],
  evidence: Array<{
    taskID?: string;
    objective?: string;
    changePaths?: string[];
  }>,
): Array<PlanTask & { state: PlanTaskState }> {
  const normalized = (value: string) => value.toLowerCase();
  return tasks.map((task) => {
    const hasEvidence = evidence.some((fact) => {
      if (fact.taskID && fact.taskID === task.id) return true;
      const needle = normalized(task.text);
      if (!needle) return false;
      if (fact.objective && normalized(fact.objective).includes(needle))
        return true;
      return (fact.changePaths ?? []).some((path) =>
        normalized(path).includes(needle),
      );
    });
    return {
      ...task,
      state: evaluatePlanTaskState({
        declaration: task.declaration,
        hasEvidence,
      }),
    };
  });
}

/**
 * The result of a `plan_doc_tick` (EI §4 Phase 4): either the rewritten document
 * or a refusal. `action` reports what happened so the caller can tell the model.
 */
export type PlanDocTickResult =
  | { ok: true; content: string; action: "ticked" | "unticked" | "logged" }
  | { ok: false; reason: string };

/** The landing-log section the model appends to a checkbox-less plan. */
export const LANDING_LOG_HEADING = "落地日志";

// A markdown ATX heading (its own local copy — this module must not reach into
// the constitution-doc parser for a regex).
const HEADING_LINE = /^(#{1,6})\s+(.*\S)\s*$/u;

function normalizeLabel(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Ticks / unticks one checkbox task, or — when the plan carries no checkboxes
 * at all — appends (or extends) a `## 落地日志` landing-log section holding the
 * task. This is the model's "declare this step done / retract it" action.
 *
 * Only a marker flips or a log item is appended; **no existing line's text is
 * ever rewritten**, so the model can declare progress without editing the plan.
 * A plan that already has checkboxes will not gain fabricated tasks: a
 * non-matching `task` is refused rather than silently injected.
 */
export function applyPlanDocTick(
  content: string,
  input: { task: string; done: boolean },
): PlanDocTickResult {
  const task = input.task.trim();
  if (!task) return { ok: false, reason: "task must not be empty" };
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const target = normalizeLabel(task);

  const boxes: Array<{
    index: number;
    raw: string;
    label: string;
    marker: string;
  }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(TASK_LINE);
    if (!match) continue;
    boxes.push({
      index,
      raw: lines[index]!,
      label: normalizeLabel(match[3] ?? ""),
      marker: match[2] ?? " ",
    });
  }

  // Prefer an exact label match; otherwise a unique substring match either way.
  const exact = boxes.filter((box) => box.label === target);
  let chosen = exact.length === 1 ? exact[0] : undefined;
  if (!chosen && exact.length === 0) {
    const substrings = boxes.filter(
      (box) =>
        (box.label.includes(target) && target.length >= 2) ||
        (target.includes(box.label) && box.label.length >= 4),
    );
    if (substrings.length === 1) chosen = substrings[0];
  }

  if (chosen) {
    const wasDone = chosen.marker === "x" || chosen.marker === "X";
    if (input.done === wasDone) {
      // Already in the requested state — a no-op write, still reported.
      return {
        ok: true,
        content,
        action: input.done ? "ticked" : "unticked",
      };
    }
    const marker = input.done ? "x" : " ";
    const next = [...lines];
    next[chosen.index] = chosen.raw.replace(/\[([ xX~\-])\]/, `[${marker}]`);
    return {
      ok: true,
      content: next.join("\n"),
      action: input.done ? "ticked" : "unticked",
    };
  }

  // No checkbox matched. Append to the landing log when the plan has none at
  // all (a prose plan) or already carries a landing-log section (the model is
  // using it); otherwise refuse — a checklist plan's tasks are matched, not
  // fabricated.
  const hasLandingLog = lines.some((line) => {
    const match = line.match(HEADING_LINE);
    return Boolean(match && match[2]!.trim().includes(LANDING_LOG_HEADING));
  });
  if (boxes.length > 0 && !hasLandingLog) {
    return {
      ok: false,
      reason: `no checkbox task matches "${task}" in this plan (or it is ambiguous); read the plan and pass the exact step label`,
    };
  }

  const item = `${input.done ? "- [x]" : "- [ ]"} ${task}`;
  return {
    ok: true,
    content: appendToLandingLog(lines, item).join("\n"),
    action: "logged",
  };
}

/** Appends `item` to the `## 落地日志` section, creating it if absent. */
function appendToLandingLog(lines: string[], item: string): string[] {
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(HEADING_LINE);
    if (match && match[2]!.trim().includes(LANDING_LOG_HEADING)) {
      headingIndex = index;
      break;
    }
  }
  if (headingIndex < 0) {
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "")
      trimmed.pop();
    return [...trimmed, "", `## ${LANDING_LOG_HEADING}`, "", item];
  }
  // Find the section's end (the next heading or EOF) and its last content line.
  let end = headingIndex + 1;
  let lastContent = headingIndex;
  while (end < lines.length) {
    if (lines[end]!.match(HEADING_LINE)) break;
    if (lines[end]!.trim() !== "") lastContent = end;
    end += 1;
  }
  const insertAt = Math.max(lastContent, headingIndex) + 1;
  const next = [...lines];
  next.splice(insertAt, 0, lastContent === headingIndex ? `\n${item}` : item);
  return next;
}
