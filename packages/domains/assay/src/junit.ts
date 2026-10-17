/**
 * A validation run as JUnit XML — the format CI already speaks.
 *
 * WHY A STANDARD FORMAT. The evidence record is Natalia's own vocabulary; a
 * reader outside this product wants the format its tools already parse. JUnit
 * XML is that format (pytest, jest, cargo-nextest, GitHub's own test reporters
 * all emit or consume it), and inventing a second one would make every export a
 * translation nobody asked for.
 *
 * THE MAPPING IS THE HONEST PART. A run that was killed at its budget is NOT a
 * failing test — it is a run that never answered — so it maps to `<error>`
 * (`timed out`), not `<failure>`. Conflating them is how "the suite was slow"
 * becomes "the suite is red".
 */
import type { ValidationOutcome } from "./validation";

/** One run, as the suite reports it. */
export type JunitCase = {
  /** The case's name: the task or the command it ran. */
  name: string;
  outcome: ValidationOutcome;
  /** The status the command reported, when it reported one. */
  exitCode?: number;
  durationMs?: number;
  /** The bounded, redacted output summary. */
  summary: string;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** XML-escape one text run. Control characters XML 1.0 forbids are dropped. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replace(/[&<>"']/gu, (character) => ESCAPES[character]!);
}

/** Whether the run answered at all, and if so whether it said yes. */
function verdictOf(entry: JunitCase): "pass" | "failure" | "error" | "skipped" {
  if (entry.outcome === "exited")
    return entry.exitCode === 0 || entry.exitCode === undefined
      ? "pass"
      : "failure";
  // Everything else means the command never got to answer. A timeout is an
  // ERROR (the harness stopped it), never a failure of the check itself.
  return entry.outcome === "aborted" ? "skipped" : "error";
}

function messageOf(entry: JunitCase): string | undefined {
  switch (entry.outcome) {
    case "exited":
      return entry.exitCode === undefined
        ? undefined
        : `exit ${entry.exitCode}`;
    case "timed_out":
      return "timed out: the run was killed at its budget";
    case "aborted":
      return "cancelled before it could answer";
    case "spawn-failed":
      return "the command could not be started";
  }
}

/**
 * Render one suite of cases.
 *
 * `suite` names the batch (a task, a plan step); the runtime is the platform's
 * own. Timestamps are omitted on purpose: a document that changes every time it
 * is rendered cannot be diffed, and a re-assay compares documents.
 */
export function validationRunToJUnitXml(input: {
  suite: string;
  cases: readonly JunitCase[];
}): string {
  const cases = input.cases;
  const failures = cases.filter(
    (entry) => verdictOf(entry) === "failure",
  ).length;
  const errors = cases.filter((entry) => verdictOf(entry) === "error").length;
  const skipped = cases.filter(
    (entry) => verdictOf(entry) === "skipped",
  ).length;
  const totalMs = cases.reduce(
    (sum, entry) => sum + (entry.durationMs ?? 0),
    0,
  );
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(totalMs / 1000).toFixed(3)}">`,
    `  <testsuite name="${escapeXml(input.suite)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(totalMs / 1000).toFixed(3)}" hostname="${escapeXml(process.platform)}">`,
  ];
  for (const entry of cases) {
    const name = escapeXml(entry.name);
    const time = ((entry.durationMs ?? 0) / 1000).toFixed(3);
    const verdict = verdictOf(entry);
    const message = messageOf(entry);
    const body = escapeXml(entry.summary);
    const open = `    <testcase name="${name}" time="${time}"`;
    if (verdict === "pass") {
      lines.push(
        `${open}>`,
        `      <system-out>${body}</system-out>`,
        "    </testcase>",
      );
      continue;
    }
    if (verdict === "skipped") {
      lines.push(
        `${open}>`,
        `      <skipped message="${escapeXml(message ?? "skipped")}"/>`,
        "    </testcase>",
      );
      continue;
    }
    const tag = verdict === "failure" ? "failure" : "error";
    lines.push(
      `${open}>`,
      `      <${tag} message="${escapeXml(message ?? "")}">${body}</${tag}>`,
      "    </testcase>",
    );
  }
  lines.push("  </testsuite>", "</testsuites>");
  return `${lines.join("\n")}\n`;
}
