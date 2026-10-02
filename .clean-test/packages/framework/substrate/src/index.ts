/**
 * The engine substrate's public surface.
 *
 * Worker entrypoints (`.worker.ts`) are deliberately NOT re-exported:
 * they execute `parentPort`-guarded code at module load, and pulling one
 * into the barrel would throw on the very first main-thread import of
 * this package. A worker is instantiated by path/URL, never imported.
 */

export * from "./context";
export * from "./helpers";
export * from "./initialize-types";
export * from "./options";
export * from "./performance-trace";
export * from "./plan-doc-port";
export * from "./plugin-discovery";
export * from "./plugin-mount";
export * from "./plugin-owner";
export * from "./plugins-controller";
export * from "./ports";
export * from "./ports-client-surface";
export * from "./ports-extra";
export * from "./ports-initialize";
export * from "./projection-contributions";
export * from "./repository-refs";
export * from "./service-bindings";
export * from "./session-audit-scan";
export * from "./session-event-retention";
export * from "./session-event-window";
export * from "./session-execution-state";
export * from "./session-facts";
export * from "./session-full-events";
export * from "./session-project-client";
export * from "./session-window";
export * from "./status-config";
export * from "./transcript-page";
export * from "./worker-pool";
