/**
 * The seam's public entry.
 *
 * This file only re-exports, so a concrete executor can depend on the abstract
 * class (./shell) without importing this barrel — importing it would be a
 * cycle.
 */
export { RUN_OUTPUT_MAX_BYTES, ShellExecutor } from "./shell";
export { BashLocalExecutor } from "./bash-local";
export {
  NATALIA_ENV_PREFIX,
  NATALIA_HOME_ENV,
  NATALIA_SESSION_ID_ENV,
  NATALIA_SHELL_ENV,
  ShellEnvRegistry,
  applyShellEnv,
} from "./shell-env";
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
  WRAPPER_REFUSAL_EXIT,
  clampTimeout,
  missingConfinementRefusal,
} from "./types";
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
  ShellSandboxInfo,
} from "./types";
