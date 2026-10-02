/**
 * The seam's public entry.
 *
 * This file only re-exports, so a concrete executor can depend on the abstract
 * class (./shell) without importing this barrel — importing it would be a
 * cycle.
 */
export { ShellExecutor } from "./shell";
export { BashLocalExecutor } from "./bash-local";
export {
  PwshLocalExecutor,
  ENCODING_PREAMBLE,
  ENV_OVERRIDES,
} from "./pwsh-local";
export { candidatePwshPaths, resolvePwshPath } from "./pwsh-resolve";
export {
  executorFor,
  platformShell,
  resolveShellName,
  selectExecutor,
  type ShellName,
} from "./select";
export {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WRAPPER_FAILURE_SIGNATURE,
  clampTimeout,
} from "./types";
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from "./types";
