/**
 * The sandbox family's operation-log seam (audit 缺口 4).
 *
 * The sandbox package had ZERO log points: a promotion that failed its
 * gate, a rollback that refused, a delete that discarded unmerged work, a
 * resource whose confinement backend was missing — none of it reached the
 * operations log, so "why did my merge not land" had no durable answer.
 * The seams below log IN and OUT (or the refusal), with the ids and the
 * counts a reader acts on.
 *
 * The logger is STRUCTURAL on purpose: the package takes anything with
 * these methods, tests pass a recorder, production passes the operation
 * log's component logger, and a manager built without one stays silent
 * (the seam's historical behaviour).
 */

export type SandboxLog = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

/** The silent default: a directly constructed manager logs nowhere. */
export const noopSandboxLog: SandboxLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
