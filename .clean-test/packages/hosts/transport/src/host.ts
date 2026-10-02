/**
 * Host-side transport surface: serving a runtime, and the daemon lifecycle.
 *
 * Deliberately a separate entry point from `@natalia/transport`. Everything
 * here either opens a listening socket, mints or reads a bearer token, or
 * spawns a process, so it belongs to whoever runs the runtime — today
 * `apps/cli` — and not to a UI that merely talks to one. `guard:imports`
 * enforces that consumer-contract packages never reach this module.
 */
export {
  createRuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServer,
  type TaskDeliveryRequest,
  type TaskDeliveryResult,
  type TaskExecutionHandle,
} from "./http";
export {
  createRuntimeWsServer,
  type RuntimeWsServerOptions,
  type RuntimeWsServer,
} from "./ws";
export { handleRPCMessage, stringParam, arrayParam } from "./rpc";
export {
  matchTerminalPath,
  authorizeTerminalSession,
  type TerminalWsMessage,
  type TerminalWsServerMessage,
} from "./terminal-ws";
export {
  createRuntimeDaemonStore,
  daemonToken,
  registerRuntimeDaemon,
  readRuntimeDaemonRegistration,
  runtimeDaemonStatus,
  stopRuntimeDaemon,
  spawnRuntimeDaemon,
  type RuntimeDaemonRegistration,
  type RuntimeDaemonStore,
} from "./daemon";
